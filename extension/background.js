/**
 * Tiny Browser — background service worker
 *
 * All browser interactions go through CDP (chrome.debugger) to simulate
 * realistic human mouse + keyboard behavior.
 */

const WS_URL = 'ws://localhost:7331';
const RECONNECT_DELAY_MS = 3000;
const KEEPALIVE_ALARM = 'tiny-mcp-keepalive';

// Interactive element selector — used for text-based element finding.
// Restricted to truly actionable elements; excludes generic containers.
const INTERACTIVE =
  'button, a, input, textarea, select, summary, ' +
  '[role="button"], [role="link"], [role="checkbox"], ' +
  '[role="menuitem"], [role="tab"], [role="option"], [role="radio"]';

let ws = null;
let connected = false;

// ---------------------------------------------------------------------------
// Active-tab tracking
//
// chrome.tabs.query({ active:true, lastFocusedWindow:true }) returns the wrong
// tab when multiple Chrome windows are open and a non-Chrome app (e.g. Cursor)
// has focus. Instead we track the last tab that was activated inside any Chrome
// window and fall back to the query only when no tab has been seen yet.
// ---------------------------------------------------------------------------

let lastActiveTabId = null;

chrome.tabs.onActivated.addListener(({ tabId }) => {
  lastActiveTabId = tabId;
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return; // non-Chrome app focused
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab?.id) lastActiveTabId = tab.id;
});

// ---------------------------------------------------------------------------
// Persistent debugger sessions
//
// Attaching/detaching CDP on every command fires browser-level focus events
// (blur, visibilitychange) that can dismiss JS-managed overlays.
// Instead, we keep the debugger attached for the lifetime of the tab session
// and only re-attach when Chrome auto-detaches (navigation, DevTools open).
// ---------------------------------------------------------------------------

const debuggerSessions = new Set(); // tabIds with active debugger

// ---------------------------------------------------------------------------
// Console and network buffers
//
// Entries are keyed by tabId and capped to avoid unbounded growth.
// ts fields are Unix ms (params.timestamp * 1000) so the AI can filter with
// standard Date.now() values or `date +%s%3N` in shell.
// ---------------------------------------------------------------------------

const MAX_CONSOLE_ENTRIES = 500;
const MAX_NETWORK_ENTRIES = 200;

const consoleLogs     = new Map(); // tabId → ConsoleEntry[]
const networkRequests = new Map(); // tabId → Map(requestId → NetworkEntry)
const networkEnabled  = new Set(); // tabIds with Network domain active

chrome.debugger.onDetach.addListener(({ tabId }) => {
  if (tabId != null) debuggerSessions.delete(tabId);
  // Buffers are intentionally kept across navigations so the AI can read
  // cross-navigation logs. They are cleared only when the tab is closed.
});
chrome.tabs.onRemoved.addListener((tabId) => {
  debuggerSessions.delete(tabId);
  consoleLogs.delete(tabId);
  networkRequests.delete(tabId);
  networkEnabled.delete(tabId);
});

async function ensureDebugger(tabId) {
  if (!debuggerSessions.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
    // Re-enable Network if it was active before a navigation caused a detach
    if (networkEnabled.has(tabId)) {
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    }
    debuggerSessions.add(tabId);
  }
  return { tabId };
}

