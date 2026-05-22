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

  // Tab elements
  const tabBtnTranslate = document.getElementById('tabBtnTranslate');
  const tabBtnPhrasebook = document.getElementById('tabBtnPhrasebook');
  const panelTranslate = document.getElementById('panelTranslate');
  const panelPhrasebook = document.getElementById('panelPhrasebook');
  const phraseList = document.getElementById('phraseList');
  const clearStarredBtn = document.getElementById('clearStarredBtn');

  // Tab switching
  tabBtnTranslate.addEventListener('click', () => {
    tabBtnTranslate.classList.add('active');
    tabBtnPhrasebook.classList.remove('active');
    panelTranslate.classList.add('active');
    panelPhrasebook.classList.remove('active');
    updateCacheStats();
  });

  tabBtnPhrasebook.addEventListener('click', () => {
    tabBtnPhrasebook.classList.add('active');
    tabBtnTranslate.classList.remove('active');
    panelPhrasebook.classList.add('active');
    panelTranslate.classList.remove('active');
    loadStarredPhrases();
  });

  // Load and render starred phrases
  function loadStarredPhrases() {
    chrome.runtime.sendMessage({ action: 'getStarred' }, (response) => {
      if (response && response.success && response.phrases && response.phrases.length > 0) {
        renderPhraseList(response.phrases);
      } else {
        renderEmptyState();
      }
    });
  }

  function renderEmptyState() {
    phraseList.innerHTML = '';
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    emptyState.textContent = 'No saved phrases yet. Highlight text on a page to star and save translations.';
    phraseList.appendChild(emptyState);
  }

  function renderPhraseList(phrases) {
    phraseList.innerHTML = '';
    
    // Sort phrases: newest first
    phrases.sort((a, b) => b.timestamp - a.timestamp);

    phrases.forEach((phrase) => {
      const item = document.createElement('div');
      item.className = 'phrase-item';
      
      const origText = phrase.originalText || '';
      const transText = phrase.translatedText || '';

      const textGroup = document.createElement('div');
      textGroup.className = 'phrase-text-group';

      const origDiv = document.createElement('div');
      origDiv.className = 'phrase-orig';
      origDiv.textContent = origText;
      origDiv.title = origText;

      const transDiv = document.createElement('div');
      transDiv.className = 'phrase-trans';
      transDiv.textContent = transText;
      transDiv.title = transText;

      textGroup.appendChild(origDiv);
      textGroup.appendChild(transDiv);

      const actionsGroup = document.createElement('div');
      actionsGroup.className = 'phrase-actions';

      // Copy Button
      const copyBtn = document.createElement('button');
      copyBtn.className = 'phrase-btn';
      copyBtn.title = 'Copy Translation';
      copyBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.0">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      `;
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(transText).then(() => {
          // Success Feedback animation
          copyBtn.style.color = 'var(--success)';
          copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          `;
          setTimeout(() => {
            copyBtn.style.color = '';
            copyBtn.innerHTML = `
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.0">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            `;
          }, 1500);
        }).catch((err) => {
          console.error('Failed to copy text: ', err);
        });
      });

      // Delete Button
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'phrase-btn delete';
      deleteBtn.title = 'Delete';
      deleteBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.0">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      `;
      deleteBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({
          action: 'removeStarred',
          originalText: origText
        }, (res) => {
          if (res && res.success) {
            // Animating item removal
            item.style.opacity = '0';
            item.style.transform = 'scale(0.95)';
            item.style.transition = 'opacity 0.2s, transform 0.2s';
            setTimeout(() => {
              loadStarredPhrases();
            }, 200);
          } else {
            console.error('Failed to remove starred phrase:', res ? res.error : 'No response');
          }
        });
      });

      actionsGroup.appendChild(copyBtn);
      actionsGroup.appendChild(deleteBtn);

      item.appendChild(textGroup);
      item.appendChild(actionsGroup);
      phraseList.appendChild(item);
    });
  }

  // Clear all starred phrases
  clearStarredBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear all saved phrases?')) {
      chrome.runtime.sendMessage({ action: 'clearStarred' }, (response) => {
        if (response && response.success) {
          loadStarredPhrases();
        } else {
          console.error('Failed to clear starred phrases:', response ? response.error : 'No response');
        }
      });
    }
  });
});
