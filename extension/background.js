/**
 * Tiny Browser — background service worker
 *
 * All browser interactions go through CDP (chrome.debugger) to simulate
 * realistic human mouse + keyboard behavior.
 */

const WS_URL = 'ws://localhost:7331';
const RECONNECT_DELAY_MS = 3000;
const KEEPALIVE_ALARM = 'tiny-mcp-keepalive';

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
const pendingDialogs  = new Map(); // tabId → { type, message } for open JS dialogs

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
  pendingDialogs.delete(tabId);
});

async function ensureDebugger(tabId) {
  if (!debuggerSessions.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
    // Page.enable subscribes to dialog lifecycle events (javascriptDialogOpening, etc.)
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
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
      ts:       Math.round((params.wallTime ?? params.timestamp) * 1000), // Unix ms
      _mono:    params.timestamp, // Chrome monotonic seconds — used for duration calc only
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
      r.duration = Math.round((params.timestamp - r._mono) * 1000); // ms, both monotonic
    }
  }

  if (method === 'Network.loadingFailed') {
    const r = networkRequests.get(tabId)?.get(params.requestId);
    if (r) r.error = params.errorText;
  }

  // Dialog lifecycle — store pending dialog so get_dialog can read it and
  // dismiss_dialog can handle it before the 30s CDP timeout fires.
  if (method === 'Page.javascriptDialogOpening') {
    pendingDialogs.set(tabId, { type: params.type, message: params.message });
  }
  if (method === 'Page.javascriptDialogClosed') {
    pendingDialogs.delete(tabId);
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
      case 'drag':           return await cmdDrag(msg.params);
      case 'hover':          return await cmdHover(msg.params);
      case 'type':           return await cmdType(msg.params);
      case 'scroll':         return await cmdScroll(msg.params);
      case 'navigate':       return await cmdNavigate(msg.params);
      case 'get_url':        return await cmdGetUrl(msg.params);
      case 'read_page':      return await cmdReadPage(msg.params);
      case 'key_press':      return await cmdKeyPress(msg.params);
      case 'select_option':  return await cmdSelectOption(msg.params);
      case 'wait':           return await cmdWait(msg.params);
      case 'query':          return await cmdQuery(msg.params);
      case 'list_tabs':      return await cmdListTabs();
      case 'new_tab':        return await cmdNewTab(msg.params);
      case 'switch_tab':     return await cmdSwitchTab(msg.params);
      case 'close_tab':      return await cmdCloseTab(msg.params);
      case 'get_console':    return await cmdGetConsole(msg.params);
      case 'enable_network': return await cmdEnableNetwork(msg.params);
      case 'get_network':    return await cmdGetNetwork(msg.params);
      case 'get_dialog':     return await cmdGetDialog(msg.params);
      case 'dismiss_dialog': return await cmdDismissDialog(msg.params);
      case 'set_file_input': return await cmdSetFileInput(msg.params);
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
  // \n must be dispatched as a real Enter keypress (keyCode 13), not as charCode 10.
  // Textareas and rich editors ignore char events with charCode 10.
  if (char === '\n') {
    const ev = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...ev, type: 'keyDown', text: '\r' });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...ev, type: 'keyUp' });
    return;
  }
  // \t as a real Tab keypress
  if (char === '\t') {
    const ev = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...ev, type: 'keyDown' });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...ev, type: 'keyUp' });
    return;
  }
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
  // When targeting a specific tab, ensure it is active so the browser fires
  // JS synthetic events (click, mousedown, etc.). Background tabs receive the
  // CDP mouse events but browsers suppress synthetic events for inactive tabs.
  if (tabId != null && !tab.active) {
    await chrome.tabs.update(tab.id, { active: true });
  }
  const target = await ensureDebugger(tab.id);
  await humanClick(target, x, y, { precise });
  return { ok: true };
}

