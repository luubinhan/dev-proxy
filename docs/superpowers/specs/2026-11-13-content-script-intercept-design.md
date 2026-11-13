# Content-script network intercept (replace debugger)

## Goal

Intercept and mock `fetch` / `XMLHttpRequest` on normal `http(s)` pages **without** `chrome.debugger`, so DevProxy works when Chrome blocks debugger attach (this machine’s failure on `https://app-sinch.../register`) and does not freeze page loads.

## Non-goals

- Intercepting requests from the page’s own service worker
- Intercepting navigations, `<img>`, CSS, or non-XHR/Fetch traffic
- Keeping a dual debugger + content-script path in v1

## Approach

1. **Inject at `document_start`**
   - Manifest `content_scripts` for `<all_urls>` (http/https).
   - A small **isolated-world** content script reads rules and installs a **MAIN-world** page script (via `script` element or `chrome.scripting.executeScript` world `MAIN`) so it sees the page’s real `fetch` / `XHR`.

2. **Rule source of truth**
   - Same `chrome.storage.local.interceptRules` as today.
   - MAIN-world script receives rules via `postMessage` / `CustomEvent` from the isolated content script; content script also listens to `chrome.storage.onChanged` and pushes updates without reload.

3. **Matching & fulfill**
   - Same regex `urlPattern`, `enabled`, `statusCode`, `delay` (cap 30s), `responseBody`, `responseHeaders`.
   - On match + should-fulfill: wait delay, return mocked `Response` / XHR result; **do not** call the network.
   - On match + delay-only: delay then call original.
   - On no match: call original immediately.
   - OPTIONS left to the browser (page scripts rarely issue raw CORS preflights the same way).

4. **Background role**
   - Keep rule CRUD + storage only.
   - **Remove** debugger attach / Fetch domain / reattach loops from the hot path.
   - Drop `debugger` permission when unused.
   - Preserve “no rules ⇒ idle” behavior (nothing to inject-activate beyond empty rules → passthrough).

5. **Popup status**
   - Replace debugger attach status with: rules count / “Page intercept ready (fetch/XHR)”.
   - Note: DevTools Network may show the request as canceled or as a synthetic response depending on Chrome; app behavior is the source of truth. Service worker logs optional via content-script `console` in page.

## Error handling

- Invalid regex → skip rule, log once, passthrough.
- Patch install failure → console warn; page stays usable.
- Storage missing → treat as `[]` (passthrough).

## Testing (manual)

1. Reload extension; open `https://app-sinch.../register` with DevTools open → page loads; popup shows intercept ready when a rule exists.
2. Rule for `/middleware/iam/v2/register`, status `500`, body JSON → trigger register → app sees 500; real server not required.
3. Disable rule → real network again.
4. Clear all rules → passthrough; no debugger banner / no attach.
5. Hard refresh still applies patch (document_start).

## Migration

- Existing saved rules keep working (same shape).
- README: document fetch/XHR-only page intercept; remove debugger troubleshooting as primary path.
