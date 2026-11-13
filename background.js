// Network Intercept Background Service Worker
let interceptRules = [];
let attachedTabs = new Set();
const reattachTimers = new Map(); // tabId -> timeout id
const debuggees = new Map(); // tabId -> { tabId } | { targetId }
const tabByTargetId = new Map(); // targetId -> tabId

// MV3 workers are killed/restarted; always wait for storage before handling events
const stateReady = chrome.storage.local.get(['interceptRules']).then((result) => {
  interceptRules = result.interceptRules || [];
});

async function ensureState() {
  await stateReady;
}

function hasRules() {
  return interceptRules.length > 0;
}

async function detachDebugger(tabId) {
  clearReattach(tabId);
  const debuggee = debuggees.get(tabId) || (attachedTabs.has(tabId) ? { tabId } : null);
  if (debuggee) {
    try {
      await chrome.debugger.detach(debuggee);
    } catch (error) {
      console.warn(`[DevProxy] Detach failed for tab ${tabId}:`, error);
    }
  }
  forgetDebuggee(tabId);
}

async function disableInterception() {
  const tabIds = new Set([...attachedTabs, ...debuggees.keys()]);
  for (const tabId of [...reattachTimers.keys()]) {
    tabIds.add(tabId);
  }
  for (const tabId of tabIds) {
    await detachDebugger(tabId);
  }
}

/** Attach when rules exist; otherwise detach and report idle. */
async function syncInterception(preferredTabId) {
  if (!hasRules()) {
    await disableInterception();
    return attachResult({
      ok: false,
      tabId: preferredTabId ?? null,
      reason: 'no_rules',
      message: 'Interception off — add a rule to enable the debugger'
    });
  }
  if (preferredTabId != null) {
    return attachDebugger(preferredTabId, { forceEnableFetch: true });
  }
  return attachDebuggerToActiveTab();
}

function isDevToolsConflict(message) {
  const msg = (message || '').toLowerCase();
  return msg.includes('another debugger') || msg.includes('devtools');
}

function isAlreadyAttached(message) {
  const msg = (message || '').toLowerCase();
  // Do not treat "Another debugger is already attached" as our own session
  if (msg.includes('another debugger')) return false;
  return msg.includes('already attached');
}

function isExtensionUrlConflict(message) {
  const msg = (message || '').toLowerCase();
  return msg.includes('chrome-extension://') && msg.includes('different extension');
}

function isAttachableUrl(url) {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://');
}

function isBlockedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('devtools://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('view-source:')
  );
}

function rememberDebuggee(tabId, debuggee) {
  debuggees.set(tabId, debuggee);
  if (debuggee.targetId) {
    tabByTargetId.set(debuggee.targetId, tabId);
  }
}

function forgetDebuggee(tabId) {
  const debuggee = debuggees.get(tabId);
  if (debuggee?.targetId) {
    tabByTargetId.delete(debuggee.targetId);
  }
  debuggees.delete(tabId);
  attachedTabs.delete(tabId);
}

function resolveTabIdFromSource(source) {
  if (source?.tabId != null) return source.tabId;
  if (source?.targetId) return tabByTargetId.get(source.targetId) ?? null;
  return null;
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await ensureState();

    switch (message.action) {
      case 'getStatus': {
        const result = await syncInterception(message.tabId);
        sendResponse({
          isEnabled: hasRules(),
          attachedTabs: Array.from(attachedTabs),
          activeTabId: result.tabId,
          debuggerAttached: result.ok,
          attachReason: result.reason,
          attachMessage: result.message,
          tabUrl: result.url
        });
        break;
      }

      case 'ensureAttach': {
        const result = await syncInterception(message.tabId);
        sendResponse({
          success: result.ok,
          activeTabId: result.tabId,
          debuggerAttached: result.ok,
          attachReason: result.reason,
          attachMessage: result.message,
          tabUrl: result.url
        });
        break;
      }

      case 'getRules':
        await syncInterception(message.tabId);
        sendResponse({ rules: interceptRules });
        break;

      case 'addRule':
        interceptRules.push(message.rule);
        await chrome.storage.local.set({ interceptRules });
        await syncInterception(message.tabId);
        sendResponse({ success: true });
        break;

      case 'updateRule':
        if (message.index >= 0 && message.index < interceptRules.length) {
          interceptRules[message.index] = message.rule;
          await chrome.storage.local.set({ interceptRules });
          await syncInterception(message.tabId);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'Invalid index' });
        }
        break;

      case 'deleteRule':
        if (message.index >= 0 && message.index < interceptRules.length) {
          interceptRules.splice(message.index, 1);
          await chrome.storage.local.set({ interceptRules });
          await syncInterception(message.tabId);
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
        await syncInterception(message.tabId);
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

// Re-attach after service worker restart (only when rules exist)
stateReady.then(async () => {
  console.log('[DevProxy] State ready, syncing interception');
  await syncInterception();
});

// Attach when user switches tabs (no-op when no rules)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await ensureState();
  try {
    await syncInterception(activeInfo.tabId);
  } catch (error) {
    console.error('[DevProxy] Error attaching on tab activate:', error);
  }
});

