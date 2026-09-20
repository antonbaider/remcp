import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { resolveSafePath } from '../util.mjs';
import { clamp, commandExists, jsonResult, optionalString, requireEnum, spawnDetached, unavailable } from './common.mjs';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:9222';
const MAX_DISCOVERY_BYTES = 8 * 1024 * 1024;

let browserLaunchPromise = null;

function browserExecutable() {
  const configured = optionalString(process.env.REMCP_BROWSER_BINARY);
  const candidates = configured ? [configured] : process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
    : process.platform === 'win32'
      ? [
          path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ]
      : ['/opt/google/chrome/chrome','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','chromium','chromium-browser','microsoft-edge','microsoft-edge-stable'];
  return candidates.find(candidate => path.isAbsolute(candidate) ? existsSync(candidate) : commandExists(candidate)) || null;
}

export function browserAutoLaunchAvailable() {
  return Boolean(browserExecutable());
}

function browserDataDir() {
  const configured = optionalString(process.env.REMCP_BROWSER_DATA_DIR);
  if (configured) return configured;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'ReMCP', 'browser-cdp');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'ReMCP', 'browser-cdp');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'remcp', 'browser-cdp');
}

async function waitForBrowserEndpoint(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await browserCapabilityAvailable(undefined, 250)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return false;
}

async function ensureBrowserEndpoint(endpoint) {
  if (endpoint || process.env.REMCP_CDP_URL) return;
  if (await browserCapabilityAvailable(undefined, 250)) return;
  if (!browserLaunchPromise) {
    browserLaunchPromise = (async () => {
      const executable = browserExecutable();
      if (!executable) throw new Error('Browser control is unavailable: no supported Chrome, Edge, or Chromium executable was found');
      const profile = browserDataDir();
      mkdirSync(profile, { recursive:true, mode:0o700 });
      const args = [
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=9222',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
      ];
      if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) args.unshift('--headless=new');
      spawnDetached(executable, args);
      if (!await waitForBrowserEndpoint(5000)) throw new Error('ReMCP launched a browser but its local CDP endpoint did not become ready');
    })().finally(() => { browserLaunchPromise = null; });
  }
  await browserLaunchPromise;
}

export async function browserControlAvailable(endpoint, timeoutMs = 500) {
  if (await browserCapabilityAvailable(endpoint, timeoutMs)) return true;
  if (endpoint || process.env.REMCP_CDP_URL) return false;
  return browserAutoLaunchAvailable();
}

function boundedText(value, max = 1000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return ['localhost', '127.0.0.1', '::1'].includes(host);
}

