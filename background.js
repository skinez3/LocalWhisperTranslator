chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (message.action === 'START') {
        handleStart()
            .then(() => sendResponse({ status: 'STARTED' }))
            .catch(err => sendResponse({ status: 'ERROR', error: err.message }));
        return true;
    }

    if (message.action === 'STOP') {
        handleStop()
            .then(() => sendResponse({ status: 'STOPPED' }))
            .catch(err => sendResponse({ status: 'ERROR', error: err.message }));
        return true;
    }

    if (message.action === 'GET_STATUS') {
        chrome.storage.local.get(['isTranslating'], (res) => {
            sendResponse({ isTranslating: !!res.isTranslating });
        });
        return true;
    }

    // Relay subtitles from offscreen to the tab
    if (message.action === 'RELAY_ORIGINAL' || message.action === 'RELAY_TRANSLATED') {
        if (message.tabId) {
            chrome.tabs.sendMessage(message.tabId, {
                action: message.action === 'RELAY_ORIGINAL' ? 'SHOW_ORIGINAL' : 'UPDATE_TRANSLATION',
                msgId: message.msgId,
                original: message.original,
                translated: message.translated
            }).catch(() => { });
        }
    }

    // Relay model status to the tab
    if (message.action === 'MODEL_READY' || message.action === 'MODEL_ERROR' || message.action === 'MODEL_LOADING') {
        if (message.tabId) {
            chrome.tabs.sendMessage(message.tabId, {
                action: message.action,
                error: message.error
            }).catch(() => { });
        }
    }
});

async function handleStart() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
        throw new Error('Open a standard tab (e.g., YouTube) for translation!');
    }

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

    if (!(await chrome.offscreen.hasDocument())) {
        await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['USER_MEDIA'],
            justification: 'Tab audio capture and local Whisper execution'
        });
        // Wait for the offscreen page to load
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
    });

    await chrome.storage.local.set({ isTranslating: true, activeTabId: tab.id });

    const settings = await chrome.storage.local.get(['modelSize', 'sourceLang', 'targetLang']);

    chrome.runtime.sendMessage({
        action: 'INIT_CAPTURE_AND_WHISPER',
        streamId: streamId,
        tabId: tab.id,
        settings: settings
    }).catch(err => console.error('INIT_CAPTURE send error:', err));
}

async function handleStop() {
    try {
        await chrome.runtime.sendMessage({ action: 'STOP_CAPTURE' }).catch(() => { });
    } catch (e) { }

    if (await chrome.offscreen.hasDocument()) {
        await chrome.offscreen.closeDocument();
    }

    const { activeTabId } = await chrome.storage.local.get('activeTabId');
    if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, { action: 'HIDE_UI' }).catch(() => { });
    }

    await chrome.storage.local.set({ isTranslating: false, activeTabId: null });
}

// Forward settings changes to the offscreen document
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        const newSettings = {};
        if (changes.modelSize) newSettings.modelSize = changes.modelSize.newValue;
        if (changes.sourceLang) newSettings.sourceLang = changes.sourceLang.newValue;
        if (changes.targetLang) newSettings.targetLang = changes.targetLang.newValue;

        if (Object.keys(newSettings).length > 0) {
            chrome.runtime.sendMessage({
                action: 'UPDATE_SETTINGS',
                settings: newSettings
            }).catch(() => { });
        }
    }
});
