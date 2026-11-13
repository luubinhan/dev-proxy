// Network Intercept Background Service Worker
let interceptRules = [];
let attachedTabs = new Set();
const reattachTimers = new Map(); // tabId -> timeout id

// MV3 workers are killed/restarted; always wait for storage before handling events
const stateReady = chrome.storage.local.get(['interceptRules']).then((result) => {
  interceptRules = result.interceptRules || [];
});

async function ensureState() {
  await stateReady;
}

function isDevToolsConflict(message) {
  const msg = (message || '').toLowerCase();
  return msg.includes('another debugger') || msg.includes('devtools');
}

function isAlreadyAttached(message) {
  const msg = (message || '').toLowerCase();
  return msg.includes('already attached');
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await ensureState();

    switch (message.action) {
      case 'getStatus': {
        const tabId = await attachDebuggerToActiveTab();
        sendResponse({
          isEnabled: true,
          attachedTabs: Array.from(attachedTabs),
          activeTabId: tabId,
          debuggerAttached: tabId != null && attachedTabs.has(tabId)
        });
        break;
      }

      case 'ensureAttach': {
        const tabId = await attachDebuggerToActiveTab();
        sendResponse({
          success: true,
          activeTabId: tabId,
          debuggerAttached: tabId != null && attachedTabs.has(tabId)
        });
        break;
      }

      case 'getRules':
        // Opening popup should keep debugger alive on the page being tested
        await attachDebuggerToActiveTab();
        sendResponse({ rules: interceptRules });
        break;

      case 'addRule':
        interceptRules.push(message.rule);
        await chrome.storage.local.set({ interceptRules });
        await attachDebuggerToActiveTab();
        sendResponse({ success: true });
        break;

      case 'updateRule':
        if (message.index >= 0 && message.index < interceptRules.length) {
          interceptRules[message.index] = message.rule;
          await chrome.storage.local.set({ interceptRules });
          await attachDebuggerToActiveTab();
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

// Attach on navigation — always re-enable Fetch (domains can drop across navigations)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  await ensureState();
  if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') return;
  try {
    await attachDebugger(tabId, { forceEnableFetch: true });
  } catch (error) {
    console.error('[DevProxy] Error attaching on tab update:', error);
  }
});

// Attach debugger to active tab; returns tabId or null
async function attachDebuggerToActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id && isAttachableUrl(tab.url)) {
      await attachDebugger(tab.id, { forceEnableFetch: true });
      return tab.id;
    }
    return tab?.id ?? null;
  } catch (error) {
    console.error('[DevProxy] Error attaching debugger:', error);
    return null;
  }
}

function isAttachableUrl(url) {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://');
}

/**
 * Attach debugger and enable Fetch interception.
 * @param {number} tabId
 * @param {{ forceEnableFetch?: boolean }} [options]
 */
async function attachDebugger(tabId, options = {}) {
  const forceEnableFetch = options.forceEnableFetch === true;

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

  const alreadyTracked = attachedTabs.has(tabId);
  if (alreadyTracked && !forceEnableFetch) {
    return;
  }

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (error) {
    const message = error?.message || String(error);
    if (isDevToolsConflict(message)) {
      attachedTabs.delete(tabId);
      console.warn(
        `[DevProxy] Cannot attach to tab ${tabId}: DevTools/another debugger owns it. ` +
          'Close DevTools on that tab (or undock conflict), then reopen the DevProxy popup.'
      );
      scheduleReattach(tabId);
      return;
    }
    if (!isAlreadyAttached(message)) {
      console.error(`[DevProxy] Failed to attach debugger to tab ${tabId}:`, error);
      scheduleReattach(tabId);
      return;
    }
    console.log(`[DevProxy] Debugger already attached to tab ${tabId}, re-enabling Fetch`);
  }

  try {
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
      patterns: [
        { urlPattern: '*', requestStage: 'Request' }
      ]
    });

    attachedTabs.add(tabId);
    clearReattach(tabId);
    console.log(`[DevProxy] Debugger ready on tab ${tabId}`);
  } catch (error) {
    console.error(`[DevProxy] Failed to enable Fetch on tab ${tabId}:`, error);
    attachedTabs.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch (_) {
      // ignore
    }
    scheduleReattach(tabId);
  }
}

function clearReattach(tabId) {
  const timer = reattachTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    reattachTimers.delete(tabId);
  }
}

function scheduleReattach(tabId, attempt = 1) {
  if (attempt > 10) return;
  clearReattach(tabId);
  const delayMs = Math.min(1000 * attempt, 5000);
  const timer = setTimeout(async () => {
    reattachTimers.delete(tabId);
    try {
      await attachDebugger(tabId, { forceEnableFetch: true });
      if (!attachedTabs.has(tabId)) {
        scheduleReattach(tabId, attempt + 1);
      }
    } catch (_) {
      scheduleReattach(tabId, attempt + 1);
    }
  }, delayMs);
  reattachTimers.set(tabId, timer);
}

// Handle debugger events
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== 'Fetch.requestPaused') return;

  handleRequestPaused(source.tabId, params).catch((error) => {
    console.error('[DevProxy] Unhandled requestPaused error:', error);
  });
});

// Handle debugger detach — common when DevTools opens on the same tab
chrome.debugger.onDetach.addListener((source, reason) => {
  attachedTabs.delete(source.tabId);
  console.log(`[DevProxy] Debugger detached from tab ${source.tabId}. Reason: ${reason}`);
  // When DevTools replaces us, retry after it may have closed
  scheduleReattach(source.tabId);
});

async function continueRequest(tabId, requestId) {
  await chrome.debugger.sendCommand(
    { tabId },
    'Fetch.continueRequest',
    { requestId }
  );
}

async function failRequest(tabId, requestId, errorReason = 'Failed') {
  await chrome.debugger.sendCommand(
    { tabId },
    'Fetch.failRequest',
    { requestId, errorReason }
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

    let responseCode = Number(rule.statusCode) || 200;
    let body = rule.responseBody ?? '';

    // Convert body to base64 if needed
    let base64Body = null;
    if (body !== '' && body != null) {
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
      base64Body = btoa(unescape(encodeURIComponent(String(body))));
    } else if (responseCode !== 200) {
      // Status-only mocks: send a tiny JSON body so clients/CDP always get a clear response
      responseHeaders.push({ name: 'Content-Type', value: 'application/json' });
      base64Body = btoa(unescape(encodeURIComponent(JSON.stringify({
        error: 'Intercepted by DevProxy',
        status: responseCode
      }))));
    }

    const fulfillParams = {
      requestId,
      responseCode,
      responseHeaders
    };
    if (base64Body != null) {
      fulfillParams.body = base64Body;
    }

    await chrome.debugger.sendCommand(
      { tabId },
      'Fetch.fulfillRequest',
      fulfillParams
    );

    console.log('[DevProxy] Fulfilled', requestId, 'with status', responseCode, '(network skipped)');
  } catch (error) {
    console.error('[DevProxy] Error applying rule (will NOT hit real network):', error);

    // Intentionally do not continueRequest — that would call the real endpoint (e.g. 200)
    try {
      await failRequest(tabId, requestId, 'Failed');
    } catch (failError) {
      console.error('[DevProxy] Error failing request after fulfill failure:', failError);
    }
  }
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  clearReattach(tabId);
});
