#!/usr/bin/env node
/**
 * tiny-browser — HTTP REST bridge between Cursor AI agents and Chrome extension.
 *
 * AI agents use `curl` to POST commands; the Chrome extension connects via WebSocket.
 * Both live on the same port (7331): HTTP for the AI, WS upgrade for the extension.
 *
 * Usage:
 *   node bin/server.mjs          (local)
 *   npx tiny-browser             (global install)
 *
 * On startup: installs/updates the SKILL.md in ~/.cursor/skills/browser-control/
 * so Cursor picks up the latest usage instructions automatically.
 */

import http from 'http';
import { WebSocketServer } from 'ws';
import sharp from 'sharp';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const PORT = Number(process.env.TINY_BROWSER_PORT ?? 7331);
const SCREENSHOT_PATH = path.join(os.tmpdir(), 'tiny-browser-screenshot.png');

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SKILL_SRC  = path.resolve(__dir, '../SKILL.md');
const SKILL_DEST = path.join(os.homedir(), '.cursor', 'skills', 'browser-control', 'SKILL.md');

// ---------------------------------------------------------------------------
// Screenshot: overlay coordinate grid, downscale to MAX_WIDTH
// ---------------------------------------------------------------------------

const MAX_WIDTH = 1024;
const GRID = 100;

/**
 * Overlay a coordinate grid on a screenshot and optionally downscale.
 *
 * dpr — device pixel ratio of the source tab (default 1).
 * Page.captureScreenshot returns an image at physical resolution (DPR × CSS viewport).
 * Input.dispatchMouseEvent uses CSS pixels, so grid lines must be spaced every
 * GRID *CSS* pixels (= GRID * dpr physical pixels) and labelled with CSS values.
 * This ensures grid labels match click coordinates exactly on HiDPI displays.
 */
async function makeScreenshot(base64, dpr = 1) {
  const buf = Buffer.from(base64, 'base64');
  const { width: w, height: h } = await sharp(buf).metadata();

  // Scale label font so it stays legible after the image is downscaled to MAX_WIDTH
  const scale = w > MAX_WIDTH ? w / MAX_WIDTH : 1;
  const fs   = Math.round(13 * scale);  // font-size in original pixels
  const pad  = Math.round(2  * scale);  // inner padding of background rect
  const lh   = fs + pad * 2;            // label height

  function label(x, y, text, anchor = 'start') {
    // Estimate text width: monospace chars are ~0.6× font-size wide
    const tw = Math.round(text.length * fs * 0.62);
    const bx = anchor === 'start' ? x : x - tw - pad * 2;
    return [
      `<rect x="${bx}" y="${y - fs - pad}" width="${tw + pad * 2}" height="${lh}" fill="white" opacity="0.75"/>`,
      `<text x="${bx + pad}" y="${y - pad}" font-family="monospace" font-size="${fs}" font-weight="bold" fill="red">${text}</text>`,
    ].join('');
  }

  // Step size in physical pixels = GRID CSS pixels × DPR
  const step = Math.round(GRID * dpr);
  const parts = [];
  for (let x = 0; x <= w; x += step) {
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="red" stroke-width="${Math.round(scale)}" opacity="0.4"/>`);
    if (x > 0) parts.push(label(x + pad, lh + pad, `${Math.round(x / dpr)}`));
  }
  for (let y = step; y <= h; y += step) {
    parts.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="red" stroke-width="${Math.round(scale)}" opacity="0.4"/>`);
    parts.push(label(pad, y - pad, `${Math.round(y / dpr)}`));
  }
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${parts.join('')}</svg>`
  );

  // Two-step: composite grid onto full-resolution image first, then downscale.
  // sharp applies resize before composite internally, so chaining .composite().resize()
  // would try to overlay the full-size SVG onto an already-shrunk base → error.
  // Materialising the composited buffer first avoids that ordering issue.
  const composited = await sharp(buf).composite([{ input: svg }]).toBuffer();
  return w > MAX_WIDTH
    ? sharp(composited).resize({ width: MAX_WIDTH, withoutEnlargement: true }).toBuffer()
    : composited;
}

// ---------------------------------------------------------------------------
// WebSocket bridge to Chrome extension
// ---------------------------------------------------------------------------

let socket = null;
const pending = new Map();
let seq = 0;

function sendToExtension(command, params = {}) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== 1) {
      return reject(new Error('Chrome extension not connected. Is the extension loaded?'));
    }
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Command "${command}" timed out after 30s`));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, command, params }));
  });
}

// ---------------------------------------------------------------------------
// HTTP REST server
// ---------------------------------------------------------------------------

const ROUTES = new Set([
  'click', 'drag', 'type', 'scroll', 'navigate',
  'get_url', 'read_page', 'key_press',
  'select_option', 'wait', 'query',
  'list_tabs', 'new_tab', 'switch_tab', 'close_tab',
  'get_console', 'enable_network', 'get_network',
  'hover',
  'get_dialog', 'dismiss_dialog', 'set_file_input',
]);

