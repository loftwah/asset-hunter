# Testing

`npm test` — **687 tests, serial.** `npm run typecheck` must be 0 errors first.

## Why serial

These tests share a live server and a live D1. `node --test`'s default is one
worker per file, in parallel, and that produced a suite that reported failures
that did not exist:

```
$ node --test tests/*.test.ts            # parallel
# tests 687   # pass 667   # fail 20
$ node --test --test-concurrency=1 tests/*.test.ts
# tests 687   # pass 687   # fail 0
```

The twenty were not flaky assertions. They were:

- **`tests/visibility.test.ts` mutating content other files are reading.** It
  hides a real entry and asserts it disappears — which is the point — while
  `tests/routes.test.ts` asserts a drill-in for the same entry is still `200`.
  One of them has to lose.
- **Three Playwright instances against one dev server.** The browser assertions
  fail on timeouts, not on product behaviour, and the failure text reads like a
  layout defect.

Serial execution costs wall-clock and buys a suite whose failures mean something.
That is the whole trade: this project's rule is that a gate which skips because
the thing it checks is broken is worse than no gate, and a gate that fails for
the wrong reason is the same failure wearing a different hat.

The fix is **not** to weaken an assertion. It is to stop asking two questions of
one server at the same time.

## The suite's own health check

`tests/routes.test.ts` classifies its server before it runs anything:

| state | meaning |
| --- | --- |
| `up` | the suite runs |
| `broken` | reachable but answering `500` — a stale Vite optimiser cache does exactly this |
| `down` | nothing listening |

`broken` runs the suite rather than skipping it. The earlier version skipped, and
54 route tests skipped while the suite reported green — the precise failure mode
the comment above is about.

If you see every route fail at once, check this before anything else:

```bash
npx astro dev stop && rm -rf node_modules/.vite && npx astro dev --port 4321
```

## What each file is for

| file | covers |
| --- | --- |
| `tests/effect.test.ts` | Effect 4 services, schemas, typed failures, service substitution |
| `tests/routes.test.ts` | every public route and API against a live server |
| `tests/catalogue.test.ts` | loaders, `isPubliclyVisible`, null-vs-zero discipline |
| `tests/curate.test.ts` | the curation cockpit's gates and queues |
| `tests/board.test.ts` | the shortlist board's pure rules |
| `tests/asset-use.test.ts` | the four-condition handoff gate |
| `tests/build-info.test.ts` | build provenance and what it may claim |
| `tests/deploy-freshness.test.ts` | all four verdicts on whether production is current |
| `tests/refresh-crawl.test.ts` | the crawl as an Effect, resumption, supersession |
| `tests/security.test.ts` | one test per fixed finding, each failing without the fix |
| `tests/responsive-a11y.test.ts` | the real experience in Chromium at 11 viewports |
| `tests/visual-lab.test.ts` | the deterministic visual lab |
| `tests/seed.test.ts` | the seed's invariants |
| `tests/brand.test.ts` | one source of truth for the mark |
| `tests/handoff.test.ts` | the agent handoff document, pure |
| `tests/takedown.test.ts` | report → quarantine → exclusion → release |
| `tests/visibility.test.ts` | withdrawn entries vanish everywhere, and come back |

## Browser tests

`tests/responsive-a11y.test.ts` drives Chromium. It is the only file that
measures the rendered experience, and it is deliberately not a unit test: a tap
target is not a property of the DOM, it is a property of a box on a screen.

It uses `AH_URL` when set, so it can be pointed at a running deployment:

```bash
AH_URL=http://localhost:4321 node --test tests/responsive-a11y.test.ts
```

## What is deliberately not here

- **No snapshot tests.** A snapshot records what the page looked like, and then
  gets updated to match whatever the page looked like, and stops being evidence.
  The assertions here name the property: 44px, `aria-current`, `null` not `0`.
- **No unit tests for effectful code paths that cannot fail.** A function that
  reads a string and returns a string does not need a mock. The value of a test
  is proportional to how badly the thing can be wrong.
- **No test that passes when the server is broken.** Covered above.