// Attach on navigation — always re-enable Fetch when rules exist
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  await ensureState();
  if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') return;
  try {
    await syncInterception(tabId);
  } catch (error) {
    console.error('[DevProxy] Error attaching on tab update:', error);
  }
});

function attachResult( partial ) {
  return {
    ok: false,
    tabId: null,
    url: null,
    reason: 'unknown',
    message: '',
    ...partial
  };
}

// Prefer lastFocusedWindow — more reliable from MV3 service worker than currentWindow
async function findCandidateTab(preferredTabId) {
  if (preferredTabId != null) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      return tab;
    } catch (_) {
      // fall through
    }
  }

  const queries = [
    { active: true, lastFocusedWindow: true },
    { active: true, currentWindow: true }
  ];

  for (const query of queries) {
    try {
      const [tab] = await chrome.tabs.query(query);
      if (tab?.id) return tab;
    } catch (_) {
      // try next
    }
  }
  return null;
}

async function attachDebuggerToActiveTab() {
  const tab = await findCandidateTab();
  if (!tab?.id) {
    return attachResult({
      reason: 'no_tab',
      message: 'No active tab found. Focus your app tab, then reopen this popup.'
    });
  }
  return attachDebugger(tab.id, { forceEnableFetch: true });
}

/**
 * @returns {object|null} attachResult on hard failure; null when caller should continue (already attached)
 */
function handleAttachFailure(tabId, tabUrl, message) {
  if (isAlreadyAttached(message)) {
    return null;
  }

  if (isExtensionUrlConflict(message)) {
    forgetDebuggee(tabId);
    clearReattach(tabId);
    console.warn(`[DevProxy] Extension-page attach blocked for tab ${tabId}:`, message);
    return attachResult({
      tabId,
      url: tabUrl,
      reason: 'extension_page',
      message:
        `Chrome blocked debugger on this tab (${tabUrl || 'unknown'}). ` +
        'If this is a normal website, close PDF viewer / embedded browser / other debugger extensions and retry. ' +
        'If this is an extension options page, DevProxy cannot intercept it.'
    });
  }

  if (isDevToolsConflict(message)) {
    forgetDebuggee(tabId);
    console.warn(`[DevProxy] Cannot attach to tab ${tabId}: DevTools/another debugger owns it.`);
    scheduleReattach(tabId);
    return attachResult({
      tabId,
      url: tabUrl,
      reason: 'devtools_conflict',
      message:
        `DevTools (or another debugger) is attached to this tab (${tabUrl || 'unknown'}). ` +
        'Close DevTools completely, then reopen this popup.'
    });
  }

  console.error(`[DevProxy] Failed to attach debugger to tab ${tabId}:`, message);
  scheduleReattach(tabId);
  return attachResult({
    tabId,
    url: tabUrl,
    reason: 'attach_failed',
    message: `Attach failed on ${tabUrl || 'unknown'}: ${message}`
  });
}

/**
 * Resolve how to attach to a tab.
 * Important: other extensions' content-script targets also share tabId and look like
 * chrome-extension://… — that must NOT block attach when the tab URL itself is http(s).
 */
async function resolveDebuggeeForTab(tabId, tabUrl) {
  // Tab address bar is the source of truth
  if (isBlockedUrl(tabUrl)) {
    return {
      ok: false,
      reason: 'extension_page',
      url: tabUrl,
      message:
        `This tab is not a normal website (${tabUrl || 'unknown'}). ` +
        'Focus your https:// app tab, then reopen DevProxy.'
    };
  }

  if (!isAttachableUrl(tabUrl)) {
    return {
      ok: false,
      reason: 'unsupported_url',
      url: tabUrl,
      message: `Cannot attach to this page (${tabUrl || 'unknown'}). Open your http(s) app tab and retry.`
    };
  }

  // Prefer the http(s) page target when CDP exposes it; otherwise attach by tabId
  try {
    const targets = await chrome.debugger.getTargets();
    const httpPage = targets.find(
      (t) =>
        t.tabId === tabId &&
        t.type === 'page' &&
        isAttachableUrl(t.url) &&
        !isBlockedUrl(t.url)
    );
    if (httpPage) {
      return {
        ok: true,
        debuggee: { targetId: httpPage.id },
        url: httpPage.url
      };
    }
  } catch (error) {
    console.warn('[DevProxy] getTargets failed:', error);
  }

  return {
    ok: true,
    debuggee: { tabId },
    url: tabUrl
  };
}

