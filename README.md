# DevProxy — Network Intercept Chrome Extension

Intercept, mock, and delay **fetch / XHR** requests on normal `http(s)` pages.

## Features

- **URL Pattern Matching**: Regular expressions against the full request URL
- **Response Modification**: Custom status, body, and headers
- **Request Delay**: Artificial latency (capped at 30s)
- **Rule Management**: Enable/disable rules individually
- **No Chrome debugger**: Works with DevTools open; does not freeze page loads

## Installation

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. **Load unpacked** → select this repository folder
4. Pin DevProxy from the toolbar

After upgrading, click **Reload** on the extension card, then **hard-refresh** your app tab.

## Usage

1. Open your app tab (`https://...`)
2. Click DevProxy → **Add Rule**
3. Example for IAM register mock:
   - **URL Pattern**: `/middleware/iam/v2/register` (auto-normalized) or `.*middleware/iam/v2/register.*`
   - **Status Code**: `500`
   - **Response Body** (optional): `{"error":"mocked"}`
4. Hard-refresh the page once so content scripts load
5. Trigger the API — page console should log `[DevProxy] MATCH fetch|xhr ...`

Popup status shows **Page intercept ready** when at least one rule is enabled.

## How It Works

1. A **MAIN-world** content script patches `window.fetch` and `XMLHttpRequest` at `document_start`
2. An isolated bridge pushes `interceptRules` from `chrome.storage` into the page via `postMessage`
3. Matching calls return a mocked `Response` / XHR result without hitting the network
4. Non-matching calls use the original implementations

## Permissions

- **storage**: Save rules
- **tabs**: Popup helpers
- **host_permissions (`<all_urls>`)**: Run content scripts on http(s) pages

## Limitations

- Only **fetch** and **XHR** from the page (and same-origin frames) are intercepted
- Requests from the site’s **service worker** are not patched
- Document / CSS / image loads are never intercepted
- After installing or reloading the extension, **hard-refresh** open tabs

## Troubleshooting

**Rule not applying?**
- Hard-refresh the app tab after reloading the extension
- Confirm popup shows an enabled rule
- In the page DevTools console, look for `[DevProxy] Page intercept ready` and `[DevProxy] MATCH ...`
- Test the URL pattern against the full request URL (regex)

**Still seeing a real 200?**
- Pattern may not match (copy full URL from Network and tune regex)
- Call may come from a service worker (not supported)
- Rule may be disabled (grey indicator)

## Project Structure

```
dev-proxy/
├── manifest.json        # MV3 config (content_scripts, no debugger)
├── background.js        # Rule CRUD + storage
├── page-intercept.js    # MAIN-world fetch/XHR patch
├── content-bridge.js    # Pushes rules into the page
├── popup.html / .js / .css
├── icons/
└── README.md
```

## License

MIT
