// Network Intercept Background Service Worker

let interceptRules = [];
let attachedTabs = new Set();
let isEnabled = false;

// Load rules from storage on startup
chrome.storage.local.get(['interceptRules', 'isEnabled'], (result) => {
  interceptRules = result.interceptRules || [];
  isEnabled = result.isEnabled || false;
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'getStatus':
      sendResponse({ isEnabled, attachedTabs: Array.from(attachedTabs) });
      break;
    
    case 'toggleIntercept':
      isEnabled = message.enabled;
      chrome.storage.local.set({ isEnabled });
      
      if (isEnabled) {
        attachDebuggerToActiveTab();
      } else {
        detachAllDebuggers();
      }
      sendResponse({ success: true });
      break;
    
    case 'getRules':
      sendResponse({ rules: interceptRules });
      break;
    
    case 'addRule':
      interceptRules.push(message.rule);
      chrome.storage.local.set({ interceptRules });
      sendResponse({ success: true });
      break;
    
    case 'updateRule':
      if (message.index >= 0 && message.index < interceptRules.length) {
        interceptRules[message.index] = message.rule;
        chrome.storage.local.set({ interceptRules });
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Invalid index' });
      }
      break;
    
    case 'deleteRule':
      if (message.index >= 0 && message.index < interceptRules.length) {
        interceptRules.splice(message.index, 1);
        chrome.storage.local.set({ interceptRules });
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Invalid index' });
      }
      break;
    
    case 'toggleRule':
      if (message.index >= 0 && message.index < interceptRules.length) {
        interceptRules[message.index].enabled = !interceptRules[message.index].enabled;
        chrome.storage.local.set({ interceptRules });
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Invalid index' });
      }
      break;
    
    case 'clearAllRules':
      interceptRules = [];
      chrome.storage.local.set({ interceptRules });
      sendResponse({ success: true });
      break;
  }
  return true; // Keep message channel open for async response
});

// Attach debugger to active tab
async function attachDebuggerToActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      await attachDebugger(tab.id);
    }
  } catch (error) {
    console.error('Error attaching debugger:', error);
  }
}

// Attach debugger to specific tab
async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) {
    return; // Already attached
  }

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
    
    // Enable network tracking
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
      patterns: [{ urlPattern: '*' }]
    });
    
    console.log(`Debugger attached to tab ${tabId}`);
  } catch (error) {
    console.error(`Failed to attach debugger to tab ${tabId}:`, error);
    attachedTabs.delete(tabId);
  }
}

// Detach debugger from all tabs
async function detachAllDebuggers() {
  for (const tabId of attachedTabs) {
    try {
      await chrome.debugger.detach({ tabId });
      console.log(`Debugger detached from tab ${tabId}`);
    } catch (error) {
      console.error(`Failed to detach debugger from tab ${tabId}:`, error);
    }
  }
  attachedTabs.clear();
}

// Handle debugger events
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!isEnabled) return;

  if (method === 'Fetch.requestPaused') {
    handleRequestPaused(source.tabId, params);
  }
});

// Handle debugger detach
chrome.debugger.onDetach.addListener((source, reason) => {
  attachedTabs.delete(source.tabId);
  console.log(`Debugger detached from tab ${source.tabId}. Reason: ${reason}`);
});

// Handle request interception
async function handleRequestPaused(tabId, params) {
  const { requestId, request } = params;
  const url = request.url;

  // Find matching rule
  const matchingRule = interceptRules.find(rule => {
    if (!rule.enabled) return false;
    
    try {
      const urlPattern = new RegExp(rule.urlPattern);
      return urlPattern.test(url);
    } catch (error) {
      console.error('Invalid URL pattern:', rule.urlPattern, error);
      return false;
    }
  });

  if (matchingRule) {
    console.log(`Intercepting request: ${url}`);
    await applyRule(tabId, requestId, params, matchingRule);
  } else {
    // Continue without modification
    try {
      await chrome.debugger.sendCommand(
        { tabId },
        'Fetch.continueRequest',
        { requestId }
      );
    } catch (error) {
      console.error('Error continuing request:', error);
    }
  }
}

// Apply interception rule
async function applyRule(tabId, requestId, params, rule) {
  try {
    // Apply delay if specified
    if (rule.delay && rule.delay > 0) {
      await new Promise(resolve => setTimeout(resolve, rule.delay));
    }

    // Prepare response override
    const responseHeaders = [
      { name: 'Access-Control-Allow-Origin', value: '*' }
    ];

    let responseCode = rule.statusCode || 200;
    let body = rule.responseBody || '';

    // Convert body to base64 if needed
    let base64Body = '';
    if (body) {
      if (typeof body === 'object') {
        body = JSON.stringify(body);
        responseHeaders.push({ name: 'Content-Type', value: 'application/json' });
      }
      base64Body = btoa(unescape(encodeURIComponent(body)));
    }

    // Fulfill request with modified response
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

    console.log(`Request intercepted and modified: ${params.request.url}`);
  } catch (error) {
    console.error('Error applying rule:', error);
    
    // Try to continue the request if modification fails
    try {
      await chrome.debugger.sendCommand(
        { tabId },
        'Fetch.continueRequest',
        { requestId }
      );
    } catch (continueError) {
      console.error('Error continuing request after failure:', continueError);
    }
  }
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  
  // Auto-disable extension when all tabs are closed
  if (attachedTabs.size === 0 && isEnabled) {
    isEnabled = false;
    chrome.storage.local.set({ isEnabled });
    console.log('Extension auto-disabled: all tabs closed');
  }
});
