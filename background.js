// Service Worker for AuraTranslate

// Translation Cache in memory (synced with storage)
let translationCache = {};
const CACHE_MAX_SIZE = 5000;

// Load cache from storage on startup
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['translationCache'], (data) => {
    if (data.translationCache) {
      translationCache = data.translationCache;
    } else {
      chrome.storage.local.set({ translationCache: {} });
    }
  });
});

chrome.storage.local.get(['translationCache'], (data) => {
  if (data.translationCache) {
    translationCache = data.translationCache;
  }
});

// Listener for messages from popup or content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
    chrome.storage.local.set({ translationCache: {} }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

/**
 * Handles translation of an array of strings, using cache and batching.
 */
async function handleBatchTranslation(texts, sourceLang, targetLang) {
  const cacheKeyPrefix = `${sourceLang}_${targetLang}_`;
  const results = new Array(texts.length).fill(null);
  const uncachedIndices = [];
  const uncachedTexts = [];

  // 1. Check cache first
  texts.forEach((text, index) => {
    const key = cacheKeyPrefix + text;
    if (translationCache[key]) {
      results[index] = translationCache[key];
    } else {
      uncachedIndices.push(index);
      uncachedTexts.push(text);
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
  let cacheUpdated = false;
  uncachedIndices.forEach((originalIndex, i) => {
    const originalText = uncachedTexts[i];
    const translatedText = translatedUncached[i] || originalText;
    
    results[originalIndex] = translatedText;

    // Cache the result
    const key = cacheKeyPrefix + originalText;
    translationCache[key] = translatedText;
    cacheUpdated = true;
  });

  // Save updated cache to storage if changes were made
  if (cacheUpdated) {
    // Keep cache under size limit
    const cacheKeys = Object.keys(translationCache);
    if (cacheKeys.length > CACHE_MAX_SIZE) {
      // Delete oldest 500 entries
      const keysToDelete = cacheKeys.slice(0, 500);
      keysToDelete.forEach(k => delete translationCache[k]);
    }
    chrome.storage.local.set({ translationCache });
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
    // Let's build a map of original segment -> translated segment.
    const segmentMap = new Map();
    segments.forEach(seg => {
      if (seg && seg[0] !== null && seg[1] !== null) {
        const trans = seg[0];
        const orig = seg[1];
        
        // Trim and lowercase key for robust matching
        const cleanOrig = orig.trim();
        if (cleanOrig) {
          if (segmentMap.has(cleanOrig)) {
            segmentMap.set(cleanOrig, segmentMap.get(cleanOrig) + trans);
          } else {
            segmentMap.set(cleanOrig, trans);
          }
        }
      }
    });

    // Also reconstruct the full text block and split it by newlines to see if it matches text count
    const fullTranslatedText = segments.map(seg => seg[0] || '').join('');
    const splitTranslations = fullTranslatedText.split('\n');

    // Return mapped results
    return texts.map((originalText, idx) => {
      const cleanOriginal = originalText.trim();
      
      // 1. Try mapping via the exact segment map
      if (segmentMap.has(cleanOriginal)) {
        return segmentMap.get(cleanOriginal);
      }
      
      // 2. Try case/space insensitive matching
      for (const [origKey, transVal] of segmentMap.entries()) {
        if (origKey.toLowerCase() === cleanOriginal.toLowerCase()) {
          return transVal;
        }
      }

      // 3. Fallback to index-based split if length matches
      if (splitTranslations.length === texts.length) {
        return splitTranslations[idx] || originalText;
      }

      // 4. Try matching parts
      for (const [origKey, transVal] of segmentMap.entries()) {
        if (cleanOriginal.includes(origKey) || origKey.includes(cleanOriginal)) {
          return transVal;
        }
      }

      // 5. Ultimate fallback: original text
      return originalText;
    });

  } catch (error) {
    console.error("Network fetch failed in translateTextList:", error);
    throw error;
  }
}
