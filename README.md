# Tiny Browser

A Chrome extension + HTTP bridge that lets **any AI agent with shell access** control a real browser via a simple CLI.  
The extension is a dumb actuator — no AI inside. All intelligence stays in the agent.

## Architecture

```
AI Agent (shell access)
  └─ tiny-browser COMMAND 'JSON'
       └─ HTTP POST → http://127.0.0.1:7331 ── WebSocket ──► Chrome Extension ──► Active Tab
```

- **`bin/tiny-browser.mjs`** — dual-mode entry point: no args = start server, with args = CLI client
- **`bin/server.mjs`** — HTTP + WebSocket server, screenshot grid overlay, auto-screenshot on actions
- **Chrome Extension** (Manifest V3 service worker) — executes browser commands via Chrome DevTools Protocol (CDP)

Works with any AI agent that can run shell commands: Cursor, Claude Code, GPT with code interpreter, custom agents, etc.

## Setup

### 1 — Install

```bash
cd tiny-browser
npm install
npm install -g .  # makes `tiny-browser` available globally in your shell
```

`npm install -g .` only needs to be run once (re-run after pulling updates). After that `tiny-browser` works from anywhere.

### 2 — Start the server

```bash
tiny-browser      # start server (kills any existing process on port 7331 automatically)
# or:
npm start
```

The server runs at `http://127.0.0.1:7331`. Verify it's up:

```bash
curl -s http://127.0.0.1:7331
# → {"status":"ok","extension":"connected"}
```

### 3 — Load the Chrome extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder
4. Click the extension icon to confirm it shows "Connected to server"

### 4 — Install the skill file

The server copies `SKILL.md` to `~/.cursor/skills/browser-control/SKILL.md` automatically on startup.  
Cursor reads it automatically — no configuration required.

To install manually:

```bash
mkdir -p ~/.cursor/skills/browser-control
cp SKILL.md ~/.cursor/skills/browser-control/SKILL.md
```

## Usage

```bash
tiny-browser help                    # full command reference
tiny-browser help navigate           # detail for a specific command
tiny-browser screenshot              # take a screenshot
tiny-browser navigate '{"url":"https://example.com"}'
tiny-browser click_element '{"text":"Sign in","exact":true}'
tiny-browser query '{"expression":"document.title"}'
```

Action commands (`click`, `navigate`, `click_element`, etc.) automatically include a `"screenshot"` field in their response — the AI can read it immediately without a separate screenshot call.

Screenshots overlay a DPR-corrected coordinate grid in CSS pixels — use the red grid labels as click coordinates directly.

For the full list of commands, params, and patterns see `SKILL.md` or run `tiny-browser help`.

### Performance notes

| Command | Typical time |
|---|---|
| `navigate` | ~1.5s (waits for `readyState=complete` + screenshot) |
| `click` / `click_element` | ~0.7s (consistent — no jitter overhead) |
| `type` (default) | ~85ms/char + screenshot |
| `type` with `fast:true` | ~0.6s flat regardless of length |
| `screenshot` | ~0.5s |
| `query` / `find_element` | ~0.05–0.1s |

## Project structure

```
tiny-browser/
  bin/
    tiny-browser.mjs  CLI entry point (server mode + client mode) + built-in help
    server.mjs        HTTP REST server + WebSocket bridge + screenshot grid overlay
  extension/
    manifest.json     Manifest V3
    background.js     Service worker: WS client, CDP command dispatcher, shadow DOM support
    popup.html/js     Status indicator
  SKILL.md            AI agent instructions (auto-installed to ~/.cursor/skills/ on server start)
  package.json
  README.md
```

## Development

After changing `bin/server.mjs` or `bin/tiny-browser.mjs`:
```bash
tiny-browser   # restarts automatically (kills previous process on 7331)
```

After changing `extension/background.js`:
```
chrome://extensions → Tiny Browser → reload icon
```
