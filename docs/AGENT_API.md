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
```

Every command works offline against a saved file, so a change can be reviewed as
a diff rather than as a claim:

```bash
node scripts/catalogue.mjs fetch --out /tmp/catalogue.json
git diff --no-index /tmp/before.json /tmp/after.json
node scripts/catalogue.mjs summary --file /tmp/catalogue.json
```

## The endpoint

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

## The three things not to flatten

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

## How the payload relates to the CMS

Built by `src/lib/catalogue-json.ts` from the same loaders the pages use, so it
cannot drift from what the site shows. Drafts are excluded by the query, which
is why `npm run doctor`'s draft-leak check and this endpoint agree: a machine
entry that a crawl created lands here as nothing at all until a person publishes
it.

Media is referenced, not inlined. Plate and image URLs point at R2 or the
repository's `public/specimens/`, and `contentHash` on an example is the sha256
of the bytes the engine actually read — so an agent can tell whether the thing it
fetched is the thing that was classified.

## Not here yet

An MCP surface (#58 mentions it as a later step). When it arrives it should be a
thin wrapper over this contract and nothing else, so there is one catalogue to
be wrong about.