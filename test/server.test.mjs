/**
 * Integration tests for bin/server.mjs.
 *
 * Spawns the server on a dedicated test port, runs HTTP assertions,
 * then shuts it down.  No Chrome extension is connected, so any
 * command that reaches sendToExtension() will 500 — that's intentional.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const PORT = 17331;
const __dir = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dir, '../bin/server.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const opts = {
      hostname: '127.0.0.1',
      port: PORT,
      path: route,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload != null ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

function rawPost(route, rawBody) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: PORT,
      path: route,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawBody),
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

function waitReady(retries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/', method: 'GET' }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (--retries <= 0) return reject(new Error('Server did not start in time'));
        setTimeout(attempt, 100);
      });
      req.end();
    };
    attempt();
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let proc;

before(async () => {
  proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, TINY_BROWSER_PORT: String(PORT) },
    stdio: 'ignore',
  });
  await waitReady();
});

after(() => {
  proc?.kill();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('GET / returns 200 with status and extension fields', async () => {
  const { status, body } = await request('GET', '/');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.ok('extension' in body);
  assert.equal(body.extension, 'disconnected');
});

test('PUT / returns 405', async () => {
  const { status, body } = await request('PUT', '/');
  assert.equal(status, 405);
  assert.ok(body.error);
});

test('POST to unknown route returns 404', async () => {
  const { status, body } = await request('POST', '/not_a_command', {});
  assert.equal(status, 404);
  assert.match(body.error, /unknown route/);
});

test('POST with invalid JSON body returns 400', async () => {
  const { status, body } = await rawPost('/click', 'not-json');
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('POST to known route without extension returns 500 with descriptive error', async () => {
  const { status, body } = await request('POST', '/click', { x: 10, y: 10 });
  assert.equal(status, 500);
  assert.match(body.error, /Chrome extension not connected/);
});

test('POST screenshot without extension returns 500', async () => {
  const { status, body } = await request('POST', '/screenshot', {});
  assert.equal(status, 500);
  assert.ok(body.error);
});

test('every ROUTES entry has a matching COMMANDS catalogue entry', async () => {
  const fs = await import('fs');

  // Extract route names from the ROUTES Set literal in server.mjs
  const serverSrc = fs.readFileSync(path.resolve(__dir, '../bin/server.mjs'), 'utf8');
  const routesMatch = serverSrc.match(/const ROUTES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(routesMatch, 'ROUTES set not found in server.mjs');
  const routes = routesMatch[1].match(/'[^']+'/g).map(s => s.slice(1, -1));

  // Extract command names from the name: '...' entries in COMMANDS in tiny-browser.mjs
  const cliSrc = fs.readFileSync(path.resolve(__dir, '../bin/tiny-browser.mjs'), 'utf8');
  const nameMatches = [...cliSrc.matchAll(/name:\s*'([^']+)'/g)].map(m => m[1]);
  assert.ok(nameMatches.length > 0, 'No name entries found in COMMANDS in tiny-browser.mjs');
  const cataloguedNames = new Set(nameMatches);

  const missing = routes.filter(r => !cataloguedNames.has(r));
  assert.deepEqual(missing, [], `Routes missing from help catalogue: ${missing.join(', ')}`);
});
