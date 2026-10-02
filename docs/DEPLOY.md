# Deploying Asset Hunter

The public catalogue is an EmDash application on Cloudflare Workers, with D1 for
structured data and R2 for media. There is no second site, no second CMS and no
sidecar service: what deploys is the same app the tests run against.

This document is the procedure `README.md` refers to. It exists because the
alternative — a link to a file that is not there — means a deploy is attempted
from guesswork.

## What deploys

| Piece | Where it lives | Cloudflare resource |
| --- | --- | --- |
| The public catalogue and the admin | `src/`, built by Astro | Worker `asset-hunter` |
| Catalogue, collections, pages, ratings, reports | EmDash content | D1 `DB` |
| Uploaded media | EmDash storage | R2 `MEDIA` |
| Hunt/crawl state | `engine/state/` | **nowhere** — it is local and rebuildable |

The last row matters. `engine/state/` is a cache of what GitHub said, not a
record of record. It is gitignored and never deployed; deleting it and re-running
the hunt produces the same payload. If a deploy appears to have "lost" it,
nothing was lost.

## Required configuration

### Secrets

EmDash needs one operator-provided secret. It is **not** stored in the database,
and losing it means losing everything encrypted with it.

```bash
npx emdash secrets generate          # prints emdash_enc_v1_<43 chars>
npx wrangler secret put EMDASH_ENCRYPTION_KEY
```

Rotation is a comma-separated list. The first key encrypts new values; every
listed key stays available for decryption, so a rotation does not require
rewriting existing settings:

```bash
npx wrangler secret put EMDASH_ENCRYPTION_KEY   # "new_key,old_key"
```

Keep the key material with the database backups. `docs/ARCHITECTURE.md` records
which state is not reconstructable by re-crawling — editorial rank, community
ratings and reports — and the encryption key protects part of that.

Two more secrets exist and are **optional**: `EMDASH_PREVIEW_SECRET` and
`EMDASH_IP_SALT`. When unset, EmDash generates each once and stores it in the
options table. Set them explicitly only if you need the values to be stable
across a database replacement, which is the restore-drill case.

`EMDASH_AUTH_SECRET` is a legacy fallback that only seeds the IP salt. A new
deployment does not need it.

### Bindings

`wrangler.jsonc` declares both bindings. The D1 binding needs a `database_id`,
which Cloudflare assigns when the database is created:

```bash
npx wrangler d1 create asset-hunter
```

Copy the printed `database_id` into `wrangler.jsonc` under the `DB` binding.
`wrangler.local.jsonc` keeps `"database_id": "local"` so `npm run preview` and
`npm run dev` stay on a local database and can never touch production by
accident.

R2 has no id to fill in:

```bash
npx wrangler r2 bucket create asset-hunter-media
```

### Migrations

EmDash migrations are deployment-managed rather than hand-written files. The
manifest is derived from the Astro config, so `migrations_dir` in
`wrangler.jsonc` is where wrangler would look for application-level migrations,
not for EmDash's.

```bash
npx emdash migrate --check        # what is pending or unknown, without changing anything
npx emdash migrate --status       # every migration set and its state
```

On a fresh database, the first request applies pending migrations and then the
bundled seed's schema and structure once. Sample content comes from the setup
wizard or `emdash seed`.

If a migration is interrupted, `--status` prints the lock id and
`--release-lock=<id>` clears it. `--expected-target-fingerprint` is required for
a non-interactive apply, which is the safe way to script it: it fails rather
than applying against a database that is not the one you inspected.

## First deploy

```bash
npm install
npm run verify          # typecheck, seed integrity, plates, 190 tests
npm run build
npx wrangler deploy
```

`npm run deploy` does the build and the deploy in one step.

Then point the hostname at the Worker. Either in the Cloudflare dashboard under
Workers & Pages → `asset-hunter` → Settings → Domains & Routes, or as a route in
`wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "assets.loftwah.com", "custom_domain": true }]
```

## Verifying a deploy

A deploy that returns 200 is not a healthy catalogue. `docs/PERFORMANCE.md`
covers measurement; this is the correctness pass.

`npm run smoke` and `npm run check:admin-edit` both accept a `--url` and run
against any origin:

```bash
node scripts/emdash-smoke.mjs --url https://assets.loftwah.com
node scripts/admin-edit-check.mjs --url https://assets.loftwah.com
```

`check:admin-edit` writes a marker through the CMS, publishes, reads the public
page and the wall, and restores the original value. It is the only check that
proves the whole path — CMS write → publish → public read — works in the
deployed environment. It needs a dev bypass session, so it only runs against a
development server; on production, make the same edit through `/_emdash/admin`
and confirm it appears on the public page.

The journeys worth confirming by hand after any deploy:

- `/` serves real catalogue data, not an empty wall
- `/search?q=<known term>` returns results with the term marked
- a detail page shows its rights status in words
- a CMS edit appears publicly
- media resolves from R2
- `/api/catalogue.json` returns `200` with an `X-Catalogue-Schema` header
- `/rss.xml` parses

## What not to do

- **Do not point the production D1 at a local id.** `wrangler.local.jsonc`
  exists precisely so local work cannot reach production.
- **Do not re-run the seed against a populated database.** Seed application
  happens once, on an empty database. The seed applies schema and structure; it
  is not a reset.
- **Do not hand-write EmDash migrations.** They are versioned with EmDash, and
  the manifest is generated from the config.
- **Do not commit secrets.** `.env*` is gitignored; `.env.example` documents
  which names exist without their values.

## Related

- [Architecture](ARCHITECTURE.md) — the app/engine boundary and what each owns
- [Performance](PERFORMANCE.md) — budgets and how they are measured
- `npm run doctor` — local environment state, including whether the D1 and R2
  bindings are declared
