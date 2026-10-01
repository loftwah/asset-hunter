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
controls fill opacity, border strength and type size:

| Tier       | Use                                    | Treatment                              |
| ---------- | -------------------------------------- | -------------------------------------- |
| 1 (hero)   | Exactly one region per viewport        | Ember wash, 16/10 plate, larger title  |
| 2          | Secondary                               | Cool wash, standard plate              |
| 3          | Body of the grid                       | `4/5` plate, hairline border           |
| 4          | Reference rows                         | No border, small mono label            |

The most common failure is **two hero cells**. If two regions are equally loud
the ramp is not a ramp and the eye has nowhere to land.

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

**Where things live: public catalogue vs EmDash admin.**

The admin is a tool for authorised operators and inherits EmDash's own
interface. It is not themed with these tokens — restyling the CMS to match a
consumer catalogue would make the editing surface worse for its actual job.

The public catalogue owns all visual presentation: masthead, wall, drill-in,
search, 404, RSS, OG images. If a change touches either side, it belongs to
exactly one.

## 10. Metadata and social

- `<title>`: `Page — Asset Hunter`, except on `/` where it is the brand line.
- OG image is a real capture of the product, 1200×630.
- `og:image:alt` mirrors the description.
- Canonical URL always absolute, from `Astro.site`.
- Search results and 404 are `noindex, follow`.
