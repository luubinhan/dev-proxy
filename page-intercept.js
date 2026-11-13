// Runs in MAIN world (page context). Patches fetch + XHR.
(function () {
  if (window.__DEVPROXY_PATCHED__) return;
  window.__DEVPROXY_PATCHED__ = true;

  let rules = [];

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'devproxy' || data.type !== 'rules') return;
    rules = Array.isArray(data.rules) ? data.rules : [];
  });

  function resolveUrl(url) {
    try {
      return new URL(String(url), location.href).href;
    } catch (_) {
      return String(url || '');
    }
  }

  function findRule(url) {
    const full = resolveUrl(url);
    for (const rule of rules) {
      if (!rule || rule.enabled === false) continue;
      try {
        if (new RegExp(rule.urlPattern).test(full)) return rule;
      } catch (error) {
        console.warn('[DevProxy] Invalid pattern:', rule.urlPattern, error);
      }
    }
    return null;
  }

  function shouldFulfill(rule) {
    const hasBody = rule.responseBody !== undefined && rule.responseBody !== null && rule.responseBody !== '';
    const hasHeaders = rule.responseHeaders && Object.keys(rule.responseHeaders).length > 0;
    const hasCustomStatus =
      rule.statusCode !== undefined && rule.statusCode !== null && Number(rule.statusCode) !== 200;
    return hasBody || hasHeaders || hasCustomStatus;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function buildMockPayload(rule) {
    const status = Number(rule.statusCode) || 200;
    const headers = {};

    if (rule.responseHeaders && typeof rule.responseHeaders === 'object') {
      for (const [name, value] of Object.entries(rule.responseHeaders)) {
        headers[name] = String(value);
      }
    }

    let body = rule.responseBody;
    if (body !== undefined && body !== null && body !== '') {
      if (typeof body === 'object') {
        body = JSON.stringify(body);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      } else if (
        typeof body === 'string' &&
        !headers['Content-Type'] &&
        !headers['content-type'] &&
        /^\s*[\{\[]/.test(body)
      ) {
        headers['Content-Type'] = 'application/json';
      } else {
        body = String(body);
      }
    } else if (status !== 200) {
      body = JSON.stringify({ error: 'Intercepted by DevProxy', status });
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    } else {
      body = '';
    }

    return { status, headers, body: body == null ? '' : String(body) };
  }

  function delayMs(rule) {
    return Math.min(Math.max(Number(rule.delay) || 0, 0), 30000);
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    let url = '';
    let method = 'GET';

    try {
      if (typeof input === 'string') {
        url = input;
      } else if (input && typeof input === 'object') {
        url = input.url || '';
        method = input.method || method;
      }
      if (init && init.method) method = init.method;
    } catch (_) {
      return originalFetch(input, init);
    }

    method = String(method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      return originalFetch(input, init);
    }

    const rule = findRule(url);
    if (!rule) {
      return originalFetch(input, init);
    }

    const wait = delayMs(rule);
    if (wait) await sleep(wait);

    if (!shouldFulfill(rule)) {
      return originalFetch(input, init);
    }

    const mock = buildMockPayload(rule);
    console.log('[DevProxy] MATCH fetch', method, resolveUrl(url), '→', mock.status);
    return new Response(mock.body, {
      status: mock.status,
      statusText: mock.status === 200 ? 'OK' : 'Error',
      headers: mock.headers
    });
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__devproxy = {
      method: String(method || 'GET').toUpperCase(),
      url: String(url || '')
    };
    return xhrOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const meta = this.__devproxy || { method: 'GET', url: '' };
    if (meta.method === 'OPTIONS') {
      return xhrSend.call(this, body);
    }

    const rule = findRule(meta.url);
    if (!rule) {
      return xhrSend.call(this, body);
    }

    const xhr = this;
    const wait = delayMs(rule);

    const finishMock = () => {
      if (!shouldFulfill(rule)) {
        xhrSend.call(xhr, body);
        return;
      }

      const mock = buildMockPayload(rule);
      console.log('[DevProxy] MATCH xhr', meta.method, resolveUrl(meta.url), '→', mock.status);

      const responseText = mock.body;
      Object.defineProperty(xhr, 'readyState', { configurable: true, get: () => 4 });
      Object.defineProperty(xhr, 'status', { configurable: true, get: () => mock.status });
      Object.defineProperty(xhr, 'statusText', {
        configurable: true,
        get: () => (mock.status === 200 ? 'OK' : 'Error')
      });
      Object.defineProperty(xhr, 'responseText', { configurable: true, get: () => responseText });
      Object.defineProperty(xhr, 'response', {
        configurable: true,
        get: () => {
          if (xhr.responseType === 'json') {
            try {
              return JSON.parse(responseText || 'null');
            } catch (_) {
              return null;
            }
          }
          return responseText;
        }
      });
      Object.defineProperty(xhr, 'getAllResponseHeaders', {
        configurable: true,
        value: () =>
          Object.entries(mock.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n')
      });
      Object.defineProperty(xhr, 'getResponseHeader', {
        configurable: true,
        value: (name) => {
          const key = String(name || '').toLowerCase();
          for (const [k, v] of Object.entries(mock.headers)) {
            if (k.toLowerCase() === key) return v;
          }
          return null;
        }
      });

      try {
        xhr.dispatchEvent(new Event('readystatechange'));
        xhr.dispatchEvent(new Event('load'));
        xhr.dispatchEvent(new Event('loadend'));
      } catch (error) {
        console.warn('[DevProxy] XHR mock event error:', error);
      }
      if (typeof xhr.onload === 'function') {
        try {
          xhr.onload(new Event('load'));
        } catch (_) {}
      }
      if (typeof xhr.onreadystatechange === 'function') {
        try {
          xhr.onreadystatechange(new Event('readystatechange'));
        } catch (_) {}
      }
    };

    if (wait) {
      setTimeout(finishMock, wait);
    } else {
      finishMock();
    }
  };

  console.log('[DevProxy] Page intercept ready (fetch/XHR)');
})();
