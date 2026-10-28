import { pipeline, env } from './transformers.js';

env.backends.onnx.wasm.numThreads = 1;
// Load ONNX Runtime files from the extension
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('');
// Prefer the discrete GPU on laptops
if (env.backends.onnx.webgpu) env.backends.onnx.webgpu.powerPreference = 'high-performance';
env.allowLocalModels = false;

const SAMPLE_RATE = 16000;
const WHISPER_WINDOW = SAMPLE_RATE * 30;

const MODEL_IDS = {
    tiny: 'onnx-community/whisper-tiny',
    base: 'onnx-community/whisper-base',
    small: 'onnx-community/whisper-small',
    turbo: 'onnx-community/whisper-large-v3-turbo',
    // Old setting, turbo is faster and more accurate than medium
    medium: 'onnx-community/whisper-large-v3-turbo'
};

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

// Unload and reload model
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

// fp16 weights need the shader-f16 GPU feature
async function isFp16Supported() {
    try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        return !!adapter && adapter.features.has('shader-f16');
    } catch (e) {
        return false;
    }
}

// Load Whisper model on WebGPU
async function initWhisper() {
    if (transcriber) return transcriber;
    if (isModelLoading) return null;

    isModelLoading = true;
    const modelId = MODEL_IDS[currentSettings.modelSize] || MODEL_IDS.small;
    console.log(`Loading ${modelId} on WebGPU...`);

    try {
        // v2 silently ignores device and runs on CPU
        if (env.version.startsWith('2.')) {
            throw new Error(`transformers.js ${env.version} has no WebGPU support, update to v3`);
        }

        const fp16 = await isFp16Supported();
        transcriber = await pipeline('automatic-speech-recognition', modelId, {
            device: 'webgpu',
            dtype: {
                // Encoder is sensitive to quantization, q4 decoder generates tokens fastest
                encoder_model: fp16 ? 'fp16' : 'fp32',
                decoder_model_merged: 'q4'
            }
        });

        // Compile GPU shaders now so the first phrase isn't delayed
        await transcriber(new Float32Array(SAMPLE_RATE), {
            language: currentSettings.sourceLang,
            task: 'transcribe',
            max_new_tokens: 4
        }).catch(e => console.warn('Warm-up error:', e));

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

        audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });

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

        await processAudio(gainNode, source);
    } catch (err) {
        console.error('Tab audio access error:', err);
    }
}

// Split audio into phrases by silence
async function processAudio(audioNode, rawNode) {
    try {
        await audioContext.audioWorklet.addModule('audio-processor.js');
        // Input 0: boosted audio for Whisper, input 1: raw audio for silence detection
        const workletNode = new AudioWorkletNode(audioContext, 'whisper-audio-processor', {
            numberOfInputs: 2,
            channelCount: 1,
            channelCountMode: 'explicit'
        });

        const MIN_SAMPLES = SAMPLE_RATE * 1.5;
        const MAX_SAMPLES = SAMPLE_RATE * 10.0;
        const SILENCE_THRESHOLD = SAMPLE_RATE * 0.7;
        const ABSOLUTE_MIN_VOLUME = 0.005;
        // Chunk this much quieter than the phrase peak counts as a pause (music under speech)
        const PAUSE_RATIO = 0.3;

        let audioChunks = [];
        let totalSamples = 0;
        let silenceSamples = 0;
        let isSpeaking = false;
        let phrasePeak = 0;
        let preRoll = null;

        workletNode.port.onmessage = (event) => {
            // rms is measured before the compressor, which lifts noise above any threshold
            const { audio: chunk, rms } = event.data;

            if (rms >= ABSOLUTE_MIN_VOLUME && rms >= phrasePeak * PAUSE_RATIO) {
                // Keep the chunk before speech so the first syllable isn't cut
                if (!isSpeaking && preRoll) {
                    audioChunks.push(preRoll);
                    totalSamples += preRoll.length;
                }
                isSpeaking = true;
                silenceSamples = 0;
            } else {
                silenceSamples += chunk.length;
            }

            if (isSpeaking) {
                audioChunks.push(chunk);
                totalSamples += chunk.length;
                phrasePeak = Math.max(phrasePeak, rms);
                preRoll = null;

                const isPhraseFinished = silenceSamples >= SILENCE_THRESHOLD && totalSamples >= MIN_SAMPLES;
                const isBufferFull = totalSamples >= MAX_SAMPLES;

                if (isPhraseFinished || isBufferFull) {
                    const combined = combineFloat32Arrays(audioChunks);
                    audioChunks = [];
                    totalSamples = 0;
                    silenceSamples = 0;
                    isSpeaking = false;
                    phrasePeak = 0;
                    enqueueTranscription(combined);
                }
            } else {
                preRoll = chunk;
            }
        };

        audioNode.connect(workletNode, 0, 0);
        rawNode.connect(workletNode, 0, 1);
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

// Transcribe one batch at a time
async function processQueue() {
    if (isTranscribing || transcriptionQueue.length === 0) return;
    isTranscribing = true;

    // Merge waiting phrases into one Whisper window to catch up
    const parts = [transcriptionQueue.shift()];
    let length = parts[0].length;
    while (transcriptionQueue.length > 0 && length + transcriptionQueue[0].length <= WHISPER_WINDOW) {
        length += transcriptionQueue[0].length;
        parts.push(transcriptionQueue.shift());
    }

    try {
        await transcribeAndTranslate(parts.length > 1 ? combineFloat32Arrays(parts) : parts[0]);
    } catch (err) {
        console.error('Transcription queue error:', err);
    } finally {
        isTranscribing = false;
        processQueue();
    }
}

// Translations run in parallel, rows are matched by msgId
async function translateAndRelay(text, msgId) {
    const translatedText = await freeTranslate(text);
    if (targetTabId && translatedText) {
        chrome.runtime.sendMessage({
            action: 'RELAY_TRANSLATED',
            tabId: targetTabId,
            msgId: msgId,
            translated: translatedText
        });
    }
}

// Speech to text, then translate
async function transcribeAndTranslate(audioData) {
    if (!transcriber) return;

    try {
        const result = await transcriber(audioData, {
            language: currentSettings.sourceLang,
            task: 'transcribe',
            // Stop hallucination loops early instead of running to 448 tokens
            max_new_tokens: Math.min(440, 16 + Math.ceil(audioData.length / SAMPLE_RATE * 15))
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

        translateAndRelay(originalText, msgId);

    } catch (error) {
        console.error('Processing error:', error);
    }
}

// Translate via Google Translate endpoint
async function freeTranslate(text) {
    if (!text || text.trim() === '') return '';
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${currentSettings.sourceLang}&tl=${currentSettings.targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
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