/**
 * Attach debugger and enable Fetch interception.
 * @param {number} tabId
 * @param {{ forceEnableFetch?: boolean }} [options]
 * @returns {Promise<{ok:boolean, tabId:number|null, url:string|null, reason:string, message:string}>}
 */
async function attachDebugger(tabId, options = {}) {
  if (!hasRules()) {
    await detachDebugger(tabId);
    return attachResult({
      ok: false,
      tabId,
      reason: 'no_rules',
      message: 'Interception off — add a rule to enable the debugger'
    });
  }

  const forceEnableFetch = options.forceEnableFetch === true;
  let tabUrl = null;

  try {
    const tab = await chrome.tabs.get(tabId);
    tabUrl = tab.url || tab.pendingUrl || null;
    if (isBlockedUrl(tabUrl) || !isAttachableUrl(tabUrl)) {
      console.log(`[DevProxy] Skipping non-attachable tab ${tabId}: ${tabUrl}`);
      clearReattach(tabId);
      return attachResult({
        tabId,
        url: tabUrl,
        reason: isBlockedUrl(tabUrl) ? 'extension_page' : 'unsupported_url',
        message: isBlockedUrl(tabUrl)
          ? `This tab is not a normal website (${tabUrl || 'unknown'}). Focus your https:// app tab, then reopen DevProxy.`
          : `Cannot attach to this page (${tabUrl || 'unknown'}). Open your http(s) app tab and retry.`
      });
    }
  } catch (error) {
    console.error(`[DevProxy] Could not get tab ${tabId}:`, error);
    return attachResult({
      tabId,
      reason: 'tab_missing',
      message: `Could not read tab ${tabId}: ${error?.message || error}`
    });
  }

  const alreadyTracked = attachedTabs.has(tabId);
  if (alreadyTracked && !forceEnableFetch) {
    return attachResult({
      ok: true,
      tabId,
      url: tabUrl,
      reason: 'already_tracked',
      message: 'Debugger already active on this tab'
    });
  }

  const resolved = await resolveDebuggeeForTab(tabId, tabUrl);
  if (!resolved.ok) {
    clearReattach(tabId);
    return attachResult({
      tabId,
      url: resolved.url || tabUrl,
      reason: resolved.reason,
      message: resolved.message
    });
  }

  let debuggee = resolved.debuggee;
  tabUrl = resolved.url || tabUrl;

  try {
    await chrome.debugger.attach(debuggee, '1.3');
  } catch (error) {
    const message = error?.message || String(error);

    // targetId attach can fail when CDP points at a guest view; retry plain tabId for real https tabs
    if (
      isExtensionUrlConflict(message) &&
      debuggee.targetId &&
      isAttachableUrl(tabUrl) &&
      !isBlockedUrl(tabUrl)
    ) {
      console.warn(`[DevProxy] targetId attach blocked, retrying with tabId for ${tabUrl}`);
      debuggee = { tabId };
      try {
        await chrome.debugger.attach(debuggee, '1.3');
      } catch (retryError) {
        const retryMessage = retryError?.message || String(retryError);
        const failure = handleAttachFailure(tabId, tabUrl, retryMessage);
        if (failure) return failure;
        console.log(`[DevProxy] Debugger already attached to tab ${tabId}, re-enabling Fetch`);
      }
    } else {
      const failure = handleAttachFailure(tabId, tabUrl, message);
      if (failure) return failure;
      // already attached → fall through to Fetch.enable
      console.log(`[DevProxy] Debugger already attached to tab ${tabId}, re-enabling Fetch`);
    }
  }

  try {
    await chrome.debugger.sendCommand(debuggee, 'Network.enable');
    // Only pause XHR/Fetch — NEVER Document/Script/Stylesheet/Image.
    // Pausing all resources hangs the page if the service worker misses an event.
    await chrome.debugger.sendCommand(debuggee, 'Fetch.enable', {
      patterns: [
        { urlPattern: '*', resourceType: 'XHR', requestStage: 'Request' },
        { urlPattern: '*', resourceType: 'Fetch', requestStage: 'Request' }
      ]
    });

    rememberDebuggee(tabId, debuggee);
    attachedTabs.add(tabId);
    clearReattach(tabId);
    console.log(`[DevProxy] Debugger ready on tab ${tabId}`, debuggee);
    return attachResult({
      ok: true,
      tabId,
      url: tabUrl,
      reason: 'attached',
      message: 'Debugger attached — interception active on this tab'
    });
  } catch (error) {
    const message = error?.message || String(error);
    console.error(`[DevProxy] Failed to enable Fetch on tab ${tabId}:`, error);
    forgetDebuggee(tabId);
    try {
      await chrome.debugger.detach(debuggee);
    } catch (_) {
      // ignore
    }
    if (isExtensionUrlConflict(message)) {
      clearReattach(tabId);
      return attachResult({
        tabId,
        url: tabUrl,
        reason: 'extension_page',
        message:
          'Chrome blocked Fetch on an extension-backed tab. Use a normal https:// website tab instead.'
      });
    }
    scheduleReattach(tabId);
    return attachResult({
      tabId,
      url: tabUrl,
      reason: 'fetch_enable_failed',
      message: `Attached but Fetch.enable failed: ${message}`
    });
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
  if (tabId == null || attempt > 10 || !hasRules()) return;
  clearReattach(tabId);
  const delayMs = Math.min(1000 * attempt, 5000);
  const timer = setTimeout(async () => {
    reattachTimers.delete(tabId);
    if (!hasRules()) return;
    try {
      const result = await attachDebugger(tabId, { forceEnableFetch: true });
      // Permanent failures should not loop
      if (
        result.ok ||
        result.reason === 'no_rules' ||
        result.reason === 'extension_page' ||
        result.reason === 'unsupported_url' ||
        result.reason === 'tab_missing'
      ) {
        return;
      }
      scheduleReattach(tabId, attempt + 1);
    } catch (_) {
      scheduleReattach(tabId, attempt + 1);
    }
  }, delayMs);
  reattachTimers.set(tabId, timer);
}

async function safeContinue(debuggee, requestId, reason) {
  try {
    await chrome.debugger.sendCommand(debuggee, 'Fetch.continueRequest', { requestId });
  } catch (error) {
    console.error(`[DevProxy] Failed to continue request (${reason}):`, error);
  }
}

// Handle debugger events — MUST always continue/fulfill/fail paused requests
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== 'Fetch.requestPaused') return;

  const tabId = resolveTabIdFromSource(source);
  // Always use the event's debuggee so continue works even if our maps were reset
  const debuggee = source.targetId ? { targetId: source.targetId } : (source.tabId != null ? { tabId: source.tabId } : source);

  if (tabId != null) {
    rememberDebuggee(tabId, debuggee);
  }

  handleRequestPaused(debuggee, tabId, params).catch(async (error) => {
    console.error('[DevProxy] Unhandled requestPaused error:', error);
    await safeContinue(debuggee, params.requestId, 'unhandled error');
  });
});

