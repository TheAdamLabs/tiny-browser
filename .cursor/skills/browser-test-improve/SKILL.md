---
name: browser-test-improve
description: >-
  Run the full test-and-improve iteration loop for tiny-browser-mcp against a
  target website. Use when asked to "test and improve", "test on <site>", "run
  the improvement loop", or "find and fix issues". Each iteration is fully
  autonomous across all seven phases: sweep → functional tests → classify →
  fix → retest → document and commit → cleanup.
---

# Browser Test-and-Improve Loop

Each iteration is fully autonomous — do not stop between phases to ask for direction.

## Phase 1 — Sweep

Open all relevant pages as background tabs in one Python batch. Run `detect_boxes` with `draw:true` on every tab in the same batch — this paints the bounding-box overlays directly on each page so you can switch to any tab and see exactly what was detected. Print a summary table:

```
page_name   (N items)
  C0  control  button[inputType:submit]  cx=88  cy=113  'Add Element'
```

Flag: `items==0` on an interactive page • `error` field present • obviously missing controls (confirm with `query`).

## Phase 2 — Functional Tests

Run targeted tests **in parallel** for all flagged pages and for these challenging scenarios proactively:

| Pattern | Method |
|---|---|
| Click / checkbox / radio | `click` → `query el.checked` or DOM state |
| Type into input | `click` + `type` → `query el.value` |
| Dynamic / AJAX content | trigger → `wait 3s` → `detect_boxes` again |
| Right-click / context menu | `click '{"button":"right",...}'` in bg with `&` → `get_dialog` / `dismiss_dialog` |
| Drag & drop | `drag` (`html5:true` for HTML5 DnD) |
| File input | `set_file_input` |
| Modal / overlay close | look for cursor:pointer items in boxes[] or `query` for rect |
| New tab from link | `click` → `list_tabs` → `switch_tab` → `detect_boxes` |
| Multi-step form | fill all fields → submit → verify success message in boxes[] |
| Lazy-loaded content | scroll → re-detect → interact with new items |
| Rapid repeated actions | add N items → delete M → verify count |

## Phase 3 — Classify Issues

| Category | Description | Action |
|---|---|---|
| **Broken** | Error returned / wrong result | Must fix |
| **Suboptimal** | Works but needs workaround | Should fix |
| **Limitation** | Fundamental CDP/browser constraint | Document in SKILL.md |

Also propose autonomously in each iteration:
- **New features** — commands or params that would shorten common workflows
- **Simplifications** — anything more complex than it needs to be
- **Detection improvements** — element patterns that consistently escape `detect_boxes`

Common root causes:
- Missing elements → `extension/page-extractor.js` (selector, area threshold, new pass)
- CDP serialisation crash → `el` reference leaked into return value
- Missing param → `extension/background.js` + `bin/tiny-browser.mjs`

## Phase 4 — Fix

1. `extension/page-extractor.js` — detection improvements
2. `extension/background.js` — new or extended commands
3. `bin/tiny-browser.mjs` — COMMANDS catalogue
4. `bin/server.mjs` — AUTO_SCREENSHOT / AUTO_DETECT / SETTLE_MS if needed
5. `SKILL.md` — new gotchas, updated workflows, remove stale patterns
6. `README.md` — updated commands, performance table, usage examples
7. `npm run lint` — fix all errors
8. `npm install -g .` — update global binary
9. `pkill -f "node.*server.mjs"; tiny-browser &` — restart server
10. Ask user to **reload Chrome extension** at `chrome://extensions` when `background.js` or `page-extractor.js` changed

## Phase 5 — Retest

Open **fresh tabs** (stale after server restart). Re-run `detect_boxes` with `draw:true` on all previously-broken pages. Run functional tests for each fix. Confirm no regressions.

## Phase 6 — Document & Commit

Pre-commit checklist:
- `SKILL.md` covers every new command, param, and gotcha from this iteration
- `README.md` usage examples and performance table are current
- `bin/tiny-browser.mjs` COMMANDS match what `background.js` accepts

```bash
cd /Users/adam.pavlat/projects/personal/tiny-browser-mcp
git add -A
git commit -m "fix/feat: <summary>"
git push
```

## Phase 7 — Cleanup

Close all tabs opened during the iteration in one Python batch. Keep only tabs that were open before the iteration started (i.e. don't close the user's pre-existing tabs).

```python
import subprocess, json

# Collect tab IDs opened during the sweep (stored in /tmp/*_tabs.json)
# and any additional tabs opened during functional tests.
r = subprocess.run(["tiny-browser","list_tabs",'{}'], capture_output=True, text=True)
all_tabs = json.loads(r.stdout)

# Close tabs by the URLs opened during this iteration — never close
# chrome://, about:, or tabs not matching the test target domain(s).
test_urls = [
    "the-internet.herokuapp.com",
    "jqueryui",
    # add other domains used in this iteration
]
to_close = [t for t in all_tabs
            if any(u in t.get("url","") for u in test_urls)]
for t in to_close:
    subprocess.run(["tiny-browser","close_tab",json.dumps({"tabId":t["tabId"]})],
                   capture_output=True, text=True)
    print(f"closed {t['tabId']} {t['url'][:60]}")
print(f"Closed {len(to_close)} test tabs.")
```

Rule: **never close tabs whose URL contains `chrome://`, `about:`, or the user's personal apps** (Gmail, GitHub, Linear, etc.) — only close tabs that match the target test domain(s) opened during this iteration.

## Key files

| File | Role |
|---|---|
| `extension/page-extractor.js` | DOM detection logic |
| `extension/background.js` | CDP command handlers |
| `bin/tiny-browser.mjs` | CLI + COMMANDS catalogue |
| `bin/server.mjs` | HTTP/WS server, AUTO_* sets |
| `SKILL.md` | Agent workflow docs — keep exhaustively up to date |
| `README.md` | Human docs — update each iteration |

## Parallelism rules

- Open all tabs in one Python script
- Run `detect_boxes` with `draw:true` on all tabs in one Python batch — `{"tabId": id, "draw": true}`
- Chain independent functional tests with `&&` in the same shell call
- Never loop tab IDs in bash — use Python for dynamic data