function endpointUrl(value) {
  let url;
  try { url = new URL(optionalString(value) || process.env.REMCP_CDP_URL || DEFAULT_ENDPOINT); }
  catch { throw new Error('endpoint must be a valid local http(s) URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('endpoint must use http or https');
  if (!isLoopbackHost(url.hostname)) throw new Error('Browser CDP endpoint must be loopback-only');
  return url;
}

async function requestJson(pathname, endpoint, options = {}) {
  const base = endpointUrl(endpoint);
  const url = new URL(pathname, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clamp(options.timeout_ms, 5000, 100, 30_000));
  try {
    const response = await fetch(url, { method: options.method || 'GET', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_DISCOVERY_BYTES) throw new Error(`CDP discovery response is too large (${declared} bytes)`);
    const reader = response.body?.getReader();
    if (!reader) return JSON.parse(await response.text());
    const chunks = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DISCOVERY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`CDP discovery response exceeded ${MAX_DISCOVERY_BYTES} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch (error) {
    throw new Error(`Could not reach Chrome DevTools Protocol at ${base.origin}: ${error instanceof Error ? error.message : String(error)}. Start Chrome/Edge with --remote-debugging-port=9222.`);
  } finally {
    clearTimeout(timer);
  }
}

export async function browserCapabilityAvailable(endpoint, timeoutMs = 500) {
  try {
    const version = await requestJson('/json/version', endpoint, { timeout_ms: timeoutMs });
    return Boolean(version && typeof version === 'object' && (version.Browser || version.webSocketDebuggerUrl));
  } catch {
    return false;
  }
}

export async function listBrowserTargets(endpoint) {
  await ensureBrowserEndpoint(endpoint);
  const list = await requestJson('/json/list', endpoint);
  return Array.isArray(list) ? list : [];
}

async function chooseTarget(args = {}) {
  const targets = (await listBrowserTargets(args.endpoint)).filter(item => item.type === 'page' && item.webSocketDebuggerUrl);
  const id = optionalString(args.target_id || args.targetId);
  const title = optionalString(args.title);
  const urlContains = optionalString(args.url_contains || args.urlContains);
  const target = targets.find(item =>
    (!id || item.id === id) &&
    (!title || String(item.title || '').toLowerCase().includes(title.toLowerCase())) &&
    (!urlContains || String(item.url || '').toLowerCase().includes(urlContains.toLowerCase()))
  ) || targets[0];
  if (!target) unavailable('Browser control', 'no debuggable page target is available');
  let socketUrl;
  try { socketUrl = new URL(String(target.webSocketDebuggerUrl)); }
  catch { throw new Error('Browser returned an invalid CDP WebSocket URL'); }
  if (!['ws:', 'wss:'].includes(socketUrl.protocol) || !isLoopbackHost(socketUrl.hostname)) {
    throw new Error('Browser CDP WebSocket target must be loopback-only');
  }
  return { ...target, webSocketDebuggerUrl: socketUrl.href };
}

class CdpSession {
  constructor(url, timeoutMs) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();
    this.observers = new Map();
  }

  async open() {
    if (typeof WebSocket !== 'function') throw new Error('This Node.js runtime does not provide WebSocket support');
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const timer = setTimeout(() => reject(new Error('CDP websocket connection timed out')), this.timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); this.socket = socket; resolve(); }, { once: true });
      socket.addEventListener('error', event => { clearTimeout(timer); reject(new Error(event?.message || 'CDP websocket error')); }, { once: true });
      socket.addEventListener('message', event => this.onMessage(event));
      socket.addEventListener('close', () => this.onClose());
    });
    return this;
  }

  onMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result || {});
      return;
    }
    const observers = this.observers.get(message.method);
    if (observers) {
      for (const observer of [...observers]) {
        try { observer(message.params || {}); } catch {}
      }
    }
    const listeners = this.waiters.get(message.method);
    if (!listeners) return;
    this.waiters.delete(message.method);
    for (const listener of listeners) {
      clearTimeout(listener.timer);
      listener.resolve(message.params || {});
    }
  }

  onClose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CDP websocket closed'));
    }
    this.pending.clear();
    for (const listeners of this.waiters.values()) {
      for (const listener of listeners) {
        clearTimeout(listener.timer);
        listener.reject(new Error('CDP websocket closed'));
      }
    }
    this.waiters.clear();
    this.observers.clear();
  }

  observe(method, callback) {
    const listeners = this.observers.get(method) || new Set();
    listeners.add(callback);
    this.observers.set(method, listeners);
    return () => {
      const current = this.observers.get(method);
      if (!current) return;
      current.delete(callback);
      if (!current.size) this.observers.delete(method);
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const listeners = this.waiters.get(method) || [];
      const listener = { resolve, reject, timer: null };
      listener.timer = setTimeout(() => {
        const current = this.waiters.get(method) || [];
        const next = current.filter(item => item !== listener);
        if (next.length) this.waiters.set(method, next); else this.waiters.delete(method);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      listeners.push(listener);
      this.waiters.set(method, listeners);
    });
  }

  close() { try { this.socket?.close(); } catch {} }
}

async function withTarget(args, callback) {
  const target = await chooseTarget(args);
  const session = await new CdpSession(target.webSocketDebuggerUrl, clamp(args.timeout_ms, 10_000, 100, 120_000)).open();
  try { return await callback(session, target); } finally { session.close(); }
}

async function evaluate(session, expression, awaitPromise = true) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'JavaScript evaluation failed');
  }
  return result.result?.value;
}

export async function browserTabs(args = {}) {
  const targets = await listBrowserTargets(args.endpoint);
  return jsonResult(targets.filter(item => item.type === 'page').slice(0, 500).map(item => ({
    id: boundedText(item.id, 256),
    title: boundedText(item.title, 1000),
    url: boundedText(item.url, 4096),
    description: boundedText(item.description, 1000),
  })));
}

async function waitForHistoryReady(session, expectedUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = await evaluate(session, '({url:location.href,ready:document.readyState})').catch(() => null);
    if (state?.ready === 'complete' && (!expectedUrl || state.url === expectedUrl)) return true;
    await new Promise(resolve => setTimeout(resolve, 75));
  } while (Date.now() < deadline);
  return false;
}

export async function browserNavigate(args = {}) {
  const url = optionalString(args.url);
  const action = requireEnum(args.action || (url ? 'url' : 'reload'), 'action', ['url','new_tab','back','forward','reload']);
  if (['url','new_tab'].includes(action) && !url) throw new Error('url is required when action=url or new_tab');
  if (action === 'new_tab') {
    await ensureBrowserEndpoint(args.endpoint);
    const created = await requestJson(`/json/new?${encodeURIComponent(url)}`, args.endpoint, { method:'PUT', timeout_ms:args.timeout_ms });
    return jsonResult({
      target_id:created?.id || null,
      action,
      url:created?.url || url,
      title:created?.title || '',
    });
  }
  return withTarget(args, async (session, target) => {
    await session.send('Page.enable');
    const timeoutMs = clamp(args.timeout_ms, 15_000, 500, 120_000);
    const loaded = args.wait === false || ['back','forward'].includes(action)
      ? null
      : session.waitFor('Page.loadEventFired', timeoutMs).catch(() => null);
    let frameId = null;
    let errorText = null;
    let historyUrl = null;
    if (action === 'url') {
      const result = await session.send('Page.navigate', { url });
      frameId = result.frameId || null;
      errorText = result.errorText || null;
    } else if (action === 'reload') {
      await session.send('Page.reload', { ignoreCache: Boolean(args.ignore_cache) });
    } else {
      const history = await session.send('Page.getNavigationHistory');
      const current = Number(history.currentIndex || 0);
      const nextIndex = action === 'back' ? current - 1 : current + 1;
      const entry = Array.isArray(history.entries) ? history.entries[nextIndex] : null;
      if (!entry) throw new Error(`Cannot navigate ${action}: no history entry is available`);
      historyUrl = entry.url || null;
      await session.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    }
    if (loaded) await loaded;
    if (args.wait !== false && ['back','forward'].includes(action)) {
      await waitForHistoryReady(session, historyUrl, timeoutMs);
    }
    const currentUrl = await evaluate(session, 'location.href').catch(() => url || target.url || null);
    return jsonResult({ target_id: target.id, action, url: currentUrl, frame_id: frameId, error_text: errorText });
  });
}

export async function browserSnapshot(args) {
  return withTarget(args, async (session, target) => {
    await session.send('Accessibility.enable');
    const { nodes = [] } = await session.send('Accessibility.getFullAXTree');
    const limit = clamp(args.max_nodes, 1500, 1, 10_000);
    const simplified = nodes.slice(0, limit).map(node => ({
      node_id: boundedText(node.nodeId, 256),
      ignored: Boolean(node.ignored),
      role: boundedText(node.role?.value, 256),
      name: boundedText(node.name?.value, 1000),
      value: boundedText(node.value?.value, 1000),
      description: boundedText(node.description?.value, 1000),
      child_ids: Array.isArray(node.childIds) ? node.childIds.slice(0, 200).map(id => boundedText(id, 256)) : [],
      backend_dom_node_id: node.backendDOMNodeId || null,
    }));
    const payload = {
      target_id: target.id,
      title: target.title,
      url: target.url,
      count: simplified.length,
      truncated: nodes.length > limit,
      nodes: simplified,
    };
    if (!args.include_screenshot) return jsonResult(payload);

    await session.send('Page.enable');
    const selector = optionalString(args.selector);
    let restoreScroll = null;
    if (selector) {
      const bounds = await evaluate(session, `new Promise((resolve,reject) => {
        const el=document.querySelector(${JSON.stringify(selector)});
        if(!el){reject(new Error('Screenshot element not found'));return;}
        const originalScrollX=scrollX, originalScrollY=scrollY;
        const initial=el.getBoundingClientRect();
        const desiredTop=Math.max(0, scrollY + initial.top - Math.max(0,(innerHeight-initial.height)/2));
        window.scrollTo({top:desiredTop,left:scrollX,behavior:'instant'});
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const r=el.getBoundingClientRect();
          resolve({
            x:r.x,
            y:r.y,
            width:r.width,
            height:r.height,
            viewport_width:innerWidth,
            viewport_height:innerHeight,
            scroll_x:scrollX,
            scroll_y:scrollY,
            original_scroll_x:originalScrollX,
            original_scroll_y:originalScrollY,
            fully_visible:r.x>=0 && r.y>=0 && r.right<=innerWidth && r.bottom<=innerHeight
          });
        }));
      })`);
      if (!bounds || !Number.isFinite(Number(bounds.width)) || !Number.isFinite(Number(bounds.height)) || bounds.width <= 0 || bounds.height <= 0) {
        throw new Error('Screenshot element has invalid bounds');
      }
      restoreScroll = { x:Number(bounds.original_scroll_x || 0), y:Number(bounds.original_scroll_y || 0) };
      const { original_scroll_x: _originalX, original_scroll_y: _originalY, ...reportedBounds } = bounds;
      payload.screenshot_target = { selector, ...reportedBounds };
    }
    payload.screenshot = {
      scope: 'viewport',
      width: await evaluate(session, 'innerWidth').catch(() => null),
      height: await evaluate(session, 'innerHeight').catch(() => null),
    };
    const result = jsonResult(payload);
    let captured;
    try {
      captured = await session.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      });
    } finally {
      if (restoreScroll) {
        await evaluate(session, `window.scrollTo({left:${restoreScroll.x},top:${restoreScroll.y},behavior:'instant'})`).catch(() => {});
      }
    }
    const data = String(captured?.data || '');
    if (!data) throw new Error('CDP returned no screenshot data');
    if (Buffer.byteLength(data, 'base64') > 8 * 1024 * 1024) throw new Error('Browser screenshot exceeds the 8 MiB inline image limit');
    result.content.push({ type:'image', data, mimeType:'image/png' });
    return result;
  });
}

function findExpression(args) {
  const selector = optionalString(args.selector);
  const needle = optionalString(args.text);
  const role = optionalString(args.role);
  const limit = clamp(args.limit, 20, 1, 200);
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const needle = ${JSON.stringify(needle)};
    const role = ${JSON.stringify(role)};
    const source = selector ? Array.from(document.querySelectorAll(selector)) : Array.from(document.querySelectorAll('*'));
    function cssPath(el) {
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      while (el && el.nodeType === 1 && el !== document.documentElement) {
        let part = el.tagName.toLowerCase();
        if (el.parentElement) {
          const same = Array.from(el.parentElement.children).filter(x => x.tagName === el.tagName);
          if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
        }
        parts.unshift(part); el = el.parentElement;
      }
      return parts.join(' > ');
    }
    return source.filter(el => {
      const style = getComputedStyle(el);
      const visible = style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0;
      const hay = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
      const r = el.getAttribute('role') || '';
      return visible && (!needle || hay.toLowerCase().includes(needle.toLowerCase())) && (!role || r.toLowerCase() === role.toLowerCase());
    }).slice(0, ${limit}).map(el => {
      const b = el.getBoundingClientRect();
      return { selector: cssPath(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name: el.getAttribute('aria-label') || el.getAttribute('name') || '', text: (el.innerText || el.textContent || '').trim().slice(0, 500), value: 'value' in el ? String(el.value).slice(0, 500) : '', x: b.x, y: b.y, width: b.width, height: b.height, disabled: Boolean(el.disabled) };
    });
  })()`;
}

export async function browserFind(args) {
  if (!(args.selector || args.text || args.role)) throw new Error('browser_find requires selector, text, or role; use browser_snapshot to enumerate page structure');
  return withTarget(args, async (session, target) => {
    const matches = await evaluate(session, findExpression(args));
    return jsonResult({ target_id: target.id, count: Array.isArray(matches) ? matches.length : 0, matches: Array.isArray(matches) ? matches : [] });
  });
}

function elementLookup(args) {
  const selector = optionalString(args.selector);
  const needle = optionalString(args.text);
  if (!selector && !needle) throw new Error('selector or text is required');
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const needle = ${JSON.stringify(needle)};
    let el = selector ? document.querySelector(selector) : null;
    if (!el && needle) el = Array.from(document.querySelectorAll('*')).find(x => ((x.innerText || x.textContent || '').trim().toLowerCase().includes(needle.toLowerCase())));
    return el;
  })()`;
}

export async function browserAction(args) {
  const action = requireEnum(args.action, 'action', ['click', 'focus', 'type', 'set_value', 'select', 'scroll_into_view', 'upload', 'press', 'set_viewport']);
  return withTarget(args, async (session, target) => {
    if (action === 'set_viewport') {
      const width = clamp(args.width, 1280, 200, 8192);
      const height = clamp(args.height, 720, 200, 8192);
      const deviceScaleFactor = Math.max(0.1, Math.min(8, Number(args.device_scale_factor) || 1));
      await session.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile: Boolean(args.mobile),
        screenWidth: width,
        screenHeight: height,
      });
      return jsonResult({ target_id:target.id, action, width, height, device_scale_factor:deviceScaleFactor, mobile:Boolean(args.mobile) });
    }
    if (action === 'upload') {
      const selector = optionalString(args.selector);
      if (!selector) throw new Error('selector is required for upload');
      const requested = (Array.isArray(args.paths) ? args.paths : [args.path]).filter(Boolean);
      if (!requested.length) throw new Error('path or paths is required for upload');
      const files = [];
      for (const value of requested) files.push(await resolveSafePath(value, 'path'));
      await session.send('DOM.enable');
      const doc = await session.send('DOM.getDocument', { depth: 1 });
      const found = await session.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
      if (!found.nodeId) throw new Error(`No element matches selector ${selector}`);
      await session.send('DOM.setFileInputFiles', { nodeId: found.nodeId, files });
      return jsonResult({ target_id: target.id, action, selector, files: files.length });
    }
    if (action === 'press') {
      const key = optionalString(args.key);
      if (!key) throw new Error('key is required for press');
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
      return jsonResult({ target_id: target.id, action, key });
    }
    const lookup = elementLookup(args);
    const value = String(args.value ?? args.text_value ?? '');
    const option = String(args.option ?? value);

    if (action === 'click') {
      const rect = await evaluate(session, `(() => {
        const el = ${lookup};
        if (!el) throw new Error('Element not found');
        el.scrollIntoView({block:'center',inline:'center'});
        const b = el.getBoundingClientRect();
        if (!b.width || !b.height) throw new Error('Element has no clickable bounds');
        return { tag:el.tagName.toLowerCase(), x:b.x, y:b.y, width:b.width, height:b.height };
      })()`);
      const x = Number(rect.x) + Number(rect.width) / 2;
      const y = Number(rect.y) + Number(rect.height) / 2;
      await session.send('Input.dispatchMouseEvent', { type:'mouseMoved', x, y, button:'none' });
      await session.send('Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'left', clickCount:1 });
      await session.send('Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'left', clickCount:1 });
      return jsonResult({ target_id:target.id, action, result:{ ...rect, x, y } });
    }

    if (action === 'type') {
      const focused = await evaluate(session, `(() => {
        const el = ${lookup};
        if (!el) throw new Error('Element not found');
        el.scrollIntoView({block:'center',inline:'center'});
        el.focus();
        const b = el.getBoundingClientRect();
        return { tag:el.tagName.toLowerCase(), value:'value' in el?String(el.value):'', x:b.x, y:b.y, width:b.width, height:b.height };
      })()`);
      await session.send('Input.insertText', { text:value });
      const current = await evaluate(session, `(() => { const el=${lookup}; return 'value' in el ? String(el.value) : ''; })()`);
      return jsonResult({ target_id:target.id, action, result:{ ...focused, value:current } });
    }

    const expression = `(() => {
      const el = ${lookup};
      if (!el) throw new Error('Element not found');
      ${action === 'focus' ? 'el.focus();' :
        action === 'scroll_into_view' ? "el.scrollIntoView({block:'center',inline:'center'});" :
        action === 'select' ? `el.value=${JSON.stringify(option)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));` :
        `const proto=Object.getPrototypeOf(el);const own=Object.getOwnPropertyDescriptor(proto,'value');const parent=Object.getPrototypeOf(proto);const inherited=parent?Object.getOwnPropertyDescriptor(parent,'value'):null;const setter=own?.set||inherited?.set;if(setter)setter.call(el,${JSON.stringify(value)});else el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));`
      }
      const b = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), value: 'value' in el ? String(el.value) : '', x: b.x, y: b.y, width: b.width, height: b.height };
    })()`;
    return jsonResult({ target_id: target.id, action, result: await evaluate(session, expression) });
  });
}

export async function browserWait(args = {}) {
  const condition = requireEnum(args.condition || 'selector', 'condition', ['selector', 'text', 'url_contains', 'expression', 'load', 'navigation', 'network_idle']);
  const timeoutMs = clamp(args.timeout_ms, 10_000, 100, 120_000);
  const pollMs = clamp(args.poll_ms, 200, 50, 5000);
  const idleMs = clamp(args.idle_ms, 500, 100, 10_000);
  const wanted = optionalString(args.selector || args.text || args.value || args.expression);
  if (['selector','text','url_contains','expression'].includes(condition) && !wanted) throw new Error('selector/text/value/expression is required for this condition');
  return withTarget(args, async (session, target) => {
    const started = Date.now();
    const initialUrl = await evaluate(session, 'location.href').catch(() => target.url || '');
    const inflight = new Set();
    let lastResourceCount = -1;
    let stableSince = Date.now();
    const unsubscribers = [];
    if (condition === 'network_idle') {
      await session.send('Network.enable');
      const markBusy = params => {
        if (params?.requestId) inflight.add(params.requestId);
        stableSince = Date.now();
      };
      const markDone = params => {
        if (params?.requestId) inflight.delete(params.requestId);
        stableSince = Date.now();
      };
      unsubscribers.push(
        session.observe('Network.requestWillBeSent', markBusy),
        session.observe('Network.loadingFinished', markDone),
        session.observe('Network.loadingFailed', markDone),
      );
    }
    try {
      while (Date.now() - started < timeoutMs) {
        let matched = false;
        if (condition === 'network_idle') {
          const state = await evaluate(session, `({ready:document.readyState,resources:performance.getEntriesByType('resource').length})`).catch(() => null);
          if (state) {
            if (state.resources !== lastResourceCount) {
              lastResourceCount = state.resources;
              stableSince = Date.now();
            }
            matched = state.ready === 'complete' && inflight.size === 0 && Date.now() - stableSince >= idleMs;
          }
        } else {
          const expression = condition === 'selector' ? `Boolean(document.querySelector(${JSON.stringify(wanted)}))`
            : condition === 'text' ? `(document.body?.innerText||'').toLowerCase().includes(${JSON.stringify(wanted?.toLowerCase())})`
            : condition === 'url_contains' ? `location.href.includes(${JSON.stringify(wanted)})`
            : condition === 'load' ? `document.readyState === 'complete'`
            : condition === 'navigation' ? `location.href !== ${JSON.stringify(initialUrl)}`
            : `Boolean(${wanted})`;
          matched = Boolean(await evaluate(session, expression));
        }
        if (matched) return jsonResult({
          target_id: target.id,
          condition,
          matched: true,
          elapsed_ms: Date.now() - started,
          ...(condition === 'network_idle' ? { inflight: inflight.size, idle_ms: idleMs } : {}),
          url: await evaluate(session, 'location.href').catch(() => target.url || null),
        });
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }
      return jsonResult({
        target_id: target.id,
        condition,
        matched: false,
        elapsed_ms: Date.now() - started,
        ...(condition === 'network_idle' ? { inflight: inflight.size, idle_ms: idleMs } : {}),
        url: await evaluate(session, 'location.href').catch(() => target.url || null),
      });
    } finally {
      for (const unsubscribe of unsubscribers) unsubscribe();
    }
  });
}

export async function browserEvaluate(args) {
  const expression = optionalString(args.expression);
  if (!expression) throw new Error('expression is required');
  return withTarget(args, async (session, target) => jsonResult({ target_id: target.id, value: await evaluate(session, expression, args.await_promise !== false) }));
}

export const browserHandlers = {
  browser_tabs: browserTabs,
  browser_navigate: browserNavigate,
  browser_snapshot: browserSnapshot,
  browser_find: browserFind,
  browser_action: browserAction,
  browser_wait: browserWait,
  browser_evaluate: browserEvaluate,
};