// ---------------------------------------------------------------------------
// CDP event listener — buffers console and network events as they arrive
// ---------------------------------------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;

  if (method === 'Runtime.consoleAPICalled') {
    const text = (params.args ?? [])
      .map(a => a.value !== undefined ? String(a.value) : (a.description ?? a.type))
      .join(' ');
    const entries = consoleLogs.get(tabId) ?? [];
    entries.push({
      level: params.type,
      text,
      ts:   Math.round(params.timestamp * 1000),
      url:  params.stackTrace?.callFrames?.[0]?.url  ?? null,
      line: params.stackTrace?.callFrames?.[0]?.lineNumber ?? null,
    });
    if (entries.length > MAX_CONSOLE_ENTRIES) entries.shift();
    consoleLogs.set(tabId, entries);
  }

  if (method === 'Runtime.exceptionThrown') {
    const ex = params.exceptionDetails;
    const entries = consoleLogs.get(tabId) ?? [];
    entries.push({
      level: 'error',
      text:  ex.exception?.description ?? ex.text,
      ts:    Math.round(params.timestamp * 1000),
      url:   ex.url  ?? null,
      line:  ex.lineNumber ?? null,
    });
    if (entries.length > MAX_CONSOLE_ENTRIES) entries.shift();
    consoleLogs.set(tabId, entries);
  }

  if (method === 'Network.requestWillBeSent') {
    const reqs = networkRequests.get(tabId) ?? new Map();
    reqs.set(params.requestId, {
      method:   params.request.method,
      url:      params.request.url,
      type:     params.type,
      ts:       Math.round(params.timestamp * 1000),
      status:   null,
      size:     null,
      duration: null,
    });
    // Evict oldest entry when cap is reached (Map preserves insertion order)
    if (reqs.size > MAX_NETWORK_ENTRIES) reqs.delete(reqs.keys().next().value);
    networkRequests.set(tabId, reqs);
  }

  if (method === 'Network.responseReceived') {
    const r = networkRequests.get(tabId)?.get(params.requestId);
    if (r) r.status = params.response.status;
  }

  if (method === 'Network.loadingFinished') {
    const r = networkRequests.get(tabId)?.get(params.requestId);
    if (r) {
      r.size     = params.encodedDataLength;
      r.duration = Math.round((params.timestamp - r.ts / 1000) * 1000); // ms
    }
  }

  if (method === 'Network.loadingFailed') {
    const r = networkRequests.get(tabId)?.get(params.requestId);
    if (r) r.error = params.errorText;
  }
});

// ---------------------------------------------------------------------------
// WebSocket keepalive
// ---------------------------------------------------------------------------

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 / 3 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!connected || ws?.readyState !== WebSocket.OPEN) connect();
});

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  ws = new WebSocket(WS_URL);
  ws.addEventListener('open', () => { connected = true; console.log('[tiny-mcp] connected'); });
  ws.addEventListener('message', async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    const result = await dispatch(msg);
    ws.send(JSON.stringify({ id: msg.id, result }));
  });
  ws.addEventListener('close', () => { connected = false; setTimeout(connect, RECONNECT_DELAY_MS); });
  ws.addEventListener('error', () => {});
}

