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
  let bilingualMode = false;
  let showTooltip = true;
  
  // Translation stats for the current tab
  let translatedCount = 0;
  
  // DOM Tracking & Viewport Observer
  let observer = null;
  let viewportObserver = null;
  const observedElements = new WeakSet();
  let pendingTranslationQueue = [];
  let activeTranslationQueue = [];
  let queueTimeout = null;
  let isProcessingQueue = false;

  // Stored references of translated nodes to enable instant restoration
  // We use a WeakMap to track nodes that are currently translated
  let translatedNodes = new WeakMap(); // Map<TextNode, {original: string, translated: string}>

  // Custom CSS injection for translated text styling and highlight tooltip
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
    .aura-tooltip-container {
      position: absolute;
      z-index: 2147483647;
      background: #1c1c1e;
      color: #f5f5f7;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 16px;
      padding: 10px 14px;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 230px;
      max-width: 320px;
      opacity: 0;
      transform: translateY(6px) scale(0.98);
      transition: opacity 0.15s ease, transform 0.15s ease;
      pointer-events: auto;
      text-align: left;
    }
    .aura-tooltip-container.show {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
    .aura-tooltip-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding-bottom: 6px;
    }
    .aura-tooltip-btn {
      background: rgba(255, 255, 255, 0.06);
      border: none;
      color: #f5f5f7;
      border-radius: 8px;
      padding: 5px 9px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
      transition: background 0.1s, transform 0.1s;
    }
    .aura-tooltip-btn:hover {
      background: rgba(255, 255, 255, 0.12);
    }
    .aura-tooltip-btn:active {
      transform: scale(0.96);
    }
    .aura-tooltip-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .aura-tooltip-btn.primary {
      background: #0a84ff;
      color: #ffffff;
    }
    .aura-tooltip-btn.primary:hover {
      background: #2997ff;
    }
    .aura-tooltip-btn.starred {
      color: #ffd60a;
    }
    .aura-tooltip-result {
      font-size: 12px;
      color: #e5e5ea;
      line-height: 1.45;
      word-break: break-word;
      user-select: text;
    }
    .aura-bilingual-line {
      display: block;
      font-size: 0.88em;
      line-height: 1.5;
      color: #5aadff;
      font-style: italic;
      margin-top: 2px;
      padding: 2px 0;
      opacity: 0.92;
      border-left: 2px solid rgba(10, 132, 255, 0.4);
      padding-left: 6px;
      font-family: inherit;
      pointer-events: none;
      transition: opacity 0.2s ease;
    }
    [data-aura-translated="true"]:hover .aura-bilingual-line {
      opacity: 1;
    }
  `;

  // Initialize content script
  init();

  function init() {
    // Inject custom styles
    document.documentElement.appendChild(styleElement);

    // Set up highlight tooltip selection listener
    setupSelectionListener();

    // Get configuration from storage and check if auto-translate is enabled for this domain
    const domain = window.location.hostname;
    chrome.storage.local.get([
      'sourceLang',
      'targetLang',
      'autoTranslate',
      'bilingualMode',
      'hoverOriginal',
      'showTooltip',
      `auto_${domain}`
    ], (data) => {
      if (data.sourceLang) sourceLang = data.sourceLang;
      if (data.targetLang) targetLang = data.targetLang;
      if (data.hoverOriginal !== undefined) hoverOriginal = data.hoverOriginal;
      if (data.bilingualMode !== undefined) bilingualMode = data.bilingualMode;
      if (data.showTooltip !== undefined) showTooltip = data.showTooltip;
      
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
        bilingualMode = request.bilingualMode !== undefined ? request.bilingualMode : bilingualMode;
        
        enableTranslation(request.force);
        sendResponse({ success: true });
      } 
      else if (request.action === 'disableTranslation') {
        disableTranslation();
        sendResponse({ success: true });
      }
      else if (request.action === 'settingsChanged') {
        const settings = request.settings;
        const oldSourceLang = sourceLang;
        const oldTargetLang = targetLang;
        const oldBilingualMode = bilingualMode;
        sourceLang = settings.sourceLang || sourceLang;
        targetLang = settings.targetLang || targetLang;
        
        const oldHover = hoverOriginal;
        hoverOriginal = settings.hoverOriginal !== undefined ? settings.hoverOriginal : hoverOriginal;
        bilingualMode = settings.bilingualMode !== undefined ? settings.bilingualMode : bilingualMode;
        showTooltip = settings.showTooltip !== undefined ? settings.showTooltip : showTooltip;
        
        const langOrModeChanged = (oldTargetLang !== targetLang || oldSourceLang !== sourceLang || oldBilingualMode !== bilingualMode);
        if (langOrModeChanged) {
          translatedNodes = new WeakMap();
        }

        if (isEnabled) {
          // If translation is active, adjust hover styles or languages dynamically
          if (oldHover !== hoverOriginal) {
            updateHoverTooltips();
          }
          // Re-translate page if source/target language or bilingual mode changed
          if (langOrModeChanged) {
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
  }

  // Turn translation on
  function enableTranslation(force = false) {
    if (isEnabled && !force) return;
    
    if (force) {
      translatedNodes = new WeakMap();
    }
    
    isEnabled = true;
    reportTabState('translating');

    // Initialize viewport IntersectionObserver
    initViewportObserver();

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

    if (viewportObserver) {
      viewportObserver.disconnect();
      viewportObserver = null;
    }
    
    // Clear translation queues
    pendingTranslationQueue = [];
    activeTranslationQueue = [];
    if (queueTimeout) {
      clearTimeout(queueTimeout);
      queueTimeout = null;
    }

    // Walk the entire document to restore original values
    restoreOriginalDOM();
    
    translatedCount = 0;
    reportTabState('ready');
  }

  // Initialize Viewport IntersectionObserver
  function initViewportObserver() {
    if (viewportObserver) return;
    
    viewportObserver = new IntersectionObserver((entries) => {
      let needsProcessing = false;
      
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const element = entry.target;
          viewportObserver.unobserve(element);
          
          // Move matching text nodes under this parent to active queue
          const textNodes = findQueuedTextNodesUnder(element);
          if (textNodes.length > 0) {
            textNodes.forEach(node => {
              if (!activeTranslationQueue.includes(node)) {
                activeTranslationQueue.push(node);
              }
              const pIdx = pendingTranslationQueue.indexOf(node);
              if (pIdx > -1) {
                pendingTranslationQueue.splice(pIdx, 1);
              }
            });
            needsProcessing = true;
          }
        }
      });
      
      if (needsProcessing) {
        triggerActiveQueueProcessing();
      }
    }, {
      rootMargin: '120px 0px 120px 0px' // pre-translate slightly offscreen for smoothness
    });
  }

  // Find all pending text nodes that belong to this observed element
  function findQueuedTextNodesUnder(element) {
    return pendingTranslationQueue.filter(node => {
      return node.parentElement && element.contains(node.parentElement);
    });
  }

  // Setup MutationObserver for dynamic page components
  function setupMutationObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver((mutations) => {
      if (!isEnabled) return;
      
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            queueNodeForTranslation(node);
          } else if (node.nodeType === Node.TEXT_NODE) {
            if (shouldTranslateNode(node)) {
              queueTextNode(node);
            }
          }
        }
        
        // Also check if text content of existing text node was changed
        if (mutation.type === 'characterData' && mutation.target.nodeType === Node.TEXT_NODE) {
          const textNode = mutation.target;
          if (shouldTranslateNode(textNode)) {
            queueTextNode(textNode);
          }
        }
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

    // Skip our own bilingual annotation elements to prevent infinite re-translation
    if (parent.hasAttribute('data-aura-bilingual') || parent.closest('[data-aura-bilingual]')) {
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

    // If source language is explicitly set to Chinese, verify it contains Chinese characters
    if (sourceLang.startsWith('zh') && !/[\u4e00-\u9fa5]/.test(textVal)) {
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
    if (activeTranslationQueue.includes(node) || pendingTranslationQueue.includes(node)) {
      return;
    }

    // Check if we have the translation cached in memory for instant restore
    const info = translatedNodes.get(node);
    if (info && info.original === node.nodeValue) {
      applySingleTranslation(node, info);
      return; // Handled instantly, do not queue!
    }

    const parent = node.parentElement;
    if (!parent) {
      activeTranslationQueue.push(node);
      triggerActiveQueueProcessing();
      return;
    }

    // Add to pending queue
    pendingTranslationQueue.push(node);
    
    // Start observing parent
    if (viewportObserver) {
      if (!observedElements.has(parent)) {
        observedElements.add(parent);
        viewportObserver.observe(parent);
      }
    } else {
      // Fallback if observer not set up: translate immediately
      pendingTranslationQueue.pop();
      activeTranslationQueue.push(node);
      triggerActiveQueueProcessing();
    }
  }

  // Trigger processing with debounce to batch requests
  function triggerActiveQueueProcessing() {
    if (queueTimeout) clearTimeout(queueTimeout);
    queueTimeout = setTimeout(() => {
      processQueueImmediately();
    }, 80); // 80ms batching delay for instant feedback
  }

  // Process the translation queue
  async function processQueueImmediately() {
    if (isProcessingQueue || activeTranslationQueue.length === 0) return;
    
    isProcessingQueue = true;
    reportTabState('translating');

    // Retrieve nodes from queue
    const batchNodes = [...activeTranslationQueue];
    activeTranslationQueue = [];

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

  // Apply a single cached translation synchronously
  function applySingleTranslation(node, info) {
    const originalText = info.original;
    const translatedText = info.translated;
    const parent = node.parentElement;

    if (bilingualMode) {
      if (parent) {
        parent.setAttribute('data-aura-translated', 'true');
        parent.setAttribute('data-aura-original', originalText);
        
        // Append bilingual span if it doesn't already exist
        let bilingualSpan = parent.querySelector(':scope > [data-aura-bilingual="true"]');
        if (!bilingualSpan) {
          bilingualSpan = document.createElement('span');
          bilingualSpan.className = 'aura-bilingual-line';
          bilingualSpan.textContent = translatedText;
          bilingualSpan.setAttribute('data-aura-bilingual', 'true');
          parent.appendChild(bilingualSpan);
        }
      }
    } else {
      node.nodeValue = translatedText;
      if (parent) {
        parent.setAttribute('data-aura-translated', 'true');
        parent.setAttribute('data-aura-original', originalText);
        
        if (hoverOriginal) {
          parent.setAttribute('title', `Original: ${originalText}`);
          parent.setAttribute('data-aura-title-added', 'true');
        }
      }
    }
    translatedCount++;
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
      translatedCount++;

      const parent = node.parentElement;

      if (bilingualMode) {
        // Bilingual mode: keep original text, append translation below
        if (parent) {
          parent.setAttribute('data-aura-translated', 'true');
          parent.setAttribute('data-aura-original', originalText);
          
          // Create the bilingual translation annotation
          const bilingualSpan = document.createElement('span');
          bilingualSpan.className = 'aura-bilingual-line';
          bilingualSpan.textContent = translatedText;
          bilingualSpan.setAttribute('data-aura-bilingual', 'true');
          
          // Insert the bilingual annotation after the parent element's content
          parent.appendChild(bilingualSpan);
        }
      } else {
        // Standard mode: replace text
        node.nodeValue = translatedText;

        if (parent) {
          parent.setAttribute('data-aura-translated', 'true');
          parent.setAttribute('data-aura-original', originalText);
          
          if (hoverOriginal) {
            parent.setAttribute('title', `Original: ${originalText}`);
            parent.setAttribute('data-aura-title-added', 'true');
          }
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
    // Remove all bilingual annotation spans first
    const bilingualSpans = document.querySelectorAll('[data-aura-bilingual="true"]');
    bilingualSpans.forEach(span => {
      if (span.parentNode) {
        span.parentNode.removeChild(span);
      }
    });

    const elements = document.querySelectorAll('[data-aura-translated="true"]');
    elements.forEach(el => {
      // Find all text node children and restore originals
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        const info = translatedNodes.get(node);
        if (info) {
          node.nodeValue = info.original;
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

  // Floating Highlight Tooltip UI and Translation Logic
  let activeTooltip = null;

  function setupSelectionListener() {
    document.addEventListener('mouseup', handleSelectionMouseUp);
    document.addEventListener('mousedown', handleSelectionMouseDown);
  }

  function handleSelectionMouseDown(e) {
    if (activeTooltip && !activeTooltip.contains(e.target)) {
      removeTooltip();
    }
  }

  function handleSelectionMouseUp(e) {
    if (!showTooltip) return;
    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection) return;

      const selectedText = selection.toString().trim();
      // Length constraints to prevent showing on accidental clicks/massive selects
      if (selectedText.length < 2 || selectedText.length > 800) {
        return;
      }

      if (activeTooltip && activeTooltip.contains(e.target)) {
        return;
      }

      if (selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      createTooltip(selectedText, rect);
    }, 10);
  }

  function createTooltip(text, selectionRect) {
    removeTooltip();

    const tooltip = document.createElement('div');
    tooltip.className = 'aura-tooltip-container';
    tooltip.innerHTML = `
      <div class="aura-tooltip-actions">
        <button class="aura-tooltip-btn primary" id="aura-btn-trans">🌐 Translate</button>
        <button class="aura-tooltip-btn" id="aura-btn-tts" title="Listen" disabled>🔊 Speak</button>
        <button class="aura-tooltip-btn" id="aura-btn-star" title="Save to Phrasebook" disabled>⭐ Save</button>
      </div>
      <div class="aura-tooltip-result" id="aura-tooltip-res">Select action above</div>
    `;

    document.body.appendChild(tooltip);
    activeTooltip = tooltip;

    const tooltipWidth = 240;
    const tooltipHeight = 75;
    
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const scrollLeft = window.scrollX || document.documentElement.scrollLeft;

    let top = selectionRect.top + scrollTop - tooltipHeight - 12;
    let left = selectionRect.left + scrollLeft + (selectionRect.width / 2) - (tooltipWidth / 2);

    if (top < scrollTop) {
      top = selectionRect.bottom + scrollTop + 8;
    }
    if (left < 10) left = 10;
    if (left + tooltipWidth > window.innerWidth - 10) {
      left = window.innerWidth - tooltipWidth - 10;
    }

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;

    requestAnimationFrame(() => {
      tooltip.classList.add('show');
    });

    let translationResult = '';
    const transBtn = tooltip.querySelector('#aura-btn-trans');
    const ttsBtn = tooltip.querySelector('#aura-btn-tts');
    const starBtn = tooltip.querySelector('#aura-btn-star');
    const resDiv = tooltip.querySelector('#aura-tooltip-res');

    transBtn.addEventListener('click', async () => {
      resDiv.textContent = 'Translating...';
      transBtn.disabled = true;

      chrome.runtime.sendMessage({
        action: 'translateBatch',
        texts: [text],
        sourceLang: sourceLang,
        targetLang: targetLang
      }, (response) => {
        if (response && response.success && response.translations && response.translations[0]) {
          translationResult = response.translations[0];
          // Use textContent instead of innerHTML to prevent XSS
          resDiv.textContent = translationResult;
          ttsBtn.disabled = false;
          starBtn.disabled = false;
        } else {
          resDiv.textContent = 'Translation failed.';
          transBtn.disabled = false;
        }
      });
    });

    ttsBtn.addEventListener('click', () => {
      if (!translationResult) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(translationResult);
      utterance.lang = targetLang === 'en' ? 'en-US' : targetLang;
      window.speechSynthesis.speak(utterance);
    });

    starBtn.addEventListener('click', () => {
      if (!translationResult) return;
      
      const phrase = {
        originalText: text,
        translatedText: translationResult,
        sourceLang: sourceLang,
        targetLang: targetLang,
        timestamp: Date.now()
      };

      chrome.runtime.sendMessage({
        action: 'addStarred',
        phrase: phrase
      }, (response) => {
        if (response && response.success) {
          starBtn.classList.add('starred');
          starBtn.textContent = '⭐ Starred';
          starBtn.disabled = true;
        } else {
          console.error("Error saving phrase:", response ? response.error : 'No response');
        }
      });
    });
  }

  function removeTooltip() {
    if (activeTooltip) {
      activeTooltip.classList.remove('show');
      const tooltip = activeTooltip;
      activeTooltip = null;
      setTimeout(() => {
        if (tooltip.parentNode) {
          tooltip.parentNode.removeChild(tooltip);
        }
      }, 150);
    }
  }
})();
