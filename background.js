// Network Intercept Background Service Worker
let interceptRules = [];
let attachedTabs = new Set();

// MV3 workers are killed/restarted; always wait for storage before handling events
const stateReady = chrome.storage.local.get(['interceptRules']).then((result) => {
  interceptRules = result.interceptRules || [];
});

async function ensureState() {
  await stateReady;
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await ensureState();

    switch (message.action) {
      case 'getStatus':
        sendResponse({ isEnabled: true, attachedTabs: Array.from(attachedTabs) });
        break;

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

      default:
        sendResponse({ success: false, error: 'Unknown action' });
    }
  })().catch((error) => {
    console.error('[DevProxy] Message handler error:', error);
    sendResponse({ success: false, error: String(error) });
  });

  return true; // Keep message channel open for async response
});

// Re-attach after service worker restart
stateReady.then(async () => {
  console.log('[DevProxy] State ready, attaching debugger');
  await attachDebuggerToActiveTab();
});

// Attach when user switches tabs
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await ensureState();
  try {
    await attachDebugger(activeInfo.tabId);
  } catch (error) {
    console.error('[DevProxy] Error attaching on tab activate:', error);
  }
});

// Attach on navigation
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  await ensureState();
  if (changeInfo.status !== 'loading') return;
  try {
    await attachDebugger(tabId);
  } catch (error) {
    console.error('[DevProxy] Error attaching on tab update:', error);
  }
});

// Attach debugger to active tab
async function attachDebuggerToActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id && isAttachableUrl(tab.url)) {
      await attachDebugger(tab.id);
    }
  } catch (error) {
    console.error('[DevProxy] Error attaching debugger:', error);
  }
}

function isAttachableUrl(url) {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://');
}

// Attach debugger to specific tab
async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) {
    return; // Already tracked in this worker
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isAttachableUrl(tab.url)) {
      console.log(`[DevProxy] Skipping non-attachable tab ${tabId}: ${tab.url}`);
      return;
    }
  } catch (error) {
    console.error(`[DevProxy] Could not get tab ${tabId}:`, error);
    return;
  }

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (error) {
    const message = error?.message || String(error);
    // After SW restart, debugger may still be attached from the previous worker
    if (!message.includes('Already attached')) {
      console.error(`[DevProxy] Failed to attach debugger to tab ${tabId}:`, error);
      return;
    }
    console.log(`[DevProxy] Debugger already attached to tab ${tabId}, re-enabling Fetch`);
  }

  try {
    attachedTabs.add(tabId);

    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
      patterns: [
        { urlPattern: '*', requestStage: 'Request' }
      ]
    });

    console.log(`[DevProxy] Debugger ready on tab ${tabId}`);
  } catch (error) {
    console.error(`[DevProxy] Failed to enable Fetch on tab ${tabId}:`, error);
    attachedTabs.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch (_) {
      // ignore
    }
  }
}

// Handle debugger events
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== 'Fetch.requestPaused') return;

  handleRequestPaused(source.tabId, params).catch((error) => {
    console.error('[DevProxy] Unhandled requestPaused error:', error);
  });
});

// Handle debugger detach
chrome.debugger.onDetach.addListener((source, reason) => {
  attachedTabs.delete(source.tabId);
  console.log(`[DevProxy] Debugger detached from tab ${source.tabId}. Reason: ${reason}`);
});

async function continueRequest(tabId, requestId) {
  await chrome.debugger.sendCommand(
    { tabId },
    'Fetch.continueRequest',
    { requestId }
  );
}

