document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const powerBtn = document.getElementById('powerBtn');
  const statusCard = document.getElementById('statusCard');
  const statusText = document.getElementById('statusText');
  const statusDesc = document.getElementById('statusDesc');
  const sourceLangSelect = document.getElementById('sourceLang');
  const targetLangSelect = document.getElementById('targetLang');
  const swapLangsBtn = document.getElementById('swapLangs');
  const autoTranslateCheck = document.getElementById('autoTranslate');
  const hoverOriginalCheck = document.getElementById('hoverOriginal');
  const statTranslatedVal = document.getElementById('statTranslated');
  const statCachedVal = document.getElementById('statCached');
  const translateBtn = document.getElementById('translateBtn');
  const resetBtn = document.getElementById('resetBtn');

  let activeTab = null;

  // Initialize and load saved options
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];
  } catch (err) {
    console.error("Error getting active tab:", err);
  }

  // Load global configurations
  chrome.storage.local.get(['sourceLang', 'targetLang', 'autoTranslate', 'hoverOriginal'], (data) => {
    if (data.sourceLang) sourceLangSelect.value = data.sourceLang;
    if (data.targetLang) targetLangSelect.value = data.targetLang;
    if (data.autoTranslate !== undefined) autoTranslateCheck.checked = data.autoTranslate;
    if (data.hoverOriginal !== undefined) hoverOriginalCheck.checked = data.hoverOriginal;
    
    updateCacheStats();
  });

  function updateCacheStats() {
    chrome.runtime.sendMessage({ action: 'getCacheStats' }, (response) => {
      if (response && response.success) {
        statCachedVal.textContent = response.translationCount;
      } else {
        statCachedVal.textContent = '0';
      }
    });
  }

  // Load current tab state if available
  if (activeTab && activeTab.url) {
    const isSystemPage = activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('edge://') || activeTab.url.startsWith('about:');
    
    if (isSystemPage) {
      statusCard.className = 'status-card';
      statusText.textContent = 'Unsupported Page';
      statusDesc.textContent = 'Extension cannot run on browser system pages';
      powerBtn.disabled = true;
      translateBtn.disabled = true;
      resetBtn.disabled = true;
      return;
    }

    const cleanUrl = new URL(activeTab.url);
    const domain = cleanUrl.hostname;

    // Check if auto-translate is configured for this domain
    chrome.storage.local.get([`auto_${domain}`, `tabState_${activeTab.id}`], (data) => {
      const isAutoForDomain = data[`auto_${domain}`] || false;
      const tabState = data[`tabState_${activeTab.id}`] || { enabled: false, translatedCount: 0, status: 'ready' };
      
      updateUIStatus(tabState.enabled, tabState.status, tabState.translatedCount);
    });
  } else {
    // No active tab or access
    statusText.textContent = 'No Webpage Found';
    statusDesc.textContent = 'Open a website to translate it';
    powerBtn.disabled = true;
  }

  // Helper to update the UI elements based on state
  function updateUIStatus(enabled, status, count = 0) {
    statTranslatedVal.textContent = count;
    
    if (enabled) {
      powerBtn.classList.add('active');
      statusCard.className = 'status-card active';
      
      if (status === 'translating') {
        statusCard.className = 'status-card translating';
        statusText.textContent = 'Translating...';
        statusDesc.textContent = 'Replacing page elements with translated text';
      } else {
        statusText.textContent = 'Page Translated';
        statusDesc.textContent = `Successfully translated ${count} elements`;
      }
    } else {
      powerBtn.classList.remove('active');
      statusCard.className = 'status-card';
      statusText.textContent = 'Translation Off';
      statusDesc.textContent = 'Tap power button or Translate Page below';
    }
  }

  // Resilient wrapper to send messages to content script, auto-injecting if not present
  async function sendMessageToTab(message) {
    if (!activeTab || !activeTab.id) return;
    try {
      return await chrome.tabs.sendMessage(activeTab.id, message);
    } catch (err) {
      if (err.message && (err.message.includes('Could not establish connection') || err.message.includes('Receiving end does not exist'))) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            files: ['content.js']
          });
          // Small delay to ensure content.js parses and registers its listener
          await new Promise(r => setTimeout(r, 100));
          return await chrome.tabs.sendMessage(activeTab.id, message);
        } catch (injectErr) {
          console.error("Content script auto-injection failed:", injectErr);
          throw err;
        }
      }
      throw err;
    }
  }

  // Monitor for tab state updates from the content script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'tabStateUpdated' && activeTab && sender.tab && sender.tab.id === activeTab.id) {
      updateUIStatus(message.state.enabled, message.state.status, message.state.translatedCount);
    }
  });

  // Toggle power button (Directly enables / disables translation)
  powerBtn.addEventListener('click', async () => {
    if (!activeTab) return;
    
    const isCurrentlyActive = powerBtn.classList.contains('active');
    const action = isCurrentlyActive ? 'disableTranslation' : 'enableTranslation';
    
    updateUIStatus(!isCurrentlyActive, isCurrentlyActive ? 'ready' : 'translating');
    
    try {
      await sendMessageToTab({
        action: action,
        sourceLang: sourceLangSelect.value,
        targetLang: targetLangSelect.value,
        hoverOriginal: hoverOriginalCheck.checked
      });
    } catch (err) {
      console.error("Failed to send message to tab content script:", err);
      statusText.textContent = 'Error';
      statusDesc.textContent = 'Try refreshing the page and trying again';
    }
  });

  // Translate page button
  translateBtn.addEventListener('click', async () => {
    if (!activeTab) return;
    
    updateUIStatus(true, 'translating');
    
    try {
      await sendMessageToTab({
        action: 'enableTranslation',
        sourceLang: sourceLangSelect.value,
        targetLang: targetLangSelect.value,
        hoverOriginal: hoverOriginalCheck.checked,
        force: true
      });
    } catch (err) {
      console.error(err);
      statusText.textContent = 'Error';
      statusDesc.textContent = 'Try refreshing the page and trying again';
    }
  });

  // Restore original button
  resetBtn.addEventListener('click', async () => {
    if (!activeTab) return;
    
    updateUIStatus(false, 'ready');
    
    try {
      await sendMessageToTab({ action: 'disableTranslation' });
    } catch (err) {
      console.error(err);
    }
  });

  // Swap Languages
  swapLangsBtn.addEventListener('click', () => {
    const src = sourceLangSelect.value;
    const tgt = targetLangSelect.value;
    
    if (src === 'auto') {
      // Cannot swap "auto" directly, default to English as source if swapped
      sourceLangSelect.value = tgt;
      targetLangSelect.value = 'zh-CN';
    } else {
      sourceLangSelect.value = tgt;
      targetLangSelect.value = src;
    }
    
    saveSettings();
  });

  // Save Settings when changed
  function saveSettings() {
    chrome.storage.local.set({
      sourceLang: sourceLangSelect.value,
      targetLang: targetLangSelect.value,
      autoTranslate: autoTranslateCheck.checked,
      hoverOriginal: hoverOriginalCheck.checked
    });
    
    // Notify active tab about configuration changes (e.g. if hover option changed)
    if (activeTab) {
      sendMessageToTab({
        action: 'settingsChanged',
        settings: {
          sourceLang: sourceLangSelect.value,
          targetLang: targetLangSelect.value,
          autoTranslate: autoTranslateCheck.checked,
          hoverOriginal: hoverOriginalCheck.checked
        }
      }).catch(() => {});
    }
  }

  sourceLangSelect.addEventListener('change', saveSettings);
  targetLangSelect.addEventListener('change', saveSettings);
  autoTranslateCheck.addEventListener('change', () => {
    saveSettings();
    if (activeTab && activeTab.url) {
      const cleanUrl = new URL(activeTab.url);
      const domain = cleanUrl.hostname;
      // Save domain-specific auto-translate setting
      chrome.storage.local.set({
        [`auto_${domain}`]: autoTranslateCheck.checked
      });
    }
  });
  hoverOriginalCheck.addEventListener('change', saveSettings);
});
