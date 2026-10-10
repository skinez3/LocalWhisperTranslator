import { pipeline, env } from './transformers.js';

env.backends.onnx.wasm.numThreads = 1;
env.allowLocalModels = false;

let transcriber = null;
let isModelLoading = false;
let targetTabId = null;
let audioContext = null;
let activeStream = null;

let transcriptionQueue = [];
let isTranscribing = false;

// Current settings
let currentSettings = {
    modelSize: 'small',
    sourceLang: 'et',
    targetLang: 'ru'
};

// Volume level of an audio chunk
function getRMS(pcmData) {
    let sum = 0;
    for (let i = 0; i < pcmData.length; i++) sum += pcmData[i] * pcmData[i];
    return Math.sqrt(sum / pcmData.length);
}

// Unload and reload model (e.g. size changed)
async function reloadModel() {
    if (isModelLoading) return;

    if (targetTabId) {
        chrome.runtime.sendMessage({ action: 'MODEL_LOADING', tabId: targetTabId });
    }

    if (transcriber && typeof transcriber.dispose === 'function') {
        try { await transcriber.dispose(); } catch (e) { console.error('Dispose error:', e); }
    }

    transcriber = null;
    await initWhisper();
}

// Load Whisper model on WebGPU
async function initWhisper() {
    if (transcriber) return transcriber;
    if (isModelLoading) return null;

    isModelLoading = true;
    console.log(`Loading whisper-${currentSettings.modelSize} on WebGPU...`);

    try {
        transcriber = await pipeline('automatic-speech-recognition', `Xenova/whisper-${currentSettings.modelSize}`, {
            device: 'webgpu',
            dtype: 'fp16'
        });

        console.log('Whisper model ready');

        if (targetTabId) {
            chrome.runtime.sendMessage({ action: 'MODEL_READY', tabId: targetTabId });
        }
    } catch (err) {
        console.error('Whisper load error:', err);
        if (targetTabId) {
            chrome.runtime.sendMessage({
                action: 'MODEL_ERROR',
                tabId: targetTabId,
                error: err.message || 'WebGPU / model loading error'
            });
        }
    } finally {
        isModelLoading = false;
    }

    return transcriber;
}

chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'INIT_CAPTURE_AND_WHISPER') {
        targetTabId = message.tabId;

        if (message.settings) {
            currentSettings.modelSize = message.settings.modelSize || 'small';
            currentSettings.sourceLang = message.settings.sourceLang || 'et';
            currentSettings.targetLang = message.settings.targetLang || 'ru';
        }

        initWhisper().then(() => {
            startAudioCapture(message.streamId);
        });
    } else if (message.action === 'STOP_CAPTURE') {
        stopAudioCapture();
    } else if (message.action === 'UPDATE_SETTINGS') {
        let needsModelReload = false;

        if (message.settings.modelSize && message.settings.modelSize !== currentSettings.modelSize) {
            currentSettings.modelSize = message.settings.modelSize;
            needsModelReload = true;
        }
        if (message.settings.sourceLang) currentSettings.sourceLang = message.settings.sourceLang;
        if (message.settings.targetLang) currentSettings.targetLang = message.settings.targetLang;

        if (needsModelReload && transcriber !== null) {
            reloadModel();
        }
    }
});

let keepAliveInterval = null;

// Release audio resources
function stopAudioCapture() {
    if (activeStream) {
        activeStream.getTracks().forEach(track => track.stop());
        activeStream = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
    transcriptionQueue = [];
    isTranscribing = false;
}

// Capture tab audio at 16 kHz
async function startAudioCapture(streamId) {
    try {
        activeStream = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
            video: false
        });

        audioContext = new AudioContext({ sampleRate: 16000 });

        // Keep context from suspending
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        keepAliveInterval = setInterval(() => {
            if (audioContext && audioContext.state === 'suspended') audioContext.resume();
        }, 1000);

        const source = audioContext.createMediaStreamSource(activeStream);
        // Keep tab audible
        source.connect(audioContext.destination);

        // Boost quiet speech
        const compressor = audioContext.createDynamicsCompressor();
        compressor.threshold.value = -60;
        compressor.knee.value = 30;
        compressor.ratio.value = 12;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.25;

        const gainNode = audioContext.createGain();
        gainNode.gain.value = 2.5;

        source.connect(compressor);
        compressor.connect(gainNode);

        await processAudio(gainNode);
    } catch (err) {
        console.error('Tab audio access error:', err);
    }
}