async function dispatch(msg) {
  try {
    switch (msg.command) {
      case 'screenshot':     return await cmdScreenshot(msg.params);
      case 'click':          return await cmdClick(msg.params);
      case 'type':           return await cmdType(msg.params);
      case 'scroll':         return await cmdScroll(msg.params);
      case 'navigate':       return await cmdNavigate(msg.params);
      case 'get_url':        return await cmdGetUrl(msg.params);
      case 'read_page':      return await cmdReadPage(msg.params);
      case 'key_press':      return await cmdKeyPress(msg.params);
      case 'find_element':   return await cmdFindElement(msg.params);
      case 'click_element':  return await cmdClickElement(msg.params);
      case 'wait':           return await cmdWait(msg.params);
      case 'query':          return await cmdQuery(msg.params);
      case 'list_tabs':      return await cmdListTabs();
      case 'new_tab':        return await cmdNewTab(msg.params);
      case 'switch_tab':     return await cmdSwitchTab(msg.params);
      case 'close_tab':      return await cmdCloseTab(msg.params);
      case 'wait_for_element': return await cmdWaitForElement(msg.params);
      case 'get_console':    return await cmdGetConsole(msg.params);
      case 'enable_network': return await cmdEnableNetwork(msg.params);
      case 'get_network':    return await cmdGetNetwork(msg.params);
      default:               return { error: `unknown command: ${msg.command}` };
    }
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function getActiveTab() {
  if (lastActiveTabId != null) {
    try {
      const tab = await chrome.tabs.get(lastActiveTabId);
      if (tab?.id) return tab;
    } catch { /* tab was closed — fall through */ }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('no active tab');
  return tab;
}

/**
 * Resolve the target tab for a command.
 * If params.tabId is set, use that specific tab (enables parallel multi-tab operations).
 * Otherwise fall back to the last active Chrome tab.
 */
async function resolveTab(params) {
  if (params?.tabId != null) return chrome.tabs.get(params.tabId);
  return getActiveTab();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base, range) => base + Math.random() * range;

// ---------------------------------------------------------------------------
// Human-like input primitives
// ---------------------------------------------------------------------------

/**
 * Simulate a mouse click at (x, y).
 *
 * precise:true — skip jitter moves and long press-hold delay (~200ms saved,
 * exact pixel targeting).  Use for data tables, coordinate grids, or any
 * scenario where a few pixels matter.
 *
 * Default (precise:false) — human-like jitter + natural press-hold timing,
 * better for sites that check for bot-like instant clicks.
 */
async function humanClick(target, x, y, { precise = false } = {}) {
  // mouseMoved pre-click jitter was removed: Input.dispatchMouseEvent(mouseMoved)
  // suffers a multi-stage lazy-init penalty (~0.9-5 s per call) in Chrome's CDP
  // input pipeline that makes every non-precise click 3-5× slower with zero
  // practical benefit for a local AI agent using CDP.
  // If hover-triggered UI is needed, dispatch an explicit mouseMoved before calling click.
  const base = { x, y, button: 'left', clickCount: 1, modifiers: 0 };
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent',
    { ...base, type: 'mousePressed' });
  await sleep(precise ? 10 : jitter(60, 80));
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent',
    { ...base, type: 'mouseReleased' });
}

/** Focus element at (x, y) using CDP DOM API — bypasses JS event handling. */
async function cdpFocus(target, x, y) {
  try {
    await chrome.debugger.sendCommand(target, 'DOM.enable');
    await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: 0 });
    const { nodeId } = await chrome.debugger.sendCommand(target, 'DOM.getNodeForLocation', {
      x: Math.round(x), y: Math.round(y),
      includeUserAgentShadowDOM: false,
      ignorePointerEventsNone: true,
    });
    if (nodeId) await chrome.debugger.sendCommand(target, 'DOM.focus', { nodeId });
  } catch { /* best-effort */ }
}

/** Dispatch a single character as rawKeyDown + char + keyUp. */
async function humanTypeKey(target, char) {
  const charCode = char.charCodeAt(0);
  const base = {
    key: char, text: char, unmodifiedText: char,
    windowsVirtualKeyCode: charCode, nativeVirtualKeyCode: charCode, modifiers: 0,
  };
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...base, type: 'char' });
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

// ---------------------------------------------------------------------------
// Shared element-finding JS expression (runs inside Runtime.evaluate)
//
// Returns the element reference itself (not a JSON string) so callers can
// do further work (getBoundingClientRect, click, etc.) in the same expression.
//
// Strategy:
//   1. Restrict to truly interactive elements (not generic containers).
//   2. Filter to visible elements with non-zero bounding boxes.
//   3. Optional positional constraints: x_max, within_selector, nth.
//   4. visible_only: element must not be hidden (offsetParent !== null or visible rect).
//   5. Shadow DOM fallback: if nothing found in the regular DOM, repeat the
//      search across all open shadow roots recursively (Option A — implicit).
//   6. Among matches, pick the *smallest* element by bounding area.
// ---------------------------------------------------------------------------