/**
 * Move the mouse to (x, y) without clicking.
 *
 * Triggers CSS :hover styles, mouseover/mouseenter events, and JS-driven
 * hover menus (dropdowns, flyouts, tooltips). The first call incurs a
 * one-time ~0.9–5 s Chrome CDP input-pipeline lazy-init cost; subsequent
 * calls are fast. Use when hover is explicitly needed — prefer click for
 * interactive elements.
 */
async function cmdHover({ x, y, tabId } = {}) {
  const tab = await resolveTab({ tabId });
  const target = await ensureDebugger(tab.id);
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, button: 'none', modifiers: 0,
  });
  return { ok: true };
}

/**
 * Type text into the active (or clicked) element.
 *
 * fast:true         — uses Input.insertText for a single CDP round trip regardless of
 *                     string length (~50ms flat vs 3N round trips for character-by-character typing).
 *                     Fires beforeinput/input but not keydown/keyup — works for most forms and
 *                     React/Vue controlled inputs. Omit for sites that gate on keydown events.
 *
 * replace:true      — select-all + delete the existing value before typing, so the new text
 *                     replaces the field contents rather than appending. Works on native inputs,
 *                     textareas, and React controlled inputs.
 *
 * frame_selector    — CSS selector for a same-origin <iframe>. When set, types into the
 *                     focused element within that iframe using direct JS value injection
 *                     (fires input + change events; works for React/Vue controlled inputs).
 *                     Not supported for cross-origin iframes.
 */
async function cmdType({ text, x, y, tabId, fast = false, replace = false, frame_selector } = {}) {
  const tab = await resolveTab({ tabId });
  const target = await ensureDebugger(tab.id);

  // iframe mode: direct JS value injection into the iframe's focused/active element
  if (frame_selector) {
    const sel = JSON.stringify(frame_selector);
    const textJson = JSON.stringify(text);
    const replaceFlag = replace;
    const { result, exceptionDetails } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `(() => {
        const iframe = document.querySelector(${sel});
        if (!iframe) return JSON.stringify({ ok: false, error: 'iframe not found' });
        let doc;
        try { doc = iframe.contentDocument; } catch(_) { return JSON.stringify({ ok: false, error: 'cross-origin iframe' }); }
        if (!doc) return JSON.stringify({ ok: false, error: 'cross-origin iframe' });
        const el = doc.activeElement && doc.activeElement !== doc.body
          ? doc.activeElement
          : doc.querySelector('input, textarea, [contenteditable]');
        if (!el) return JSON.stringify({ ok: false, error: 'no focusable element in iframe' });
        if (typeof el.value !== 'undefined') {
          el.value = ${replaceFlag} ? ${textJson} : (el.value + ${textJson});
        } else if (el.isContentEditable) {
          if (${replaceFlag}) el.textContent = '';
          el.textContent += ${textJson};
        }
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return JSON.stringify({ ok: true });
      })()`,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'JS error in iframe type');
    return JSON.parse(result.value);
  }

  if (x != null && y != null) {
    await humanClick(target, x, y);
    if (!fast) await sleep(400);
    await cdpFocus(target, x, y);
    if (!fast) await sleep(100);
  }
  if (replace) {
    // Select all existing content via the DOM API, which is more reliable than
    // dispatching Cmd+A — CDP modifier+key combos don't consistently trigger
    // browser select-all in all input types. el.select() works on INPUT/TEXTAREA;
    // execCommand('selectAll') covers contentEditable and other elements.
    // The first typed character (or Input.insertText) then replaces the selection.
    await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `(() => {
        const el = document.activeElement;
        if (!el) return;
        if (typeof el.select === 'function') {
          el.select();
        } else {
          document.execCommand('selectAll');
        }
      })()`,
    });
    await sleep(30);
  }
  if (fast) {
    // Single CDP call — no per-char round trips regardless of string length.
    // Handles \n and \t by splitting on them and dispatching real key events
    // between insertText segments (some editors only accept \n via keyDown).
    const segments = text.split(/(\n|\t)/);
    for (const seg of segments) {
      if (seg === '\n' || seg === '\t') {
        await humanTypeKey(target, seg);
      } else if (seg.length > 0) {
        await chrome.debugger.sendCommand(target, 'Input.insertText', { text: seg });
      }
    }
  } else {
    for (const char of text) {
      await humanTypeKey(target, char);
      await sleep(jitter(50, 70));
    }
  }
  return { ok: true };
}

