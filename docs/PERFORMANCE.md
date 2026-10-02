# Performance budgets

These numbers are **measured from this implementation**, not taken from advice
about what a page "should" weigh. Thresholds invented in advance are either
trivially met or arbitrarily strict, and neither tells you anything.

- Measure: `npm run check:perf`
- Re-record after a deliberate change: `npm run check:perf:write`
- Quieter host, median of three runs: `npm run check:perf:repeat`
- Ceilings and the reasoning behind each: [`performance-budgets.json`](performance-budgets.json)

## What is measured

| Metric | Why this one |
| ------ | ------------ |
| transfer weight | A media-first catalogue that ships every plate up front is the failure this product is most able to produce |
| request count | With dev-only module requests excluded, so the number means something in both dev and production |
| DOM nodes | A wall is a long list; the cost of the list is the list |
| eager plates | The `loading` attribute the wall *chose* per plate — the decision that stops a 500-tile wall fetching 500 plates |
| fetched plates | How many plates actually decoded. `document.images.length` says what the markup declared; only `naturalWidth` says what arrived |
| CLS | Plates reserve geometry by aspect ratio, so this should be zero. Anything else is a real jump |
| document size | What the page costs *before* a reader looks at any of it, raw and compressed |
| server render | EmDash's own `Server-Timing`: render time, D1 time, query count |
| TTFB | Wall-clock to first byte on a warm local server, so it is a regression signal rather than a network claim |
| load to `networkidle` | Wall-clock on a warm local server, so it is a regression signal rather than a network claim |
| search shortcut latency | The `/` shortcut is the first thing a reader tries |
| filter latency, both ways | Showing every tile and hiding all but the narrowest vertical are different jobs, and only the second one grows with the catalogue |
| drill-in latency | A real click on a plate and a real navigation, from a wall that is already warm |
| long-wall cost | Main-thread time, layouts, style recalculations, long tasks and DOM nodes while scrolling a wall to its end |

## What is a gate, and what is only reported

This is the part that makes the command safe to put in a gate.

A measurement only fails the run when its `gate` flag in the budget file is
true. Timings — `cls`, `loadMs`, `ttfbMs`, `drillInMs` — are false, because a
laptop under a debugger is not a laptop in a VM and a budget that fails on the
first is a budget that gets deleted. They are still measured, still printed with
their ceiling, and still recorded, so a regression is a diff in
`performance-budgets.json` rather than something nobody noticed.

Gated: `bytes`, `requests`, `domNodes`, `eagerImages`. These are properties of
the page. They are the same on any machine, which is exactly what a gate needs.

`loadedImages` is neither: it is recorded as an **observation** and compared to
nothing. It is a race between the viewport strategy and the network — the same
500-tile wall measured 7 and 104 plates fetched across runs — so a ceiling for it
would be a coin flip, and a permanently red line is worse than no line.
`eagerImages` is the gate; `loadedImages` is the outcome it is supposed to
produce.

Alongside the budgets, six assertions are structural and always fail the run,
because none of them depends on the host:

- a measured route answering anything but 200;
- a failed request (4xx/5xx), including one that never produced a response;
- a lazy image above the fold;
- an image without `width`/`height`;
- a `video`, `audio`, `canvas`, `iframe`, `object` or `embed` instantiated by the
  page — the catalogue wall renders plates, not players;
- a scale wall that did not render the number of tiles it was asked for, which
  would otherwise let an empty database produce a passing measurement of nothing.

## Measured, 24 possibilities

Mobile 390×844, cold cache, `astro dev` on a MacBook Pro:

| Route | Transfer | Images | Requests | DOM | CLS | HTML | TTFB | Load |
| ----- | -------- | ------ | -------- | --- | --- | ---- | ---- | ---- |
| `/` wall | 505kB | 111kB | 67 | 862 | 0.0000 | 169kB | 32ms | 583ms |
| `/possibilities/<slug>` | 372kB | 19kB | 48 | 410 | 0.0000 | 136kB | 212ms | 755ms |
| `/search?q=seam` | 350kB | 15kB | 45 | 259 | 0.0000 | 122kB | 94ms | 639ms |
| `/board` | 330kB | 0kB | 42 | 190 | 0.0000 | 117kB | 60ms | 592ms |
| `/verticals` | 485kB | 111kB | 66 | 818 | 0.0000 | 161kB | 38ms | 602ms |

Desktop 1280×800: the wall is 505kB and the search 350kB; DOM and CLS are
identical, which is the point — the extra bytes on desktop are plates the reader
can actually see, because 24 of them fit in the viewport and 7 do not.

Interaction, mobile: `/` focuses search in **1ms**. The filter rail puts all 24
tiles back in **25ms** and hides all but the narrowest vertical in **34ms**.
Drill-in from the wall: **738–836ms**, of which the server render is 19–24ms.

## Measured, 500 entries

`/?scale=500` is the wall above with a synthetic catalogue of five hundred
entries derived from the real twenty-four — the same component, the same grid,
the same filter script, the same lazy strategy. It is refused outside
`astro dev`, because the entries do not exist and five hundred of them would be
both a lie and a performance liability.

| Metric | mobile-390 | desktop-1280 |
| ------ | ---------- | ------------ |
| tiles | 500 | 500 |
| DOM nodes | 12,763 | 12,763 |
| **plates fetched at load** | **87** | **104** |
| plates marked eager | 4 | 4 |
| expensive media elements | 0 | 0 |
| transfer, whole wall read | 1,470kB | 1,470kB |
| HTML document, raw | 1,135kB | 1,135kB |
| HTML document, gzip / brotli | 63kB / **21kB** | 63kB / 21kB |
| CLS | 0.0000 | 0.0000 |
| server render | 24ms | 24ms |
| D1 queries | 11 | 11 |
| filter: all 500 back | 22ms | 33ms |
| filter: hide to narrowest | 33ms | 33ms |
| scroll to the end, main thread | 114ms | 76ms |
| layouts / style recalcs while scrolling | ×11 / ×0 | ×0 / ×0 |
| long tasks | none | none |
| plates fetched after scrolling the whole wall | 306 of 500 | 500 of 500 |

A note on the fetched count, because it is the one number here that moves. It
ranged from 7 to 104 on mobile across runs of the same unchanged wall, depending
on how far Chromium decided to prefetch below the fold before the sampler read
`naturalWidth`. That instability is why `loadedImages` is recorded as an
observation and compared to nothing: a ceiling for it would be a coin flip, and
a permanently red line is worse than no line. `eagerImages` — 4 of 500 — is the
gate, because it is the decision the wall made rather than the outcome.

## Measured, 5,000 entries

`npm run check:visual` audits `/?scale=5000` at all eleven viewports, because a
matrix of one 24-entry wall cannot find the failures that only appear when there
are enough tiles for the grid to wrap oddly.

| Metric | mobile-390 | desktop-1280 |
| ------ | ---------- | ------------ |
| DOM nodes | 125,263 | 125,263 |
| CLS | 0.0000 | 0.0000 |
| long tasks while scrolling | none | none |
| layouts while scrolling | ×10 | ×0 |
| layout issues across 11 viewports | 0 | 0 |
| contrast / tap-target / overflow issues | 0 | 0 |
| server render | ~700ms (4.2MB document) | ~700ms |

## What the numbers say

**The 500-tile wall fetches 87–104 plates at load out of 500, and marks exactly
four eager.** That is the acceptance criterion for #49, met. `loading="lazy"`
on everything past the first four, plus `aspect-ratio` reservation, means the
cost of the wall is proportional to the viewport rather than to the catalogue.
The fetched count ranged from 7 to 104 across runs of the unchanged wall, which
is the honest measurement of a lazy strategy rather than a flattering one; the
decision it is making does not move at all, and 4 of 500 is the number that is
gated.

