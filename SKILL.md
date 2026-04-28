---
name: browser-control
description: >-
  Control a real Chrome browser tab from any AI agent with shell access. Use
  when asked to browse the web, fill forms, click buttons, or automate any
  browser task. Requires the tiny-browser server to be running and the Chrome
  extension to be loaded.
---

# Browser Control

Use the **Shell tool** to run `tiny-browser COMMAND 'JSON'` commands.
Use the **Read tool** to view screenshots.

## Prerequisites — check server before first command

```bash
curl -s http://127.0.0.1:7331
# → {"status":"ok","extension":"connected"}    ← ready
# → {"status":"ok","extension":"disconnected"} ← reload Chrome extension
# → connection refused                          ← start the server first
```

Start if not running:
```bash
tiny-browser &   # kills any stale process on port 7331 automatically
```

Not found? Install once from the project directory: `npm install -g .`

If extension shows `"disconnected"`, ask the user to reload it at `chrome://extensions`.

## Command reference

```bash
tiny-browser help               # full list with params + return shapes
tiny-browser help COMMAND       # detail for one command (always up to date)
```

When unsure about params or return format, **run `tiny-browser help COMMAND` first**.

## Core loop

```
screenshot → Read PNG → identify target → act
→ response includes "screenshot" field → Read it → act again → …
```

Action commands (`click`, `navigate`, `click_element`, etc.) automatically include a
`"screenshot"` field — **read that path immediately** instead of a separate screenshot call.

Screenshots have a bold red coordinate grid every 100 px. **Use the label values as click
coordinates — not the visual pixel positions in the rendered image.**

## Patterns

**Fill / clear an input**
```bash
tiny-browser click_element '{"selector":"input[name=email]"}'
tiny-browser key_press '{"key":"SelectAll"}'
tiny-browser type '{"text":"new@email.com"}'
```

**Navigate to SPA — wait for interactive content**
```bash
# navigate waits for readyState=complete internally. SPAs may hydrate later:
tiny-browser navigate '{"url":"https://example.com/app"}'
tiny-browser wait_for_element '{"selector":"button[type=submit]","timeout":8000}'
```

**Form inside a modal**
```bash
tiny-browser click_element '{"text":"Book slot"}'   # scrolls into view automatically
tiny-browser key_press '{"key":"Tab"}'
tiny-browser type '{"text":"value"}'
tiny-browser click_element '{"text":"Submit","exact":true}'
```

**Open a dropdown option**
```bash
# Use selector= not text= — text-match can hit same-word elements behind the overlay
tiny-browser click_element '{"selector":"li[role=option]"}'
```

**Disambiguate duplicate buttons**
```bash
tiny-browser click_element '{"text":"Subscribe","exact":true,"x_max":400}'
# or: "within_selector":"section.main-card"  |  "nth":0  |  "visible_only":true
```

**Follow a link reliably**
```bash
tiny-browser read_page | python3 -c "
import json,sys
links = json.load(sys.stdin)['links']
print(next(l['href'] for l in links if 'Report' in l['text']))
"
```

**Extract structured data — discover selector first**
```bash
# Step 1: find what wraps the content
tiny-browser query '{"expression":"[\"article\",\".prose\",\"main\",\".content\",\".result\"].map(sel=>({sel,count:document.querySelectorAll(sel).length,sample:(document.querySelector(sel)||{}).textContent?.trim().slice(0,80)})).filter(e=>e.count)"}'
# Step 2: extract with the matching selector
tiny-browser query '{"expression":"Array.from(document.querySelectorAll(\".prose p\")).map(e=>e.textContent.trim()).filter(t=>t.length>15).join(\"|||\")"}'
```

**Extract real URLs from search results**
```bash
# Search engines wrap hrefs — use a[href*=domain] to get actual destinations
tiny-browser query '{"expression":"Array.from(document.querySelectorAll(\"a[href*=target-domain]\")).map(a=>({text:a.textContent.trim(),href:a.href})).filter(a=>a.text).slice(0,5)"}'
```

**Search via URL params (reliable for SPAs)**
```bash
# More reliable than typing into React inputs on background tabs
tiny-browser navigate '{"url":"https://search.example.com/?q=your+query"}'
```

**Network capture**
```bash
# navigate first (waits internally), then enable, then capture
tiny-browser navigate '{"url":"https://app.com"}'
tiny-browser enable_network
TS=$(date +%s%3N)
tiny-browser click_element '{"text":"Submit"}'
tiny-browser get_network "{\"since\":$TS}"
```

**Console errors after an action**
```bash
TS=$(date +%s%3N)
tiny-browser click_element '{"text":"Submit"}'
tiny-browser get_console "{\"since\":$TS}"
```

## Parallel execution

Every command accepts optional `tabId` (from `new_tab` or `list_tabs`).

**Best: issue multiple Shell tool calls in one agent message** — they run concurrently:
```
Shell 1: tiny-browser query '{"tabId":101,"expression":"document.title"}'
Shell 2: tiny-browser query '{"tabId":102,"expression":"document.title"}'
```

**Scripting with bash `&`:**
```bash
TA=$(tiny-browser new_tab '{"url":"https://site-a.com"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['tabId'])")
TB=$(tiny-browser new_tab '{"url":"https://site-b.com"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['tabId'])")

tiny-browser query "{\"tabId\":$TA,\"expression\":\"document.title\"}" &
tiny-browser query "{\"tabId\":$TB,\"expression\":\"document.title\"}" &
wait
```

`new_tab` and `navigate` both wait for the page to load before returning — no extra `wait` needed.
Parallel screenshots write to `/tmp/tiny-browser-screenshot-{tabId}.png` and never overwrite each other.

## Gotchas

- **Auto-screenshot**: action responses include `"screenshot"` — read it immediately, don't call screenshot separately
- **SPA hydration**: `navigate` waits for `readyState=complete` but React/Vue may render buttons after that — use `wait_for_element` on the specific element before acting
- **Off-screen elements**: `click_element` scrolls into view automatically
- **Modals / overlays**: use `click_element` + Tab navigation — a missed coordinate click dismisses the overlay
- **Dropdown options**: use `{"selector":"li[role=option]"}` not `{"text":"…"}` when a dropdown is open — text-match hits background elements
- **Pre-filled inputs**: `click_element` to focus → `SelectAll` → `type` new value
- **Shadow DOM**: `find_element`/`click_element` automatically fall back to shadow DOM search; for manual inspection use `query` with `el.shadowRoot`
- **Duplicate elements**: same button text in header and sidebar — scope with `x_max`, `within_selector`, or `nth`
- **Click coordinates are viewport-relative**: screenshot grid labels = page-offset coords, which diverge after scrolling — prefer `click_element` over reading grid coords directly
- **React inputs on background tabs**: CDP `type` bypasses synthetic events — use `?q=` URL params or `switch_tab` to activate first
- **enable_network order**: call after `navigate`, not before — early call can attach to a `chrome://` tab
- **New tabs from links**: after a `target="_blank"` click, use `list_tabs` → `switch_tab` to follow it
- **Search engine hrefs**: result links are wrapped — extract via `a[href*=target-domain]`, not result card selectors
- **CSS selectors**: never guess class names — use the "Discover selector" pattern first
- **Cookie banners**: `click_element '{"text":"Accept"}'` before interacting
- **exact:true**: use when multiple elements share the same word (e.g. "Book" vs "Book appointment")
- **`bash &` warning**: `zsh: nice(5) failed: operation not permitted` is a harmless sandbox restriction
- **Slow background tabs**: screenshot default timeout 20s — pass `{"timeout_ms":30000}` if it times out
