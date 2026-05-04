#!/usr/bin/env node
/**
 * tiny-browser — dual-mode entry point
 *
 * No arguments:  start the HTTP/WS server (server mode)
 * With arguments: act as a CLI client against a running server (client mode)
 *
 * Usage:
 *   tiny-browser                          # start server
 *   tiny-browser help                     # show full command reference
 *   tiny-browser help navigate            # show help for one command
 *   tiny-browser screenshot               # take screenshot
 *   tiny-browser navigate '{"url":"..."}' # send command with JSON params
 *   tiny-browser click '{"x":350,"y":200}'
 */

import http from 'http';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

// ---------------------------------------------------------------------------
// Command catalogue — single source of truth for help output
// ---------------------------------------------------------------------------

const COMMANDS = [
  {
    name: 'screenshot',
    params: '[{"tabId":N,"timeout_ms":N}]',
    returns: '{"file":"/tmp/tiny-browser-screenshot.png"}',
    desc: 'Capture a PNG of the current (or specified) tab. The image has a bold red coordinate grid every 100 px — use those label values as click coordinates. Prefer detect_boxes for navigation; use screenshot when visual state matters (error colours, canvas, overlays).',
    auto_screenshot: false,
  },
  {
    name: 'detect_boxes',
    params: '[{"draw":bool,"tabId":N,"frameId":"str"}]',
    returns: '{"items":[{"id":"C0","kind":"control","tag":"button","text":"Submit","cx":N,"cy":N,"rect":{"top":N,"left":N,"right":N,"bottom":N,"width":N,"height":N},"selector":"...","index":N},...]}}',
    desc: 'Extract all visible interactive controls (C*), semantic cards (K*), and significant images (I*) from the current viewport with their CSS-pixel bounding boxes. Each item includes cx and cy (pre-computed center coordinates) — pass them directly to click without any arithmetic. Primary navigation method — ~5–10× fewer tokens than a screenshot. draw:true overlays coloured boxes on the page. Pass frameId (from list_frames) to inspect inside an iframe.',
    auto_screenshot: false,
  },
  {
    name: 'page_to_md',
    params: '[{"char_limit":8000,"tabId":N}]',
    returns: '{"markdown":"# Title\\n\\nParagraph text…"}',
    desc: 'Extract the main content of the page as clean Markdown (headings, paragraphs, lists, tables, code blocks). Targets main/article first, falls back to body; strips nav/header/footer/aside. Auto-included in navigate and wait responses — no separate call needed on arrival. Use explicitly to re-fetch after dynamic content loads, or pass char_limit to raise the 8000-char default for long articles. Empty string means no readable content found (SPA shell, login redirect, etc.).',
    auto_screenshot: false,
  },
  {
    name: 'list_frames',
    params: '[{"tabId":N}]',
    returns: '{"frames":[{"frameId":"str","url":"https://...","name":"","depth":0},...]}',
    desc: 'List all frames (main + iframes) in the tab. Use frameId with detect_boxes or query to inspect iframe content — needed for embedded apps, payment widgets, or any site that uses iframes.',
    auto_screenshot: false,
  },
  {
    name: 'navigate',
    params: '{"url":"https://example.com"[,"tabId":N]}',
    returns: '{"ok":true,"boxes":[...],"screenshot":"...","markdown":"# Title\\n\\nPage content…"}',
    desc: 'Navigate to a URL. Response includes auto boxes[], screenshot, and markdown — the main page content as clean Markdown (headings, paragraphs, lists, tables). Read markdown to understand what the page says without a separate call.',
    auto_screenshot: true,
  },
  {
    name: 'wait',
    params: '[{"timeout":10000,"tabId":N}]',
    returns: '{"ready":true,"boxes":[...],"screenshot":"...","markdown":"# Title\\n\\nPage content…"}',
    desc: 'Block until the tab finishes loading. Use after navigate or form submit. Response includes auto boxes[], screenshot, and markdown (main page content). markdown is empty string if no semantic content container is found (SPA shell, login redirect, etc.).',
    auto_screenshot: true,
  },
  {
    name: 'click',
    params: '{"x":N,"y":N[,"precise":bool,"button":"left"|"right"|"middle","tabId":N]}',
    returns: '{"ok":true,"boxes":[...],"screenshot":"..."}',
    desc: 'Click at viewport coordinates. Get coordinates from detect_boxes (cx = rect.left + rect.width/2, cy = rect.top + rect.height/2) or from screenshot grid labels. Set precise:true for exact pixel targeting (data tables, grids); default adds human-like timing. Use button:"right" for context menus.',
    auto_screenshot: true,
  },
  {
    name: 'select_option',
    params: '{"selector":"css","value":"opt-value" | "text":"option label"[,"tabId":N]}',
    returns: '{"ok":true,"value":"selected-value","text":"Option Label","boxes":[...],"screenshot":"..."}',
    desc: 'Select an option in a native <select> element. Find the select by CSS selector; pick the option by value attribute (exact) or by visible text (case-insensitive, exact before partial). Fires input and change events so React/Vue/vanilla handlers trigger.',
    auto_screenshot: true,
  },
  {
    name: 'type',
    params: '{"text":"value"[,"x":N,"y":N,"fast":bool,"replace":bool,"frame_selector":"css","tabId":N]}',
    returns: '{"ok":true,"boxes":[...],"screenshot":"..."}',
    desc: 'Type text. Set fast:true to use Input.insertText — a single CDP round trip for any string length (~50ms flat vs character-by-character). fast:true fires input/beforeinput events but not keydown/keyup; works for most forms including React. Set replace:true to select-all and delete existing field content before typing (prevents appending). Use frame_selector to type into the active/first input inside a same-origin <iframe> (fires input+change events). Omit x/y to type into the currently focused element.',
    auto_screenshot: true,
  },
  {
    name: 'key_press',
    params: '{"key":"Enter"[,"tabId":N]}',
    returns: '{"ok":true,"boxes":[...],"screenshot":"..."}',
    desc: 'Press a named key. Keys: Enter Tab Escape Backspace Delete ArrowUp ArrowDown ArrowLeft ArrowRight PageUp PageDown Home End Space SelectAll Copy Paste Cut (last four are Cmd shortcuts on Mac).',
    auto_screenshot: true,
  },
  {
    name: 'drag',
    params: '{"fromX":N,"fromY":N,"toX":N,"toY":N[,"steps":10,"duration":300,"html5":bool,"tabId":N]}',
    returns: '{"ok":true,"boxes":[...],"screenshot":"..."}',
    desc: 'Drag from (fromX, fromY) to (toX, toY). Set html5:true for apps that use the HTML5 Drag and Drop API (dragstart/dragover/drop events) — e.g. the-internet drag & drop demo. Default (html5:false) uses CDP mouse events and works for canvas, range sliders, Kanban boards using pointermove. steps and duration only apply to the default mode.',
    auto_screenshot: true,
  },
  {
    name: 'hover',
    params: '{"x":N,"y":N[,"tabId":N]}',
    returns: '{"ok":true,"boxes":[...],"screenshot":"..."}',
    desc: 'Move the mouse to (x, y) without clicking. Triggers CSS :hover styles, mouseover/mouseenter events, and JS-driven hover menus (dropdowns, flyouts, tooltips). First call incurs a ~1–5 s CDP init cost; subsequent calls are fast.',
    auto_screenshot: true,
  },
  {
    name: 'scroll',
    params: '{"deltaY":N[,"deltaX":N,"x":N,"y":N,"tabId":N]}',
    returns: '{"ok":true,"scrollY":N,"scrollX":N,"boxes":[...],"screenshot":"..."}',
    desc: 'Scroll the page. Positive deltaY = down, negative = up. Pass x,y to target a specific scrollable container. Response includes scrollY/scrollX and updated boxes[] so you can immediately target newly-visible elements.',
    auto_screenshot: true,
  },
  {
    name: 'get_url',
    params: '[{"tabId":N}]',
    returns: '{"url":"https://..."}',
    desc: 'Return the current URL of the active (or specified) tab.',
    auto_screenshot: false,
  },
  {
    name: 'read_page',
    params: '[{"tabId":N,"within_selector":"CSS","text_limit":N}]',
    returns: '{"title":"...","url":"...","text":"...","links":[{"text":"...","href":"..."}]}',
    desc: 'Return page title, body text, and up to 100 anchor links. text_limit controls body text length (default 4000 — pass e.g. 20000 for long articles). Pass within_selector to scope link extraction to a container (e.g. "#mw-content-text" on Wikipedia to skip language sidebar links).',
    auto_screenshot: false,
  },
  {
    name: 'query',
    params: '{"expression":"JS"[,"tabId":N]}',
    returns: '{"result": <any JSON>}',
    desc: 'Evaluate a JS expression and return the JSON-serialisable result. For structured data extraction only — not for interaction. Expression must be a single value (not a statement).',
    auto_screenshot: false,
  },
  {
    name: 'list_tabs',
    params: '',
    returns: '[{"index":N,"tabId":N,"url":"...","title":"...","active":bool}]',
    desc: 'List all tabs in the current Chrome window.',
    auto_screenshot: false,
  },
  {
    name: 'new_tab',
    params: '[{"url":"https://...","active":bool}]',
    returns: '{"index":N,"tabId":N,"url":"..."}',
    desc: 'Open a new tab and return its tabId. Save tabId — use it for all targeted commands (detect_boxes, click, etc.). active:false opens the tab in the background without stealing focus, safe for batch tab opening. No auto-screenshot or detect_boxes — call those explicitly with tabId after opening.',
    auto_screenshot: false,
  },
  {
    name: 'switch_tab',
    params: '{"tabId":N} | {"index":N} | {"url_contains":"fragment"}',
    returns: '{"ok":true,"index":N,"tabId":N,"url":"...","title":"..."}',
    desc: 'Activate a tab. Prefer tabId (stable) over index (can shift). Required before typing into React SPAs in background tabs.',
    auto_screenshot: false,
  },
  {
    name: 'close_tab',
    params: '[{"tabId":N} | {"index":N}]',
    returns: '{"ok":true}',
    desc: 'Close a tab. Defaults to the current active tab.',
    auto_screenshot: false,
  },
  {
    name: 'get_dialog',
    params: '[{"tabId":N}]',
    returns: '{"type":"alert","message":"..."} | null',
    desc: 'Return the pending JS dialog (alert/confirm/prompt) for the tab, or null if none is open. Use before dismiss_dialog to read the message. Does not block.',
    auto_screenshot: false,
  },
  {
    name: 'dismiss_dialog',
    params: '[{"accept":bool,"promptText":"...","tabId":N}]',
    returns: '{"ok":true}',
    desc: 'Accept or cancel the pending JS dialog. accept:true (default) = OK/Accept, accept:false = Cancel/Dismiss. Use promptText to fill in prompt() dialogs. Unblocks the tab immediately — all subsequent commands work normally.',
    auto_screenshot: false,
  },
  {
    name: 'set_file_input',
    params: '{"files":"/abs/path" | ["/path1","/path2"][,"selector":"css","tabId":N]}',
    returns: '{"ok":true,"boxes":[...],"screenshot":"..."}',
    desc: 'Set files on a native <input type="file"> without opening the OS file picker. files is an absolute path string or array of paths. selector defaults to input[type="file"]. Response includes auto boxes[] and screenshot showing the updated filename label.',
    auto_screenshot: true,
  },
  {
    name: 'enable_network',
    params: '[{"tabId":N}]',
    returns: '{"ok":true}',
    desc: 'Start capturing network requests for a tab. Call AFTER navigate+wait — calling before may attach to the wrong tab. Survives navigations. Off by default to avoid noise.',
    auto_screenshot: false,
  },
  {
    name: 'get_network',
    params: '[{"since":unixMs,"until":unixMs,"clear":bool,"include_extensions":bool,"tabId":N}]',
    returns: '{"requests":[{"method":"...","url":"...","status":N,"type":"XHR","size":N,"duration":N,"ts":N}]}',
    desc: 'Return buffered network requests. chrome-extension:// requests are filtered out by default (set include_extensions:true to include them). Use since/until (Unix ms) to filter to a time window. clear resets the buffer.',
    auto_screenshot: false,
  },
  {
    name: 'reload_extension',
    params: '',
    returns: '{"ok":true}',
    desc: 'Reload the Chrome extension (equivalent to clicking the reload button at chrome://extensions). Useful after editing background.js or page-extractor.js to apply changes without leaving Cursor. The WebSocket reconnects automatically within ~3 seconds.',
    auto_screenshot: false,
  },
  {
    name: 'get_console',
    params: '[{"since":unixMs,"until":unixMs,"level":"error","clear":bool,"include_extensions":bool,"tabId":N}]',
    returns: '{"entries":[{"level":"error","text":"...","url":"...","line":N,"ts":N}]}',
    desc: 'Return buffered console entries (log/info/warn/error/debug + uncaught exceptions). ts is Unix ms. chrome-extension:// entries are filtered out by default (set include_extensions:true to include them). Use level to filter by severity — e.g. "error" or ["error","warning"].',
    auto_screenshot: false,
  },
];