function buildFindExpr(selector, text, exact = false, opts = {}) {
  const { x_max, within_selector, nth = 0, visible_only = false } = opts;

  // Helper: collect all elements matching `sel` in `root`, then recurse into shadow roots
  const collectFn = `
    function collectAll(root, sel) {
      const els = Array.from(root.querySelectorAll(sel));
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) els.push(...collectAll(el.shadowRoot, sel));
      });
      return els;
    }`;

  if (selector) {
    // Selector path: try regular DOM first, then shadow DOM
    return `(() => {
      ${collectFn}
      // Try light DOM first for speed
      let el = ${within_selector
        ? `document.querySelector(${JSON.stringify(within_selector)})?.querySelector(${JSON.stringify(selector)})`
        : `document.querySelector(${JSON.stringify(selector)})`};
      // Fall back to full shadow-piercing search
      if (!el) {
        const scope = ${within_selector
          ? `document.querySelector(${JSON.stringify(within_selector)}) ?? document`
          : 'document'};
        el = collectAll(scope, ${JSON.stringify(selector)})[${nth}] ?? null;
      }
      return el;
    })()`;
  }

  const q = JSON.stringify((text ?? '').toLowerCase());
  const match = exact ? `t === ${q}` : `t.includes(${q})`;

  const filterChain = `
      .filter(el => {
        // Use || not ?? so empty innerText (e.g. input[type=submit]) falls through to value/aria-label
        const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
        return ${match};
      })
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      ${visible_only ? `.filter(el => el.offsetParent !== null || el.getBoundingClientRect().width > 0)` : ''}
      ${x_max != null ? `.filter(el => el.getBoundingClientRect().x < ${x_max})` : ''}
      .filter(el => {
        // Skip elements covered by an overlay — elementFromPoint must reach this element.
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return top != null && (top === el || el.contains(top));
      })`;

  const sortAndPick = (n) => `
      .sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (ra.width * ra.height) - (rb.width * rb.height);
      })[${n}] ?? null`;

  const scope = within_selector
    ? `(document.querySelector(${JSON.stringify(within_selector)}) ?? document)`
    : 'document';

  return `(() => {
    ${collectFn}
    const INTERACTIVE = ${JSON.stringify(INTERACTIVE)};
    // First pass: light DOM only (fast path)
    let candidates = Array.from(${scope}.querySelectorAll(INTERACTIVE))${filterChain};
    let el = candidates${sortAndPick(nth)};
    // Second pass: shadow DOM fallback
    if (!el) {
      candidates = collectAll(${scope}, INTERACTIVE)${filterChain};
      el = candidates${sortAndPick(nth)};
    }
    return el;
  })()`;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function cmdScreenshot(params = {}) {
  const tab = await resolveTab(params);
  const target = await ensureDebugger(tab.id);
  // Configurable timeout: {"timeout_ms": 30000} — default 20s (screenshots on
  // content-heavy or freshly-loaded background tabs can be slow).
  const timeoutMs = params.timeout_ms ?? 20000;
  const res = await Promise.race([
    chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false,
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('screenshot timed out')), timeoutMs)),
  ]);
  if (!res?.data) throw new Error('captureScreenshot returned no data');
  // Include DPR so the server can label the coordinate grid in CSS pixels.
  // Page.captureScreenshot returns an image at physical resolution (DPR × CSS size),
  // but Input.dispatchMouseEvent uses CSS pixels — labels must match.
  const { result: dprResult } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: 'window.devicePixelRatio', returnByValue: true,
  });
  return { base64: res.data, dpr: dprResult?.value ?? 1 };
}

async function cmdClick({ x, y, tabId, precise = false } = {}) {
  const tab = await resolveTab({ tabId });
  const target = await ensureDebugger(tab.id);
  await humanClick(target, x, y, { precise });
  return { ok: true };
}

/**
 * Type text into the active (or clicked) element.
 *
 * fast:true — skip the 50-120 ms per-keystroke delay and pre-type click
 * settle sleeps, reducing a 20-char string from ~2 s to <100 ms.  Trades
 * human-likeness for speed; suitable for most automated workflows.
 */
