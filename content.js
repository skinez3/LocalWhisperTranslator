if (!window.__aiTranslatorInjected) {
    window.__aiTranslatorInjected = true;

    // Build draggable sidebar
    window.createTranslationSidebar = function () {
        const container = document.createElement('div');
        container.id = 'ai-translator-sidebar';
        container.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            width: 300px;
            height: 400px;
            background: rgba(0, 0, 0, 0.85);
            color: white;
            border: 1px solid #444;
            border-radius: 8px;
            z-index: 2147483647;
            display: flex;
            flex-direction: column;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            resize: both;
            overflow: hidden;
            font-family: Arial, sans-serif;
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            background: #333;
            padding: 10px;
            cursor: move;
            font-weight: bold;
            user-select: none;
            border-bottom: 1px solid #555;
            display: flex;
            justify-content: space-between; 
            align-items: center;
        `;

        const title = document.createElement('span');
        title.innerText = 'Translation (History) ✥';

        const closeBtn = document.createElement('span');
        closeBtn.innerText = '✖';
        closeBtn.title = "Stop translation";
        closeBtn.style.cssText = `
            cursor: pointer;
            color: #ff5555;
            font-size: 16px;
            padding: 0 5px;
            line-height: 1;
        `;
        closeBtn.onclick = () => {
            chrome.runtime.sendMessage({ action: 'STOP' });
        };

        header.appendChild(title);
        header.appendChild(closeBtn);

        const historyArea = document.createElement('div');
        historyArea.id = 'ai-translator-history';
        historyArea.style.cssText = `
            flex-grow: 1;
            padding: 10px;
            overflow-y: auto;
            font-size: 16px;
            line-height: 1.4;
        `;

        const statusMsg = document.createElement('div');
        statusMsg.id = 'ai-translator-status';
        statusMsg.style.cssText = 'font-size: 13px; color: #ff9800; font-style: italic; text-align: center; margin-top: 15px;';
        statusMsg.innerText = '⏳ Loading Whisper model weights...';
        historyArea.appendChild(statusMsg);

        container.appendChild(header);
        container.appendChild(historyArea);
        document.body.appendChild(container);

        // Drag logic
        let isDragging = false;
        let offsetX, offsetY;

        header.addEventListener('mousedown', (e) => {
            if (e.target === closeBtn) return;
            isDragging = true;
            offsetX = e.clientX - container.getBoundingClientRect().left;
            offsetY = e.clientY - container.getBoundingClientRect().top;
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            container.style.left = (e.clientX - offsetX) + 'px';
            container.style.top = (e.clientY - offsetY) + 'px';
            container.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });

        return historyArea;
    }

    // Add new subtitle row
    window.appendOriginal = function (msgId, originalText) {
        const statusMsg = document.getElementById('ai-translator-status');
        if (statusMsg) statusMsg.remove();

        const itemElement = document.createElement('div');
        itemElement.style.cssText = 'margin-bottom: 12px; border-bottom: 1px solid #444; padding-bottom: 8px; display: flex; flex-direction: column; gap: 4px;';

        const originalDiv = document.createElement('div');
        originalDiv.style.cssText = 'font-size: 13px; color: #a0a0a0; font-style: italic;';
        originalDiv.innerText = originalText;

        const translatedDiv = document.createElement('div');
        translatedDiv.id = `trans-text-${msgId}`;
        translatedDiv.style.cssText = 'font-size: 15px; color: #ff9800; font-style: italic;';
        translatedDiv.innerText = '⏳ Translating...';

        itemElement.appendChild(originalDiv);
        itemElement.appendChild(translatedDiv);

        window.historyContainer.appendChild(itemElement);
        window.historyContainer.scrollTop = window.historyContainer.scrollHeight;
    }

    // Fill in translated text
    window.updateTranslation = function (msgId, translatedText) {
        const translatedDiv = document.getElementById(`trans-text-${msgId}`);
        if (translatedDiv) {
            translatedDiv.style.cssText = 'font-size: 16px; color: #ffffff; font-style: normal;';
            translatedDiv.innerText = translatedText;
        }
    }

    // Handle messages from background
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'MODEL_LOADING') {
            const statusMsg = document.getElementById('ai-translator-status');
            if (statusMsg) {
                statusMsg.style.color = '#ff9800';
                statusMsg.innerText = '⏳ Reloading Whisper model...';
            }
        }
        if (message.action === 'MODEL_READY') {
            const statusMsg = document.getElementById('ai-translator-status');
            if (statusMsg) {
                statusMsg.style.color = '#4CAF50';
                statusMsg.innerText = '✅ Model is ready. Waiting for speech...';
            }
        }
        if (message.action === 'MODEL_ERROR') {
            const statusMsg = document.getElementById('ai-translator-status');
            if (statusMsg) {
                statusMsg.style.color = '#ff5555';
                statusMsg.innerText = `❌ Model error: ${message.error}`;
            }
        }
        if (message.action === 'SHOW_ORIGINAL') {
            window.appendOriginal(message.msgId, message.original);
        }
        if (message.action === 'UPDATE_TRANSLATION') {
            window.updateTranslation(message.msgId, message.translated);
        }
        if (message.action === 'HIDE_UI') {
            const sidebar = document.getElementById('ai-translator-sidebar');
            if (sidebar) sidebar.remove();
        }
    });
}

// Create sidebar once
if (!document.getElementById('ai-translator-sidebar')) {
    window.historyContainer = window.createTranslationSidebar();
}