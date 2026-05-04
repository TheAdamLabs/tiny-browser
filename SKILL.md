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
detect_boxes  →  read items[]  →  compute cx/cy from rect  →  click cx,cy
              →  response includes boxes[]  →  read updated items  →  act again
              →  call screenshot only when visual state matters
```

`detect_boxes` returns all visible interactive controls (buttons, links, inputs), semantic cards, and images with exact CSS-pixel bounding boxes. It is the primary navigation method — **~5–10× fewer tokens than a screenshot**.

Action commands (`click`, `navigate`, `type`, etc.) automatically include `boxes[]` in their response — read that directly to find the next target without a separate call.

Use `screenshot` when you need to verify visual state (error colours, loading spinners, canvas, overlays) or when `detect_boxes` misses something (shadow DOM, cross-origin iframes).

**Computing click coordinates from a box:**
```
cx = rect.left + rect.width  / 2
cy = rect.top  + rect.height / 2
```

## Patterns

**Identify and click any element (primary — no screenshot needed)**
```bash
# Discover all visible controls, cards, images with bounding boxes
tiny-browser detect_boxes
# Returns items like: {"id":"C3","kind":"control","tag":"button","text":"Sign in",
#   "rect":{"left":320,"top":240,"width":120,"height":40}, "selector":"..."}
# Compute center: cx = 320 + 120/2 = 380,  cy = 240 + 40/2 = 260
tiny-browser click '{"x":380,"y":260}'
# Response includes boxes[] — read updated items to find the next target
```

**When to use screenshot instead of detect_boxes**
```bash
# Use screenshot when visual state matters:
#   - Error colour / success colour on a field or banner
#   - Loading spinner / skeleton covering interactive elements
#   - Canvas or WebGL content (charts, maps, games)
#   - Cross-origin iframe content
#   - Element visually covered by a modal or overlay
tiny-browser screenshot
# Read the PNG — use the red grid label values as click coordinates
```

**Identify and click any element (screenshot fallback)**
```bash
tiny-browser screenshot
# Read the PNG — find the element in the grid, note its coordinates
tiny-browser click '{"x":350,"y":240}'
# The response includes boxes[] and screenshot — read boxes[] first
```

**Visual debugging with detect_boxes overlay**
```bash
# draw:true paints coloured boxes on the page — always pair with a screenshot
tiny-browser detect_boxes '{"draw":true}'
tiny-browser screenshot
# Red = controls (C*), Green = cards (K*), Purple = images (I*)
```

**Fill a text field**
```bash
tiny-browser detect_boxes
# Find the input: {"id":"C2","kind":"control","tag":"input","text":"Email","rect":{"left":200,"top":300,"width":300,"height":40}}
tiny-browser click '{"x":350,"y":320}'  # cx = 200+300/2, cy = 300+40/2
tiny-browser key_press '{"key":"SelectAll"}'
tiny-browser type '{"text":"new value"}'
```

**Type a long string fast** — skip per-keystroke delays (~10× faster for strings > 10 chars)
```bash
tiny-browser type '{"text":"long paragraph or a search query here","fast":true}'
```

**Navigate and wait for content to appear**
```bash
tiny-browser navigate '{"url":"https://example.com/app"}'
# navigate waits for tab load internally and returns boxes[].
# SPAs may hydrate later — use wait + detect_boxes to confirm interactive content is loaded.
tiny-browser wait '{"timeout":8000}'
# Read boxes[] in the response to verify interactive elements are present
```

**Form inside a modal**
```bash
tiny-browser detect_boxes
# Find the trigger button by text (e.g. "Open", "Add", "Edit")
tiny-browser click '{"x":N,"y":N}'
# Read boxes[] in the response — modal controls are now listed
# Find each field and the submit button
tiny-browser click '{"x":N,"y":N}'   # focus first field
tiny-browser type '{"text":"value"}'
tiny-browser click '{"x":N,"y":N}'   # submit button
```

**Select from a native `<select>` dropdown**
```bash
# By option value attribute (most reliable)
tiny-browser select_option '{"selector":"select[name=country]","value":"US"}'
# By visible option text (case-insensitive)
tiny-browser select_option '{"selector":"#sort","text":"Newest first"}'
```

**Open a custom (non-native) dropdown**
```bash
tiny-browser detect_boxes
# Find the dropdown trigger control by text
tiny-browser click '{"x":N,"y":N}'
# Read boxes[] — the dropdown options are now listed as controls
# Find the desired option by text and click its center coordinates
tiny-browser click '{"x":N,"y":N}'
```

**Trigger a hover-activated menu or tooltip**
```bash
# Take detect_boxes to find the nav item coordinates
tiny-browser detect_boxes
# Move the mouse to the nav item — CSS :hover activates, dropdown appears
tiny-browser hover '{"x":350,"y":60}'
# Read boxes[] in the response — revealed options are now listed
tiny-browser click '{"x":N,"y":N}'
```

**Drag and drop (Kanban, sortable lists, resizable panels)**
```bash
# detect_boxes to get source and target center coordinates
tiny-browser detect_boxes
# Drag from one card to another column — steps:20 for smooth SPAs like Linear/Trello
tiny-browser drag '{"fromX":200,"fromY":300,"toX":600,"toY":300,"steps":20,"duration":500}'
# Read boxes[] in response to confirm new layout
```

**HTML5 drag & drop (sites using dragstart/dragover/drop events)**
```bash
# Some sites (e.g. the-internet.herokuapp.com/drag_and_drop) use the HTML5
# DnD API; standard mouse events don't trigger it — use html5:true
tiny-browser detect_boxes
tiny-browser drag '{"fromX":200,"fromY":300,"toX":600,"toY":300,"html5":true}'
# Read boxes[] to confirm
```

**Handle a JS alert / confirm / prompt**
```bash
# If a page fires window.alert/confirm/prompt, the tab freezes for other commands.
# Check for an open dialog first:
tiny-browser get_dialog
# → {"type":"alert","message":"Are you sure?"} or null

