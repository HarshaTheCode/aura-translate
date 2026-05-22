// Service Worker for AuraTranslate

// Translation Cache in memory (synced with storage)
let translationCache = {};
const CACHE_MAX_SIZE = 5000;

// IndexedDB Helper Functions
const DB_NAME = 'AuraTranslateDB';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('translations')) {
        db.createObjectStore('translations');
      }
      if (!db.objectStoreNames.contains('phrasebook')) {
        db.createObjectStore('phrasebook', { keyPath: 'originalText' });
      }
    };
  });
}

async function getTranslation(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('translations', 'readonly');
    const store = transaction.objectStore('translations');
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveTranslation(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('translations', 'readwrite');
    const store = transaction.objectStore('translations');
    const request = store.put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function clearAllTranslations() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('translations', 'readwrite');
    const store = transaction.objectStore('translations');
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getTranslationCount() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('translations', 'readonly');
    const store = transaction.objectStore('translations');
    const request = store.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Starred Phrasebook Helpers (IndexedDB)
async function getStarredCount() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('phrasebook', 'readonly');
      const store = transaction.objectStore('phrasebook');
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.error(e);
    return 0;
  }
}

async function addStarredPhrase(phraseObj) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('phrasebook', 'readwrite');
    const store = transaction.objectStore('phrasebook');
    const request = store.put(phraseObj);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function removeStarredPhrase(originalText) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('phrasebook', 'readwrite');
    const store = transaction.objectStore('phrasebook');
    const request = store.delete(originalText);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getStarredPhrases() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('phrasebook', 'readonly');
    const store = transaction.objectStore('phrasebook');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function clearAllStarred() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('phrasebook', 'readwrite');
    const store = transaction.objectStore('phrasebook');
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Helper to set up context menus reliably
function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "translate-page",
      title: "Translate this page with AuraTranslate",
      contexts: ["page"]
    });
  });
}

// Set up context menus on service worker startup/load
setupContextMenus();

// Load cache migration and register context menus on installation
chrome.runtime.onInstalled.addListener(() => {
  setupContextMenus();

  chrome.storage.local.get(['translationCache'], (data) => {
    if (data.translationCache) {
      openDB().then(async (db) => {
        const keys = Object.keys(data.translationCache);
        for (const key of keys) {
          await saveTranslation(key, data.translationCache[key]);
        }
        chrome.storage.local.remove(['translationCache']);
      }).catch(err => {
        console.error("Migration to IndexedDB failed:", err);
      });
    }
  });
});

// Context Menu Click Listener
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "translate-page" && tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, {
      action: "enableTranslation",
      force: true
    }).catch(err => {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      }).then(() => {
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, {
            action: "enableTranslation",
            force: true
          }).catch(e => console.error("Failed to enable translation after injection:", e));
        }, 120);
      }).catch(e => console.error("Failed to inject content script from context menu:", e));
    });
  }
});