async function cmdType({ text, x, y, tabId, fast = false } = {}) {
  const tab = await resolveTab({ tabId });
  const target = await ensureDebugger(tab.id);
  if (x != null && y != null) {
    await humanClick(target, x, y);
    if (!fast) await sleep(400);
    await cdpFocus(target, x, y);
    if (!fast) await sleep(100);
  }
  for (const char of text) {
    await humanTypeKey(target, char);
    if (!fast) await sleep(jitter(50, 70));
  }
  return { ok: true };
}

async function cmdScroll({ deltaX = 0, deltaY = 0, x = 400, y = 300, tabId } = {}) {
  const tab = await resolveTab({ tabId });
  const target = await ensureDebugger(tab.id);
  const STEPS = 5;
  for (let i = 0; i < STEPS; i++) {
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y,
      deltaX: deltaX / STEPS, deltaY: deltaY / STEPS, modifiers: 0,
    });
    await sleep(jitter(30, 20));
  }
  return { ok: true };
}

async function cmdNavigate({ url, tabId, timeout = 15000 } = {}) {
  const tab = await resolveTab({ tabId });
  await chrome.tabs.update(tab.id, { url });
  // Wait for the navigation to commit and the page to reach readyState=complete.
  // Without this the auto-screenshot (and any immediate follow-up command) sees
  // the previous page because chrome.tabs.update returns before the load begins.
  // 50ms initial sleep: enough for the browser to register the navigation before
  // the first poll, while avoiding the 250ms waste of the old 300ms sleep on fast
  // local or cached pages.
  const deadline = Date.now() + timeout;
  await sleep(50);
  while (Date.now() < deadline) {
    try {
      const updatedTab = await chrome.tabs.get(tab.id);
      if (updatedTab.status === 'complete') return { ok: true };
    } catch { break; }
    await sleep(150);
  }
  return { ok: true };
}

async function cmdGetUrl(params = {}) {
  const tab = await resolveTab(params);
  return { url: tab.url };
}

async function cmdListTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.map(t => ({ index: t.index, tabId: t.id, url: t.url, title: t.title, active: t.active }));
}

async function cmdNewTab({ url, timeout = 15000 } = {}) {
  const resolved = url ?? 'about:blank';
  const tab = await chrome.tabs.create({ url: resolved, active: true });
  // Poll for load completion the same way cmdNavigate does (50ms initial sleep,
  // 150ms poll interval — matches the reduced overhead in cmdNavigate).
  if (resolved !== 'about:blank') {
    const deadline = Date.now() + timeout;
    await sleep(50);
    while (Date.now() < deadline) {
      try {
        const updatedTab = await chrome.tabs.get(tab.id);
        if (updatedTab.status === 'complete') break;
      } catch { break; }
      await sleep(150);
    }
  }
  return { index: tab.index, tabId: tab.id, url: resolved };
}

async function cmdSwitchTab({ index, tabId, url_contains } = {}) {
  let tab;
  if (tabId != null) {
    tab = await chrome.tabs.get(tabId).catch(() => null);
  } else if (index != null) {
    [tab] = await chrome.tabs.query({ index, currentWindow: true });
  } else if (url_contains) {
    const all = await chrome.tabs.query({ currentWindow: true });
    tab = all.find(t => t.url?.includes(url_contains));
  }
  if (!tab) return { ok: false, error: 'tab not found' };
  await chrome.tabs.update(tab.id, { active: true });
  return { ok: true, index: tab.index, tabId: tab.id, url: tab.url, title: tab.title };
}

async function cmdCloseTab({ index, tabId } = {}) {
  let tab;
  if (tabId != null) {
    tab = await chrome.tabs.get(tabId).catch(() => null);
  } else if (index != null) {
    [tab] = await chrome.tabs.query({ index, currentWindow: true });
  } else {
    tab = await getActiveTab();
  }
  if (!tab) return { ok: false, error: 'tab not found' };
  await chrome.tabs.remove(tab.id);
  return { ok: true };
}