/**
 * Drag from (fromX, fromY) to (toX, toY).
 *
 * steps    — number of intermediate mouseMoved events (default 10); higher = smoother
 *            for apps that use pointermove to track position (e.g. canvas, Kanban).
 * duration — total drag time in ms (default 300); spread across the intermediate steps.
 * html5    — set true for apps that use the HTML5 Drag and Drop API (dragstart/dragover/drop
 *            events). Standard mouse events don't trigger HTML5 DnD; this mode dispatches
 *            synthetic DragEvents resolved from the source and target viewport coordinates.
 *
 * Works on: Kanban boards (Linear, Trello), sortable lists, resizable panels,
 * file manager moves, canvas drawing tools, range sliders.
 */
async function cmdDrag({ fromX, fromY, toX, toY, tabId, steps = 10, duration = 300, html5 = false } = {}) {
  const tab = await resolveTab({ tabId });
  const target = await ensureDebugger(tab.id);

  if (html5) {
    // HTML5 Drag and Drop protocol — uses DragEvent objects resolved from coordinates.
    // elementFromPoint is coordinate-based (not selector/text-based) so this stays
    // inside the visual loop: coordinates come from the screenshot grid as usual.
    await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `(() => {
        const dt = new DataTransfer();
        const src = document.elementFromPoint(${fromX}, ${fromY});
        const dst = document.elementFromPoint(${toX}, ${toY});
        if (!src || !dst) return;
        src.dispatchEvent(new DragEvent('dragstart', { bubbles:true, cancelable:true, dataTransfer:dt }));
        dst.dispatchEvent(new DragEvent('dragenter', { bubbles:true, cancelable:true, dataTransfer:dt }));
        dst.dispatchEvent(new DragEvent('dragover',  { bubbles:true, cancelable:true, dataTransfer:dt }));
        dst.dispatchEvent(new DragEvent('drop',       { bubbles:true, cancelable:true, dataTransfer:dt }));
        src.dispatchEvent(new DragEvent('dragend',    { bubbles:true, dataTransfer:dt }));
      })()`,
    });
    return { ok: true };
  }

  const stepMs = Math.max(1, Math.round(duration / steps));
  // Press at source
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: fromX, y: fromY,
    button: 'left', clickCount: 1, modifiers: 0,
  });
  // Move across intermediate positions
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(fromX + (toX - fromX) * t);
    const y = Math.round(fromY + (toY - fromY) * t);
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, button: 'left', modifiers: 0,
    });
    await sleep(stepMs);
  }
  // Release at destination
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: toX, y: toY,
    button: 'left', clickCount: 1, modifiers: 0,
  });
  return { ok: true };
}

/**
 * Scroll the page or a specific scrollable container.
 *
 * x, y — optional viewport coordinates to anchor the scroll. When provided,
 * the deepest scrollable ancestor at (x, y) is scrolled directly, bypassing
 * the viewport-center probe. Use this to target sidebars, modals, or any
 * scrollable area that isn't at the center of the page.
 *
 * Without x/y: tries window.scrollBy first, falls back to the deepest
 * scrollable container at the viewport center.
 */