**No expensive media is instantiated at any size.** Zero `<video>`, `<audio>`,
`<canvas>`, `<iframe>`, `<object>` or `<embed>` on any route, at any scale. A
plate is an `<img>` with a poster, and the poster frame is the whole of what
#49's "poster frames for video/animation" strategy is supposed to mean. This is
the assertion most likely to fail first when raster or interactive media enters
the catalogue, which is the point of asserting it.

**1.1MB of HTML for 500 tiles is 21kB over the wire.** The document is 500 copies
of the same 24 tiles, so brotli removes almost all of it. This is the number
that decides the virtualisation question, and it is the opposite of the one the
raw size suggests: at 500 entries the transfer is dominated by fonts and CSS
(79kB + 30kB of the 1,470kB total), not by the wall. Measured with
`zlib.brotliCompressSync` at quality 11 in `measure-perf.mjs`, because that is a
claim about what a compressor can do to the bytes rather than a claim about what
one CDN configuration happened to serve.

**The wall is 24 DOM nodes per tile.** 12,763 nodes for 500 tiles, so the O(entries)
is real and it is linear: the save form alone is 4 `<input>` elements per tile
and the provenance markers are 7 nodes. **This is the first number to break at
scale**, and unlike transfer it does not compress. `domNodes` is a gate precisely
because it is the one that will fail first, and it will fail on a design change
(a save control per tile, say) rather than on a network change.

**Server render is not the wall's problem. The drill-in's is.** From EmDash's
`Server-Timing`: the wall takes 11 queries and 7–13ms of D1; the drill-in takes
**88 queries and 124–140ms of D1**. That is `loadExamplesFor`'s N+1 — one
`emdash.entry()` per example to resolve a `reference` field — and it is the
reason the drill-in is ~800ms to interactive while the wall is under 30ms of
server time. It is a documented, deliberate choice (`REFERENCE_CONCURRENCY`),
not a regression, and it is the correct place to look next.

**CLS is 0.0000 at 24, 500 and 5,000 entries.** The `aspect-ratio: 4/5`
reservation holds at any wall length, which is the property that makes
non-virtualised rendering viable here: the reason a long list usually shifts is
that its rows arrive without known height, and these are server-rendered with
dimensions on every `<img>`.

**The filter does not degrade from 24 tiles to 500.** 25ms → 22–33ms to put
every tile back, 33–34ms at both sizes to hide to the narrowest vertical. The loop is
`tile.hidden = !matches` over a `NodeList` captured once, which is O(entries)
attribute writes and no reflow work until the frame lands. At 5,000 tiles the
same loop was measured at 33ms. If virtualisation ever becomes necessary, this
loop is why it will not be: the tiles are already in the DOM.

**Long tasks: none.** Scrolling a 5,000-tile wall — 125,263 DOM nodes, a
document 1.1 million pixels tall on mobile — produces no task over 50ms and
`RecalcStyleCount` of ×0. Scrolling does not dirty style; the work is already
done.

**The two fonts are 79kB and they are the entire page.** `bricolage.woff2` is
40kB and `jetbrains-mono.woff2` is 39kB. On `/board`, which has no media at all,
the transfer is 330kB and the fonts are the largest thing in it. This is the
first thing to optimise if bytes matter, and the answer is subsetting both fonts
to the weights and glyphs actually used rather than dropping the preload — the
preload is correct, since both faces paint above the fold.

## Memory: what was measured, and what was not

This is the honest limit of the tooling, and it is stated rather than papered
over with a small number.

**Measured:** `JSHeapUsedSize` from Chromium's `Performance.getMetrics`, and
`Memory.getDOMCounters`' node count. The scale wall holds 1.4MB of JS heap and
21,069 DOM nodes; the 24-tile wall holds 1.2MB and 5,291. **The JavaScript heap
barely moves** — the wall's JS is the filter script, not the tiles.

