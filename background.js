// DevProxy background — rule storage only (page intercept via content scripts)

let interceptRules = [];

const stateReady = chrome.storage.local.get(['interceptRules']).then((result) => {
  interceptRules = result.interceptRules || [];
});

async function ensureState() {
  await stateReady;
}

function hasRules() {
  return interceptRules.some((rule) => rule && rule.enabled !== false);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await ensureState();

    switch (message.action) {
      case 'getStatus': {
        const enabledCount = interceptRules.filter((r) => r && r.enabled !== false).length;
        sendResponse({
          isEnabled: hasRules(),
          ruleCount: interceptRules.length,
          enabledCount,
          mode: 'content-script',
          message: hasRules()
            ? `Page intercept ready (${enabledCount} enabled rule${enabledCount === 1 ? '' : 's'}) — fetch/XHR`
            : 'Interception off — add an enabled rule'
        });
        break;
      }

      case 'getRules':
        sendResponse({ rules: interceptRules });
        break;

      case 'addRule':
        interceptRules.push(message.rule);
        await chrome.storage.local.set({ interceptRules });
        sendResponse({ success: true });
        break;

      case 'updateRule':
        if (message.index >= 0 && message.index < interceptRules.length) {
          interceptRules[message.index] = message.rule;
          await chrome.storage.local.set({ interceptRules });
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'Invalid index' });
        }
        break;

      case 'deleteRule':
        if (message.index >= 0 && message.index < interceptRules.length) {
          interceptRules.splice(message.index, 1);
          await chrome.storage.local.set({ interceptRules });
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'Invalid index' });
        }
        break;

      case 'toggleRule':
        if (message.index >= 0 && message.index < interceptRules.length) {
          interceptRules[message.index].enabled = !interceptRules[message.index].enabled;
          await chrome.storage.local.set({ interceptRules });
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'Invalid index' });
        }
        break;

      case 'clearAllRules':
        interceptRules = [];
        await chrome.storage.local.set({ interceptRules });
        sendResponse({ success: true });
        break;

      // Legacy no-ops (old popup builds)
      case 'ensureAttach':
        sendResponse({ success: true, mode: 'content-script' });
        break;

      default:
        sendResponse({ success: false, error: 'Unknown action' });
    }
  })().catch((error) => {
    console.error('[DevProxy] Message handler error:', error);
    sendResponse({ success: false, error: String(error) });
  });

  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.interceptRules) return;
  interceptRules = changes.interceptRules.newValue || [];
});