async function cmdScroll({ deltaX = 0, deltaY = 0, x, y, tabId } = {}) {
  const tab = await resolveTab({ tabId });
  const target = await ensureDebugger(tab.id);
  // Use window.scrollBy via Runtime.evaluate instead of Input.dispatchMouseEvent(mouseWheel).
  // mouseWheel has the same ~25s first-use Input pipeline lazy-init penalty as mouseMoved.
  // behavior:'instant' overrides CSS scroll-behavior:smooth so the scroll is atomic and
  // the auto-screenshot always captures the final position, not an animation midpoint.
  const probeX = x != null ? x : null;
  const probeY = y != null ? y : null;
  const { result } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: `(function() {
      const dx = ${deltaX}, dy = ${deltaY};
      const px = ${probeX !== null ? probeX : 'null'};
      const py = ${probeY !== null ? probeY : 'null'};

      function scrollAncestor(startEl) {
        let el = startEl;
        while (el && el !== document.documentElement) {
          const s = getComputedStyle(el);
          const oy = s.overflowY, ox = s.overflowX;
          if ((dy !== 0 && (oy==='auto'||oy==='scroll') && el.scrollHeight > el.clientHeight) ||
              (dx !== 0 && (ox==='auto'||ox==='scroll') && el.scrollWidth  > el.clientWidth)) {
            el.scrollBy({left:dx, top:dy, behavior:'instant'});
            return true;
          }
          el = el.parentElement;
        }
        return false;
      }

      if (px !== null && py !== null) {
        // Explicit target: walk up from (px,py) for a scrollable ancestor
        const hit = document.elementFromPoint(px, py);
        if (hit) scrollAncestor(hit);
      } else {
        // Default: try window first, fall back to viewport-center probe
        const wy = window.scrollY, wx = window.scrollX;
        window.scrollBy({left:dx, top:dy, behavior:'instant'});
        if (window.scrollY === wy && window.scrollX === wx) {
          const hit = document.elementFromPoint(window.innerWidth/2, window.innerHeight/2);
          if (hit) scrollAncestor(hit);
        }
      }
      // Return final scroll position so the caller can track coordinate offsets
      return JSON.stringify({ scrollY: window.scrollY, scrollX: window.scrollX });
    })()`,
    returnByValue: true,
  });
  const pos = result?.value ? JSON.parse(result.value) : { scrollY: 0, scrollX: 0 };
  return { ok: true, scrollY: pos.scrollY, scrollX: pos.scrollX };
}

async function cmdNavigate({ url, tabId, timeout = 15000 } = {}) {
  const tab = await resolveTab({ tabId });
  await chrome.tabs.update(tab.id, { url });
  // 50ms initial sleep lets the browser register the navigation before the first
  // status poll; avoids the old 300ms fixed wait on fast/cached pages.
  const deadline = Date.now() + timeout;
  await sleep(50);
  while (Date.now() < deadline) {
    try {
      const updatedTab = await chrome.tabs.get(tab.id);
      if (updatedTab.status === 'complete') {
        // Detect Chrome error pages via CDP: tab.url stays as the originally requested URL
        // even on error pages, but document location.href reports 'chrome-error://chromewebdata'
        // internally. Evaluating location.href gives the true document URL.
        try {
          const debugTarget = await ensureDebugger(updatedTab.id);
          const { result: locResult } = await chrome.debugger.sendCommand(debugTarget, 'Runtime.evaluate', {
            expression: 'location.href', returnByValue: true,
          });
          const docUrl = locResult?.value ?? '';
          if (docUrl.startsWith('chrome-error://')) {
            return { ok: false, error: 'Navigation failed: page could not be loaded', url: updatedTab.url };
          }
        } catch { /* CDP unavailable on this page type — treat as success */ }
        return { ok: true, url: updatedTab.url };
      }
    } catch { break; }
    await sleep(150);
  }
  return { ok: false, error: 'Navigation timed out', url };
}

async function cmdGetUrl(params = {}) {
  const tab = await resolveTab(params);
  return { url: tab.url };
}

