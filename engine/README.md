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
| `src/refresh.ts`    | What a refresh owes, decided with no network at all               |
| `src/crawl.ts`      | The crawl, as one Effect: metadata, then plan, then bytes         |
| `src/licence.ts`    | Licence evidence and the four-way rights classification          |
| `src/possibility.ts`| Extract a possibility from evidence, without inventing certainty   |
| `src/publish.ts`    | The deterministic publish payload and its invariants              |
| `src/cli.ts`        | `hunt`, `refresh`, `sync`, `verify`                              |

## Running it

```bash
# Plan a hunt from a brief, discover, and record what the sources actually are
npm run hunt

# Re-read what is already known and nothing else. This is the mode to schedule.
npm run hunt:refresh

# Reconcile the result into the catalogue (idempotent)
npm run hunt:sync

# Prove the catalogue matches the payload
npm run hunt:verify
```

## How a refresh avoids re-reading the world

The order is the whole design:

```
  cheap metadata  →  plan  →  bytes
  (2 requests)      (pure)   (tree + files, only for what the plan kept)
```

Reading a repository costs a recursive tree listing — megabytes for an ordinary
project — and then a download per sampled file. So nothing that costs bytes is
asked for until something that costs kilobytes has said it is worth it.

`src/refresh.ts` is a pure planner: `planRefresh(candidates, observations, now)`
answers which sources owe a re-read, and it can be tested without a network. The
crawl reads the plan and does, or skips, the work. A source is re-inspected when
something that could change what the catalogue *claims* about it has moved —
`pushedAt`, the head commit, the default branch, or a new `archived` flag. **Star
counts and descriptions are deliberately not evidence**: they move on nearly every
real crawl, and treating them as evidence would make the second run cost as much
as the first.

| Mode             | Discovery | Known sources                     |
| ---------------- | --------- | --------------------------------- |
| `hunt <brief>`   | yes       | re-checked; unchanged ones skipped |
| `refresh <brief>`| no        | re-checked; unchanged ones skipped |

`refresh` cannot grow the universe, so its cost is bounded by what is already
held — which is what makes it safe to put on a schedule. `--force` re-reads
everything the brief allows, for a change in the *engine's* rules rather than in
anything upstream, and is still bounded by `maxBytes` and `maxCandidates`.

A schedule is deliberately not hard-coded. `refresh` is the deterministic command
a future scheduler invokes; adding a schedule is a `cron` line, not a second
crawler.

### What the report tells you

Every run prints the same compact metrics, and every one of them can honestly be
zero:

```
Refresh
  checked     18
  changed     0
  unchanged   18
  new         0
```

`unchanged` matters as much as `changed`: a refresh that re-reads everything
reports the same numbers forever and gives no signal. When nothing changed, no
payload is rewritten — the same rule that keeps `machine_synced_at` still — and
the run says so rather than passing over it in silence.

### Disappearance is recorded, never inferred

A source that 404s is **not** dropped. It is recorded in `state/vanished.json`
with the commit it was last read at, the date, and the reason; the candidate stays
in the store and stays in the payload, because evidence read at a commit is still
evidence about that commit. A record of "gone, at this commit, on this date" can be
investigated in a way that an absence cannot.

The three failures of the pre-check are kept apart, because collapsing them is how
a catalogue quietly becomes wrong:

- **404** — the source is gone. Recorded, as above.
- **403/429** — GitHub throttled us. Reported, recorded as *nothing*: a throttle
  is not a fact about a repository.
- **transport failure** — the socket moved. Also recorded as nothing. Recording
  these is how a flaky network invents repositories that were deleted.

A **renamed** repository is a fourth case and is neither: GitHub redirects an old
path and reports the canonical name, so the old reading is marked `renamedTo` and
the new name is inspected in the same run, carrying the recorded description
across. One live entry, under the name GitHub now serves.

State lands in `engine/state/` (gitignored). It is a cache of what the sources
said, not a record of record — deleting it and re-running produces the same
payload.

## GitHub credentials

Unauthenticated search works but is rate-limited to 10 requests a minute, which
is not enough for a real hunt. Set `GITHUB_TOKEN` (or `GH_TOKEN`) and the
engine uses it. Without a token it still runs, slowly, and says so in its
report rather than failing.
