# The agent interface

An agent should not have to scrape HTML to ask the catalogue a question. So the
catalogue is also a documented JSON contract, served read-only from the same
EmDash reads the site uses.

```bash
node scripts/catalogue.mjs summary
node scripts/catalogue.mjs search "loop without a seam"
node scripts/catalogue.mjs get seamless-loop
node scripts/catalogue.mjs rights --status reference
node scripts/catalogue.mjs verticals
node scripts/catalogue.mjs handoff density-gradient,diegetic-damage --check
```

Every command works offline against a saved file, so a change can be reviewed as
a diff rather than as a claim:

```bash
node scripts/catalogue.mjs fetch --out /tmp/catalogue.json
git diff --no-index /tmp/before.json /tmp/after.json
node scripts/catalogue.mjs summary --file /tmp/catalogue.json
```

There are two endpoints, and there are two because there are two questions.
`/api/catalogue.json` answers *what does this catalogue know*. `/api/handoff.json`
answers *what did you decide, and what may you do with it*. Both are built from
the same loaders and the same rights decision, so they cannot describe different
catalogues — but a brief that answered the first question would be a README of
the CMS rather than a way to start work.

## The catalogue

```
GET /api/catalogue.json
```

| Property | Value |
| -------- | ----- |
| Auth | none. Everything it serves is already public HTML |
| Drafts | never. The collection queries filter on published status |
| Cache | `max-age=60` with a weak ETag; `?fresh=1` bypasses it |
| Type | `asset-hunter.catalogue/1` in `schema`, repeated in the `x-catalogue-schema` header |

`schema` is the version. A field that disappears is a breaking change; a new
field is not. Consumers read what the version says is there.

### Shape

```
schema      string                      "asset-hunter.catalogue/1"
site        string                      canonical site
generated   string                      ISO 8601
fingerprint string                      content digest, 8 hex chars
openReports number                      reports with no resolution yet
counts      {
  possibilities  number
  examples       number
  collections    number
  verticals      number
  rights         { <status>: number }
}
possibilities [ Possibility ]
collections   [ { id, title, tagline, members[] } ]
```

### Possibility

```
id, title, tagline, summary, technique
vertical, verticalLabel
mediaKind, media                    raw kind and its human label
representativeOrigin, representativeOriginLabel
rightsStatus, rightsLabel, rightsNote
novelty, coverage                   number | null — null means not measured
exampleCount, distinctSources       distinctSources counts licences actually read
communityRating { average | null, count }
communityRatingSummary              a sentence that cannot be mistaken for quality
featured                            boolean
examples[]                          see below
```

### Example

```
id, title
origin, originMeaning
mediaKind, media
rightsStatus, rightsLabel, rightsNote
sourceUrl, sourceRepo, sourceRef, sourcePath
licenceSpdx, licenceEvidence, attribution
contentHash
downloadable                        true only when the evidence permits redistribution
```

### The three things not to flatten

A machine-readable catalogue is trusted, so the distinctions the HTML makes
carefully survive into it:

- **`null` is not `0`.** `novelty: null` means nothing was measured. A number
  there means it was. The same applies to `distinctSources`, where `0` is a real
  and common answer: nobody has read a licence yet.
- **A possibility is not permission.** `rightsStatus` on a possibility is the
  *weakest* status across its examples. `rightsStatus` on an example is what
  that example's evidence supports. Use the example's, not the possibility's.
- **`communityRating` is an opinion.** It is separate from `novelty`/`coverage`
  (machine) and `featured`/`editorial_rank` (a curator). Do not average them into
  one "score"; a blend cannot be explained to anyone who asks what it means.

### How the payload relates to the CMS

Built by `src/lib/catalogue-json.ts` from the same loaders the pages use, so it
cannot drift from what the site shows. Drafts are excluded by the query, which
is why `npm run doctor`'s draft-leak check and this endpoint agree: a machine
entry that a crawl created lands here as nothing at all until a person publishes
it.

Media is referenced, not inlined. Plate and image URLs point at R2 or the
repository's `public/specimens/`, and `contentHash` on an example is the sha256
of the bytes the engine actually read — so an agent can tell whether the thing it
fetched is the thing that was classified.

## The handoff

```
GET /api/handoff.json
```

| Property | Value |
| -------- | ----- |
| Auth | none. It resolves slugs through the same published-only queries |
| Drafts | never. An unknown or withdrawn slug lands in `board.unknown`, not in the document |
| Cache | `max-age=60` with a weak ETag; `private` + `Vary: Cookie` when it came from a board; `?fresh=1` bypasses it |
| Type | `asset-hunter.handoff/1` in `schema`, repeated in `x-ah-handoff-schema`, plus `x-ah-handoff-format` and `x-ah-handoff-source` |

### Asking for one

Either name the possibilities, or ask for one of the reader's boards:

| Parameter | Meaning |
| --------- | ------- |
| `slugs=a,b` | The possibilities, comma- or whitespace-separated |
| `board=shortlist` | A board from the request's own cookies. Slugs win if both are present |
| `chose=a,b` | The ones the reader is going with |
| `rejected=a,b` | The ones they ruled out |
| `goal` `surface` `platform` `constraints` `acceptance` | Free text, recorded as written |
| `format=md` | The same document, rendered as Markdown |
| `fresh=1` | Bypass the short cache |

