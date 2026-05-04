/**
 * Tiny Browser — offscreen document
 *
 * Maintains a persistent WebSocket connection to the local server.
 * Forwards each command to the background service worker (which holds
 * chrome.debugger privileges) via chrome.runtime.sendMessage, then
 * returns the result to the server over the same WebSocket.
 *
 * Unlike the MV3 service worker, this document is not terminated by Chrome
 * between commands, so the connection stays alive for the entire browser
 * session regardless of idle time.
 */

'use strict';

const WS_URL = 'ws://127.0.0.1:7331';
const RECONNECT_DELAY_MS = 3000;

let ws = null;

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    console.log('[tiny-mcp] offscreen connected');
  });

  ws.addEventListener('message', async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    try {
      // Wakes the service worker if needed; it stays alive while handling the message.
      const result = await chrome.runtime.sendMessage({
        _tiny: true,
        id:      msg.id,
        command: msg.command,
        params:  msg.params ?? {},
      });
      send(msg.id, result ?? { error: 'no response from service worker' });
    } catch (err) {
      send(msg.id, { error: err?.message ?? String(err) });
    }
  });

  ws.addEventListener('close', () => {
    ws = null;
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.addEventListener('error', () => { /* close fires right after — handled there */ });
}

function send(id, result) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ id, result }));
  }
}

connect();
