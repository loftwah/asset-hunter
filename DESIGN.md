# Asset Hunter — visual design authority

This document is the authority for the catalogue's visual language. It exists so
that changes stay deliberate: tokens belong in `src/styles/global.css`, and the
rules below are what "good" means here.

Design intent: **a field guide to what can be made.** The reference points are
natural-history plate walls, instrument panels, and museum labels — a dark
archive with lit specimens and almost no chrome. Type is a label, not a summary.
The specimen is the content.

---

## 1. Non-negotiables

1. **Media first.** A tile is a specimen with a label. If a layout adds a card
   frame, a shadow, a badge stack or an icon row around the media, it has failed.
2. **One accent.** Ember marks action, selection and the single highest-priority
   element on a viewport. It is never decorative.
3. **Honest provenance.** Rights and origin are shown as a coloured dot **and** a
   word. Colour alone is not information.
4. **No card soup.** Grids earn their structure from tiered density, not from
   every cell shouting. See §5.
5. **Nothing invented.** Where a count, score or source is not machine-verified,
   it reads zero or is absent. The design must make an honest zero look
   deliberate rather than broken.
6. **Real product visuals.** Marketing and OG imagery comes from the running
   product. No mock dashboards.

## 2. Colour

Defined once as tokens. Never introduce a hex value in a component.

| Token                       | Value                    | Role                                  |
| --------------------------- | ------------------------ | ------------------------------------- |
| `--canvas`                  | `#08090a`                | Page ground. Near-black, slightly cool |
| `--surface`                 | `#101214`                | Raised panels, footer                 |
| `--surface-2` / `-3`        | `#16191c` / `#1d2126`    | Hover, inset, disabled fills          |
| `--line`                    | `#23272c`                | Default hairline                      |
| `--line-strong` / `-loud`   | `#343b42` / `#4d565f`    | Emphasised borders                    |
| `--ink`                     | `#f4f2ee`                | Primary text. Warm paper white        |
| `--ink-2` … `--ink-4`       | `#b6bcc3` … `#6a7178`     | Descending text emphasis              |
| `--ember`                   | `#ff5a1f`                | The single accent                     |
| `--origin-upstream`         | `#4cc2f0`                | Shown from discovered material        |
| `--origin-derived`          | `#a68bfb`                | Produced from discovered material     |
| `--origin-generated`        | `#f2a33c`                | Newly generated demonstration        |
| `--rights-cleared`          | `#4fce8a`                | Licence read and permits this use     |
| `--rights-attribution`      | `#4cc2f0`                | Permitted with attribution            |
| `--rights-review`           | `#ff8a4c`                | Detected but not understood           |
| `--rights-reference`        | `#f2a33c`                | No licence / not reusable             |

Rules:

- **`--rights-reference` must never be presented as permissive.** It is the
  amber caution token, and the copy next to it says what it actually means.
- Origin uses a **filled** dot; rights uses a **ring**, so the two encodings
  stay distinguishable at a glance and in greyscale.
- Contrast is enforced by `npm run check:visual`, not by eye.

## 3. Typography

Two self-hosted variable faces, no third-party requests at runtime.

| Token           | Face                 | Use                                                    |
| --------------- | -------------------- | ------------------------------------------------------ |
| `--font-display`| Bricolage Grotesque  | Headlines, numerals, tile titles. Tight tracking        |
| `--font-mono`   | JetBrains Mono        | Labels, metadata, provenance, all `caps` micro-type     |
| `--font-ui`     | system stack          | Body prose only                                          |

Rules:

- **All-caps micro-type is mono, 10–13px, `letter-spacing: 0.08–0.1em`.** It is
  the museum-label voice. Never set body copy in caps.
- Headlines use `--font-display` with `letter-spacing: -0.025em` and
  `text-wrap: balance`. Prose never uses the display face.
- Fluid scale via `--step--2` … `--step-5` (`clamp()`), so nothing is a
  hard-coded size.
- A line of body copy stays near 68ch (`--measure`).

## 4. Spacing and geometry

- Spacing scale: `--sp-1` … `--sp-9` (4px base, fluid at the top end).
- Radii are small and deliberate: `--radius: 3px`, `--radius-lg: 5px`. Pills are
  reserved for filters and counts, never for content cards.
- Hairlines (1px) do the structural work; shadows are near-absent
  (`--shadow-plate` inset, `--shadow-lift` only on tile hover).
