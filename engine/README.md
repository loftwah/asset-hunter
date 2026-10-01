# The hunt engine

The engine discovers material, records what it actually is, and publishes
possibilities into the EmDash catalogue. It is deliberately **outside** the Astro
app: crawl state is high-volume, transient and rebuildable, and putting it in
CMS tables nobody edits by hand would make both the admin and the schema wrong.

See [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the boundary. The rule
that matters: the public app never reads engine state, and the engine never
writes EmDash system tables. Everything crossing is the publish payload.

## What it will not do

- **It will not run anything it downloads.** Repositories are read as bytes over
  the API. No clone, no `npm install`, no build. An upstream `package.json` is
  data, not an instruction.
- **It will not treat repository licence metadata as authority.** GitHub's
  `license.spdx_id` is a hint that is frequently `NOASSERTION` or simply wrong
  for the asset in question. The classifier reads the licence *file*, hashes it,
  and records the evidence. Repository-level permission is not the same question
  as "may I use this file".
- **It will not invent counts.** `distinct_sources` is `0` until sources are
  verified, and `novelty`/`coverage` stay `null` rather than seeded with an
  estimate.
- **It will not overwrite human decisions.** `editorial_rank`, `featured`,
  `image`, `build_notes` and `prompt_scaffold` are owned by people. The
  publisher writes only the fields the engine owns, and says so when it skips
  one.

## Layout

| Path                | Responsibility                                                  |
| ------------------- | --------------------------------------------------------------- |
| `src/brief.ts`      | The hunt brief: intent, constraints, limits. Validated, not trusted |
| `src/github.ts`     | Read-only GitHub access: search, tree listing, file bytes         |
| `src/candidates.ts` | The candidate store: content-addressed, resumable, append-only    |
| `src/licence.ts`    | Licence evidence and the four-way rights classification          |
| `src/possibility.ts`| Extract a possibility from evidence, without inventing certainty   |
| `src/publish.ts`    | The deterministic publish payload and its invariants              |
| `src/cli.ts`        | `hunt`, `sync`, `verify`                                          |

## Running it

```bash
# Plan a hunt from a brief and record what the sources actually are
node --experimental-strip-types engine/src/cli.ts hunt engine/briefs/sfx.json

# Reconcile the result into the catalogue (idempotent)
node --experimental-strip-types engine/src/cli.ts sync

# Prove the catalogue matches the payload
node --experimental-strip-types engine/src/cli.ts verify
```

State lands in `engine/state/` (gitignored). It is a cache of what the sources
said, not a record of record — deleting it and re-running produces the same
payload.

## GitHub credentials

Unauthenticated search works but is rate-limited to 10 requests a minute, which
is not enough for a real hunt. Set `GITHUB_TOKEN` (or `GH_TOKEN`) and the
engine uses it. Without a token it still runs, slowly, and says so in its
report rather than failing.