// Handle debugger detach — common when DevTools opens on the same tab
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = resolveTabIdFromSource(source);
  if (tabId != null) {
    forgetDebuggee(tabId);
    console.log(`[DevProxy] Debugger detached from tab ${tabId}. Reason: ${reason}`);
    // Only soft-retry after DevTools replacement; avoid aggressive loops that re-hang tabs
    if (reason === 'replaced_with_devtools' && hasRules()) {
      scheduleReattach(tabId, 1);
    }
  } else {
    console.log('[DevProxy] Debugger detached from unknown target', source, reason);
  }
});

// Handle request interception
async function handleRequestPaused(debuggee, tabId, params) {
  const { requestId, request } = params;
  const url = request.url;

  try {
    await ensureState();

    // Skip preflight OPTIONS requests - let them pass through
    if (request.method === 'OPTIONS') {
      await safeContinue(debuggee, requestId, 'preflight');
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
      await applyRule(debuggee, requestId, params, matchingRule);
    } else {
      await safeContinue(debuggee, requestId, 'no match');
    }
  } catch (error) {
    console.error('[DevProxy] handleRequestPaused failed:', error);
    await safeContinue(debuggee, requestId, 'handler catch');
  }
}

function shouldFulfill(rule) {
  const hasBody = rule.responseBody !== undefined && rule.responseBody !== null && rule.responseBody !== '';
  const hasHeaders = rule.responseHeaders && Object.keys(rule.responseHeaders).length > 0;
  const hasCustomStatus = rule.statusCode !== undefined && rule.statusCode !== null && Number(rule.statusCode) !== 200;
  return hasBody || hasHeaders || hasCustomStatus;
}

// Apply interception rule
async function applyRule(debuggee, requestId, params, rule) {
  try {
    // Cap delay so a bad rule cannot freeze the tab indefinitely
    const delayMs = Math.min(Number(rule.delay) || 0, 30000);
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    // Delay-only / passthrough rules: continue to network after waiting
    if (!shouldFulfill(rule)) {
      await safeContinue(debuggee, requestId, 'delay-only');
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

    await chrome.debugger.sendCommand(debuggee, 'Fetch.fulfillRequest', fulfillParams);

    console.log('[DevProxy] Fulfilled', requestId, 'with status', responseCode, '(network skipped)');
  } catch (error) {
    console.error('[DevProxy] Error applying rule, continuing to network:', error);
    // Prefer continue over fail — failRequest can strand the app; continue keeps the tab usable
    await safeContinue(debuggee, requestId, 'fulfill failed');
  }
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  forgetDebuggee(tabId);
  clearReattach(tabId);
});