- Gutters: `--gutter` is fluid, `--maxw: 1560px`.

## 5. Density ramp — the core layout idea

Grids do not shout everywhere. Each cell is assigned a **tier**, and the tier
controls its size in the grid, fill opacity, border strength and type size:

| Tier       | Use                                    | Treatment                              |
| ---------- | -------------------------------------- | -------------------------------------- |
| 1 (hero)   | Exactly one region per viewport        | Spans 2 columns and 2 rows, larger title |
| 2          | Secondary                               | Standard plate                         |
| 3          | Body of the grid                       | `4/5` plate, hairline border           |
| 4          | Reference rows                         | No border, small mono label            |

The most common failure is **two hero cells**. If two regions are equally loud
the ramp is not a ramp and the eye has nowhere to land.

**The ramp lives inside the wall's grid, not in a band above it.** An earlier
version put the hero in its own 1.6fr/1fr row above the grid, which left a
permanent hole beside a single wide tile. The hero is now the first tile of the
same grid spanning two columns and two rows, and the band is gone.

**A tier changes size, never shape.** Every specimen plate is 4:5 and its
annotations often sit near an edge, so no tile may render at a different aspect
ratio — a 16:10 "wider hero" crops the content that makes the plate worth
looking at. `npm run check:visual` asserts the rendered ratio and fails if a tile
crops its plate.

## 5b. The fold

**The catalogue is above the fold.** On the wall, the first plate must start
inside the first viewport at every width: 50% of a 1280×800 fold, 57% of a
390×844 one. The intro is a band, not a hero — a title block on the left and the
honest counts on the right, never a full-height stacked column.

This is the rule `docs/UNSLOP.md` states as "huge hero copy pushing the actual
catalogue below the fold", and `npm run check:visual` enforces it by measuring
where the first plate starts rather than by reading the stylesheet.

Measured, at the time of writing:

| Viewport | Masthead | First plate starts | Page height |
| -------- | -------- | ------------------ | ----------- |
| 1680×1050 | 57px     | 402px (38%)        | 3822px      |
| 1280×800  | 57px     | 401px (50%)        | 4370px      |
| 768×1024  | 88px     | 486px (47%)        | 7595px      |
| 390×844   | 88px     | 478px (57%)        | 14597px     |
| 360×780   | 87px     | 473px (61%)        | 13747px     |

### The fold on a selection page

`/use/<slug>` is the same kind of surface and carries the same rule, because
before #64 it was the one page on the site where the specimen was unreadable and
off-screen: it rendered its only plate at 104px, which put a plate authored at
800px with 13px annotations at 1.7px, and started it at 991px in a 1280×800
window — 124% of the fold.

So the use page leads with the plate too: a breadcrumb, one headline, one line of
lede, one action, and then the representative plate beside the use decision.
`npm run check:visual` gates it the same way, at 75% of the fold. The two
landscape rows are the exception and are printed rather than gated, because a
390px-tall window cannot contain a 4:5 plate however the header is composed —
the same rule, and the same reasoning, as the sticky plate's 46rem condition.

Measured on `/use/density-gradient` after #64:

| Viewport  | Plate          | 13px annotation lands at | Plate starts |
| --------- | -------------- | ------------------------ | ------------ |
| 1920×1080 | 640×800 (0.80) | 10.4px                   | 364px (34%)  |
| 1680×1050 | 640×800 (0.80) | 10.4px                   | 364px (35%)  |
| 1280×800  | 593×741 (0.74) | 9.6px                    | 364px (46%)  |
| 1024×768  | 640×800 (0.80) | 10.4px                   | 356px (46%)  |
| 768×1024  | 640×800 (0.80) | 10.4px                   | 420px (41%)  |
| 390×844   | 355×444 (0.44) | 5.8px                    | 544px (64%)  |
| 360×780   | 327×408 (0.41) | 5.3px                    | 542px (69%)  |

## 6. Specimen plates

Plates live in `public/specimens/*.svg`, one per possibility, `800×1000` (4:5),
hand-authored, and validated by `npm run check:specimens`.

Every plate follows the same grammar:

- a near-black ground matching `--canvas`, so the wall reads as one surface;
- the technique drawn as actual diagram or interface, not an icon;
- mono annotations with the real constraint values (2px gap, 30% overlap, 128
  step budget);
- the honest failure called out where one exists — a plate that shows only the
  technique that works is marketing.

Plates are always `origin: generated`. Never label a repo-shipped plate
`upstream`.

