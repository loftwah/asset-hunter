# Visual QA — the matrix, the artefacts, and what it does not cover

`scripts/visual-qa.mjs` is the visual evidence for the public catalogue. One
command captures a route × viewport matrix and asserts the things that are
cheaper to measure than to look at.

```bash
npm run check:visual                              # capture + audit, against :4321
npm run check:visual -- --url http://localhost:4394
npm run check:visual -- --url http://localhost:4394 --audit-only
npm run check:visual -- --url https://assets.loftwah.com --audit-only
```

There is no CI for it, and that is deliberate: #47's cost rule forbids hosted
Actions unless their $0 cost is demonstrated, and a browser matrix on GitHub's
runners is neither free nor deterministic. The qualification path is local or
repository-side, and this is the command.

---

## Retention: screenshots are a working set, not an archive

`screenshots/` is **wiped at the start of every capture run and never
committed**. It is in `.gitignore`, and the run *fails* if it ever stops being
there — an artefact set nobody can account for is the debris #47's last
acceptance criterion is about.

The reasoning: a run is reproducible from three things, and all three are
recorded.

1. the commit (`git rev-parse HEAD`, in the manifest),
2. the origin (`--url`, in the manifest),
3. the matrix and the assertions (`ROUTES`, `VIEWPORTS`, in the manifest).

So a PNG is a *result*, not a *record*. Keeping results in the repository buys
nothing that the manifest does not, costs hundreds of megabytes of diff, and
guarantees that the copy under review is the copy from six weeks ago. If a
screenshot needs to outlive a run, it belongs in the issue or PR that argues
about it, where the commit it came from is already written down.

`npm run check:visual` writes `screenshots/manifest.json` next to the images:

```jsonc
{
  "schema": "asset-hunter.visual-qa/1",
  "generated": "…", "origin": "…", "commit": "…", "branch": "…",
  "node": "…", "playwright": "chromium",
  "viewports": [ … ],        // the whole matrix, not just the ones that ran
  "routes":    [ … ],        // path + every selector each route asserts
  "counts":    { "routes": …, "viewports": …, "files": … },
  "files":     [ { "file": "wall--laptop-1280.png", "bytes": …, "sha256": "…" } ]
}
```

Two runs of the same commit against the same origin produce the same
`sha256` values. Two runs that differ have a real reason to differ, and the
digest is where you find out which.

`auditManifest` fails the run on any of:

- a capture the matrix expected that was never written;
- a file on disk the matrix does not name (debris from a deleted route);
- a capture the manifest claims but cannot read;
- `screenshots/` missing from `.gitignore`.

---

## What the issue asked for, and what carries it

The run prints this table every time, and **fails** if a row has nothing behind
it. A coverage claim that lives only in an issue goes stale the moment somebody
renames a route; this one is checked.

| Item | Carried by |
| ---- | ---------- |
| wall/home | `wall`, `wall-filtered` |
| search/filter results | `search`, `search-blank`, `search-none`, `wall-filtered` |
| possibility detail | `detail`, `detail-fold`, `collection` |
| compare/shortlist | `board`, `board-full`, `board-second` |
| rating/report interactions | `detail-signals` (signed out, a real route) + `lab-signals` (all seven states) + `auditSignalStates` |
| asset-use/licence drill-in | `asset-use`, `lab-use`, and `use-reference` / `use-review` / `use-attribution` / `use-reusable` / `use-not-retained` on the real `/use/<slug>` |
| EmDash-managed content reflected publicly | `auditCmsReflection` |
| key mobile/tablet/desktop viewports | the eleven `VIEWPORTS`, including two landscape phones, a 430px phone and 200% text |
| light/dark if both are supported | `auditDarkOnly` — asserts the **absence** of a light theme |
| `/lab` fixture states | `lab`, `lab-signals`, `lab-use` |

### Light/dark, and why it is an assertion rather than a skip

`DESIGN.md` §9.3 is a decision: the catalogue is dark only, and a light theme
would be a second visual system rather than a token flip. #47 asks for light and
dark "if both are supported", and the honest answer to "only one is supported" is
evidence that the other one is not there — not silence.

So `auditDarkOnly` renders the wall under `prefers-color-scheme: dark` **and**
under `prefers-color-scheme: light`, and fails if:

- `color-scheme` does not resolve to `dark`;
- `--canvas` or `--ink` differ between the two;
- the painted `body` background differs;
- any control in the interface reads as a theme switch.

A check whose normal outcome is silence has to be proved to be looking, so the
self-check points the same comparison at a `data:` page that *does* switch to a
light theme and requires the detector to report it. A pass on this site means the
detector ran, not that nothing was examined.

### States that need a fixture, and how they get one

The catalogue is 24 of 24 `reference` with nothing retained, so several states
are unreachable through real content:

- all four use states on `/use/<slug>`;
- any page with a download control at all;
- every signed-in rating state.

`src/lib/fixtures.ts` holds the literals, all behind the `fixture-` prefix, and
`src/pages/use/[slug].astro` resolves them **inside `import.meta.env.DEV` only**.
The captured pixels are therefore the production page rather than a second
implementation of it — a lab page that re-implemented the use flow would prove
that the lab page works, which is the mistake #45 was opened to stop. In a
production build the dynamic import is behind a `DEV` guard and the routes 404.

On a non-local origin those routes are **skipped and reported**, never failed:
they are refused in production by design. The run says so by name.