/**
 * Run a JS expression in the page and return the JSON-serializable result.
 * Designed for structured data extraction only — not for interaction.
 * The expression must return something JSON.stringify-able.
 */
async function cmdQuery({ expression, tabId } = {}) {
  const tab = await resolveTab({ tabId });
  const target = await ensureDebugger(tab.id);
  const { result, exceptionDetails } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: `JSON.stringify(${expression})`,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'JS error');
  return { result: JSON.parse(result.value) };
}

async function cmdReadPage(params = {}) {
  const tab = await resolveTab(params);
  const target = await ensureDebugger(tab.id);
  const { result } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: `(() => {
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map(a => ({ text: a.innerText.trim().slice(0, 80), href: a.href }))
        .filter(l => l.text && l.href && !l.href.startsWith('javascript:'))
        .slice(0, 100); // cap to avoid JSON truncation on link-heavy pages (e.g. Wikipedia)
      return JSON.stringify({
        title: document.title,
        url: location.href,
        text: (document.body?.innerText ?? '').slice(0, 4000),
        links,
      });
    })()`,
    returnByValue: true,
  });
  return JSON.parse(result.value);
}

// modifiers: 1=Alt 2=Ctrl 4=Meta(Cmd) 8=Shift
const KEY_MAP = {
  Enter:      { code: 'Enter',      keyCode: 13 },
  Tab:        { code: 'Tab',        keyCode: 9  },
  Escape:     { code: 'Escape',     keyCode: 27 },
  Backspace:  { code: 'Backspace',  keyCode: 8  },
  Delete:     { code: 'Delete',     keyCode: 46 },
  ArrowUp:    { code: 'ArrowUp',    keyCode: 38 },
  ArrowDown:  { code: 'ArrowDown',  keyCode: 40 },
  ArrowLeft:  { code: 'ArrowLeft',  keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Space:      { code: 'Space',      keyCode: 32, text: ' ' },
  // Editing shortcuts (Cmd on Mac)
  SelectAll:  { code: 'KeyA',       keyCode: 65, key: 'a', modifiers: 4 },
  Copy:       { code: 'KeyC',       keyCode: 67, key: 'c', modifiers: 4 },
  Paste:      { code: 'KeyV',       keyCode: 86, key: 'v', modifiers: 4 },
  Cut:        { code: 'KeyX',       keyCode: 88, key: 'x', modifiers: 4 },
};

async function cmdKeyPress({ key, tabId } = {}) {
  const tab = await resolveTab({ tabId });
  const target = await ensureDebugger(tab.id);
  const k = KEY_MAP[key] ?? { code: `Key${key.toUpperCase()}`, keyCode: key.charCodeAt(0) };
  // k.modifiers carries the Cmd/Ctrl bitmask for shortcuts like SelectAll/Copy/Paste/Cut
  const ev = {
    key:  k.key ?? key,
    code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode:  k.keyCode,
    modifiers: k.modifiers ?? 0,
  };
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...ev, type: 'keyDown', text: k.text ?? '' });
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...ev, type: 'keyUp' });
  return { ok: true };
}

async function cmdFindElement({ selector, text, exact = false, x_max, within_selector, nth, visible_only, tabId } = {}) {
  const tab = await resolveTab({ tabId });
  const target = await ensureDebugger(tab.id);
  const opts = { x_max, within_selector, nth, visible_only };
  const { result } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: `(() => {
      const el = ${buildFindExpr(selector, text, exact, opts)};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return JSON.stringify({
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        tag: el.tagName,
        text: (el.innerText ?? el.value ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 80),
        href: el.href ?? null,
      });
    })()`,
    returnByValue: true,
  });
  if (!result.value) return { found: false };
  return { found: true, ...JSON.parse(result.value) };
}

/**
 * Find an interactive element by selector or text, then click its center.
 * Atomic find+click in a single debugger session — avoids the two-step
 * find_element → click pattern where stale coordinates can miss small targets.
 *
 * Scrolls the element into view first so off-screen elements are reachable.
 */