function printHelp(filter) {
  const cmds = filter ? COMMANDS.filter(c => c.name === filter) : COMMANDS;

  if (filter && cmds.length === 0) {
    process.stderr.write(`tiny-browser: unknown command "${filter}"\n`);
    process.exit(1);
  }

  if (!filter) {
    process.stdout.write([
      '',
      'tiny-browser — AI-driven Chrome control',
      '',
      'USAGE',
      '  tiny-browser                     Start the server (kills existing on port 7331)',
      '  tiny-browser help [command]      Show this help or detail for one command',
      '  tiny-browser COMMAND [JSON]      Send a command to the running server',
      '',
      'COMMANDS  (* = response includes auto-screenshot field)',
      '',
    ].join('\n'));

    const maxName = Math.max(...COMMANDS.map(c => c.name.length));
    for (const c of COMMANDS) {
      const star = c.auto_screenshot ? '*' : ' ';
      const pad = ' '.repeat(maxName - c.name.length);
      process.stdout.write(`  ${star} ${c.name}${pad}  ${c.desc.split('.')[0]}.\n`);
    }

    process.stdout.write([
      '',
      'NOTES',
      '  · All commands accept an optional tabId to target a specific tab.',
      '  · JSON params are optional when empty  (e.g. `tiny-browser screenshot`).',
      '  · Output is always JSON — pipe to python3 -c "import json,sys; ..." freely.',
      '  · Server health: curl -s http://127.0.0.1:7331',
      '',
      'Run `tiny-browser help COMMAND` for full params + return shape.',
      '',
    ].join('\n'));

    return;
  }

  // Single-command detail
  const c = cmds[0];
  process.stdout.write([
    '',
    `tiny-browser ${c.name}`,
    '',
    `  ${c.desc}`,
    '',
    'PARAMS (pass as second argument, JSON string)',
    `  ${c.params || '(none)'}`,
    '',
    'RETURNS',
    `  ${c.returns}`,
    c.auto_screenshot ? '\n  Note: response includes "screenshot" field with path to auto-captured PNG.' : '',
    '',
  ].join('\n'));
}