// Listener for messages from popup or content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'tabStateUpdated') {
    if (sender.tab && sender.tab.id) {
      chrome.storage.local.set({
        [`tabState_${sender.tab.id}`]: request.state
      });
    }
    return false;
  }

  if (request.action === 'translateBatch') {
    handleBatchTranslation(request.texts, request.sourceLang, request.targetLang)
      .then(translations => {
        sendResponse({ success: true, translations });
      })
      .catch(error => {
        console.error("Translation error in background worker:", error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep message channel open for async response
  }
  
  if (request.action === 'clearCache') {
    translationCache = {};
    clearAllTranslations()
      .then(() => {
        chrome.storage.local.remove(['translationCache'], () => {
          sendResponse({ success: true });
        });
      })
      .catch(err => {
        console.error("Failed to clear cache:", err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === 'getCacheStats') {
    Promise.all([getTranslationCount(), getStarredCount()])
      .then(([translationCount, starredCount]) => {
        sendResponse({ success: true, translationCount, starredCount });
      })
      .catch(err => {
        console.error("Failed to get cache stats:", err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === 'addStarred') {
    addStarredPhrase(request.phrase)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'removeStarred') {
    removeStarredPhrase(request.originalText)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'getStarred') {
    getStarredPhrases()
      .then(phrases => sendResponse({ success: true, phrases }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'clearStarred') {
    clearAllStarred()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

/**
 * Handles translation of an array of strings, using cache and batching.
 */
async function handleBatchTranslation(texts, sourceLang, targetLang) {
  const cacheKeyPrefix = `${sourceLang}_${targetLang}_`;
  const results = new Array(texts.length).fill(null);

  // 1. Check cache first (parallel lookup in-memory + IndexedDB)
  const lookups = await Promise.all(
    texts.map(async (text) => {
      const key = cacheKeyPrefix + text;
      if (translationCache[key]) {
        return translationCache[key];
      }
      try {
        const cachedVal = await getTranslation(key);
        if (cachedVal) {
          translationCache[key] = cachedVal;
          return cachedVal;
        }
      } catch (err) {
        console.error("IndexedDB cache read error:", err);
      }
      return null;
    })
  );

  const uncachedIndices = [];
  const uncachedTexts = [];

  lookups.forEach((val, index) => {
    if (val !== null) {
      results[index] = val;
    } else {
      uncachedIndices.push(index);
      uncachedTexts.push(texts[index]);
    }
  });

  // If all are cached, return immediately
  if (uncachedTexts.length === 0) {
    return results;
  }

  // 2. Batch the uncached texts
  // Max size of text in one Google Translate request is around 5000 characters.
  // We will batch in groups of max 40 strings or 2500 characters to be safe.
  const batches = [];
  let currentBatch = [];
  let currentLength = 0;

  uncachedTexts.forEach((text) => {
    if (currentBatch.length >= 40 || currentLength + text.length > 2500) {
      batches.push(currentBatch);
      currentBatch = [];
      currentLength = 0;
    }
    currentBatch.push(text);
    currentLength += text.length;
  });
  
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  // Translate batches in sequence (or with slight delay) to avoid rate limits
  const translatedUncached = [];
  for (const batch of batches) {
    try {
      const batchTranslations = await translateTextList(batch, sourceLang, targetLang);
      translatedUncached.push(...batchTranslations);
      // Brief sleep to avoid hitting Google's rate limits
      await new Promise(resolve => setTimeout(resolve, 80));
    } catch (err) {
      console.error("Failed to translate batch:", batch, err);
      // Fallback: fill with original texts
      translatedUncached.push(...batch);
    }
  }

  // 3. Map translated items back to original results array and update cache
  const dbWritePromises = [];
  uncachedIndices.forEach((originalIndex, i) => {
    const originalText = uncachedTexts[i];
    const translatedText = translatedUncached[i] || originalText;
    
    results[originalIndex] = translatedText;

    // Cache the result
    const key = cacheKeyPrefix + originalText;
    translationCache[key] = translatedText;
    dbWritePromises.push(saveTranslation(key, translatedText).catch(e => console.error("IndexedDB write error:", e)));
  });

  if (dbWritePromises.length > 0) {
    await Promise.all(dbWritePromises);
  }

  // Keep in-memory cache under size limit
  const cacheKeys = Object.keys(translationCache);
  if (cacheKeys.length > CACHE_MAX_SIZE) {
    // Delete oldest 500 entries
    const keysToDelete = cacheKeys.slice(0, 500);
    keysToDelete.forEach(k => delete translationCache[k]);
  }

  return results;
}

/**
 * Translates a single list of strings using Google Translate API
 */
async function translateTextList(texts, sourceLang, targetLang) {
  // Join texts with newline. The Google Translate API translates line by line.
  const delimiter = '\n';
  const joinedText = texts.join(delimiter);

  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(joinedText)}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Google Translate API returned status ${response.status}`);
    }

    const data = await response.json();
    if (!data || !data[0]) {
      throw new Error("Invalid response format from Google Translate");
    }

    const segments = data[0];
    
    // We want to reconstruct the translations.
    // Sometimes Google Translate groups segments or splits them slightly differently.
    // Let's build a map of original segment -> translated segment using a robust alignment system.
    const alignmentMap = new Map();
    
    // Also reconstruct the full text block and split it by newlines to see if it matches text count
    const fullTranslatedText = segments.map(seg => seg[0] || '').join('');
    const splitTranslations = fullTranslatedText.split('\n');

    segments.forEach(seg => {
      if (seg && seg[0] !== null && seg[1] !== null) {
        const trans = seg[0];
        const orig = seg[1];
        
        // 1. If both contain newlines, attempt line-by-line alignment
        if (orig.includes('\n') || trans.includes('\n')) {
          const origLines = orig.split('\n');
          const transLines = trans.split('\n');
          
          if (origLines.length === transLines.length) {
            for (let i = 0; i < origLines.length; i++) {
              const o = origLines[i].trim();
              const t = transLines[i].trim();
              if (o) {
                alignmentMap.set(o.toLowerCase(), t);
              }
            }
          }
        }
        
        // 2. Map the entire segment as is
        const o = orig.trim();
        const t = trans.trim();
        if (o) {
          alignmentMap.set(o.toLowerCase(), t);
        }
      }
    });

    // Return mapped results
    return texts.map((originalText, idx) => {
      const cleanOriginal = originalText.trim().toLowerCase();
      
      // 1. Try mapping via the exact/aligned map
      if (alignmentMap.has(cleanOriginal)) {
        return alignmentMap.get(cleanOriginal);
      }
      
      // 2. Try index-based fallback if total line count matches perfectly
      if (splitTranslations.length === texts.length) {
        const fallbackVal = splitTranslations[idx];
        if (fallbackVal !== undefined) {
          return fallbackVal.trim();
        }
      }

      // 3. Ultimate fallback: original text (prevents repeating-word bugs)
      return originalText;
    });

  } catch (error) {
    console.error("Network fetch failed in translateTextList:", error);
    throw error;
  }
}