// Handle request interception
async function handleRequestPaused(tabId, params) {
  const { requestId, request } = params;
  const url = request.url;

  await ensureState();

  // Skip preflight OPTIONS requests - let them pass through
  if (request.method === 'OPTIONS') {
    try {
      await continueRequest(tabId, requestId);
    } catch (error) {
      console.error('[DevProxy] Error continuing preflight:', error);
    }
    return;
  }

  const matchingRule = interceptRules.find(rule => {
    if (!rule.enabled) return false;

    try {
      const urlPattern = new RegExp(rule.urlPattern);
      return urlPattern.test(url);
    } catch (error) {
      console.error('[DevProxy] Invalid pattern:', rule.urlPattern, error);
      return false;
    }
  });

  if (matchingRule) {
    console.log('[DevProxy] MATCH', request.method, url, '→', matchingRule.urlPattern);
    await applyRule(tabId, requestId, params, matchingRule);
  } else {
    try {
      await continueRequest(tabId, requestId);
    } catch (error) {
      console.error('[DevProxy] Error continuing request:', error);
    }
  }
}

function shouldFulfill(rule) {
  const hasBody = rule.responseBody !== undefined && rule.responseBody !== null && rule.responseBody !== '';
  const hasHeaders = rule.responseHeaders && Object.keys(rule.responseHeaders).length > 0;
  const hasCustomStatus = rule.statusCode !== undefined && rule.statusCode !== null && Number(rule.statusCode) !== 200;
  return hasBody || hasHeaders || hasCustomStatus;
}

// Apply interception rule
async function applyRule(tabId, requestId, params, rule) {
  try {
    // Apply delay if specified
    if (rule.delay && rule.delay > 0) {
      await new Promise(resolve => setTimeout(resolve, rule.delay));
    }

    // Delay-only / passthrough rules: continue to network after waiting
    if (!shouldFulfill(rule)) {
      await continueRequest(tabId, requestId);
      return;
    }

    // Get origin from request headers for proper CORS handling
    let origin = null;
    if (params.request.headers) {
      if (Array.isArray(params.request.headers)) {
        const originHeader = params.request.headers.find(h => h.name.toLowerCase() === 'origin');
        origin = originHeader ? originHeader.value : null;
      } else {
        origin = params.request.headers['origin'] || params.request.headers['Origin'] || null;
      }
    }

    const responseHeaders = [
      { name: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, DELETE, PATCH, OPTIONS' },
      { name: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization, X-Requested-With' }
    ];

    // ACAO:* cannot be combined with credentials
    if (origin) {
      responseHeaders.push({ name: 'Access-Control-Allow-Origin', value: origin });
      responseHeaders.push({ name: 'Access-Control-Allow-Credentials', value: 'true' });
    } else {
      responseHeaders.push({ name: 'Access-Control-Allow-Origin', value: '*' });
    }

    // Add custom headers from rule
    if (rule.responseHeaders && typeof rule.responseHeaders === 'object') {
      for (const [name, value] of Object.entries(rule.responseHeaders)) {
        responseHeaders.push({ name, value: String(value) });
      }
    }

    let responseCode = rule.statusCode || 200;
    let body = rule.responseBody ?? '';

    // Convert body to base64 if needed
    let base64Body = '';
    if (body !== '') {
      if (typeof body === 'object') {
        body = JSON.stringify(body);
        if (!rule.responseHeaders || !rule.responseHeaders['Content-Type']) {
          responseHeaders.push({ name: 'Content-Type', value: 'application/json' });
        }
      } else if (
        typeof body === 'string' &&
        !rule.responseHeaders?.['Content-Type'] &&
        /^\s*[\{\[]/.test(body)
      ) {
        responseHeaders.push({ name: 'Content-Type', value: 'application/json' });
      }
      base64Body = btoa(unescape(encodeURIComponent(body)));
    }

    await chrome.debugger.sendCommand(
      { tabId },
      'Fetch.fulfillRequest',
      {
        requestId,
        responseCode,
        responseHeaders,
        body: base64Body
      }
    );

    console.log('[DevProxy] Fulfilled', requestId, 'with status', responseCode);
  } catch (error) {
    console.error('[DevProxy] Error applying rule:', error);

    try {
      await continueRequest(tabId, requestId);
    } catch (continueError) {
      console.error('[DevProxy] Error continuing request after failure:', continueError);
    }
  }
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
});