With neither `slugs` nor a board, the endpoint answers **400** with the two
addresses that would work, rather than building a confident document about the
empty selection. That is the same rule `useStateFor` follows: absence is not
permission, and here it is not a selection either.

A board lives in a cookie, so `board=` only works from the browser that has it.
The CLI takes `--slugs` for that reason.

### Shape

```
schema      string                    "asset-hunter.handoff/1"
site        string                    canonical site
generated   string                    ISO 8601, from Effect's Clock
fingerprint string                    content digest, 8 hex chars
contract    { json, markdown, catalogue: { schema, url } }
board       { source, name, requested, resolved, unknown[], overflow[] }
decision    { recorded, chosen | null, rejected[] }
objective   { goal, surface, platform, constraints, acceptance, unrecorded[] }
achieve     [ string ]                the prose a reader reads first
doNotCopy   [ { subject, reason } ]   worst first
possibilities [ HandoffPossibility ]
rights      { examples, byState, payloads, summary }
credits     string | null
```

`fingerprint` covers the references and the decision. It deliberately excludes
`generated` and `contract`, because both change without the content changing —
that is the one thing a content fingerprint is for.

### Possibility

```
id, url, useUrl, title, tagline, summary
technique, buildNotes, recipe        what to achieve, how, and how to recreate it
decision                             chosen | candidate | rejected
vertical, verticalLabel, mediaKind, media, preview
representativeOrigin, representativeOriginMeaning
rightsStatus, rightsLabel, rightsNote
examplesUseState                     the weakest example, computed
examples[]                           see below
```

### Example

```
id, title
origin, originMeaning
preview                              absolute, and null when there is no plate
rightsStatus, rightsLabel, rightsNote
useState, useStateLabel, useStateMeaning, obligation
handoff, blockedBy                   what this deployment can hand over
provenance { sourceUrl, sourceRepo, sourceRef, sourcePath, contentHash }
licence { spdx, evidence }
attribution
record                               absolute /api/record/<example>
```

### What it deliberately does not carry

No community rating, no novelty or coverage, no editorial rank, no `featured`, no
collection membership, no `exampleCount`. Those answer "how does the catalogue
rank things", and none of them helps somebody build the thing. An implementation
handoff that ended with a dump of catalogue metadata would be the CMS
documentation wearing a different hat.

### The five things not to flatten here either

- **Possibility is not permission, and it is per example.** `useState` is
  derived from that example's recorded status through the same
  `useDecision` in `src/lib/asset-use.ts` that `/use/<slug>` and
  `/api/payload/<example>` use. A handoff that got this wrong would be worse than
  no handoff, because it would look like a clearance.
- **The weakest example decides the entry, and it is computed.** `rightsStatus`
  is the *stored* entry status; `examplesUseState` is derived from the examples.
  A stale or wrongly-set entry status therefore cannot make a board of
  reference-only material read as cleared.
- **`null` is not `0`, and not `[]`.** A field the reader never recorded is
  `null` and is named in `objective.unrecorded`. `decision.chosen` is `null` when
  nothing was marked, not an empty array: "no option was chosen" and "the choice
  was recorded as empty" are different facts and only one of them is reachable.
- **Nothing is invented.** No goal, no platform, no acceptance criteria are
  written for a reader who did not supply them. The catalogue knows what a
  possibility demonstrates; it does not know what you are building, and it says so
  rather than paraphrasing a tagline.
- **A slug that resolves to nothing is reported.** `board.unknown` and
  `board.overflow` exist so that a handoff which quietly omitted one of three
  requested possibilities can be told apart from one where the reader chose two.

### The Markdown rendering

`?format=md` is the same fields rendered as Markdown, not a second document. It
carries no field the JSON does not and drops none that carries rights, so a
handoff pasted into an issue body, a `DESIGN.md` or the top of a prompt cannot
lose the obligations. Blank fields are printed under **Not recorded** rather than
omitted, because an omission reads as "there was nothing to say" and the truth is
"nobody said".

### The client

```bash
node scripts/catalogue.mjs handoff density-gradient,diegetic-damage \
  --chose density-gradient \
  --goal "A bento dashboard where emphasis steps down in three tiers" \
  --platform "1440x900 and 390x844" \
  --acceptance "One capture per tier at both widths" \
  --markdown --out handoff.md

node scripts/catalogue.mjs handoff density-gradient,diegetic-damage --check
```

`--check` prints the rights report in words, one line per example, and is the
thing to read before sending anything to an agent. The CLI holds no copy of the
document: the Markdown is the server's rendering, because a second renderer in the
client is a second answer to "what may I do with this".

### GitHub handoff

The handoff is designed to *be* the handoff artefact: it records the chosen
possibility ids, their absolute catalogue URLs, the rights status of every example
and a provenance block saying which contract and fingerprint it came from, and its
Markdown rendering is an issue body as written. Creating the issue is
`gh issue create --body-file handoff.md` on the machine where the token already
lives.

The public app deliberately does not do that itself. Doing it would mean a GitHub
token in the Worker, shared by every signed-in reader, and the issue's own
acceptance criterion is that the handoff is **explicit and user-directed**. The
token belongs to the operator, so the step belongs beside it. This is the same
reason the board is a cookie rather than a server record.

## Not here yet

An MCP surface (#58 mentions it as a later step). When it arrives it should be a
thin wrapper over these contracts and nothing else, so there is one catalogue to
be wrong about.