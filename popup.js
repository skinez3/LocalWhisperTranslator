const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const modelSelect = document.getElementById('modelSelect');
const sourceLangSelect = document.getElementById('sourceLang');
const targetLangSelect = document.getElementById('targetLang');

// Load saved settings
chrome.storage.local.get(['modelSize', 'sourceLang', 'targetLang'], (res) => {
    if (res.modelSize) modelSelect.value = res.modelSize;
    else modelSelect.value = 'base'; // Default

    if (res.sourceLang) sourceLangSelect.value = res.sourceLang;
    else sourceLangSelect.value = 'et';

    if (res.targetLang) targetLangSelect.value = res.targetLang;
    else targetLangSelect.value = 'en';
});

// Save settings on change
function saveSettings() {
    chrome.storage.local.set({
        modelSize: modelSelect.value,
        sourceLang: sourceLangSelect.value,
        targetLang: targetLangSelect.value
    });
}

modelSelect.addEventListener('change', saveSettings);
sourceLangSelect.addEventListener('change', saveSettings);
targetLangSelect.addEventListener('change', saveSettings);

function updateUI(isTranslating) {
    if (isTranslating) {
        startBtn.disabled = true;
        startBtn.style.opacity = '0.5';
        stopBtn.disabled = false;
        stopBtn.style.opacity = '1';
    } else {
        startBtn.disabled = false;
        startBtn.style.opacity = '1';
        stopBtn.disabled = true;
        stopBtn.style.opacity = '0.5';
    }
}

// Sync buttons with current state
chrome.runtime.sendMessage({ action: 'GET_STATUS' }, (response) => {
    if (chrome.runtime.lastError || !response) {
        updateUI(false);
        return;
    }
    updateUI(response.isTranslating);
});

startBtn.addEventListener('click', () => {
    startBtn.disabled = true;
    chrome.runtime.sendMessage({ action: 'START' }, (response) => {
        if (response && response.status === 'STARTED') {
            updateUI(true);
        } else {
            updateUI(false);
            if (response && response.error) alert(response.error);
        }
    });
});

stopBtn.addEventListener('click', () => {
    stopBtn.disabled = true;
    chrome.runtime.sendMessage({ action: 'STOP' }, () => {
        updateUI(false);
    });
});