// ---------------------------------------------------------------------------

const [,, command, rawParams] = process.argv;

if (command === 'help' || command === '--help' || command === '-h') {
  printHelp(rawParams ?? null);
  process.exit(0);
}

if (!command) {
  // -------------------------------------------------------------------------
  // Server mode — kill any stale process on 7331 then launch server.mjs
  // -------------------------------------------------------------------------
  try {
    execFileSync('sh', ['-c', 'lsof -ti tcp:7331 | xargs kill -9 2>/dev/null; true']);
  } catch { /* ignore */ }

  const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');
  await import(serverPath);

} else {
  // -------------------------------------------------------------------------
  // Client mode — POST command to running server, print JSON result, exit
  // -------------------------------------------------------------------------
  let params;
  try {
    params = rawParams ? JSON.parse(rawParams) : {};
  } catch {
    process.stderr.write(`tiny-browser: invalid JSON params: ${rawParams}\n`);
    process.exit(1);
  }

  const body = JSON.stringify(params);

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: 7331,
      path: `/${command}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        process.stdout.write(data + '\n');
        if (res.statusCode !== 200) { process.exit(1); return; }
        // Exit 1 on logical failures so agents can use `&&` chains and `if` checks.
        // ok:false, found:false, ready:false all indicate the command did not succeed.
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok === false || parsed.found === false || parsed.ready === false) {
            process.exit(1);
            return;
          }
        } catch { /* non-JSON or unexpected shape — treat as success */ }
        process.exit(0);
      });
    }
  );

  req.on('error', (err) => {
    process.stderr.write(
      `tiny-browser: cannot connect to server at 127.0.0.1:7331 — is it running?\n  ${err.message}\n`
    );
    process.exit(1);
  });

  req.end(body);
}