**The annotations are the reason a plate has a size, and a cap.** They are set
at 12–19px in an 800×1000 file, so what a reader can read is a function of where
the plate is rendered: at 0.8 of its authored width the smallest of them lands at
~10px, and at 0.13 — which is what `/use/<slug>` used to do — it lands at 1.7px
and the plate is a texture rather than an illustration. Two consequences:

- `SpecimenPlate.astro` caps the plate at `40rem`, which is 0.8 of the authored
  width. Past that the plate stops getting more legible and starts costing the
  page its second column, so the drill-in is no larger at 1920px than it is at
  768px.
- A plate may never be shown *below* about 0.7 of its authored size where the
  viewport has room for it. `npm run check:visual` asserts that floor on
  `/use/<slug>`, the surface §9.6 singles out as the one where the preview has to
  do work.

## 7. Interaction

- Hover on a tile: plate lifts 2px, border warms to `--ember-line`, media scales
  1.028. Nothing else moves.
- Focus is always visible: 2px `--ember` outline with 3–4px offset.
- Tap targets are at least 44px, achieved with padding rather than type size when
  the type is intentionally small (breadcrumbs, footer links, TOC entries).
- Transitions: 120ms for colour, 220ms for transform, 420ms for media scale.
- `prefers-reduced-motion` collapses every transition and smooth-scroll.
- Keyboard: `/` focuses search from anywhere outside a field. The skip link is
  first in tab order. Heading levels never skip.

## 8. States

Every data surface needs a real answer for each state, and the empty state must
be indistinguishable in quality from the loaded one.

| State          | Required                                                              |
| -------------- | --------------------------------------------------------------------- |
| Loading        | Server-rendered, so there is no loading state for catalogue content. If a future async source exists, a skeleton matching final geometry — never a spinner over content |
| Empty          | States what is missing and offers the next action. `/` with no entries, an empty collection, and search with no matches all have real copy |
| Error          | Says what failed and what to try; never a bare status code            |
| 404            | Search field plus vertical links, not a dead end                       |
| Missing media  | `placeholder.svg`, which says on its face that no plate exists        |
| Unverified     | A count of `0` with the label "verified sources", which is an honest answer rather than a gap |

### Overlays and drill-in

**No modal detail view.** A drill-in is a page: linkable, shareable, in history,
navigable by keyboard, and indexable. An overlay over the wall would save a
navigation and cost all of those.

The one overlay the site does use is the sticky masthead's backdrop — 88%
opaque with a 14px blur, which separates chrome from content without blurring
the specimens.

## 9. Responsive behaviour

| Range          | Layout                                                       |
| -------------- | ------------------------------------------------------------ |
| `< 560px`      | Single column; metadata stacks; evidence rows stack           |
| `560–860px`    | Plate and prose side by side; example list becomes 2-up       |
| `860–900px`    | Sticky plate on detail pages; 2-up tiles                       |
| `> 900px`      | Hero tile spans wide; 4–5 column wall; 3-up examples           |

Test at 360 and 390 — the two widths where a filter rail or a long title
actually breaks.

## 9.1 Search and filter affordances

Search is a text input in the masthead with `/` as a global shortcut, and a full
page at `/search` with facets. Filter is a sticky horizontal rail of chips on the
wall, and anchor links on `/verticals`.

Rules:

- **The URL is the filter.** `?vertical=<slug>` is the source of truth. The rail
  writes to it, and an unknown vertical falls back to the full wall rather than
  erroring.
- **Chips show counts.** A filter that hides options is a filter that confuses.
- **Results are counted honestly.** The search summary names each kind
  separately — `3 possibilities · 1 collection` — so a mismatch in either cannot
  cancel out.
- **Queries are `noindex`.** Including the blank search page: it is a starting
  point, not a destination.
- **Search matches the problem, not the vocabulary.** The placeholder says
  "technique, treatment, problem, tool" and the empty state suggests searching for
  the problem rather than the solution.
- **Search results are rows, not tiles.** A search for a known term is a
  comparison task, so each hit is a 4:5 thumbnail, a title, its tagline, its
  vertical/media/rights markers, and a line of the entry's own summary with the
  query terms marked. The wall is the visual surface; results are a list, and
  they must not repeat the title, the rights or the metadata the row already
  shows. EmDash's `search()` returns the matched *title* as its snippet, which
  is why the reason line is built from the entry's summary instead.