async function cmdListTabs() {
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
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
 * Select an option in a native <select> element.
 *
 * selector — CSS selector for the <select> element.
 * value    — match by option's value attribute (exact).
 * text     — match by option's visible text (case-insensitive, exact first, then partial).
 * tabId    — optional tab to target.
 *
 * Dispatches both `input` and `change` events so React/Vue/vanilla handlers fire.
 * Returns { ok, value, text } on success or { ok:false, error } if not found.
 */
async function cmdSelectOption({ selector, text, value, tabId } = {}) {
  const tab = await resolveTab({ tabId });
  const target = await ensureDebugger(tab.id);
  const { result, exceptionDetails } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: `(() => {
      const sel   = ${JSON.stringify(selector ?? null)};
      const wantVal  = ${JSON.stringify(value  ?? null)};
      const wantText = ${JSON.stringify(text   ?? null)};

      const el = sel ? document.querySelector(sel) : null;
      if (!el)              return JSON.stringify({ ok: false, reason: 'select element not found' });
      if (el.tagName !== 'SELECT') return JSON.stringify({ ok: false, reason: 'element is not a <select>' });

      let opt = null;
      if (wantVal !== null) {
        opt = Array.from(el.options).find(o => o.value === wantVal) ?? null;
      } else if (wantText !== null) {
        const wl = wantText.toLowerCase();
        opt = Array.from(el.options).find(o => o.text.trim().toLowerCase() === wl)
           ?? Array.from(el.options).find(o => o.text.trim().toLowerCase().includes(wl))
           ?? null;
      } else {
        opt = el.options[0] ?? null;
      }
      if (!opt) return JSON.stringify({ ok: false, reason: 'option not found' });

      el.value = opt.value;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({ ok: true, value: el.value, text: opt.text.trim() });
    })()`,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'JS error');
  return JSON.parse(result.value);
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
  // result.value is undefined when the expression evaluates to undefined (e.g. optional chaining
  // on a missing element). JSON.parse(undefined) would throw "undefined is not valid JSON".
  // Use result.value ?? null as the raw string; 'null' parses to JSON null.
  const raw = result.value ?? null;
  return { result: raw === null ? null : JSON.parse(raw) };
}

