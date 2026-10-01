# Architecture

Asset Hunter is two systems with a documented boundary between them. Confusing
them is the main architectural risk, so the boundary is stated first.

## The split

```
┌─────────────────────────────────────────────────────────────────────┐
│ EmDash / Astro on Cloudflare Workers  ← the public product           │
│                                                                     │
│   possibilities · examples · collections · pages                   │
│   taxonomy: vertical                                                 │
│   media: R2 via EmDash storage                                       │
│   auth/RBAC: EmDash                                                  │
│   admin: /_emdash/admin                                              │
│                                                                     │
│   Published, user-facing, CMS-managed, Renders on every request.    │
└───────────────────────────────▲─────────────────────────────────────┘
                                │
                   publish / sync contract
                   (deterministic, idempotent)
                                │
┌───────────────────────────────┴─────────────────────────────────────┐
│ Hunt engine  ← crawler, classifier, analyser  (outside this app)    │
│                                                                     │
│   raw candidate search waves                                        │
│   immutable provenance evidence (repo/ref/path, commit, hashes)      │
│   licence detection and evidence text                               │
│   fingerprints and technical analysis                               │
│   discovery workspaces                                              │
│                                                                     │
│   Transient, high-volume, rebuildable, never rendered directly.     │
└─────────────────────────────────────────────────────────────────────┘
```

## Why the split

The two systems have opposite requirements.

The **public catalogue** needs editorial control, revisions, drafts, scheduling,
search indexing, media management, RBAC and a human-usable admin. EmDash provides
all of that and is the product's actual CMS — not a sidecar.

The **hunt engine** handles high-volume transient data: crawl state that is
discarded and re-derived, provenance evidence that is append-only and never
mutated, and bulk analysis that would pollute CMS tables with tens of thousands
of rows nobody edits by hand. Putting that in the CMS would make the admin
unusable and the schema wrong.

**The boundary rule:** the public app never reads transient hunt state, and the
hunt engine never writes EmDash system tables directly. Everything crossing the
boundary goes through the publish contract.

## The publish contract

The hunt engine emits **possibilities** and **examples**. The catalogue side owns
their presentation.

A possibility carries:

| Field               | Owner      | Notes                                              |
| ------------------- | ---------- | -------------------------------------------------- |
| `title`, `tagline`, `summary`, `technique` | Engine | The technical content                             |
| `vertical`          | Engine     | Must be a declared taxonomy term                    |
| `specimen`          | Engine     | Path to a generated or derived plate                |
| `image`             | Human      | CMS media; overrides `specimen` when set           |
| `representative_origin` | Engine | `upstream` \| `derived` \| `generated`            |
| `rights_status`, `rights_note` | Engine | Never inferred from repo metadata alone           |
| `example_count`, `distinct_sources` | Engine | Machine observations; **0 when unverified** |
| `novelty`, `coverage` | Engine   | Machine observations; null when unobserved         |
| `editorial_rank`, `featured` | Human | Editorial judgement                               |
| `build_notes`, `prompt_scaffold` | Human | Editorial guidance                               |

Invariants the contract enforces, all asserted in `tests/seed.test.ts`:

1. An example with a repo-shipped plate is never `upstream`.
2. `distinct_sources` is 0 until sources are verified. A plausible-looking
   number is fabricated evidence.
3. `novelty` and `coverage` are null rather than seeded with estimates.
4. Every possibility and example declares a `rights_status`.
5. Machine observations and editorial judgement are distinct fields and neither
   overwrites the other.

`scripts/emdash-smoke.mjs` fails if a shadow catalogue data source appears
under `src/`, `data/` or `lib/`.

### Sync bookkeeping

Issue #40 asks for each promoted record to be traceable, so both collections
carry the same machine-written fields:

| Field               | Purpose                                                      |
| ------------------- | ------------------------------------------------------------ |
| `source_hunt`       | Which brief and query produced it                            |
| `source_ids`        | The candidate repositories, so a record maps back to evidence |
| `source_revision`   | The commit shas the evidence was read at                     |
| `machine_synced_at` | When the engine last wrote something                          |
| `visibility`        | `draft` | `published` | `hidden` — a person decides         |

On examples the same idea is spelled `source_id`, `source_revision` and
`source_hash`, because an example *is* the evidence and needs a pointer back to
it at file granularity.

### The merge policy

`engine/src/merge.ts` is the policy; it is a pure function with no I/O, tested
on its own in `tests/merge.test.ts`. Last-write-wins is wrong here in two
specific ways, so the policy is decided per field:

| Field class       | Who writes it | On conflict                                       |
| ----------------- | ------------- | ------------------------------------------------- |
| machine factual   | engine        | engine wins                                       |
| editorial         | human         | human wins, and the run reports it as preserved   |
| `visibility`      | human         | human wins; a new machine entry is created `draft` |
| rights regression | engine        | engine wins, even over a human review             |

Two rules exist because they are the ones that would quietly damage the
catalogue:

- **A weaker rights status is written even over a curated entry.** A "cleared"
  claim that is no longer justified is not a formatting difference, and leaving
  it in place is precisely the false certainty this project exists to prevent.
- **`machine_synced_at` only moves when something else moved.** Recording a sync
  on a run that changed nothing makes every re-run a write, which is the
  opposite of idempotent and leaves `hunt:verify` unable to tell a no-op from a
  real change.

`visibility` exists so that a crawl never decides what the public catalogue
shows. Machine entries arrive as drafts at `editorial_rank: 0`, which puts them
last on the wall; promoting one is a person's decision. `npm run doctor` checks
that no draft has leaked onto the public wall.

### Compressing sources into possibilities

