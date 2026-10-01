# Performance budgets

These numbers are **measured from this implementation**, not taken from advice
about what a page "should" weigh. Thresholds invented in advance are either
trivially met or arbitrarily strict, and neither tells you anything.

- Measure: `npm run check:perf`
- Re-record after a deliberate change: `npm run check:perf:write`
- Ceilings: [`performance-budgets.json`](performance-budgets.json)

`check:perf` exits non-zero when a measurement is over its ceiling, or when an
image above the fold is lazy, or when an image has no dimensions. Those last two
are not budget numbers — they are the two ways a media-first catalogue makes
itself slow by accident.

## What is measured

| Metric | Why this one |
| ------ | ------------ |
| transfer weight | A media-first catalogue that ships every plate up front is the failure this product is most able to produce |
| request count | With dev-only module requests excluded, so the number means something in both dev and production |
| DOM nodes | A wall is a long list; the cost of the list is the list |
| CLS | Plates reserve geometry by aspect ratio, so this should be zero. Anything else is a real jump |
| load to `networkidle` | Wall-clock on a warm local server, so it is a regression signal rather than a network claim |
| search shortcut latency | The `/` shortcut is the first thing a reader tries |
| filter toggle latency | The filter rail is the first thing a reader clicks |
| lazy images above the fold | A lazy image above the fold is the slowest thing on the page |
| images without `width`/`height` | These cannot reserve space, so they shift |

## Measured, 24 possibilities

Mobile 390×844, cold, no cache:

| Route | Transfer | Images | Requests | DOM | CLS | Load |
| ----- | -------- | ------ | -------- | --- | --- | ---- |
| `/` wall | 229kB | 37kB | 47 | 826 | 0.0000 | 625ms |
| `/possibilities/<slug>` | 194kB | 4kB | 38 | 404 | 0.0000 | 1185ms |
| `/search?q=seam` | 205kB | 15kB | 40 | 251 | 0.0000 | 755ms |
| `/board` | 190kB | 0kB | 37 | 179 | 0.0000 | 664ms |
| `/verticals` | 301kB | 111kB | 61 | 783 | 0.0000 | 676ms |

Desktop 1280×800: the wall is 304kB and the search 205kB; DOM and CLS are
identical, which is the point — the extra bytes on desktop are plates the reader
can actually see.

Interaction: `/` focuses search in **1ms**. The filter rail re-filters in
**0–28ms**, and it is 25–28ms only on the wall and `/verticals`, where it hides
or unhides two dozen tiles.

## What the numbers say

**The two fonts are 79kB and they are the entire page.** `bricolage.woff2` is
40kB and `jetbrains-mono.woff2` is 39kB. On `/board`, which has no media at
all, the transfer is 190kB and the fonts are the largest thing in it. This is
the first thing to optimise if bytes matter, and the answer is subsetting both
fonts to the weights and glyphs actually used rather than dropping the preload —
the preload is correct, since both faces paint above the fold.

**24 plates cost 37kB on mobile and 111kB on desktop.** That is the lazy-loading
strategy working: on a phone only what fits is fetched, and the widest plate
still arrives at 800px. Since the plates are SVG and vector, the 800px is a
rendering size rather than a source-size claim.

**CLS is 0.0000 everywhere.** The `aspect-ratio: 4/5` on the plate container
reserves the space, and every `<img>` carries `width`/`height`. Worth stating
because it is the easiest thing to lose: an image handler that omits the
dimensions silently reintroduces it.

**The wall is 826 DOM nodes for 24 entries** — about 34 per tile. That is a lot
per tile and it is the number to watch as the catalogue grows. `check:visual`
already fails if a `.shell` element loses its gutter or an image loses its
dimensions; DOM size has no ceiling yet, and at a thousand entries it will need
one.

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
request counts are recorded here because they are the honest ones.

## Scale

Not yet measured, and it is the real remaining question. 24 entries is not a
catalogue. What #49 asks for is hundreds to thousands without eagerly
instantiating every expensive media type, and this implementation has no
virtualisation because it does not need one *yet*. The honest position: the
wall is O(entries) in DOM nodes and O(viewport) in requests, so the first thing
that breaks at scale is DOM size and the second is server render time from
`loadExamplesFor`'s per-possibility reference resolution.

`/lab` is the closest thing here to a worst case — 32 fixtures, every state
rendered at once — and it is in the visual QA matrix. A synthetic 500-entry wall
fixture is the next measurement, and it is the one that would justify
virtualisation rather than the one that assumes it.

## Not optimised, deliberately

- **No responsive image variants.** The plates are SVG; a 4:5 diagram scales by
  being vector, so a `srcset` of rasters would be worse. When raster media
  (uploaded photos, video posters) enters the catalogue, this decision needs
  revisiting and the numbers will change.
- **No client framework on the public catalogue.** The wall filters with a form
  POST and a full server render. Hydrating 24 tiles to hide eight of them would
  cost more than the request it saves, at this size.
- **Fonts are preloaded, not subset.** See above — the preload is correct and the
  subsetting is not done.