---

## What the run asserts

Per route, per viewport, in the rendered page rather than the stylesheet:

- horizontal overflow, with the elements named;
- the `.shell` gutter, which a `padding` shorthand silently replaces;
- tap targets against the 44px floor, with WCAG 2.5.8's inline exception and the
  radio-measured-by-its-label case;
- body-text contrast against the painted background;
- images that did not resolve, images with no `alt`, blank or flat media;
- exactly one `h1`, a `lang`, heading levels in order;
- content clipped inside a box that cannot scroll;
- controls with no area at all;
- aspect-ratio containers rendering a shape other than the one they declare;
- **duplicated element ids, and labels pointing at an id that does not exist** —
  `<label for>` resolves to the *first* match, so a second one is not untidy, it
  is a control labelled with the wrong name;
- **a status or count line that opens with a separator** — a join with nothing
  before it, which only happens in the emptiest state on a page;
- **a placeholder wider than its field**, measured with a canvas at the input's
  own font. Printed, not gated — see below;
- the first plate above 75% of the fold, and the plate's own 4:5;
- keyboard reachability from the top of the page;
- sticky chrome overlapping other sticky chrome, **on a scrolled frame**, because
  a `fullPage` screenshot does not simulate sticky positioning;
- a sticky element taller than the viewport that sticks to it;
- in-page anchors landing below the masthead rather than under it;
- nothing autoplaying;
- reduced motion collapsing every transition;
- the CMS catalogue and the served HTML agreeing;
- the artefact set matching the manifest.

Once per run, rather than per viewport, because each needs its own context or
its own comparison: layout shift with the media held back, the dark-only check,
and the self-check.

## The self-check

Every detector above is pointed at a deliberately broken `data:` page first, and
the run **fails** if one of them stays quiet. A check that has never failed is
indistinguishable from a check that cannot fail, and this repository has two live
examples of that mistake: a 24px tap-target gate that could not see a 32px
control, and `documentElement.scrollWidth` that cannot see content clipped
inside a scroll container. The broken page carries a clipped box, a zero-area
control, a wrong-shaped ratio container, a sticky pair painted over each other, a
flat image, a duplicated id and a dangling label; the themed page carries a light
theme.

It runs the shipping code, not a reimplementation, and the fixtures are `data:`
URLs so nothing in the repository or the CMS is involved. The dark-only check is
proved the same way, against a page that *does* switch to a light theme.

Two of the artefact checks are proved by removing the thing and running the
matrix — the `screenshots/` ignore rule, which the run reports by name. The other
two (a capture the matrix expected that was never written, and a file on disk the
matrix does not name) are reachable only when a `page.screenshot()` throws or
something else writes into the directory mid-run, because the run wipes
`screenshots/` before it captures anything: they are written and reachable, but not
demonstrated end to end, and are listed here as unproven rather than counted.

## A dev server that is broken is not a page that is broken

When a module fails to load, `astro dev` injects a `position: fixed`
`<vite-error-overlay>` over the page. Every sticky check then reports the
masthead and the filter rail sitting *behind the overlay* — true, repeated once
per viewport, and about a development tool rather than the product. The run
therefore:

- records subresource 5xx separately, as `server …`, never as a page fault;
- detects the overlay and **skips the page's own checks**, reporting the overlay
  as the finding, because a page covered by an error dialog has not been audited.

## Reading the output

Numbers printed without a pass/fail, on purpose:

- **Blank media** — the fewest distinct colours any plate produced. A real
  specimen plate lands in the dozens; a flat frame scores 1.
- **The fold** — where the first plate or example starts, on every gated route.
- **Fold, measured not gated** — the same number for the drill-in and the use
  page, where `DESIGN.md` §5b states no threshold. Gating a route the design
  authority has not written a rule for is inventing a rule in a test script, so
  the number is printed and the question stays arguable.
- **Touch targets below 44px** — which controls, and by how much, printed even
  when the gate passes so a run that *does* fail says which ones.
- **The accent count per route** — how many elements paint `--ember` opaquely and
  always-on, per `DESIGN.md` §2's "one accent per viewport". Measured, not gated:
  the wall's active filter and its featured wash are both legitimate, four
  decorative taglines is not, and only somebody who knows the page can say which.
  Alpha matters, so `--ember-wash` behind a `<mark>` is not counted.
- **Placeholders wider than their field** — the field's own explanation of itself,
  cut by the button beside it. Measured, not gated for the same reason the accent
  count is not: when the field already has the whole line, the remaining fix is
  the wording, and `DESIGN.md` §9.1 owns the words. `<input>` only — a `<textarea>`
  placeholder wraps and is fully visible.

## Reviewing the captures

The matrix is evidence, not a verdict. A clean run means nothing here is
*measurably* wrong; it does not mean the page is good. `DESIGN.md` and
`docs/UNSLOP.md` are the standard, and #47's own review questions are the prompt:

- is the example itself the visual focus?
- is there chrome the specimen does not need?
- can you tell what is clickable?
- does every media type feel native rather than forced into one template?
- are labels readable without dominating?
- do warnings and rights states communicate without poisoning the wall?
- does mobile feel intentionally composed?
- is this recognisably Asset Hunter rather than generic SaaS?

Record what you find against the issue that owns it, with the route, the
viewport and the measured number. An issue with a number in it can be closed;
an issue with an opinion in it can be argued with forever.
