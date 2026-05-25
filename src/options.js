document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKeyInput');
  const saveKeyBtn = document.getElementById('saveKeyBtn');
  const keyStatus = document.getElementById('keyStatus');
  
  const domainInput = document.getElementById('domainInput');
  const addDomainBtn = document.getElementById('addDomainBtn');
  const blocklistContainer = document.getElementById('blocklistContainer');

  const clearCacheBtn = document.getElementById('clearCacheBtn');

  // Load Settings
  chrome.storage.local.get(['customApiKey', 'blocklist'], (data) => {
    if (data.customApiKey) apiKeyInput.value = data.customApiKey;
    
    const blocklist = data.blocklist || [];
    renderBlocklist(blocklist);
  });

  // Save API Key
  saveKeyBtn.addEventListener('click', () => {
    chrome.storage.local.set({ customApiKey: apiKeyInput.value.trim() }, () => {
      keyStatus.style.display = 'inline';
      setTimeout(() => { keyStatus.style.display = 'none'; }, 2000);
    });
  });

  // Blocklist functions
  function renderBlocklist(list) {
    blocklistContainer.innerHTML = '';
    list.forEach(domain => {
      const div = document.createElement('div');
      div.className = 'domain-item';
      
      const span = document.createElement('span');
      span.textContent = domain;
      span.style.fontSize = '13px';
      
      const del = document.createElement('span');
      del.textContent = '✕';
      del.className = 'remove-domain';
      del.onclick = () => {
        const newList = list.filter(d => d !== domain);
        chrome.storage.local.set({ blocklist: newList }, () => {
          renderBlocklist(newList);
        });
      };
      
      div.appendChild(span);
      div.appendChild(del);
      blocklistContainer.appendChild(div);
    });
  }

  addDomainBtn.addEventListener('click', () => {
    let domain = domainInput.value.trim().toLowerCase();
    if (!domain) return;
    // Strip http/https and paths
    domain = domain.replace(/^https?:\/\//, '').split('/')[0];
    
    chrome.storage.local.get(['blocklist'], (data) => {
      const list = data.blocklist || [];
      if (!list.includes(domain)) {
        list.push(domain);
        chrome.storage.local.set({ blocklist: list }, () => {
          renderBlocklist(list);
          domainInput.value = '';
        });
      }
    });
  });

  // Clear cache
  clearCacheBtn.addEventListener('click', () => {
    if (confirm("Are you sure you want to clear the translation cache?")) {
      chrome.runtime.sendMessage({ action: 'clearCache' }, (res) => {
        if (res && res.success) {
          alert("Cache cleared successfully.");
        } else {
          alert("Failed to clear cache.");
        }
      });
    }
  });
});
