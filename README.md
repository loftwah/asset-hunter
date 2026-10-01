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

Hunt-engine internals (crawl state, provenance evidence, fingerprints) stay
outside this app and publish in through a documented contract — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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

## Content model

`seed/atlas.json` is the readable source of truth for catalogue content.
`scripts/build-seed.mjs` validates it and composes `seed/seed.json`, which
EmDash inlines.

```bash
npm run seed:build      # atlas.json → seed.json
npm run seed:check      # fail if seed.json is stale
npm run seed:validate   # EmDash's own structural validation
```

Four collections:

| Collection     | Holds                                                        |
| -------------- | ------------------------------------------------------------ |
| `possibilities` | The catalogue entries. Grouped by a `vertical` taxonomy.      |
| `examples`     | Evidence for a possibility, with origin and rights fields.    |
| `collections`  | Overlapping curated groupings, distinct from the taxonomy.    |
| `pages`        | Editorial content (About, Licensing).                          |

Editing content normally happens in the EmDash admin. `seed.json` schema and
structure are applied once per database and are not re-applied, so a schema
change in the seed needs a fresh database or a migration.

## Verifying

```bash
npm run verify         # typecheck + seed checks + specimen checks + tests
npm run check:visual   # screenshot matrix + layout/a11y assertions (needs dev server)
npm run smoke          # proves the public catalogue is served by EmDash
npm run doctor         # environment report
```

`npm run check:visual` captures every public route at five viewports plus an
iPhone profile into `screenshots/`, and asserts on horizontal overflow, tap
target size, body-text contrast, resolved images, heading order, `lang`, first-Tab
focus and console errors. Run it with `npm run dev` up.

## Commands

| Command                | Purpose                                              |
| ---------------------- | ---------------------------------------------------- |
| `npm run dev`          | Dev server on :4321                                  |
| `npm run build`        | Production build                                     |
| `npm run deploy`       | Build and deploy the Worker                           |
| `npm run preview`      | Build and serve locally through wrangler              |
| `npm run typecheck`    | `astro check`                                        |
| `npm run test`         | Unit and contract tests                              |
| `npm run emdash …`     | EmDash CLI (`types`, `seed`, `export-seed`, …)        |
| `npm run check:specimens` | Validate every specimen plate                     |
| `npm run check:visual` | Visual QA matrix and assertions                      |

## Design

`DESIGN.md` is the visual authority: tokens, type scale, the specimen-plate
convention, and the rules that keep the catalogue from becoming card soup.
Change tokens in `src/styles/global.css` rather than ad-hoc values in
components.

## Deployment

Cloudflare Workers + D1 + R2. See [docs/DEPLOY.md](docs/DEPLOY.md) for the
required resources, secrets, migrations and first-deploy procedure.

## Licence

Code: MIT (see [LICENSE](LICENSE)).

Catalogue content: each example carries its own rights status. Nothing in this
repository is a grant of rights to third-party material.
