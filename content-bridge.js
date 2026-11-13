// Isolated world: sync rules from storage into the page (MAIN) via postMessage

function publishRules(rules) {
  window.postMessage(
    {
      source: 'devproxy',
      type: 'rules',
      rules: Array.isArray(rules) ? rules : []
    },
    '*'
  );
}

async function syncRulesFromStorage() {
  try {
    const result = await chrome.storage.local.get(['interceptRules']);
    publishRules(result.interceptRules || []);
  } catch (error) {
    console.warn('[DevProxy] Failed to read rules:', error);
    publishRules([]);
  }
}

syncRulesFromStorage();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.interceptRules) return;
  publishRules(changes.interceptRules.newValue || []);
});

// Re-push after a tick in case MAIN script listened after first publish
setTimeout(syncRulesFromStorage, 0);
setTimeout(syncRulesFromStorage, 50);
