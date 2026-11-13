# Content-script intercept Implementation Plan

> **For agentic workers:** implement as shipped; user waived confirm/Snyk.

**Goal:** Replace `chrome.debugger` with MAIN-world fetch/XHR patching.

**Status:** Implemented in-repo (v1.1.0).

## Files

| File | Role |
|------|------|
| `page-intercept.js` | MAIN world patch |
| `content-bridge.js` | storage → postMessage rules |
| `background.js` | rules only |
| `manifest.json` | content_scripts, drop debugger |
| `popup.js` / `README.md` | status + docs |

## Verify

1. Reload extension → hard-refresh `https://app-sinch.../register`
2. Console: `[DevProxy] Page intercept ready`
3. Rule `/middleware/iam/v2/register` → 500 → MATCH log → app sees error
