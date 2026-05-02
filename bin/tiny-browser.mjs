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
 *   tiny-browser click_element '{"text":"Submit","exact":true}'
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
    desc: 'Capture a PNG of the current (or specified) tab. The image has a bold red coordinate grid every 100 px — use those label values as click coordinates.',
    auto_screenshot: false,
  },
  {
    name: 'navigate',
    params: '{"url":"https://example.com"[,"tabId":N]}',
    returns: '{"ok":true,"screenshot":"..."}',
    desc: 'Navigate to a URL. Response includes auto-screenshot.',
    auto_screenshot: true,
  },
  {
    name: 'wait',
    params: '[{"timeout":10000,"tabId":N}]',
    returns: '{"ready":true,"screenshot":"..."}',
    desc: 'Block until document.readyState === "complete". Use after navigate or form submit.',
    auto_screenshot: true,
  },
  {
    name: 'wait_for_element',
    params: '{"selector":"css" | "text":"label" [,"exact":bool,"within_selector":"css","timeout":10000,"tabId":N]}',
    returns: '{"found":true,"screenshot":"..."}',
    desc: 'Poll until an element appears with a non-zero bounding box. Essential for SPAs where readyState fires before React/Vue renders buttons.',
    auto_screenshot: true,
  },
  {
    name: 'click',
    params: '{"x":N,"y":N[,"tabId":N]}',
    returns: '{"ok":true,"screenshot":"..."}',
    desc: 'Click at viewport coordinates (getBoundingClientRect values, scroll-adjusted). Use grid labels from screenshot — they represent page coordinates which may differ after scrolling.',
    auto_screenshot: true,
  },
  {
    name: 'click_element',
    params: '{"text":"label" | "selector":"css" [,"exact":bool,"x_max":N,"within_selector":"css","nth":N,"visible_only":bool,"frame_selector":"css","tabId":N]}',
    returns: '{"found":true,"x":N,"y":N,"tag":"BUTTON","text":"...","screenshot":"..."}',
    desc: 'Find an interactive element by text or CSS selector and click its centre. Scrolls into view automatically. Falls back to shadow DOM if light DOM returns nothing. Use frame_selector to target elements inside a same-origin <iframe>. Use x_max/within_selector to disambiguate duplicate text.',
    auto_screenshot: true,
  },
  {
    name: 'select_option',
    params: '{"selector":"css","value":"opt-value" | "text":"option label"[,"tabId":N]}',
    returns: '{"ok":true,"value":"selected-value","text":"Option Label","screenshot":"..."}',
    desc: 'Select an option in a native <select> element. Find the select by CSS selector; pick the option by value attribute (exact) or by visible text (case-insensitive, exact before partial). Fires input and change events so React/Vue/vanilla handlers trigger.',
    auto_screenshot: true,
  },
  {
    name: 'type',
    params: '{"text":"value"[,"x":N,"y":N,"fast":bool,"replace":bool,"frame_selector":"css","tabId":N]}',
    returns: '{"ok":true,"screenshot":"..."}',
    desc: 'Type text. Set fast:true to use Input.insertText — a single CDP round trip for any string length (~50ms flat vs character-by-character). fast:true fires input/beforeinput events but not keydown/keyup; works for most forms including React. Set replace:true to select-all and delete existing field content before typing (prevents appending). Use frame_selector to type into the active/first input inside a same-origin <iframe> (fires input+change events). Omit x/y to type into the currently focused element.',
    auto_screenshot: true,
  },
  {
    name: 'key_press',
    params: '{"key":"Enter"[,"tabId":N]}',
    returns: '{"ok":true,"screenshot":"..."}',
    desc: 'Press a named key. Keys: Enter Tab Escape Backspace Delete ArrowUp ArrowDown ArrowLeft ArrowRight PageUp PageDown Home End Space SelectAll Copy Paste Cut (last four are Cmd shortcuts on Mac).',
    auto_screenshot: true,
  },
  {
    name: 'drag',
    params: '{"fromX":N,"fromY":N,"toX":N,"toY":N[,"steps":10,"duration":300,"tabId":N]}',
    returns: '{"ok":true,"screenshot":"..."}',
    desc: 'Drag from (fromX, fromY) to (toX, toY). steps controls how many intermediate mouseMoved events are sent (default 10, increase for smoother drags). duration is total drag time in ms (default 300). Works on Kanban boards, sortable lists, resizable panels, canvas drawing, range sliders.',
    auto_screenshot: true,
  },
  {
    name: 'hover',
    params: '{"x":N,"y":N[,"tabId":N]}',
    returns: '{"ok":true,"screenshot":"..."}',
    desc: 'Move the mouse to (x, y) without clicking. Triggers CSS :hover styles, mouseover/mouseenter events, and JS-driven hover menus (dropdowns, flyouts, tooltips). First call incurs a ~1–5 s CDP init cost; subsequent calls are fast.',
    auto_screenshot: true,
  },
  {
    name: 'scroll',
    params: '{"deltaY":N[,"deltaX":N,"x":N,"y":N,"tabId":N]}',
    returns: '{"ok":true,"screenshot":"..."}',
    desc: 'Scroll the page. Positive deltaY = down, negative = up. Pass x,y to target a specific scrollable container at those viewport coordinates (e.g. a sidebar or modal) instead of the page-center default.',
    auto_screenshot: true,
  },
  {
    name: 'find_element',
    params: '{"text":"label" | "selector":"css" [,"exact":bool,"x_max":N,"within_selector":"css","nth":N,"visible_only":bool,"frame_selector":"css","tabId":N]}',
    returns: '{"found":true,"x":N,"y":N,"tag":"BUTTON","text":"...","href":"..."}',
    desc: 'Find element and return its viewport centre coordinates without clicking. Pierces shadow DOM automatically. Use frame_selector to scope to a same-origin <iframe> (e.g. "#payment-iframe"). Returned x/y are main-viewport coordinates, usable directly with /click.',
    auto_screenshot: false,
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
    params: '[{"url":"https://..."}]',
    returns: '{"index":N,"tabId":N,"url":"...","screenshot":"..."}',
    desc: 'Open a new tab. Save tabId — use it for all targeted commands. Response includes auto-screenshot.',
    auto_screenshot: true,
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
