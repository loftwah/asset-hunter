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
| rights dispute    | human         | engine writes nothing over it, in either direction |
| exclusion         | human         | the engine does not write the entry at all        |

Four rules exist because they are the ones that would quietly damage the
catalogue:

- **A weaker rights status is written even over a curated entry.** A "cleared"
  claim that is no longer justified is not a formatting difference, and leaving
  it in place is precisely the false certainty this project exists to prevent.
- **`machine_synced_at` only moves when something else moved.** Recording a sync
  on a run that changed nothing makes every re-run a write, which is the
  opposite of idempotent and leaves `hunt:verify` unable to tell a no-op from a
  real change.
- **A rights dispute is a refusal, not a conflict (#54).** The engine has no
  standing to decide whether somebody's objection has been answered, so it does
  not clear `dispute_state`, does not open one, and does not re-enable a
  `downloadable` flag while one is live — whatever the licence evidence says.
- **An exclusion is a refusal too (#54).** `mergeExample` writes *nothing* for
  an excluded resource, and a possibility whose every source is excluded is not
  rewritten at all. A crawl that keeps refreshing an entry whose whole
  provenance has been taken down is re-asserting a claim somebody asked to
  withdraw.

### Rights correction and takedown (#54)

The correction path is four words, defined in
[`VOCABULARY.md`](VOCABULARY.md) and implemented in two modules:
`src/lib/disputes.ts` (pure) and `src/lib/takedown.ts` (Effects).

| Word           | Where it lives                                   | What it does |
| -------------- | ------------------------------------------------ | ------------ |
| **report**     | `reports`, plus `REPORTS` in `src/lib/rating.ts` | A reader's signal. Six reasons are rights matters, and `REPORT_PRIORITY` puts them above every quality signal. |
| **dispute**    | `disputes`, one row per subject                   | The case. `open` / `quarantined` withhold; `corrected` / `dismissed` are terminal and leave the record standing. |
| **quarantine** | `examples.dispute_state`                         | The gate. Read by `useDecision`, so every surface withholds without joining against anything. |
| **exclusion**  | `exclusions`, read by the engine every run       | The durable instruction. Scoped to a repository, a path, a content hash or a catalogue entry. |
| **audit event**| `audit_events`, append-only, never public        | One row per change: field, before, after, reason. |

The reporter path takes the words a person would use, never the catalogue's
classifications, and a rights report withdraws the handover **at the moment it
is filed**: `/api/signal` opens the dispute and writes `dispute_state` in one
request, so a URL handed out before the report stops working without anybody
reloading a page that might have cached the link. Withholding is a gate and
never a deletion — `licence_evidence`, `content_hash`, `attribution` and the
provenance are untouched, because the correction that resolves the dispute is
made from them.

`HandoffBlock` grew a `disputed` value for this, and it is checked **first** in
`useDecision`. That ordering is the argument: "somebody has objected and nobody
has looked yet" is not "the licence forbids this", and a reader told the second
thing has been told something untrue. `/api/payload/<example>` answers `403`
with `x-ah-blocked-by: disputed`; `/api/record/<example>` stays ungated and gains
a `dispute` block, because the evidence is owed to a reader whatever the rights
are.

A dispute on a **possibility** withdraws the entry (`visibility: hidden`) only
for the two reasons that are a person asking not to be surfaced — an infringement
claim or an opt-out. A licence correction against a possibility corrects its
examples instead: a possibility does not need deleting because one of its
examples is wrong, and `recomputePossibility` is what happens instead. It re-floors
`rights_status` across the examples that remain, sets `example_count` and
`distinct_sources` to what is actually there, and re-chooses the representative
from `chooseRepresentative` — reporting the swap, because a wall that silently
changed its picture is unexplainable.

The cockpit queues; `/curate/disputes/<slug>` decides. It writes through the CMS
content API, so every change lands in EmDash's revisions, and each action appends
its own audit row saying which field moved and why — which a CMS field cannot
carry on its own. The queues themselves stay form-free: `tests/curate.test.ts`
asserts that, and it is the right rule, because the cockpit is a list of questions
and `/pages/licensing` is where a reader is told the route exists.

### Re-crawl behaviour

An exclusion is durable because the **engine** consults it, in three places:

1. `hunt` filters search results before a repository becomes a candidate — the
   point at which material is *found*, rather than where it is written;
2. `planRefresh` skips an excluded source before every other rule, including the
   new-source branch, and reports it separately from an ordinary skip;
3. `mergeExample` refuses to write an excluded example, and `mergePossibility`
   refuses an entry whose every source is excluded.

A row that cannot be read as an exclusion (no scope, no match) is dropped rather
than displayed: an exclusion that matches nothing reads in the cockpit like
protection and protects nothing.

`visibility` exists so that a crawl never decides what the public catalogue
shows. Machine entries arrive as drafts at `editorial_rank: 0`, which puts them
last on the wall; promoting one is a person's decision. `npm run doctor` checks
that no draft has leaked onto the public wall.

### Two decisions, not one

`status` and `visibility` are independent, and conflating them is the failure
this section exists to prevent:

- **`status`** is EmDash's *publish state* — has the CMS released this revision?
- **`visibility`** is a *person's judgement* — does this belong in the catalogue?

So an entry can be published **and** hidden, which means EmDash's
`status: "published"` filter is not sufficient on its own. `isPubliclyVisible`
in `src/lib/catalogue.ts` is the single rule, applied by `loadPossibilities`,
`loadPossibility`, `loadCollections` and the search page:

| `visibility`    | Public? | Why |
| --------------- | ------- | --- |
| `published`     | yes     | the intended state |
| absent          | yes     | the field predates it; defaulting absent to hidden would empty the catalogue |
| `draft`         | no      | unreviewed crawl output |
| `hidden`        | no      | a curator said no |
| anything else   | no      | an unrecognised value is not permission, same direction as `flagValue` |

A withdrawn entry is absent from the wall, from search, from `/verticals`,
from collection membership, from the RSS feed and from
`/api/catalogue.json` — and its drill-in 404s rather than rendering, so
guessing a slug does not reach it. `tests/visibility.test.ts` hides a real
seeded entry and asserts each of those, then restores it.

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
| `examples`     | Evidence for a possibility                 | `origin`, `source_repo`, `content_hash`, `licence_spdx`, `dispute_state` |
| `collections`  | Overlapping curated groupings              | `members` → reference to `possibilities`    |
| `pages`        | Editorial content                          | `content` (Portable Text)                   |
| `ratings`, `reports` | One reader's signals                  | `subject_type`, `subject_slug`, `reason`    |
| `disputes`, `exclusions`, `audit_events` | Rights correction (#54) | `state`, `scope` + `match`, `field` + `before` + `after` |
| taxonomy `vertical` | Primary browsing axis                  | Applied to `possibilities` and `examples`   |

The last row is EmDash content like everything else, and that is the point: a
creator's takedown has to be answerable by the people who hold the catalogue, not
by an engineer reconstructing what happened from a log somewhere else. There is
no side table and no parallel store.

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

### Rights → use state

A rights status is a fact about a licence. A **use state** is the answer to "what
may I do with this file", and it is the word the public surfaces lead with.
`src/lib/asset-use.ts` is the only place the mapping is made, so the wall, the
drill-in, `/use/<slug>` and the API cannot answer differently.

| Rights status | Use state    | A payload is handed over when…                                  |
| ------------- | ------------ | --------------------------------------------------------------- |
| `cleared`     | reusable     | a payload is retained **and** a SHA-256 is recorded against it     |
| `attribution` | reusable with attribution | as above, **and** a recorded credit exists to reproduce |
| `review`      | review required | never — nothing here has been cleared on the reader's behalf   |
| `reference`   | reference only | never — this is the whole of its permission                     |
| anything else | reference only | never — an unrecognised status is not evidence of permission    |

**No download control exists without all of those conditions, and the payload
route re-derives the same decision from the record rather than trusting the
page.** A hand-typed URL gets the answer a hidden control would have hidden.
A fifth condition sits in front of all four and is not a rights status at all:
**no rights dispute is open** on the example (#54). It is checked first, and it
withholds whatever the licence evidence says — see the section above.
The refusal statuses are chosen to say different things: `403` the licence does
not permit it **or a rights concern is open**, `409` it permits but there is
nothing verified to hand over, `503` the bytes are there and do not match the
digest.

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

### Asset use and handoff

Two data routes complete the asset half of the catalogue. They are read-only,
they read the same EmDash records the pages read, and they are the only paths
that can hand anything over.

| Route                      | What it serves                                              | Gate |
| -------------------------- | ----------------------------------------------------------- | ---- |
| `GET /api/record/<example>` | The source, licence, provenance and credit for one example, as JSON (`asset-hunter.record/1`) | None. The evidence is owed to a reader whatever the rights are — including, especially, when the rights forbid reuse, and including while a dispute is open |
| `GET /api/payload/<example>` | The retained original, unmodified, with `X-AH-SHA256`        | The use state, then a recorded credit, then a retained payload, then a recorded digest — all four — and no open rights dispute ahead of them |

The payload route hashes what it is about to send and compares it with the
record's `content_hash` before a single byte goes out; a mismatch serves
nothing. No `Content-Type` is invented: `media_kind` is a catalogue label, not
a MIME type, so the response is `application/octet-stream` with an attachment
disposition.

`/use/<slug>` is the human surface for the same records: the selection, its use
states, its obligations and its credit. It is the drill-in's other half rather
than a parallel product, and it reads `loadPossibility` + `loadExamplesFor` so
the two cannot disagree about what exists.

### Content access

All reads go through `src/lib/catalogue.ts`, and all of them are **Effects**:

- `loadPossibilities()` — wall, ordered by editorial rank then title.
- `loadPossibility(slug)` — single entry.
- `loadExamplesFor(slug)` — examples for one possibility.
- `loadExample(id)` — one example by its own id, for the asset-use routes.
- `loadCollections()` / `loadCollection(slug)` — curated groupings.
- `mediaSrc(entry)` — CMS image first, then specimen, then placeholder. **Pure.**

`mediaSrc` and the domain model stay plain functions; the reads are Effects
because they are I/O with failure modes. The rule and the reasoning are in
[`EFFECT_STYLE.md`](EFFECT_STYLE.md); in one line: effectful code is Effect 4 by
default, deterministic code is plain TypeScript.

Four EmDash-specific constraints are encoded there because each one fails
silently rather than erroring:

1. **Image fields are objects**, not strings. Resolved in exactly one place.
2. **`entry.id` is the slug; `entry.data.id` is the record id.** Different things.
3. **`reference` fields have no filterable column.** `getEmDashCollection` cannot
   filter or hydrate them; `getEmDashEntry(..., { references })` is required.
   Reading `data.members` yields nothing, with no error.
4. **A failed query resolves, it does not reject.** `getEmDashCollection` returns
   `entries: []` with an `error` field set when the database is unhappy, so a
   handler that destructures `entries` renders a confident, empty catalogue. The
   `EmDashContent` service treats that field as a typed failure instead — the one
   behaviour this project refuses is showing something other than what EmDash is
   serving.

### Effect boundaries

```text
src/lib/effect/          services, schemas, config, cancellation  (the app)
engine/src/runtime/       the same shape, separately              (the engine)
```

The two roots are separate on purpose: this document's engine/app boundary is a
constraint, and a shared runner would make it a suggestion. Within each, the
composition root is the only place a `run*` function is called, and a reader is
decoded from Schema before it is projected onto a domain model.

The engine is read-only against GitHub and read/write against EmDash, and it does
not import app code — the one shape it duplicates on purpose is the EmDash entry
response, which is a documented HTTP contract rather than a shared module.

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
- #54 rights correction and takedown — implemented. `src/lib/disputes.ts` holds the
  decisions and `src/lib/takedown.ts` the Effects; `disputes`, `exclusions` and
  `audit_events` are EmDash collections, so the workflow is answerable without an
  engineer. A rights report withdraws the handover on filing
  (`examples.dispute_state`, read by `useDecision`), an exclusion is consulted by
  the engine in `hunt`, `planRefresh` and the merge policy, one example's removal
  recomputes the possibility rather than deleting it, and every change appends an
  audit event with the field, the value before, the value after and the reason.
- #42 safe public asset-use and attribution — `src/lib/asset-use.ts` decides, the
  two API routes gate, and `/use/<slug>` shows. A payload is only offered when
  a licence permits it, a credit is recorded, the original is retained and a
  digest exists; the route then verifies the digest before serving.
- #41 resumable crawling — the candidate store is content-addressed and records
  completed search waves, so an interrupted hunt resumes. A cheap metadata
  re-check before any file read is the remaining half.