async function cmdClickElement({ selector, text, exact = false, x_max, within_selector, nth, visible_only, tabId, precise = false } = {}) {
  const tab = await resolveTab({ tabId });
  const target = await ensureDebugger(tab.id);
  const opts = { x_max, within_selector, nth, visible_only };
  const { result } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: `(() => {
      const el = ${buildFindExpr(selector, text, exact, opts)};
      if (!el) return null;
      // Bring into viewport before measuring — ensures coordinates are in-bounds
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return JSON.stringify({
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        tag: el.tagName,
        text: (el.innerText ?? el.value ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 80),
      });
    })()`,
    returnByValue: true,
  });
  if (!result.value) return { found: false };
  const { x, y, tag, text: elText } = JSON.parse(result.value);
  await humanClick(target, x, y, { precise });
  return { found: true, x, y, tag, text: elText };
}

/**
 * Poll until document.readyState === 'complete' or timeout.
 * Useful after navigate, form submit, or any action that triggers a page load.
 */
async function cmdWait({ timeout = 10000, tabId } = {}) {
  const tab = await resolveTab({ tabId });
  const target = await ensureDebugger(tab.id);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { result } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: 'document.readyState',
      returnByValue: true,
    });
    if (result.value === 'complete') return { ready: true };
    await sleep(300);
  }
  return { ready: false, timeout: true };
}

/**
 * Poll until a CSS selector (or shadow-pierced element) appears in the DOM
 * with a non-zero bounding box. Useful for SPAs that pass readyState=complete
 * before their React/Vue tree is hydrated and interactive.
 *
 * Also accepts text= for the same text-matching logic as find_element.
 */
async function cmdWaitForElement({ selector, text, exact = false, within_selector, timeout = 10000, tabId } = {}) {
  const tab = await resolveTab({ tabId });
  const target = await ensureDebugger(tab.id);
  const opts = { within_selector };
  const expr = `(() => {
    const el = ${buildFindExpr(selector, text, exact, opts)};
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  })()`;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { result } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: expr, returnByValue: true,
    });
    if (result.value === true) return { found: true };
    await sleep(250);
  }
  return { found: false, timeout: true };
}

// ---------------------------------------------------------------------------
// Console and network command handlers
// ---------------------------------------------------------------------------

/**
 * Return buffered console entries for a tab.
 * since/until are Unix ms — filter to entries in that window.
 * clear resets the full buffer regardless of the time filter.
 */
async function cmdGetConsole({ clear = false, since, until, tabId } = {}) {
  const tab = await resolveTab({ tabId });
  let entries = consoleLogs.get(tab.id) ?? [];
  if (since != null) entries = entries.filter(e => e.ts >= since);
  if (until != null) entries = entries.filter(e => e.ts <= until);
  if (clear) consoleLogs.set(tab.id, []);
  return { entries };
}

/**
 * Enable network capture for a tab.
 * Off by default — opt in to avoid buffering noisy page-load assets.
 * Survives navigations: ensureDebugger re-enables Network.enable automatically.
 */
async function cmdEnableNetwork(params = {}) {
  const tab = await resolveTab(params);
  await ensureDebugger(tab.id);
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable');
  networkEnabled.add(tab.id);
  if (!networkRequests.has(tab.id)) networkRequests.set(tab.id, new Map());
  return { ok: true };
}

/**
 * Return buffered network requests for a tab.
 * since/until are Unix ms (request start time).
 * clear resets the full buffer regardless of the time filter.
 */
async function cmdGetNetwork({ clear = false, since, until, tabId } = {}) {
  const tab = await resolveTab({ tabId });
  let requests = Array.from(networkRequests.get(tab.id)?.values() ?? []);
  if (since != null) requests = requests.filter(r => r.ts >= since);
  if (until != null) requests = requests.filter(r => r.ts <= until);
  if (clear) networkRequests.set(tab.id, new Map());
  return { requests };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

connect();
