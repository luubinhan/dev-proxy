// Popup UI Logic

let currentEditIndex = -1;

// DOM Elements
const enableToggle = document.getElementById('enableToggle');
const statusText = document.getElementById('statusText');
const addRuleBtn = document.getElementById('addRuleBtn');
const rulesList = document.getElementById('rulesList');
const ruleModal = document.getElementById('ruleModal');
const modalTitle = document.getElementById('modalTitle');
const ruleForm = document.getElementById('ruleForm');
const cancelBtn = document.getElementById('cancelBtn');
const closeBtn = document.querySelector('.close');

// Initialize popup
async function init() {
  await loadStatus();
  await loadRules();
  setupEventListeners();
}

// Setup event listeners
function setupEventListeners() {
  enableToggle.addEventListener('change', handleToggleChange);
  addRuleBtn.addEventListener('click', () => openModal());
  cancelBtn.addEventListener('click', closeModal);
  closeBtn.addEventListener('click', closeModal);
  ruleForm.addEventListener('submit', handleFormSubmit);
  
  // Close modal when clicking outside
  ruleModal.addEventListener('click', (e) => {
    if (e.target === ruleModal) {
      closeModal();
    }
  });
  
  // Event delegation for rule action buttons
  rulesList.addEventListener('click', (e) => {
    const target = e.target;
    
    if (target.classList.contains('btn-toggle')) {
      const index = parseInt(target.dataset.index);
      toggleRule(index);
    } else if (target.classList.contains('btn-edit')) {
      const index = parseInt(target.dataset.index);
      editRule(index);
    } else if (target.classList.contains('btn-delete')) {
      const index = parseInt(target.dataset.index);
      deleteRule(index);
    }
  });
}

// Load intercept status
async function loadStatus() {
  const response = await sendMessage({ action: 'getStatus' });
  enableToggle.checked = response.isEnabled;
  updateStatusText(response.isEnabled);
}

// Update status text
function updateStatusText(isEnabled) {
  statusText.textContent = isEnabled ? 'Enabled' : 'Disabled';
  statusText.style.color = isEnabled ? '#4CAF50' : '#666';
}

// Handle toggle change
async function handleToggleChange(e) {
  const enabled = e.target.checked;
  
  try {
    const response = await sendMessage({ 
      action: 'toggleIntercept', 
      enabled 
    });
    
    if (response.success) {
      updateStatusText(enabled);
    } else {
      // Revert toggle if failed
      e.target.checked = !enabled;
      alert('Failed to toggle intercept');
    }
  } catch (error) {
    console.error('Error toggling intercept:', error);
    e.target.checked = !enabled;
    alert('Error: ' + error.message);
  }
}

// Load rules
async function loadRules() {
  const response = await sendMessage({ action: 'getRules' });
  displayRules(response.rules);
}

// Display rules
function displayRules(rules) {
  if (!rules || rules.length === 0) {
    rulesList.innerHTML = `
      <div class="empty-state">
        <p>No intercept rules defined</p>
        <p style="font-size: 12px; margin-top: 8px;">Click "Add Rule" to create your first rule</p>
      </div>
    `;
    return;
  }

  rulesList.innerHTML = rules.map((rule, index) => `
    <div class="rule-item ${rule.enabled ? '' : 'disabled'}">
      <div class="rule-header">
        <span class="rule-pattern">${escapeHtml(rule.urlPattern)}</span>
        
      </div>
      <div class="rule-details">
        <div class="rule-detail-group">
          <div class="rule-detail">
            <strong>Status:</strong> <span class="rule-status" data-color="${formatStatusCode(rule.statusCode)}">${rule.statusCode || 200}</span>
          </div>
          ${rule.delay ? `
            <div class="rule-detail">
              <strong>Delay:</strong> ${rule.delay}ms
            </div>
          ` : ''}
          <div class="rule-actions">
            <button class="btn btn-icon btn-toggle" data-index="${index}">
              ${rule.enabled ? '🟢' : '⚪'}
            </button>
            <button class="btn btn-icon btn-edit" data-index="${index}">⚙️</button>
            <button class="btn btn-icon btn-danger btn-delete" data-index="${index}">Delete</button>
          </div>
        </div>
        
        ${rule.responseBody ? `
        <div class="rule-detail-group">
          <div class="rule-detail">
            <strong>Custom Response:</strong> Yes
          </div>
        </div>
        ` : ''}
      </div>
    </div>
  `).join('');
}