The engine's job is not to list repositories. `engine/src/possibility.ts`
groups candidates by *distinctive* terms — terms rare enough in the corpus to
name a treatment rather than the subject of the hunt — and two grouping bugs
from the first version are worth recording because both produced a plausible,
wrong catalogue:

- **Grouping on any two shared terms collapsed everything.** In an audio hunt
  every repository says "sound" and "audio", so 18 sources became one entry that
  described none of them. The fix is a corpus-level frequency threshold: a term
  in more than about a third of the candidates is the subject, not the technique.
- **Transitive grouping chained through intermediaries.** A grouped with B and B
  with C, so A and C landed together having nothing in common. Clustering is
  star-shaped around a seed instead, and a cluster of more than six is split,
  because a group of fifteen is a bucket rather than a treatment.

Both directions of error are real: too coarse is a warehouse, too fine is the
duplicate pile the product exists to avoid. A missed merge leaves two honest
entries; a wrong merge invents a possibility that does not exist, which is the
worse failure.

## Data model

| Collection     | Purpose                                    | Notable fields                              |
| -------------- | ------------------------------------------ | ------------------------------------------- |
| `possibilities` | Catalogue entries                          | `editorial_rank`, `rights_status`, `specimen` |
| `examples`     | Evidence for a possibility                 | `origin`, `source_repo`, `content_hash`, `licence_spdx` |
| `collections`  | Overlapping curated groupings              | `members` → reference to `possibilities`    |
| `pages`        | Editorial content                          | `content` (Portable Text)                   |
| taxonomy `vertical` | Primary browsing axis                  | Applied to `possibilities` and `examples`   |

**Collections overlap by design.** The vertical taxonomy answers "what area is
this"; collections answer "what is it for". A possibility in three collections
is correct, and a partition would mean the second axis had collapsed into the
first.

### Rights semantics

| Status         | Meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `cleared`      | Licence read from the source and recorded; permits the use being made        |
| `attribution`  | Permitted if the recorded attribution is reproduced                         |
| `review`       | Detected but not understood well enough to rely on                           |
| `reference`    | No licence, or reuse not permitted. Kept because it shows a real possibility |

Rights attach to an **example**, never to a possibility. Repository licence
metadata is a hint, not authority.

### Origin semantics

| Origin      | Meaning                                                      |
| ----------- | ------------------------------------------------------------ |
| `upstream`  | Shown directly from discovered material                       |
| `derived`   | A safe preview or showcase produced from discovered material |
| `generated` | Newly generated to demonstrate a known possibility           |

## Runtime

Astro server-rendered on Cloudflare Workers.

- `astro.config.mjs` registers `emdash({ database: d1({ binding: "DB" }),
  storage: r2({ binding: "MEDIA" }) })`.
- `src/worker.ts` is the Worker entry, with EmDash's scheduled handler for
  maintenance.
- `wrangler.jsonc` declares D1 and R2 bindings. `wrangler.local.jsonc` uses a
  local D1 id for `wrangler dev`.
- `.emdash/migrations.json` tracks the applied EmDash migration set.
- `emdash-env.d.ts` is generated and committed — it is the type surface the app
  typechecks against.

**No `getStaticPaths`.** CMS content is dynamic; every route is server-rendered.

### The agent interface

`GET /api/catalogue.json` serves the published catalogue as a versioned JSON
contract, built by `src/lib/catalogue-json.ts` from the same loaders the pages
use, so it cannot drift from what the site shows. Drafts are excluded by the
query rather than by a filter afterwards, which is why the doctor check for
leaked machine drafts and this endpoint agree.

### Content access

All reads go through `src/lib/catalogue.ts`:

- `loadPossibilities()` — wall, ordered by editorial rank then title.
- `loadPossibility(slug)` — single entry.
- `loadExamplesFor(slug)` — examples for one possibility.
- `loadCollections()` / `loadCollection(slug)` — curated groupings.
- `mediaSrc(entry)` — CMS image first, then specimen, then placeholder.

Three EmDash-specific constraints are encoded there because each one fails
silently rather than erroring:

1. **Image fields are objects**, not strings. Resolved in exactly one place.
2. **`entry.id` is the slug; `entry.data.id` is the record id.** Different things.
3. **`reference` fields have no filterable column.** `getEmDashCollection` cannot
   filter or hydrate them; `getEmDashEntry(..., { references })` is required.
   Reading `data.members` yields nothing, with no error.

## What is deliberately absent

- **No GitHub Actions.** Hosted Actions stay disabled; verification is local.
- **No parallel CMS, auth or media library.** EmDash owns all three.
- **No vector database.** Full-text search via EmDash's FTS index is sufficient
  at catalogue scale.
- **No custom agent framework or MCP surface yet.** The agent interface (#58) is
  a documented read-only JSON route plus a small CLI over it — see
  [`docs/AGENT_API.md`](AGENT_API.md) — not a parallel store. An MCP surface, if
  it arrives, should be a thin wrapper over that contract so there is only ever
  one catalogue to be wrong about.

## Related issues

- #38 EmDash as the real application foundation — satisfied by this structure.
- #39 EmDash agent guidance — vendored under `.agents/skills/`.
- #40 deterministic publish/sync — `engine/` plus the contract above. The merge
  policy, the payload invariants and the idempotency guarantee are implemented
  and tested; `npm run hunt:sync` followed by `npm run hunt:verify` is the proof.
- #54 rights correction and takedown — corrections apply to the record, never the
  bytes, which content addressing makes cheap. The merge policy already carries
  the audit trail a takedown needs: the licence quote and hash are kept on the
  example, so a correction can show what the evidence was when it was read.
- #41 resumable crawling — the candidate store is content-addressed and records
  completed search waves, so an interrupted hunt resumes. A cheap metadata
  re-check before any file read is the remaining half.
