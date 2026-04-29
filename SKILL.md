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

**Type a long string fast** — skip per-keystroke delays (~10× faster for strings > 10 chars)
```bash
tiny-browser type '{"text":"long paragraph or a search query here","fast":true}'
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

**Select from a native `<select>` dropdown**
```bash
# By option value attribute (most reliable)
tiny-browser select_option '{"selector":"select[name=country]","value":"US"}'
# By visible option text (case-insensitive)
tiny-browser select_option '{"selector":"#sort","text":"Newest first"}'
```

**Open a custom (non-native) dropdown option**
```bash
# Use selector= not text= — text-match can hit same-word elements behind the overlay
tiny-browser click_element '{"selector":"li[role=option]"}'
```

**Trigger a hover-activated menu or tooltip**
```bash
# Take a screenshot first to find the coordinates of the nav item
tiny-browser screenshot
# Move the mouse to the nav item — CSS :hover activates, dropdown appears
tiny-browser hover '{"x":350,"y":60}'
# Read the screenshot in the response, then click the revealed option
tiny-browser click_element '{"text":"Settings"}'
```

**Drag and drop (Kanban, sortable lists, resizable panels)**
```bash
# Take a screenshot to get source and target coordinates from the grid
tiny-browser screenshot
# Drag from one card to another column — steps:20 for smooth SPAs like Linear/Trello
tiny-browser drag '{"fromX":200,"fromY":300,"toX":600,"toY":300,"steps":20,"duration":500}'
# Read the auto-screenshot to confirm the drop landed correctly
```

**Read a long article without truncation**
```bash
# Default text_limit is 4000 chars — use a higher value for long-form content
tiny-browser read_page '{"text_limit":20000}'
```

**Disambiguate duplicate buttons**
```bash
tiny-browser click_element '{"text":"Subscribe","exact":true,"x_max":400}'
# or: "within_selector":"section.main-card"  |  "nth":0  |  "visible_only":true
```

**Follow a link reliably** — `read_page` returns up to 100 links; for link-heavy pages use `query` to extract more
```bash
tiny-browser read_page | python3 -c "
import json,sys
links = json.load(sys.stdin)['links']
print(next(l['href'] for l in links if 'Report' in l['text']))
"
# For more than 100 links:
tiny-browser query '{"expression":"Array.from(document.querySelectorAll(\"a[href]\")).map(a=>({text:a.innerText.trim().slice(0,80),href:a.href})).filter(l=>l.text).slice(0,200)"}'
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
- **`hover` first-call latency**: the first `hover` in a session incurs a ~1–5 s Chrome CDP input-pipeline init cost; subsequent calls are fast. The auto-screenshot in the response confirms the hover state was reached.
- **SPA hydration**: `navigate` waits for `readyState=complete` but React/Vue may render buttons after that — use `wait_for_element` on the specific element before acting
- **Off-screen elements**: `click_element` scrolls into view automatically
- **Modals / overlays**: use `click_element` + Tab navigation — a missed coordinate click dismisses the overlay
- **Dropdown options**: use `{"selector":"li[role=option]"}` not `{"text":"…"}` when a dropdown is open — text-match hits background elements
- **Pre-filled inputs**: `click_element` to focus → `SelectAll` → `type` new value
- **Shadow DOM**: `find_element`/`click_element` automatically fall back to shadow DOM search; for manual inspection use `query` with `el.shadowRoot`
- **Duplicate elements**: same button text in header and sidebar — scope with `x_max`, `within_selector`, or `nth`
- **Click coordinates are viewport-relative**: screenshot grid labels = CSS pixel coords (DPR-corrected) — use them directly as click coordinates
- **React inputs on background tabs**: CDP `type` bypasses synthetic events — use `?q=` URL params or `switch_tab` to activate first
- **enable_network order**: call after `navigate`, not before — early call can attach to a `chrome://` tab
- **New tabs from links**: after a `target="_blank"` click, use `list_tabs` → `switch_tab` to follow it
- **Search engine hrefs**: result links are wrapped — extract via `a[href*=target-domain]`, not result card selectors
- **CSS selectors**: never guess class names — use the "Discover selector" pattern first
- **Cookie banners**: `click_element '{"text":"Accept"}'` before interacting
- **exact:true**: use when multiple elements share the same word (e.g. "Book" vs "Book appointment")
- **`bash &` warning**: `zsh: nice(5) failed: operation not permitted` is a harmless sandbox restriction
- **Slow background tabs**: screenshot default timeout 20s — pass `{"timeout_ms":30000}` if it times out
- **query returns null**: `query` returns `{result:null}` when the expression evaluates to `undefined` (e.g. missing selector via optional chaining) — check for null before using the result
- **read_page link cap**: `read_page` returns up to 100 links; use `query` with a custom expression for more
- **Fast typing**: `"fast":true` uses `Input.insertText` — one CDP round trip for any string length (~50ms flat). Fires `input`/`beforeinput` but not `keydown`/`keyup`; works for most React/Vue forms. Omit for sites that require per-key events
- **scroll is instant**: `scroll` uses `window.scrollBy({behavior:'instant'})` — it overrides CSS `scroll-behavior:smooth` and completes in ~0.6s; scrollY is at the final position immediately after the call returns
- **scroll takes `deltaY`/`deltaX`**: positive deltaY scrolls down, negative scrolls up; no `x`/`y` center params needed
- **scroll on SPAs (LinkedIn, Gmail, etc.)**: if the page uses an inner scroll container, `scroll` auto-detects it by checking whether `window.scrollY` changed; if not, it finds the deepest `overflow:auto/scroll` ancestor at the viewport center and scrolls that instead — no special params needed
- **newlines in `type`**: `\n` in the text string dispatches a real Enter keypress (keyCode 13); works in textareas and GitHub/Notion editors; `\t` dispatches Tab
- **CSS selector attribute values with brackets**: `input[name=foo[bar]]` is invalid CSS — always quote attribute values: `input[name="foo[bar]"]`. Invalid selectors now silently fall through to text-match rather than crashing
- **multi-step data pipelines**: use Python (`python3 - <<'PYEOF'`) not bash arrays when iterating over dynamic data with spaces — bash subshells break array accumulation and spaces break word-splitting
- **stale tabs**: tabs opened before a server restart show ERR_FILE_NOT_FOUND; always open fresh tabs with `new_tab` at the start of a workflow
- **UI-first navigation**: always click through the visible UI (Locations → type → autocomplete → Show results) rather than guessing URL parameters (geoUrn, etc.) — parameter values are opaque and wrong guesses waste time
- **`read_page` on active tab only**: `read_page` works best on the active tab; for background tabs, `switch_tab` first, then call `read_page`
- **`read_page` link cap on nav-heavy pages**: Wikipedia and similar pages put 50+ language sidebar links first in the DOM, filling the 100-link cap before article content links appear. Use `within_selector` to scope: `read_page '{"within_selector":"#mw-content-text"}'`
- **`find_element` nth with selector**: `{"selector":".toggle","nth":1}` now correctly returns the 2nd matching element. Previously `querySelector` always returned element 0 regardless of nth. Fixed: uses `querySelectorAll(sel)[nth]` directly.
- **`navigate` error detection**: `navigate` now returns `{"ok":false,"error":"Navigation failed: page could not be loaded"}` when Chrome lands on an error page (DNS failure, connection refused, etc.) instead of silently returning `ok:true`. Check `ok` before proceeding.
- **`drag` steps for SPAs**: increase `steps` (default 10) to 20–30 for apps that use `pointermove` to track position (Linear, Trello, Figma). Too few steps can cause the drag to "snap" without triggering the drop target.
- **`read_page` text_limit**: pass `{"text_limit":20000}` for long articles — the default 4000-char cap truncates most real documentation pages