async function cmdReadPage(params = {}) {
  const tab = await resolveTab(params);
  const target = await ensureDebugger(tab.id);
  // within_selector: scope link extraction to a specific container (e.g. '#mw-content-text'
  // on Wikipedia to skip the 50+ language sidebar links that fill the 100-link cap).
  const withinSelector = params.within_selector ?? null;
  // text_limit: override the default 4000-char body text cap. Pass a higher value
  // (e.g. 20000) to read long articles and docs pages without truncation.
  const textLimit = params.text_limit ?? 4000;
  const withinExpr = withinSelector
    ? `document.querySelector(${JSON.stringify(withinSelector)}) ?? document`
    : 'document';
  const { result } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: `(() => {
      const root = ${withinExpr};
      const links = Array.from(root.querySelectorAll('a[href]'))
        .map(a => ({ text: a.innerText.trim().slice(0, 80), href: a.href }))
        .filter(l => l.text && l.href && !l.href.startsWith('javascript:'))
        .slice(0, 100); // cap to avoid JSON truncation on link-heavy pages (e.g. Wikipedia)
      return JSON.stringify({
        title: document.title,
        url: location.href,
        text: (document.body?.innerText ?? '').slice(0, ${textLimit}),
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
  PageUp:     { code: 'PageUp',     keyCode: 33 },
  PageDown:   { code: 'PageDown',   keyCode: 34 },
  Home:       { code: 'Home',       keyCode: 36 },
  End:        { code: 'End',        keyCode: 35 },
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


/**
 * Poll until the tab's load status is 'complete' or timeout.
 * Useful after navigate, form submit, or any action that triggers a page load.
 */
async function cmdWait({ timeout = 10000, tabId } = {}) {
  const tab = await resolveTab({ tabId });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const updatedTab = await chrome.tabs.get(tab.id);
      if (updatedTab.status === 'complete') return { ready: true };
    } catch { break; }
    await sleep(300);
  }
  return { ready: false, timeout: true };
}

// ---------------------------------------------------------------------------
// Console and network command handlers
// ---------------------------------------------------------------------------

/**
 * Return buffered console entries for a tab.
 *
 * since/until       — Unix ms window filter.
 * level             — string or array of strings; only return entries matching
 *                     these levels (e.g. "error", ["error","warning"]).
 * include_extensions — include entries from chrome-extension:// URLs (other
 *                     extensions' content scripts). Default false — these are
 *                     almost always noise ("content script loaded" spam).
 * clear             — reset the full buffer regardless of other filters.
 */
async function cmdGetConsole({ clear = false, since, until, level, include_extensions = false, tabId } = {}) {
  const tab = await resolveTab({ tabId });
  let entries = consoleLogs.get(tab.id) ?? [];
  if (since != null) entries = entries.filter(e => e.ts >= since);
  if (until != null) entries = entries.filter(e => e.ts <= until);
  if (!include_extensions) entries = entries.filter(e => !(e.url ?? '').startsWith('chrome-extension://'));
  if (level != null) {
    const levels = Array.isArray(level) ? level : [level];
    entries = entries.filter(e => levels.includes(e.level));
  }
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
 *
 * since/until        — Unix ms window filter (request start time).
 * include_extensions — include chrome-extension:// requests (other extensions'
 *                      content script loads). Default false — noise for agents.
 * clear              — reset the full buffer regardless of other filters.
 */
async function cmdGetNetwork({ clear = false, since, until, include_extensions = false, tabId } = {}) {
  const tab = await resolveTab({ tabId });
  let requests = Array.from(networkRequests.get(tab.id)?.values() ?? []);
  if (since != null) requests = requests.filter(r => r.ts >= since);
  if (until != null) requests = requests.filter(r => r.ts <= until);
  if (!include_extensions) requests = requests.filter(r => !r.url.startsWith('chrome-extension://'));
  if (clear) networkRequests.set(tab.id, new Map());
  // Strip internal _mono field — not part of the public API
  return { requests: requests.map(({ _mono: _, ...r }) => r) };
}

// ---------------------------------------------------------------------------
// Dialog command handlers
// ---------------------------------------------------------------------------

/**
 * Return the pending JS dialog for the tab, or null if none is open.
 * Returns { type: "alert"|"confirm"|"prompt"|"beforeunload", message: "..." }
 */
async function cmdGetDialog(params = {}) {
  const tab = await resolveTab(params);
  return pendingDialogs.get(tab.id) ?? null;
}

/**
 * Dismiss (accept or cancel) the pending JS dialog for the tab.
 *
 * accept     — true = OK / Accept (default), false = Cancel / Dismiss.
 * promptText — text to fill in for prompt() dialogs.
 *
 * Page.handleJavaScriptDialog operates at browser level and works even while
 * V8 is paused waiting for the dialog — it does NOT block like other CDP calls.
 */
async function cmdDismissDialog({ accept = true, promptText = '', tabId } = {}) {
  const tab = await resolveTab({ tabId });
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.handleJavaScriptDialog',
    { accept, promptText });
  pendingDialogs.delete(tab.id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// File input command handler
// ---------------------------------------------------------------------------

/**
 * Set files on a native <input type="file"> without opening the OS picker.
 *
 * selector — CSS selector for the file input (default: 'input[type="file"]').
 * files    — absolute path string or array of absolute path strings.
 *
 * Uses pure CDP (DOM.setFileInputFiles) — no Runtime.evaluate injection.
 */
async function cmdSetFileInput({ selector, files, tabId } = {}) {
  const tab = await resolveTab({ tabId });
  const target = await ensureDebugger(tab.id);
  await chrome.debugger.sendCommand(target, 'DOM.enable');
  const { root } = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: 0 });
  const { nodeId } = await chrome.debugger.sendCommand(target, 'DOM.querySelector',
    { nodeId: root.nodeId, selector: selector ?? 'input[type="file"]' });
  if (!nodeId) return { ok: false, error: 'file input not found' };
  await chrome.debugger.sendCommand(target, 'DOM.setFileInputFiles',
    { nodeId, files: Array.isArray(files) ? files : [files] });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

connect();