// Commands that change visible page state — automatically include a screenshot
// in their response so the AI agent can read it without a separate round-trip.
const AUTO_SCREENSHOT = new Set([
  'click', 'drag', 'type', 'scroll', 'navigate', 'new_tab', 'key_press',
  'select_option', 'wait', 'hover',
  'set_file_input',  // file label updates immediately; confirm with auto-screenshot
]);

// Per-command settle time (ms) between command completion and auto-screenshot.
// Tuned to each command's typical DOM side-effect latency:
//   navigate/new_tab   — already polled to readyState=complete; 150ms covers final paint.
//   wait/wait_for_el   — element is already confirmed present; minimal settle needed.
//   click/click_el     — synchronous click; allow one repaint + CSS transition.
//   scroll             — wheel events settle quickly; some lazy-load needs a moment.
//   key_press          — keystroke fires synchronously; short settle for inline validation.
//   type               — last keystroke has fired; UI update is fast.
//   hover              — CSS :hover transitions typically complete within 200ms.
const SETTLE_MS = {
  navigate:       150,
  new_tab:        150,
  wait:            50,
  click:          200,
  drag:           200,  // allow drop targets to settle after mouseReleased
  select_option:  150,
  scroll:          60,  // scrollBy({behavior:'instant'}) is synchronous; 60ms covers repaint
  key_press:      150,
  type:           150,
  hover:          200,
  set_file_input:  50,  // file label update is synchronous; 50ms covers repaint
};

const server = http.createServer(async (req, res) => {
  const reply = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // Status / health check
  if (req.method === 'GET') {
    return reply(200, {
      status: 'ok',
      extension: socket?.readyState === 1 ? 'connected' : 'disconnected',
    });
  }

  if (req.method !== 'POST') return reply(405, { error: 'POST required' });

  let body = '';
  for await (const chunk of req) body += chunk;

  let params;
  try {
    params = body ? JSON.parse(body) : {};
  } catch {
    return reply(400, { error: 'Invalid JSON body' });
  }

  const route = (req.url ?? '/').slice(1);

  try {
    if (route === 'screenshot') {
      const { base64, dpr } = await sendToExtension('screenshot', params);
      const png = await makeScreenshot(base64, dpr);
      // Use a tab-specific path when tabId is provided so parallel screenshots
      // from different tabs don't overwrite each other.
      const filePath = params.tabId != null
        ? path.join(os.tmpdir(), `tiny-browser-screenshot-${params.tabId}.png`)
        : SCREENSHOT_PATH;
      fs.writeFileSync(filePath, png);
      return reply(200, { file: filePath });
    }

    if (ROUTES.has(route)) {
      const result = await sendToExtension(route, params);
      if (AUTO_SCREENSHOT.has(route)) {
        try {
          // Per-command settle delay before capturing the auto-screenshot.
          // navigate/new_tab already waited for tab.status=complete internally;
          // only a short final-paint settle is needed.  Interactive commands get
          // tuned values that cover their typical DOM side-effects without
          // over-waiting.
          const settleMs = SETTLE_MS[route] ?? 250;
          await new Promise(r => setTimeout(r, settleMs));
          const { base64, dpr } = await sendToExtension('screenshot', params); // forwards tabId
          const png = await makeScreenshot(base64, dpr);
          const filePath = params.tabId != null
            ? path.join(os.tmpdir(), `tiny-browser-screenshot-${params.tabId}.png`)
            : SCREENSHOT_PATH;
          fs.writeFileSync(filePath, png);
          result.screenshot = filePath;
        } catch { /* best-effort — never fail the original command */ }
      }
      return reply(200, result);
    }

    reply(404, { error: `unknown route: ${route}` });
  } catch (err) {
    reply(500, { error: err.message });
  }
});

// ---------------------------------------------------------------------------
// WebSocket server — attached to the same HTTP server (handles WS upgrades)
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('[tiny-browser] Chrome extension connected');
  socket = ws;

  ws.on('message', (raw) => {
    const { id, result } = JSON.parse(raw.toString());
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    if (result?.error) p.reject(new Error(result.error));
    else p.resolve(result);
  });

  ws.on('close', () => {
    if (socket === ws) socket = null;
    console.log('[tiny-browser] Chrome extension disconnected');
  });
});

// ---------------------------------------------------------------------------
// Start — install skill file then listen
// ---------------------------------------------------------------------------

server.listen(PORT, '127.0.0.1', () => {
  try {
    fs.mkdirSync(path.dirname(SKILL_DEST), { recursive: true });
    fs.copyFileSync(SKILL_SRC, SKILL_DEST);
    console.log(`[tiny-browser] Skill updated: ${SKILL_DEST}`);
  } catch (err) {
    console.warn(`[tiny-browser] Could not install skill: ${err.message}`);
  }

  console.log(`[tiny-browser] Ready at http://127.0.0.1:${PORT}`);
  console.log(`[tiny-browser] Screenshots → ${SCREENSHOT_PATH}`);
  console.log('[tiny-browser] Load the Chrome extension, then use Cursor.');
});