# Accept it (OK button):
tiny-browser dismiss_dialog '{"accept":true}'
# Cancel it:
tiny-browser dismiss_dialog '{"accept":false}'
# Fill in a prompt() and accept:
tiny-browser dismiss_dialog '{"accept":true,"promptText":"my answer"}'
# After dismissal all commands work normally again
```

**Set a native file input without an OS picker**
```bash
# Bypass the OS file picker entirely — set the file path directly via CDP
tiny-browser set_file_input '{"files":"/absolute/path/to/file.pdf"}'
# Multiple files on a multi-select input:
tiny-browser set_file_input '{"files":["/path/a.jpg","/path/b.jpg"],"selector":"#avatar-upload"}'
# Response includes auto-screenshot showing the updated filename label
```

**Read a long article without truncation**
```bash
# Default text_limit is 4000 chars — use a higher value for long-form content
tiny-browser read_page '{"text_limit":20000}'
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
tiny-browser click '{"x":N,"y":N}'
tiny-browser get_network "{\"since\":$TS}"
```

**Console errors after an action**
```bash
TS=$(date +%s%3N)
tiny-browser click '{"x":N,"y":N}'
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
- **SPA hydration**: `navigate` waits for tab load but React/Vue may render after that — use `wait` + screenshot loop to confirm the page is interactive before acting
- **Off-screen elements**: scroll to bring elements into view before clicking (`scroll '{"deltaY":300}'`), then take a screenshot to get fresh coordinates
- **Modals / overlays**: click in the modal boundary — a click outside dismisses it
- **Native `<select>` dropdowns**: OS-level pickers don't appear in screenshots; use `select_option` to set them by value or text
- **Custom dropdowns**: click the trigger → read auto-screenshot → click the option at its coordinates
- **Pre-filled inputs**: click to focus → `key_press SelectAll` → `type` new value
- **Click coordinates are viewport-relative**: screenshot grid labels = CSS pixel coords (DPR-corrected) — use them directly as click coordinates
- **React inputs on background tabs**: CDP `type` bypasses synthetic events — use `?q=` URL params or `switch_tab` to activate first
- **enable_network order**: call after `navigate`, not before — early call can attach to a `chrome://` tab
- **New tabs from links**: after a `target="_blank"` click, use `list_tabs` → `switch_tab` to follow it
- **Search engine hrefs**: result links are wrapped — extract via `a[href*=target-domain]`, not result card selectors
- **`bash &` warning**: `zsh: nice(5) failed: operation not permitted` is a harmless sandbox restriction
- **Slow background tabs**: screenshot default timeout 20s — pass `{"timeout_ms":30000}` if it times out
- **query returns null**: `query` returns `{result:null}` when the expression evaluates to `undefined` (e.g. missing selector via optional chaining) — check for null before using the result
- **read_page link cap**: `read_page` returns up to 100 links; use `query` with a custom expression for more
- **Fast typing**: `"fast":true` uses `Input.insertText` — one CDP round trip for any string length (~50ms flat). Fires `input`/`beforeinput` but not `keydown`/`keyup`; works for most React/Vue forms. Omit for sites that require per-key events
- **scroll is instant**: `scroll` uses `window.scrollBy({behavior:'instant'})` — it overrides CSS `scroll-behavior:smooth` and completes in ~0.6s; scrollY is at the final position immediately after the call returns
- **scroll takes `deltaY`/`deltaX`**: positive deltaY scrolls down, negative scrolls up
- **scroll on SPAs (LinkedIn, Gmail, etc.)**: if the page uses an inner scroll container, `scroll` auto-detects it by checking whether `window.scrollY` changed; if not, it finds the deepest `overflow:auto/scroll` ancestor at the viewport center and scrolls that instead — no special params needed
- **newlines in `type`**: `\n` in the text string dispatches a real Enter keypress (keyCode 13); works in textareas and GitHub/Notion editors; `\t` dispatches Tab
- **multi-step data pipelines**: use Python (`python3 - <<'PYEOF'`) not bash arrays when iterating over dynamic data with spaces — bash subshells break array accumulation and spaces break word-splitting
- **stale tabs**: tabs opened before a server restart show ERR_FILE_NOT_FOUND; always open fresh tabs with `new_tab` at the start of a workflow
- **UI-first navigation**: always click through the visible UI rather than guessing URL parameters — parameter values are opaque and wrong guesses waste time
- **`read_page` on active tab only**: `read_page` works best on the active tab; for background tabs, `switch_tab` first, then call `read_page`
- **`read_page` link cap on nav-heavy pages**: Wikipedia and similar pages put 50+ language sidebar links first in the DOM, filling the 100-link cap before article content links appear. Use `within_selector` to scope: `read_page '{"within_selector":"#mw-content-text"}'`
- **`navigate` error detection**: `navigate` returns `{"ok":false,"error":"Navigation failed: page could not be loaded"}` when Chrome lands on an error page (DNS failure, connection refused, etc.) instead of silently returning `ok:true`. Check `ok` before proceeding.
- **`drag` auto-activates background tabs**: like `click`, `drag` now auto-activates the target tab when `tabId` is provided — no manual `switch_tab` needed before dragging to background tabs.
- **`drag` steps for SPAs**: increase `steps` (default 10) to 20–30 for apps that use `pointermove` to track position (Linear, Trello, Figma). Too few steps can cause the drag to "snap" without triggering the drop target.
- **`drag html5` vs default**: use `html5:true` when the site relies on the HTML5 Drag and Drop API (`dragstart`/`dragover`/`drop` events). Use the default (mouse events) for canvas, range sliders, or pointer-event-based UIs. Both modes accept the same source/target coordinates from the screenshot grid.
- **JS alert freezes tab**: when `window.alert/confirm/prompt` fires, ALL subsequent commands on that tab block for 30s then fail. Use `get_dialog` to detect the open dialog, then `dismiss_dialog` to unblock — this works even while V8 is paused. Never send any other command to the tab before dismissing the dialog.
- **`set_file_input` requires absolute paths**: paths must be absolute on the machine running Chrome (not the agent machine if different). Selector defaults to `input[type="file"]`; pass `selector` when a page has multiple file inputs.
- **scroll returns scrollY/scrollX**: the `scroll` response now includes `scrollY` and `scrollX` — use these to offset click coordinates for elements that are now in view after scrolling. This avoids a separate `query` round-trip to get scroll position.
- **background tab click auto-activates**: when you pass an explicit `tabId` to `click`, the extension now automatically activates that tab before sending the mouse event so JS synthetic events fire correctly. You don't need a manual `switch_tab` first.
- **Shadow DOM and `query`**: `document.querySelector` doesn't pierce shadow roots. For data inside shadow DOM components, query through the host: `document.querySelector('my-component').shadowRoot.querySelector('.price')?.textContent`. Clicks still work via coordinates — the visual loop is unaffected.
- **Google / Bing search results below fold**: the AI Overview block pushes organic results below the viewport. After `navigate` to a search results page, `scroll` down 600–800px before calling `detect_boxes` to reveal the result links.
- **`contenteditable` rich-text fields**: `detect_boxes` now returns `div[contenteditable="true"]` and `[role="textbox"]` elements (LinkedIn composer, comment boxes, Gmail compose, Notion, Slack, etc.) as controls with `inputType:"contenteditable"`. Click the item to focus it, then `type` to insert text — same flow as a normal `<textarea>`.
- **Exit-intent triggers**: `mouseleave` on `document` (mouse leaving the viewport top) cannot be fired via CDP — `hover` sends `mouseMoved` which doesn't trigger document-level `mouseleave`. Use screenshot to confirm the modal appeared if testing exit-intent flows.
- **`detect_boxes` covers viewport only**: elements below the fold are not in boxes[]. Scroll first, then call `detect_boxes` again (or read boxes[] from the scroll response) to discover newly-visible content.
- **`detect_boxes` item fields**: each item carries `id`, `kind`, `tag`, `text`, `rect`, `selector` plus state fields when present — `inputType` (for `<input>`), `checked` (checkbox/radio), `disabled`, `value` (pre-filled text/select), `href` (links). Use these to decide HOW to interact without an extra `query` call: `inputType:"file"` → `set_file_input`; `inputType:"checkbox"` + `checked:false` → `click` to toggle; `disabled:true` → skip.
- **`detect_boxes` misses shadow DOM controls**: controls inside shadow roots don't pierce into `querySelectorAll` — if an element is missing from boxes[], fall back to `query` for its rect and use `click` with those coordinates.
- **checkboxes and radios always appear in boxes[]**: `input[type=checkbox]` and `input[type=radio]` are always included regardless of size; their `text` field shows the associated `<label>` text when one exists, otherwise it's empty and positional targeting is required.
- **cursor:pointer non-semantic elements**: Custom click targets (`<p>`, `<div>`, `<span>` styled as close buttons, badges, etc.) are now detected as controls when they have `cursor:pointer` computed style and non-empty text. If a clickable element is still missing from boxes[], fall back to `query` to get its rect.
- **right-click / context menus**: Use `click '{"x":N,"y":N,"button":"right"}'` to dispatch a right-click (fires the `contextmenu` event). Any resulting JS dialog should be handled with `get_dialog`/`dismiss_dialog` as normal — run `click` in the background with `&` if the context menu triggers an alert.
- **`detect_boxes` misses canvas / iframe content**: canvas-rendered UI and cross-origin iframes have no DOM nodes — use `screenshot` to see and target those elements. For **same-origin iframes** (embedded demos, sandboxed apps, payment widgets on the same domain), use `list_frames` to get the iframe's `frameId`, then pass it to `detect_boxes` or `query`: `tiny-browser list_frames '{"tabId":N}'` → pick the child frame → `tiny-browser detect_boxes '{"tabId":N,"frameId":"..."}'`.
- **`detect_boxes` with `draw:true`**: always pair with a follow-up `screenshot` call — the overlays are painted synchronously but only visible in the screenshot. Overlays are removed on the next `detect_boxes` call.
- **`read_page` text_limit**: pass `{"text_limit":20000}` for long articles — the default 4000-char cap truncates most real documentation pages
