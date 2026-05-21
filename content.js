// AuraTranslate - Content Script
(function() {
  // Prevent double injection
  if (window.__auraTranslateInjected) return;
  window.__auraTranslateInjected = true;

  // Configuration State
  let isEnabled = false;
  let sourceLang = 'auto';
  let targetLang = 'en';
  let hoverOriginal = true;
  
  // Translation stats for the current tab
  let translatedCount = 0;
  
  // DOM Tracking
  let observer = null;
  let translationQueue = [];
  let queueTimeout = null;
  let isProcessingQueue = false;

  // Stored references of translated nodes to enable instant restoration
  // We use a WeakSet to track nodes that are currently translated
  const translatedNodes = new WeakMap(); // Map<TextNode, {original: string, translated: string}>

  // Custom CSS injection for translated text styling
  const styleElement = document.createElement('style');
  styleElement.id = 'aura-translate-styles';
  styleElement.textContent = `
    [data-aura-translated="true"] {
      text-decoration: underline dotted rgba(10, 132, 255, 0.3) !important;
      text-underline-offset: 3px !important;
      transition: text-decoration-color 0.2s !important;
    }
    [data-aura-translated="true"]:hover {
      text-decoration-color: rgba(10, 132, 255, 0.85) !important;
    }
  `;

  // Initialize content script
  init();

  function init() {
    // Inject custom styles
    document.documentElement.appendChild(styleElement);

    // Get configuration from storage and check if auto-translate is enabled for this domain
    const domain = window.location.hostname;
    chrome.storage.local.get([
      'sourceLang',
      'targetLang',
      'autoTranslate',
      'hoverOriginal',
      `auto_${domain}`
    ], (data) => {
      if (data.sourceLang) sourceLang = data.sourceLang;
      if (data.targetLang) targetLang = data.targetLang;
      if (data.hoverOriginal !== undefined) hoverOriginal = data.hoverOriginal;
      
      const isAutoForDomain = data[`auto_${domain}`] || false;
      const isGlobalAuto = data.autoTranslate || false;

      // Start translation if either site-specific or global auto-translate is enabled
      if (isAutoForDomain || isGlobalAuto) {
        enableTranslation();
      } else {
        reportTabState();
      }
    });

    // Message receiver from popup or background script
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'enableTranslation') {
        sourceLang = request.sourceLang || sourceLang;
        targetLang = request.targetLang || targetLang;
        hoverOriginal = request.hoverOriginal !== undefined ? request.hoverOriginal : hoverOriginal;
        
        enableTranslation(request.force);
        sendResponse({ success: true });
      } 
      else if (request.action === 'disableTranslation') {
        disableTranslation();
        sendResponse({ success: true });
      }
      else if (request.action === 'settingsChanged') {
        const settings = request.settings;
        sourceLang = settings.sourceLang || sourceLang;
        targetLang = settings.targetLang || targetLang;
        
        const oldHover = hoverOriginal;
        hoverOriginal = settings.hoverOriginal !== undefined ? settings.hoverOriginal : hoverOriginal;
        
        if (isEnabled) {
          // If translation is active, adjust hover styles or languages dynamically
          if (oldHover !== hoverOriginal) {
            updateHoverTooltips();
          }
          // Re-translate page if target language changed
          if (settings.targetLang !== targetLang || settings.sourceLang !== sourceLang) {
            disableTranslation();
            enableTranslation(true);
          }
        }
        sendResponse({ success: true });
      }
      else if (request.action === 'getTabState') {
        sendResponse({
          enabled: isEnabled,
          translatedCount: translatedCount,
          status: isProcessingQueue ? 'translating' : 'ready'
        });
      }
    });
  }

  // Reports tab status back to popup
  function reportTabState(status = 'ready') {
    chrome.runtime.sendMessage({
      action: 'tabStateUpdated',
      state: {
        enabled: isEnabled,
        translatedCount: translatedCount,
        status: status
      }
    }).catch(() => {
      // Ignore errors when popup is closed
    });

    // Also store in local storage so popup can read it even if loaded after status changes
    chrome.tabs?.getCurrent?.((tab) => {
      if (tab) {
        chrome.storage.local.set({
          [`tabState_${tab.id}`]: { enabled: isEnabled, translatedCount, status }
        });
      }
    });
  }

  // Turn translation on
  function enableTranslation(force = false) {
    if (isEnabled && !force) return;
    
    isEnabled = true;
    reportTabState('translating');

    // Safety: If document.body is not ready yet, wait for DOMContentLoaded
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => {
        if (isEnabled && document.body) {
          scanAndTranslateDOM(document.body);
          setupMutationObserver();
        }
      }, { once: true });
    } else {
      scanAndTranslateDOM(document.body);
      setupMutationObserver();
    }
  }

  // Turn translation off (Restore original texts)
  function disableTranslation() {
    if (!isEnabled) return;
    
    isEnabled = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    
    // Clear translation queue
    translationQueue = [];
    if (queueTimeout) {
      clearTimeout(queueTimeout);
      queueTimeout = null;
    }

    // Walk the entire document to restore original values
    restoreOriginalDOM();
    
    translatedCount = 0;
    reportTabState('ready');
  }

  // Setup MutationObserver for dynamic page components
  function setupMutationObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver((mutations) => {
      if (!isEnabled) return;
      
      let addedNodesDetected = false;
      
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            queueNodeForTranslation(node);
            addedNodesDetected = true;
          } else if (node.nodeType === Node.TEXT_NODE) {
            if (shouldTranslateNode(node)) {
              queueTextNode(node);
              addedNodesDetected = true;
            }
          }
        }
        
        // Also check if text content of existing text node was changed
        if (mutation.type === 'characterData' && mutation.target.nodeType === Node.TEXT_NODE) {
          const textNode = mutation.target;
          if (shouldTranslateNode(textNode)) {
            queueTextNode(textNode);
            addedNodesDetected = true;
          }
        }
      }

      if (addedNodesDetected) {
        triggerQueueProcessing();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // Scans element tree and queues relevant text nodes
  function scanAndTranslateDOM(root) {
    if (!root) return;
    queueNodeForTranslation(root);
    processQueueImmediately();
  }

  // Determines if a text node should be translated
  function shouldTranslateNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    const parent = node.parentElement;
    if (!parent) return false;
    
    const tag = parent.tagName.toLowerCase();
    if (['script', 'style', 'code', 'pre', 'textarea', 'input', 'noscript'].includes(tag)) {
      return false;
    }

    const textVal = node.nodeValue;
    if (!textVal || !textVal.trim()) {
      return false;
    }

    // Skip numbers and symbols
    if (/^[0-9\s\p{P}\p{S}]+$/u.test(textVal)) {
      return false;
    }

    // If source language is Chinese, verify it contains Chinese characters
    if ((sourceLang === 'auto' || sourceLang.startsWith('zh')) && !/[\u4e00-\u9fa5]/.test(textVal)) {
      return false;
    }

    // Already translated node? Check if it has the same text value
    const info = translatedNodes.get(node);
    if (info && info.translated === textVal) {
      return false;
    }

    return true;
  }

  // Traverse DOM and find all target text nodes under an element
  function queueNodeForTranslation(element) {
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          return shouldTranslateNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }
    );

    let node;
    while (node = walker.nextNode()) {
      queueTextNode(node);
    }
  }

  // Queues a single text node
  function queueTextNode(node) {
    if (!translationQueue.includes(node)) {
      translationQueue.push(node);
    }
  }

  // Trigger processing with debounce to batch requests
  function triggerQueueProcessing() {
    if (queueTimeout) clearTimeout(queueTimeout);
    queueTimeout = setTimeout(() => {
      processQueueImmediately();
    }, 80); // 80ms batching delay for instant feedback
  }

  // Process the translation queue
  async function processQueueImmediately() {
    if (isProcessingQueue || translationQueue.length === 0) return;
    
    isProcessingQueue = true;
    reportTabState('translating');

    // Retrieve nodes from queue
    const batchNodes = [...translationQueue];
    translationQueue = [];

    // Extract texts to translate
    const textsToTranslate = batchNodes.map(node => node.nodeValue);

    if (textsToTranslate.length === 0) {
      isProcessingQueue = false;
      reportTabState('ready');
      return;
    }

    try {
      // Send translation batch request to background service worker
      chrome.runtime.sendMessage({
        action: 'translateBatch',
        texts: textsToTranslate,
        sourceLang: sourceLang,
        targetLang: targetLang
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error("AuraTranslate runtime communication error:", chrome.runtime.lastError);
          isProcessingQueue = false;
          reportTabState('ready');
          return;
        }

        if (response && response.success && response.translations) {
          applyTranslations(batchNodes, response.translations);
        } else {
          console.error("Translation batch request failed:", response ? response.error : 'No response');
        }

        isProcessingQueue = false;
        reportTabState('ready');
      });
    } catch (err) {
      console.error("Error sending message to background script:", err);
      isProcessingQueue = false;
      reportTabState('ready');
    }
  }

  // Apply translated text back to the DOM nodes
  function applyTranslations(nodes, translations) {
    nodes.forEach((node, idx) => {
      const originalText = node.nodeValue;
      const translatedText = translations[idx];
      
      if (!translatedText || translatedText === originalText) {
        return; // No translation or matching text
      }

      // Store node mapping
      translatedNodes.set(node, { original: originalText, translated: translatedText });

      // Safely apply translation to nodeValue (prevents React crashes)
      node.nodeValue = translatedText;
      translatedCount++;

      // Update parent element attributes for hover/tooltip features
      const parent = node.parentElement;
      if (parent) {
        parent.setAttribute('data-aura-translated', 'true');
        parent.setAttribute('data-aura-original', originalText);
        
        if (hoverOriginal) {
          parent.setAttribute('title', `Original: ${originalText}`);
          parent.setAttribute('data-aura-title-added', 'true');
        }
      }
    });

    // Update stats
    reportTabState('ready');
  }

  // Updates tooltips when hover setting changes dynamically
  function updateHoverTooltips() {
    const elements = document.querySelectorAll('[data-aura-translated="true"]');
    elements.forEach(el => {
      const originalText = el.getAttribute('data-aura-original');
      if (hoverOriginal) {
        if (originalText) {
          el.setAttribute('title', `Original: ${originalText}`);
          el.setAttribute('data-aura-title-added', 'true');
        }
      } else {
        if (el.getAttribute('data-aura-title-added') === 'true') {
          el.removeAttribute('title');
          el.removeAttribute('data-aura-title-added');
        }
      }
    });
  }

  // Reverts all text node modifications and cleans up parent attributes
  function restoreOriginalDOM() {
    const elements = document.querySelectorAll('[data-aura-translated="true"]');
    elements.forEach(el => {
      // Find all text node children
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        const info = translatedNodes.get(node);
        if (info) {
          node.nodeValue = info.original;
          translatedNodes.delete(node);
        }
      }
      
      // Remove wrapper attributes
      el.removeAttribute('data-aura-translated');
      el.removeAttribute('data-aura-original');
      if (el.getAttribute('data-aura-title-added') === 'true') {
        el.removeAttribute('title');
        el.removeAttribute('data-aura-title-added');
      }
    });
  }
})();