**Not measured: resident memory.** DOM node memory is allocated by the renderer,
not the JS heap, and no CDP domain exposes it as a byte count. `performance.memory`
is Chromium-only and reports the same JS heap. So the number that would answer
"how much RAM does a 5,000-tile wall cost" is not obtainable from this harness.

**What is obtainable instead, and what it says.** Chromium documents roughly
50–100 bytes per DOM node in the renderer process. At 21,009 nodes for the
500-tile wall that is **1.1–2.1MB**, and at 125,263 nodes for 5,000 it is
**6–13MB**. That is an estimate from a documented rule, not a measurement, and it
is labelled as such here. It is also the reason DOM node count, rather than
bytes, is the gated metric: nodes are the unit in which this wall gets expensive,
and they are the unit that can be counted exactly.

**Not measured: sustained CPU under real interaction.** The long-wall figures are
from a scripted 20-frame scroll with no compositing contention, no other tabs, and
no network variance. Long tasks of 0 confirms the main thread was never blocked
for 50ms; it does not confirm what a phone does with the same wall while a video
is decoding elsewhere on it.

## Dev versus production

`astro dev` serves every module separately, so a route looks like it makes
sixty requests when production makes six. `check:perf` excludes Vite's dev
module URLs and reports the two counts separately for exactly that reason.

Measured against a production build served by `wrangler dev`
(`npm run preview`, which points at the *built* worker — the previous
`wrangler.local.jsonc` cannot bundle Astro's virtual modules):

| Route | Requests |
| ----- | -------- |
| `/` | 6 |
| `/search?q=seam` | 6 |
| `/board` | 6 |
| `/verticals` | 5 |

Six requests for a server-rendered page with no client framework: the document,
one hashed CSS bundle per route chunk, and the two fonts. Budgets are recorded
against the dev server because that is where the content is; the production
request counts are recorded here because they are the honest ones. The scale
route is skipped against a non-local origin, since `?scale=` is refused there.

## Not optimised, deliberately

- **No responsive image variants.** The plates are SVG; a 4:5 diagram scales by
  being vector, so a `srcset` of rasters would be worse. When raster media
  (uploaded photos, video posters) enters the catalogue, this decision needs
  revisiting and the numbers will change.
- **No client framework on the public catalogue.** The wall filters with a form
  POST and a full server render. Hydrating 500 tiles to hide eight of them would
  cost more than the request it saves.
- **No virtualisation.** Measured, not assumed. At 5,000 entries the wall has no
  long tasks, no style recalculation while scrolling, 33ms filter latency and
  zero CLS. The measurements that would justify windowing are DOM node count
  (125,263 at 5,000, and linear) and the 4.2MB document. Neither is a failure yet,
  and `domNodes` is gated so the moment one becomes one, this file changes.
- **Fonts are preloaded, not subset.** See above — the preload is correct and the
  subsetting is not done.

## Still not measured

- **Raster and interactive media.** Every plate here is SVG. The moment uploaded
  photos, video posters or 3D viewers enter the catalogue, `eagerImages`,
  `loadedImages` and the whole "no expensive media element" assertion have to be
  re-derived, because the reasons they hold today — one small vector per tile,
  nothing that decodes — stop being true.
- **A slow network.** Everything above is a warm localhost. No throttling, no
  3G, no cold DNS. TTFB and load are regression signals, not claims about a
  reader's connection, and the compressed-document figures are what says
  something about transfer rather than about timing.
- **A real device.** Chromium at a desktop viewport with `deviceScaleFactor`
  set, not a phone. Mobile here means a 390×844 viewport with touch emulation,
  which catches layout and tap-target failures and does not catch thermal
  throttling or a slower rasteriser.
- **Reader memory across a session.** One wall, one load, one context. What a
  reader who browses eight verticals and comes back costs is not measured.