// Split audio into phrases by silence
async function processAudio(audioNode) {
    try {
        await audioContext.audioWorklet.addModule('audio-processor.js');
        const workletNode = new AudioWorkletNode(audioContext, 'whisper-audio-processor');

        const SAMPLE_RATE = 16000;
        const MIN_SAMPLES = SAMPLE_RATE * 1.5;
        const MAX_SAMPLES = SAMPLE_RATE * 10.0;
        const SILENCE_THRESHOLD = SAMPLE_RATE * 0.7;
        const ABSOLUTE_MIN_VOLUME = 0.005;

        let audioChunks = [];
        let totalSamples = 0;
        let silenceSamples = 0;
        let isSpeaking = false;

        workletNode.port.onmessage = (event) => {
            const chunk = event.data;
            const volume = getRMS(chunk);

            if (volume >= ABSOLUTE_MIN_VOLUME) {
                isSpeaking = true;
                silenceSamples = 0;
            } else {
                silenceSamples += chunk.length;
            }

            if (isSpeaking) {
                audioChunks.push(chunk);
                totalSamples += chunk.length;

                const isPhraseFinished = silenceSamples >= SILENCE_THRESHOLD && totalSamples >= MIN_SAMPLES;
                const isBufferFull = totalSamples >= MAX_SAMPLES;

                if (isPhraseFinished || isBufferFull) {
                    const combined = combineFloat32Arrays(audioChunks);
                    audioChunks = [];
                    totalSamples = 0;
                    silenceSamples = 0;
                    isSpeaking = false;
                    enqueueTranscription(combined);
                }
            }
        };

        audioNode.connect(workletNode);
    } catch (e) {
        console.error('AudioWorklet init error:', e);
    }
}

// Merge chunks into one array
function combineFloat32Arrays(arrays) {
    let totalLength = arrays.reduce((acc, val) => acc + val.length, 0);
    let result = new Float32Array(totalLength);
    let offset = 0;
    for (let arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}

function enqueueTranscription(audioData) {
    transcriptionQueue.push(audioData);
    processQueue();
}

// Transcribe one phrase at a time
async function processQueue() {
    if (isTranscribing || transcriptionQueue.length === 0) return;
    isTranscribing = true;

    const audioData = transcriptionQueue.shift();
    try {
        await transcribeAndTranslate(audioData);
    } catch (err) {
        console.error('Transcription queue error:', err);
    } finally {
        isTranscribing = false;
        if (transcriptionQueue.length > 0) {
            setTimeout(processQueue, 50);
        }
    }
}

let translateQueue = [];
let isTranslating = false;

// Translate one phrase at a time
async function processTranslateQueue() {
    if (isTranslating || translateQueue.length === 0) return;

    isTranslating = true;
    const task = translateQueue.shift();

    try {
        const translatedText = await freeTranslate(task.text);
        if (targetTabId && translatedText) {
            chrome.runtime.sendMessage({
                action: 'RELAY_TRANSLATED',
                tabId: targetTabId,
                msgId: task.msgId,
                translated: translatedText
            });
        }
    } catch (err) {
        console.error('Translation error:', err);
    } finally {
        setTimeout(() => {
            isTranslating = false;
            processTranslateQueue();
        }, 50);
    }
}

// Speech to text, then queue translation
async function transcribeAndTranslate(audioData) {
    if (!transcriber) return;

    try {
        const result = await transcriber(audioData, {
            language: currentSettings.sourceLang,
            task: 'transcribe'
        });

        const originalText = result.text.trim();
        // Skip empty results
        if (!originalText || originalText === '[BLANK_AUDIO]' || originalText.length < 2) return;

        const msgId = Date.now().toString(36) + Math.random().toString(36).substring(2);

        if (targetTabId) {
            chrome.runtime.sendMessage({
                action: 'RELAY_ORIGINAL',
                tabId: targetTabId,
                msgId: msgId,
                original: originalText
            });
        }

        translateQueue.push({ text: originalText, msgId: msgId });
        processTranslateQueue();

    } catch (error) {
        console.error('Processing error:', error);
    }
}

// Translate via Google Translate endpoint
async function freeTranslate(text) {
    if (!text || text.trim() === '') return '';
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${currentSettings.sourceLang}&tl=${currentSettings.targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data && data[0] && Array.isArray(data[0])) {
            return data[0]
                .map(item => item[0])
                .filter(Boolean)
                .join('');
        }
        return text;
    } catch (e) {
        console.error('Translate API error:', e);
        return text;
    }
}