- **A collection hit shows its member count as the mark**, not a decorative
  icon, because the count is the thing a visitor is comparing.

## 9.2 Accessibility expectations

Checked automatically by `npm run check:visual` and structurally by
`tests/routes.test.ts`.

- Body text clears WCAG AA against its painted background (measured, not assumed).
- Every interactive element clears 44px, achieved with padding where type is
  intentionally small.
- Exactly one `h1` per page; no skipped heading levels. Tile titles take a
  `headingLevel` prop so a page can place them correctly — an `h3` under an `h1`
  with no `h2` breaks screen-reader navigation.
- `<html lang="en">` on every route.
- First Tab moves focus into the page; a skip link precedes everything.
- Every image has `alt`. Decorative covers use `alt=""`.
- Status is never colour alone.
- `prefers-reduced-motion` collapses all transitions and smooth scrolling.
- Visible 2px focus ring at 3px offset, never removed.

## 9.3 Light and dark

**Dark only.** The catalogue is a lit-vitrine archive: specimens are technical
diagrams that were drawn for a near-black ground, and the whole plate system
assumes it. A light theme would mean re-authoring 25 plates and re-tuning every
contrast pair, for a second presentation of the same content rather than more
content.

`color-scheme: dark` is declared so form controls and scrollbars follow. If a
light mode is ever genuinely wanted, it is a separate visual system, not a token
flip.

## 9.4 Brand tokens → catalogue usage (#16 mapping)

The brand vocabulary below is the one `docs/UNSLOP.md` refers to. Every token is
already defined in `src/styles/global.css`; this table is where each one is
allowed to appear.

| Brand token      | Catalogue usage                                   | Never used for                     |
| ---------------- | ------------------------------------------------- | ---------------------------------- |
| Aperture mark    | Masthead wordmark, footer                         | Tile decoration                    |
| Ember            | Active filter, primary button, hero tier wash, focus ring, breadcrumb current | Body text, secondary metadata      |
| Ink / ink-2      | Titles, body prose                                | Backgrounds                        |
| Ink-3 / ink-4    | Labels, provenance text, captions                 | Anything that must be read first   |
| Surface / -2 / -3 | Footer, legend, example rows, inset tracks       | Page background                    |
| Line / -strong   | Hairlines, tile borders                           | Fills                              |
| Origin ring      | Representative provenance marker                  | Rights status (different shape)    |
| Rights dot       | Rights status, legend, drill-in status panel      | Decoration                         |
| Use-state ring   | The per-example use state on the drill-in and `/use/<slug>` | Origin marker, decoration    |

**Where things live: public catalogue vs EmDash admin.**

The admin is a tool for authorised operators and inherits EmDash's own
interface. It is not themed with these tokens — restyling the CMS to match a
consumer catalogue would make the editing surface worse for its actual job.

The public catalogue owns all visual presentation: masthead, wall, drill-in,
search, 404, RSS, OG images. If a change touches either side, it belongs to
exactly one.

## 9.5 Shortlist and compare

The wall is for browsing; the board is for deciding. Two rules keep the second
from becoming a project-management app:

- **Comparison is media-first.** Every entry on `/board` renders through the same
  `PossibilityTile` in the same grid column, so the plates are the same size and
  one entry cannot win by being bigger. Source, licence and technique sit behind a
  per-entry disclosure, because a comparison that opens with metadata is a
  comparison you have already lost.
- **Saving is a form POST.** No JavaScript. A `+/` control sits over the plate as a
  *sibling* of the tile link — a form inside an anchor is invalid HTML and a button
  inside a link is unreachable by keyboard. It is dimmed rather than hidden on a
  fine pointer and always visible on touch, because hover does not exist there.

A board is a cookie. That is a deliberate trade and the reasoning is in
`src/lib/board.ts`: no account, no server state, no new collection in the CMS, and
clearing cookies clears it. It is per browser and not shareable; a shareable board
needs an identity and a server record, which is a different feature at a different
cost. It is unsigned, and every slug is validated against the catalogue before it
renders, so an edited cookie can at worst produce an empty board.

## 9.6 Asset use

The wall stays simple. The drill-in has to be unambiguous, and the selection
page is where the obligations live.

- **The use state leads, in words, with a ring beside it.** Reusable, reusable
  with attribution, review required, reference only. A ring rather than the
  filled dot used for origin, so the two encodings stay tellable apart. There is
  no euphemism and no state whose label is softer than its meaning.