// Open modal for adding/editing rule
function openModal(rule = null, index = -1) {
  currentEditIndex = index;
  
  if (rule) {
    modalTitle.textContent = 'Edit Rule';
    document.getElementById('urlPattern').value = rule.urlPattern || '';
    document.getElementById('statusCode').value = rule.statusCode || 200;
    document.getElementById('delay').value = rule.delay || 0;
    document.getElementById('responseBody').value = 
      typeof rule.responseBody === 'object' 
        ? JSON.stringify(rule.responseBody, null, 2) 
        : (rule.responseBody || '');
  } else {
    modalTitle.textContent = 'Add Rule';
    ruleForm.reset();
  }
  
  ruleModal.classList.add('show');
}

// Close modal
function closeModal() {
  ruleModal.classList.remove('show');
  ruleForm.reset();
  currentEditIndex = -1;
}

// Handle form submit
async function handleFormSubmit(e) {
  e.preventDefault();
  
  const urlPattern = document.getElementById('urlPattern').value.trim();
  const statusCode = parseInt(document.getElementById('statusCode').value) || 200;
  const delay = parseInt(document.getElementById('delay').value) || 0;
  const responseBodyStr = document.getElementById('responseBody').value.trim();
  
  // Validate URL pattern
  try {
    new RegExp(urlPattern);
  } catch (error) {
    alert('Invalid URL pattern (RegEx): ' + error.message);
    return;
  }
  
  // Parse response body
  let responseBody = responseBodyStr;
  if (responseBodyStr) {
    try {
      responseBody = JSON.parse(responseBodyStr);
    } catch (error) {
      // Keep as string if not valid JSON
    }
  }
  
  const rule = {
    urlPattern,
    statusCode,
    delay,
    responseBody,
    enabled: true
  };
  
  try {
    let response;
    if (currentEditIndex >= 0) {
      response = await sendMessage({ 
        action: 'updateRule', 
        index: currentEditIndex, 
        rule 
      });
    } else {
      response = await sendMessage({ 
        action: 'addRule', 
        rule 
      });
    }
    
    if (response.success) {
      closeModal();
      await loadRules();
    } else {
      alert('Failed to save rule: ' + (response.error || 'Unknown error'));
    }
  } catch (error) {
    console.error('Error saving rule:', error);
    alert('Error: ' + error.message);
  }
}

// Toggle rule
async function toggleRule(index) {
  const response = await sendMessage({ 
    action: 'toggleRule', 
    index 
  });
  
  if (response.success) {
    await loadRules();
  }
}

// Edit rule
async function editRule(index) {
  const response = await sendMessage({ action: 'getRules' });
  if (response.rules && response.rules[index]) {
    openModal(response.rules[index], index);
  }
}

// Delete rule
async function deleteRule(index) {
  if (!confirm('Are you sure you want to delete this rule?')) {
    return;
  }
  
  const response = await sendMessage({ 
    action: 'deleteRule', 
    index 
  });
  
  if (response.success) {
    await loadRules();
  }
}

// Send message to background script
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// Format status code to grouped range (2xx, 3xx, 4xx, 5xx)
function formatStatusCode(statusCode) {
  const code = statusCode || 200;
  if (code >= 200 && code < 300) return '2xx';
  if (code >= 300 && code < 400) return '3xx';
  if (code >= 400 && code < 500) return '4xx';
  if (code >= 500 && code < 600) return '5xx';
  return code.toString();
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
