# Workflow Report — Issue #22

## WF1: HN Ask Multi-Page Pagination

Collected 21 posts from HackerNews /ask (12 in first half, 9 in second half).

**Top 3 by score across all posts:**
| Score | Title |
|------:|-------|
| 582 | Tell HN: An app is silently installing itself on my iPhone every day |
| 105 | Tell HN: Claude 4.7 is ignoring stop hooks |
| 51 | Ask HN: How do solo devs protect their work in the age of vibe coding? |

---

## WF2: TodoMVC Full Lifecycle

1. Opened https://todomvc.com/examples/react/dist/
2. Added 5 items: Buy groceries, Write unit tests, Fix scrolling bug, Deploy to staging, Review PRs
3. Completed first 3 using toggle clicks — used `query` for exact `getBoundingClientRect` coords (x=651)
4. Filtered Active → 2 visible, Completed → 3 strikethrough
5. Clicked 'Clear completed' → 3 removed
6. **Final state: 2 items left (Deploy to staging, Review PRs)** ✓

---

## WF3: Wikipedia 5-Hop Link Chain

Starting at Web browser, following first paragraph content link each hop:

| Hop | Article |
|----:|---------|
| 0 | Web browser - Wikipedia |
| 1 | Application software - Wikipedia |
| 2 | Software - Wikipedia |
| 3 | Computer program - Wikipedia |
| 4 | Sequence - Wikipedia |
| 5 | Mathematical object - Wikipedia |

Back-2 verification: navigated to **Computer program - Wikipedia** — URL match: True ✓

---

## WF4: Bing Multi-Tab Research Pipeline

Topic: *best local-first applications 2026*
(Bing CAPTCHA — fell back to DuckDuckGo, same query)

Opened 4 result tabs and extracted first paragraphs:

**https://verity.salient.community › research › local-fir**
> Local-first software keeps the primary copy of user data on their own devices, enabling offline use, instant interactions, and long-term data ownership. This report surveys the state of the local-first ecosystem in early 2026, covering the maturation

**https://cssauthor.com › best-local-first-databases-for-**
> If you are still debating “Optimistic UI” versus “Loading Spinners” in 2026, you are fighting the last war. The paradigm has shifted. We aren’t just building offline-capable apps anymore; we are building Local-First apps where the client is the sourc

**https://www.sitepoint.com › best-local-llm-models-2026**
> Benchmarks conducted in early 2026. The local LLM field evolves rapidly; scores and recommendations are subject to change.

**https://offgrid.reviews › best-local-first-smart-hubs-a**
> Home - Communication and Tech - Off Grid Smart Systems and Rugged Tech - Best Local First Smart Hubs & Automation for 2026: Ultimate Buyer’s Guide
