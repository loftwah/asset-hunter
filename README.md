# Asset Hunter

**A discovery engine for creative and technical possibilities.**

Five thousand logo files are not five thousand useful things to look at. They
might demonstrate forty materially different treatments. Asset Hunter is built
around the forty.

Each entry in the catalogue is a **possibility** — a specific idea, technique,
pattern or mechanic that can be recreated — with representative examples, a
technique, build notes, a prompt scaffold, and an honest rights statement.

## The three rules the product is built on

1. **Possibility is not permission.** Learning that a treatment exists says
   nothing about whether you may copy the asset that demonstrated it. Rights are
   tracked per example, never per possibility, and reference-only material is
   never presented as cleared. See [Licensing](src/pages/pages/licensing).
2. **Every example states its origin.** `upstream` is shown directly from
   discovered material, `derived` is a safe preview produced from it, `generated`
   is newly made to demonstrate a known possibility. The three are never mixed
   in a row, and generated examples are never called reproductions.
3. **Machine evidence and editorial judgement stay separate.** Coverage, novelty
   and source counts are observations. Editorial curation is a human decision.
   They influence ranking and never overwrite each other.

## Stack

EmDash CMS on Astro, deployed to Cloudflare Workers with D1 and R2.

| Concern      | Choice                                                    |
| ------------ | --------------------------------------------------------- |
| CMS          | [EmDash](https://emdashcms.com) 1.0.1 (`emdash` + `emdash/astro`) |
| Framework    | Astro 7, server-rendered (`output: "server"`)              |
| Runtime      | Cloudflare Workers (`@astrojs/cloudflare`)                |
| Database     | D1                                                        |
| Media        | R2, through EmDash's storage adapter                      |
| Auth         | EmDash passkey-first auth and RBAC                        |
| Tests        | `node:test`, Playwright for visual QA                     |

The public catalogue is an EmDash application, not an adjacent one. Every read
goes through `getEmDashCollection` / `getEmDashEntry`, media goes through the
EmDash/R2 path, and `scripts/emdash-smoke.mjs` fails if that stops being true.

Hunt-engine internals (crawl state, provenance evidence, fingerprints) live in
[`engine/`](engine/README.md), outside this app, and publish in through the
contract in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The engine talks to
EmDash over the same authenticated HTTP API the admin uses; it never touches the
CMS database and never imports app code.

```bash
export GITHUB_TOKEN=$(gh auth token)   # 10 search requests/minute without it
npm run hunt -- sfx.json               # crawl, read licences, group into possibilities
npm run hunt:sync                      # reconcile into the catalogue (idempotent)
npm run hunt:verify                    # prove the catalogue matches the payload
```

Machine entries arrive as **drafts** at `editorial_rank: 0`. A crawl never
decides what the public catalogue shows; `npm run doctor` fails if a draft has
leaked onto the wall.

## Getting started

Requires Node 22+.

```bash
npm install
npm run dev
```

Then:

```bash
open http://localhost:4321                  # the catalogue wall
open http://localhost:4321/_emdash/admin    # EmDash admin
```

The first run applies pending migrations and the seed schema. To also load the
demo catalogue content in a fresh database:

```bash
curl "http://localhost:4321/_emdash/api/setup/dev-bypass"
```

That endpoint creates a local dev admin (`dev@emdash.local`) and is
development-only — it refuses to run outside `astro dev`.

### Scale fixtures

In development the wall accepts `?scale=N` and renders itself with `N` synthetic
entries derived from the real catalogue, through the production tile:

```bash
open "http://localhost:4321/?scale=500"    # what five hundred entries do
open "http://localhost:4321/?scale=5000"   # what five thousand do
```

The fixture is refused outside `astro dev` — the entries do not exist, and five
hundred of them would be both a lie and a performance liability. It exists so
performance budgets are measured against a real wall rather than a page built to
resemble one; see [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).

## Content model

`seed/atlas.json` is the readable source of truth for catalogue content.
`scripts/build-seed.mjs` validates it and composes `seed/seed.json`, which
EmDash inlines.

```bash
npm run seed:build      # atlas.json → seed.json
npm run seed:check      # fail if seed.json is stale
npm run seed:validate   # EmDash's own structural validation
```

Four collections. `possibilities` and `examples` also carry the sync
bookkeeping fields `source_hunt`, `source_ids`, `source_revision`,
`machine_synced_at` and `visibility` that make a machine refresh traceable and
idempotent.

| Collection     | Holds                                                        |
| -------------- | ------------------------------------------------------------ |
| `possibilities` | The catalogue entries. Grouped by a `vertical` taxonomy.      |
| `examples`     | Evidence for a possibility, with origin and rights fields.    |
| `collections`  | Overlapping curated groupings, distinct from the taxonomy.    |
| `pages`        | Editorial content (About, Licensing, Quick start).             |

Editing content normally happens in the EmDash admin — including the primary
navigation, which is what the masthead renders. `seed.json` schema, content and
menus are applied once per database and are not re-applied, so a change in the
seed needs a fresh database or an edit in the admin.

## Verifying

```bash
npm run verify            # typecheck + seed + plates + tests (no server needed)
<<<<<<< HEAD
npm run verify:full       # verify + smoke + admin-edit + visual + perf (needs dev server)
=======
npm run verify:full       # verify + smoke + admin-edit + nav + visual (needs dev server)
>>>>>>> lane/17
npm run smoke             # proves the public catalogue is served by EmDash
npm run check:admin-edit  # writes through the CMS, publishes, reads the public page
npm run check:nav         # edits the menu through the CMS, reads the public masthead
npm run check:visual      # screenshot matrix + layout/a11y assertions
npm run check:perf        # budget every route, plus a 500-entry wall
npm run doctor            # environment report
```

`npm run verify:full` is the full gate. It needs `npm run dev` running and the
local database seeded (`curl "http://localhost:4321/_emdash/api/setup/dev-bypass"`).

| Check                    | What it proves                                                     |
| ------------------------ | ------------------------------------------------------------------ |
| `verify`                 | Types, seed validity, every plate renders, unit + route tests. Route tests skip with no server and **fail** on a server that answers errors |
| `smoke`                  | The public catalogue reads EmDash, not a shadow data source          |
| `check:admin-edit`       | An EmDash edit reaches the public site, then is restored             |
<<<<<<< HEAD
| `check:visual`           | Layout, contrast, tap targets, images, headings, focus, fold, crop, gutter — on the real wall *and* on a 5,000-entry one |
| `check:perf`             | Transfer, requests, DOM size, eager-vs-fetched media, CLS, filter and drill-in latency and main-thread cost on a long wall, against recorded ceilings |
=======
| `check:nav`              | The masthead is the EmDash menu, and editing it changes the site     |
| `check:visual`           | Layout, contrast, tap targets, images, headings, focus, fold, crop, gutter |
| `check:perf`             | Transfer, requests, DOM size, CLS and interaction latency against recorded ceilings |
>>>>>>> lane/17
| `check:specimens`        | Plates are well-formed XML with usable viewBox and alt text          |
| `check:plates`           | Plates render without text collisions or cropped marks                |
| `doctor`                 | What is installed versus what is integrated and used                 |

`check:visual` captures every public route at five viewports plus an iPhone
profile into `screenshots/`, and asserts in the rendered page rather than on the
source — so it catches what a stylesheet review cannot.

`check:perf` also measures `/?scale=5000`, the same wall with a synthetic
catalogue of five thousand entries. It is development-only (`?scale=` is refused
outside `astro dev`), deterministic, and rendered through the production tile.
Its numbers, and what is deliberately measured rather than gated, are in
[`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).

`check:plates` renders each specimen plate in a browser and measures real glyph
boxes. Overlapping labels in a plate look fine in source and become gibberish at
wall size, which is exactly why they are measured rather than reviewed.

`check:visual` also fails if the first plate starts below three quarters of the
fold, if a tile renders at a shape other than the plate's own 4:5 (which crops
annotations off a diagram), or if an element has lost the shell gutter. Those
three were each a real bug found by reading captures rather than source.

## Commands

| Command                   | Purpose                                          |
| ------------------------- | ------------------------------------------------ |
| `npm run dev`             | Dev server on :4321                              |
| `npm run build`           | Production build                                 |
| `npm run deploy`          | Build and deploy the Worker                     |
| `npm run preview`         | Build, then serve the built Worker through wrangler |
| `npm run typecheck`       | `astro check`                                    |
| `npm run test`            | Unit, seed-contract and route tests             |
| `npm run test:unit`       | Only the tests that need no server              |
| `npm run emdash …`        | EmDash CLI (`types`, `seed`, `export-seed`, …)   |
| `npm run seed:build`      | `seed/atlas.json` → `seed/seed.json`             |
| `npm run seed:check`      | Fail if `seed.json` is stale                     |
| `npm run check:specimens` | Validate plate structure                         |
| `npm run check:plates`    | Render plates and measure them                   |
| `npm run check:visual`    | Visual QA matrix and assertions                  |
| `npm run check:perf`      | Measure every route plus a 500-entry wall, compare to recorded ceilings |
| `npm run check:perf:write` | Re-record those ceilings from this machine        |
| `npm run check:perf:repeat` | Median of three runs, for a busy host            |
| `npm run hunt -- <brief>` | Run a hunt: crawl, read licences, build the payload   |
| `npm run hunt:sync`      | Reconcile the payload into the catalogue            |
| `npm run hunt:verify`    | Prove the catalogue matches the payload             |
| `npm run generate:og`     | Regenerate social images from the running product |
| `npm run capture:reference` | Recapture `reference/` and the `/gallery` images |
| `npm run skills:sync`     | Refresh vendored EmDash agent skills             |

## The catalogue as an API

An agent should not have to scrape HTML to ask the catalogue a question, so it is
also a documented JSON contract at `/api/catalogue.json` — read-only,
published-only, no token, because everything it serves is already public HTML.

```bash
npm run catalogue -- summary
npm run catalogue -- search "loop without a seam"
npm run catalogue -- rights --status reference
npm run catalogue -- fetch --out /tmp/catalogue.json   # diff a change as a diff
```

And a chosen shortlist becomes an implementation handoff at `/api/handoff.json`,
as the same versioned contract or as Markdown:

```bash
npm run catalogue -- handoff density-gradient,diegetic-damage --check
npm run catalogue -- handoff density-gradient --chose density-gradient \
  --goal "A bento dashboard where emphasis steps down in three tiers" \
  --markdown --out handoff.md
```

The full contract is in [`docs/AGENT_API.md`](docs/AGENT_API.md). Four things
survive into it deliberately: `null` is not `0`, rights are per example, a
community rating is never blended with a machine measurement or an editorial
decision, and a handoff never invents the goal, platform or acceptance criteria
a reader did not record — it names them as unrecorded instead.

## Vocabulary and roadmap

[`docs/VOCABULARY.md`](docs/VOCABULARY.md) is the terminology authority: one
concept, one word, across the wall, search, the admin, the engine and these
docs. A surface that re-derives a label from a slug is how "UI / Web" becomes
"Ui Web" on one page and "ui-web" on another.

[`docs/ROADMAP.md`](docs/ROADMAP.md) records the delivery bands, including the
P0 local hunt loop and the P3 possibility engine that the product is heading
towards.

## Design

`DESIGN.md` is the visual authority: tokens, type scale, the specimen-plate
convention, and the rules that keep the catalogue from becoming card soup.
Change tokens in `src/styles/global.css` rather than ad-hoc values in
components.

## Deployment

Cloudflare Workers + D1 + R2. See [docs/DEPLOY.md](docs/DEPLOY.md) for the
required resources, secrets, migrations and first-deploy procedure.

**If this site has never had an administrator account created, do that before
anything else.** The first-run wizard is unauthenticated and the session it
creates is a same-origin cookie; see [docs/SECURITY.md](docs/SECURITY.md) §1.

## Security

[docs/SECURITY.md](docs/SECURITY.md) is the review of the public catalogue: what
was attacked, what was found, what was fixed, what is accepted and what is open.
The parts worth knowing before you touch the code are §4 (hostile content — the
whole product is other people's text) and §11 (what is still open).

## Licence

Code: MIT (see [LICENSE](LICENSE)).

Catalogue content: each example carries its own rights status. Nothing in this
repository is a grant of rights to third-party material.
