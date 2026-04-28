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

async function makeScreenshot(base64) {
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

  const parts = [];
  for (let x = 0; x <= w; x += GRID) {
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="red" stroke-width="${Math.round(scale)}" opacity="0.4"/>`);
    if (x > 0) parts.push(label(x + pad, lh + pad, `${x}`));
  }
  for (let y = GRID; y <= h; y += GRID) {
    parts.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="red" stroke-width="${Math.round(scale)}" opacity="0.4"/>`);
    parts.push(label(pad, y - pad, `${y}`));
  }
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${parts.join('')}</svg>`
  );

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
  'click', 'type', 'scroll', 'navigate',
  'get_url', 'read_page', 'key_press',
  'find_element', 'click_element', 'wait', 'query',
  'list_tabs', 'new_tab', 'switch_tab', 'close_tab',
  'wait_for_element',
  'get_console', 'enable_network', 'get_network',
]);

// Commands that change visible page state — automatically include a screenshot
// in their response so the AI agent can read it without a separate round-trip.
const AUTO_SCREENSHOT = new Set([
  'click', 'type', 'scroll', 'navigate', 'new_tab', 'key_press',
  'click_element', 'wait', 'wait_for_element',
]);

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
      const { base64 } = await sendToExtension('screenshot', params);
      const png = await makeScreenshot(base64);
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
          // Wait for the page to settle before capturing.
          // navigate/new_tab: the command already waited for tab.status=complete
          // internally, so just a short settle is enough for final paint.
          // All others: 400 ms covers CSS transitions, dropdown opens, etc.
          const settleMs = (route === 'navigate' || route === 'new_tab') ? 150 : 400;
          await new Promise(r => setTimeout(r, settleMs));
          const { base64 } = await sendToExtension('screenshot', params); // forwards tabId
          const png = await makeScreenshot(base64);
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
