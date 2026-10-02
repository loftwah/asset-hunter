# Asset Hunter brand

`DESIGN.md` is the visual authority. This file is the brand document: what the
mark is, where it lives in source, how the assets are produced, and — the part
that matters — what was actually decided and what was not.

## The mark

An aperture ring with a single lozenge at its centre, and four sighting ticks.
It reads as a *hunting sight* — something you are locating — rather than a
bullseye, which would be the thing you have already hit. The lozenge is the
thing being located.

## One source of truth

The geometry lives in exactly one place:

| File                              | What it owns                                     |
| --------------------------------- | ------------------------------------------------ |
| `src/lib/brand/mark.ts`           | The geometry, the inks, the clear-space and minimum-size numbers, and the SVG serialiser |
| `src/lib/brand/assets.ts`         | Which files exist and what each one is for        |
| `src/components/Wordmark.astro`   | Renders the mark inline in `currentColor`; draws no geometry of its own |
| `scripts/build-brand.mjs`         | Writes the bytes; `npm run brand:build`          |
| `scripts/build-brand.mjs --check` | Verifies them; `npm run brand:check`             |

This was not always true, and it is worth recording why it is now. The mark was
drawn twice — inline in `Wordmark.astro` and again by hand in
`public/favicon.svg` — with nothing comparing the two. They had already drifted:
the committed `apple-touch-icon.png` had lost the inner ring entirely, and nobody
noticed until the raster was opened. A shared module that nothing compares is
two files with extra steps, so the comparison is the deliverable:

- `tests/brand.test.ts` fails if `Wordmark.astro` grows a hand-drawn `<circle>`,
  `<path>` or inline coordinate; if the favicon's shape list differs from what
  the masthead renders; if any committed SVG is not byte-identical to what the
  module generates; if a brand SVG can execute or reach outside itself; or if
  `DESIGN.md` stops stating the numbers the geometry uses.
- `npm run brand:check` additionally compares each PNG against a fresh local
  render of the same vector and fails on a real difference, which is how the
  missing ring would have been caught.
- Both run in `npm run verify`.

### Changing the mark

Edit `src/lib/brand/mark.ts`, then `npm run brand:build`. Never hand-edit a file
in `brand/`, `public/favicon.svg` or the PNG icon set — `brand:check` will fail
and it will be right to.

## Variants

Two forms, not two sizes. `full` is the mark. `compact` is the icon, and it is
not a shrunken `full`.

The reason is measurement. In `full`, the sighting ticks occupy radius 5.85–9.25
and the outer ring's stroke band is radius 8.5–10.0 — they overlap, so at small
sizes they fuse. The 42%-opacity outer ring also dithers to a muddy brick over
`--canvas`. At 16px the original `full` favicon was an orange donut with a cross
in it, not an aperture.

`compact` therefore drops the ticks and the inner ring, drops the opacity, thickens
the outer ring to 2.5 units (1.67px at the 16px floor) and enlarges the lozenge so
it survives.

| File                                | Form     | Ink         | For                                       |
| ----------------------------------- | -------- | ----------- | ----------------------------------------- |
| `brand/mark.svg`                    | full     | ember       | Default export; dark surfaces            |
| `brand/mark-ink.svg`                | full     | `--ink`     | One-ink reversed for dark. Masthead, footer |
| `brand/mark-canvas.svg`             | full     | `--canvas`  | One-ink positive for light and print      |
| `brand/mark-compact.svg`            | compact  | ember       | Anything under 32px on a dark surface     |
| `brand/mark-compact-ink.svg`        | compact  | `--ink`     | Small sizes where the accent would shout   |
| `brand/mark-compact-canvas.svg`     | compact  | `--canvas`  | Small sizes on light backgrounds          |
| `brand/mark-maskable.svg`           | compact  | ember/canvas| Android maskable, mark inside safe zone   |
| `brand/clear-space.svg`             | —        | —           | The clear-space diagram; documentation    |

Icons the app actually serves: `public/favicon.svg`, `public/apple-touch-icon.png`
(180), `public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-512.png`.
The last three did not exist — the manifest declared no raster icons at all, so
Chrome had nothing to offer an install prompt.

### Reversed and one-ink

The mark has no gradient, so reversal is a one-ink operation and not a second
asset to design. `--canvas` ink is the light-background variant;
`--ink` is the dark-background variant. The catalogue is dark-only
(`DESIGN.md` §9.3), so the light-ground files exist for print, slides and
anyone placing the mark on paper — not because the product has a light mode.

### Why the masthead mark is ink and the favicon is ember

This is deliberate and it is the one place the brand uses the accent for
identity. `--ember` is reserved for action, selection and the single
highest-priority element on a viewport (`DESIGN.md` §1.2); a logo coloured with
it would spend the accent on branding and leave nothing for the primary button.
The favicon inverts that: a 16px tab icon has no context, no hover and no
neighbours, and in greyscale the accent is the only thing that keeps it from
being a grey ring.

## Clear space, minimum size, responsive variants

**Clear space: 3 units of the mark's 24-unit box** on every side of the mark and
of the wordmark lockup. Twice the `full` form's 1.5-unit stroke, so nothing can
crowd the mark without touching it. At the masthead's 20px mark the band is
2.5px. `brand/clear-space.svg` draws it.

**Minimum size: 32px for `full`, 16px for `compact`.** Both measured, not
aspirational — see `docs/BRAND-DIRECTIONS.md`.

**Responsive logo variants: none, and none are needed.** This was checked rather
than assumed. The masthead lockup is 127px wide at 1280px, 211px at 390px and
183px at 360px, and the document never gains horizontal scroll at any of them
(`docScrollW === innerWidth` at every width tested). The name is real text in
`--font-display`, so it reflows and scales with the reader's font size instead of
being an image that has to be swapped. Below roughly 300px — under this
project's own 360px test floor, and below anything the responsive matrix
exercises — the mark-only form would become necessary; `brand/mark-compact.svg`
is that asset, so the change is a one-line prop when it is ever needed.

## What was actually decided, and what was not

**This is the honest part, and it is a real gap in #16.**

The acceptance criterion for this issue reads: *"Several genuinely different brand
directions are compared before selection."*

**That was not done, and it cannot be done retroactively.** The aperture mark was
refined in place from an existing ring mark. There was no recorded comparison of
materially different concepts — no concept sketch that lost, no rejected
direction, no side-by-side at wordmark, masthead and favicon sizes. Writing one
now would be fiction: a document claiming a comparison that did not happen is
worse than a document admitting it did not, because it teaches the next person
that this is how brand decisions are recorded here.

What #16 *did* deliver, and what is genuinely recorded:

- One source of truth for the mark, with checks that fail on drift (above).
- The full set of variants a real brand needs — one-ink, reversed, light-ground,
  maskable, icon form — generated rather than hand-drawn.
- Clear space and minimum size measured and written down.
- One comparison that **was** carried out and is reproducible: the six compact-form
  candidates, rendered at 16/20/32/48px and decided on the pixels. It is recorded
  in `docs/BRAND-DIRECTIONS.md`.

So: the criterion is **unmet**. What replaces it is not a reconstruction but a
protocol — `docs/BRAND-DIRECTIONS.md` states how this project runs a brand
comparison, so that the *next* identity change is documented rather than another
undocumented one. That file is a thing to follow, not a thing to read and believe.