- **The obligation is stated, not implied.** A licence obligation is something
  the reader has to do, so it is written out under its own mono label rather
  than implied by a credit box appearing.
- **No disabled download.** A control that cannot be used is a claim about the
  record, and claims about the record are made in words. A download appears only
  for a retained, hashed, permitted payload — all four conditions, not three.
  Where there is no download, the reason is the line under the state, so nobody
  has to guess whether it was missed or withheld.
- **Honest zero beats a missing control.** A selection with nothing downloadable
  says `0 retained originals to download` and explains which half of the
  catalogue that is. DESIGN.md §1.5 again: an absent number has to look
  deliberate.
- **A preview is never the asset.** The media on the use page is labelled
  "What is on screen" and named as a preview, because the plate and the original
  are different files and conflating them is the easiest dishonesty available
  here.
- **The credit is a block, not a field.** The recorded attribution is reproduced
  exactly, with the licence and the pointer to the file, in a readonly textarea
  so it copies with a keyboard and a screen reader. There is no author input to
  fill in later: a credit template with a hole in it is how an asset ships
  unattributed while everyone believes the obligation was handled.
- **The evidence is behind a disclosure**, not a hover, and the source record is
  a link to the data rather than a summary of it.

Every control explains itself in one line. A download is the single accent on a
page; there is at most one, because two would mean the accent marks nothing.

### The composition of `/use/<slug>`

Added by #64, when this page turned out to be the one surface on the site where
the specimen was neither readable nor on screen.

- **The plate is the page's largest element**, and it is the first thing after the
  header (§5b). Before this it was the page's only image at 104–128px, below a
  1259px stack of prose at 390 wide.
- **The plate and the use decision sit side by side from 1280px**, which is the
  width at which the plate is 0.7 of its authored size with a column left for the
  words. Below that the plate takes the full shell, which is wider than any split
  would give it, and the decision follows underneath. The two-column switch is
  later than the drill-in's 860px on purpose: on the drill-in the plate is one
  block among many, here it is the page.
- **The plate does not stick here**, unlike the drill-in's. A sticky element is
  bounded by its own grid area, and the decision column is a 500px column beside
  a 780px plate, so a sticky plate would pin at its own top and unpin on the next
  scroll: a 0px range, and 59px of plate off screen at 1024×768. The drill-in's
  prose column is four times the plate's height, which is the case a sticky plate
  is for.
- **The plate never renders below 0.7 of its authored 800px where the viewport can
  hold it**, so a 13px plate annotation lands at 9px or more. `npm run
  check:visual` asserts the 560px floor from 1280px up and prints every width
  beside the effective annotation size. Below 1280 the plate is the shell's own
  width — at 390px that is 355px and 5.8px annotations, which is exactly a wall
  tile's width, and that is the honest limit of a 4:5 diagram on a phone. What the
  page adds there is that this plate is the first thing on it, at 2.8× the 128px
  the row thumbnail used to render at, rather than one of twenty-four.
- **One component, both surfaces.** `SpecimenPlate.astro` renders the drill-in's
  plate and this page's, and the caption is a required prop: the plate and the
  original are different files, and a plate that forgets to say so becomes a
  compile error rather than a page nobody looked at.
- **An example is not shown the same file twice.** Every example's preview falls
  back to the possibility's plate, so the plate is shown once, at plate size; an
  example carrying its own preview gets it through the same component at the same
  size, beside its label.
- **The four states are answered in one place.** The decision column carries a
  census — the four states, each with a ring beside it and its count, worst
  first — because the plate is the loudest thing on the page and the rights are
  the reason for it. A row reading 0 is an answer. The census is hidden when there
  are no examples at all, because four rows of zeroes would read as a finding
  about the rights rather than as the absence of anything to have an opinion
  about.
- **One line per fact, once.** The handoff statement says what is on offer and
  what was withheld; the obligation above it says what is owed. They were the same
  sentence printed twice, three lines apart, on the page whose whole job is an
  unambiguous decision. The refusal `/api/payload/<example>` returns still states
  the rule around it, because a plain-text body has no labels to do it with.

## 10. Metadata and social

- `<title>`: `Page — Asset Hunter`, except on `/` where it is the brand line.
- OG image is a real capture of the product, 1200×630.
- `og:image:alt` mirrors the description.
- Canonical URL always absolute, from `Astro.site`.
- Search results and 404 are `noindex, follow`.
