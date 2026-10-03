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

### The first administrator, and `EMDASH_ALLOW_SETUP` (#53)

EmDash's first-run wizard is **unauthenticated**. `POST /_emdash/api/setup`,
`/_emdash/api/setup/admin` and `/_emdash/api/setup/admin/verify` walk any
anonymous visitor through creating the first administrator account, and each
step's only guard is "does a user exist yet". That is right for a site that was
created a minute ago and catastrophic for one whose first account has not been
made yet — and the CMS session is a same-origin `httpOnly` cookie, so whoever
walks it owns the content, the media and the users.

`src/middleware.ts` therefore **refuses the wizard in a production build unless
the build opts in**:

```bash
# First deploy of a brand-new site: opt in, deploy, create the admin, then rebuild without the flag.
EMDASH_ALLOW_SETUP=1 npm run deploy
# …create the administrator at https://<your-host>/_emdash/admin/setup, from a machine you control…
npm run deploy          # the wizard is closed again
```

If you deploy and never create the account, the site stays **unclaimed**, which
is why the flag defaults off. `GET /_emdash/api/setup/status` tells you where you
stand; `{"needsSetup":true}` means nobody has created the first account yet.

See `docs/SECURITY.md` §1 for the measurement.

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
  is not a reset. (Adding *new* seed entries to a populated database is a
  different operation, and is described below — that one is safe, and necessary.)

## Getting the database to match the repository

Merged work does not reach the live database on its own. `wrangler deploy` ships
**code**; the schema and the rows travel a different path, written by a seed
applied once, to a database, by a command nobody has run since. So an entry can
be merged, `seed:check`-verified, specimen-checked and deployed — and be absent
from production, which is what happened to ten entries here.

### The gate

`npm run deploy:parity` compares the repository against the deployed database on
both axes and exits non-zero for anything but `aligned`, `unknown` included:

```
  entries      seeded 38   served 28   collections seeded 9   held 6

✖ the deployed database is missing 3 collections (audit_events, disputes,
  exclusions), so the code paths that write to them cannot run; it also does not
  serve 10 seeded entries
```

Two axes because they fail differently:

- **entries** — what `/api/catalogue.json` serves. Compared over `possibilities`
  and `collections`, the two the endpoint publishes. `examples` are served nested
  inside their possibility, so counting both would report one defect twice; `pages`
  are not published at all, so their parity belongs to the admin, not to a public
  gate.
- **collections** — `SELECT slug FROM _emdash_collections`. Not reachable from any
  public route, which is the whole problem.

**A missing collection is the worse finding and is named first.** It is not
invisible content; it is a deployed feature that cannot execute. This
repository's `disputes`, `exclusions` and `audit_events` collections were absent
from production while the rights-correction workflow (#54) that writes to all
three was deployed, tested and green — every page rendered and all 22 smoke checks
passed, because the dispute state lives as fields on the example row rather than
in a table of its own. The read path was never going to notice.

`extra` is reported and never fails: a promoted draft or a plugin-owned
collection is the system working. `--content-only` skips the schema axis for a
fast check and says so, because a missing collection is exactly what it cannot
see.

### Backing up first

D1's own history is the backup, and it is the only mechanism available here:

```bash
npx wrangler d1 time-travel info asset-hunter
# ⚡️ To restore to this specific bookmark, run:
#  `wrangler d1 time-travel restore asset-hunter --bookmark=<uuid>`
```

**`wrangler d1 export` cannot be used to back this database up.** It fails with
`D1 Export error: cannot export databases with Virtual Tables (fts5)`, and
EmDash's search is FTS5. Any runbook, restore drill or incident procedure that
assumes an export step is wrong for this project; read
[`docs/TESTING.md`](TESTING.md) and the restore work in the backlog for the
consequences. Time Travel retention is finite, so a bookmark taken at the start
of a risky operation is worth recording somewhere durable.

### Applying the seed additively

`emdash seed` targets a local SQLite path. There is no `--d1`, and `wrangler d1
execute` cannot stand in for it: a collection's table is created when EmDash
applies the schema, not by inserting a row into `_emdash_collections`, so
hand-written INSERTs restore the metadata and leave the table missing — verified
against a local database by dropping `ec_disputes`, re-inserting the collection
row, and finding no table.

The supported remote path is the CLI over HTTP, which creates rather than
overwrites and so is additive by construction:

```bash
# 1. schema — one create per missing collection, then its fields
npx emdash schema create disputes --label Disputes -u https://assets.loftwah.com -t "$EMDASH_TOKEN"
npx emdash schema add-field disputes --name dispute_state -u … -t "$EMDASH_TOKEN"

# 2. content — one create per missing entry, straight from the seed
npx emdash content create possibilities --file row.json --slug monoline-constant-weight \
  -u https://assets.loftwah.com -t "$EMDASH_TOKEN"

# 3. prove it
npm run deploy:parity        # must now say aligned
```

`npm run deliver:seed` computes that list from the seed and the deployed
database, prints every command, and refuses to run anything without `--apply`.
Dry-run by default is not caution for its own sake: the alternative is a person
assembling the list by hand against production, and the list is exactly the kind
of thing that gets one entry wrong.

### One thing a plan cannot reproduce

`emdash seed` applies each collection's `supports`. `possibilities` declares
`["drafts","revisions","search","seo"]`; `disputes` declares `["drafts","search"]`.
`emdash schema create` has no flag for it, and a collection created that way
arrives as `["drafts","revisions"]` — it gains revision history nobody declared
and loses its FTS table. Measured against a throwaway collection on a local
instance rather than assumed.

For the three collections missing here that is benign: nothing searches a dispute,
and the dispute state a reader sees is a field on the example row rather than a
row in that collection. It would **not** be benign for `possibilities`, which is
why `deliver-seed` never plans a collection that already exists — the only
collections it will create are ones this repository has just introduced. If a
future change needs to recreate an existing collection, the seed has to be
re-applied rather than delivered.

### Why create, and never an update

`--on-conflict=update` would bring the missing rows in **and** overwrite every
editorial change made since the last seed. Content a person edited in the admin
is not reproducible from `seed/seed.json` — the seed is the source for what has
never been touched, not for what has. Creating is additive: it cannot delete a
row and cannot overwrite one. `skip` is EmDash's own default for the same reason,
and the destructive alternative is one flag away and reads as harmless.

## Related

- [Architecture](ARCHITECTURE.md) — the app/engine boundary and what each owns
- [Performance](PERFORMANCE.md) — budgets and how they are measured
- `npm run doctor` — local environment state, including whether the D1 and R2
  bindings are declared
