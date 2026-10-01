# Roadmap

Delivery order, so implementation does not drift. The bands are about *when*,
not about importance — #22 is more important than #14 and ships later.

Status is read from GitHub, which is the authority. This file records the shape
of the work and why the order is what it is.

## Where the product is going

**#21 is the north star: an "Envato for possibilities" discovery engine.** A
possibility is a distinct idea, technique, pattern or mechanic that can be
recreated. An example is the evidence that demonstrates it — an upstream asset,
a safe preview derived from one, or a newly generated demonstration. A
collection is a grouping that overlaps rather than partitions.

The product exists to compress inventory into option-space coverage: five
thousand logo files may demonstrate forty materially different treatments, and
the catalogue should surface forty with their provenance intact, not five
thousand.

**None of that changes what P0 is.** The first shippable release proves the
complete *local* hunt loop. Possibility extraction is the layer above it.

## P0 — the core loop, local only

The first Asset Hunter a person can actually use, end to end, on their own
machine. Nothing here needs a public website, a scheduled job or an account.

| #  | Delivered as                                              |
| -- | --------------------------------------------------------- |
| 1  | Repository contract, AGENTS.md, boundary rules            |
| 2  | Environment doctor and end-to-end smoke test               |
| 3  | Hunt brief: intent, verticals, queries, budgets, policy   |
| 4  | GitHub discovery, candidate store, selective retrieval    |
| 5  | Licence evidence, provenance, non-destructive classification |
| 6  | Image, logo, sprite, GIF and video handlers               |
| 7  | Audio and font handlers with generated showcases          |
| 8  | 3D, shader, code and archive handlers                     |
| 9  | Generated descriptions, previews and a local gallery      |
| 10 | Portable output pack, manifest, attribution and verifier  |
| 11 | Fighter as the first full acceptance hunt                 |
| 12 | This document                                              |

**P0 is done when:** `npm run doctor` is green, a hunt runs from a brief, every
retained item has a licence that was read or a stated absence of one, and the
output pack verifies against its own manifest.

P0 does **not** require hosted infrastructure, a public website, additional
source providers, MCP, automated target-project integration, or the possibility
engine.

## P1 — a first-class local experience

- #13 Codex Desktop and MiniMax Code as first-class operator environments
- #15 A local brief/form UI for hunt creation
- #18 Bootstrap and guided setup for macOS developer environments

## P2 — brand, EmDash foundation and public shell

- #38 EmDash as the actual Cloudflare/Astro application foundation
- #39 EmDash agent guidance, vendored and enforced
- #16 Brand identity: mark, favicons, palette, semantic theme tokens
- #44 `DESIGN.md` plus the UNSLOP anti-pattern rules
- #60 Product vocabulary, information architecture and copy voice
- #17 EmDash-powered site shell with SEO and generated OG imagery
- #48 Reproducible brand, OG and share-card generation from the real UI
- #45 Deterministic visual lab with every media type and UI state
- #47 Deterministic visual QA, screenshot matrix, adversarial review
- #46 Responsive, touch, keyboard and accessibility hardening

## P3 — the possibility engine

Everything below serves the north star in #21.

### Model and extraction

- #22 Possibility, example and collection graph model
- #23 Possibility extraction from discovered resources
- #24 Clustering, representative examples, option-space coverage
- #33 Vertical atlas and a coverage map
- #34 Generated canonical examples where a possibility has no clear one

### Browsing

- #25 Media-first visual wall with drill-in metadata
- #26 Safe live-demo playgrounds for code, shaders, interaction, game mechanics
- #27 Novelty, coverage-gap and serendipity discovery modes
- #29 Project-lens previews against a real project
- #31 SFX discovery acceptance hunt: the "needle in the sea" problem
- #32 Intent-first problem-to-possibility search
- #35 Local asset and archive ingestion

### Choosing and judging

- #36 Shortlist and compare boards — done, cookie-backed
- #37 User ratings, editorial ratings and admin curation controls
- #51 Agent-ready implementation briefs from chosen possibilities
- #52 EmDash admin curation cockpit for quality and exception queues

### Keeping it true

- #5 Licence evidence and provenance — done in the engine
- #40 Deterministic hunt-to-catalogue publish/sync — done
- #41 Resumable incremental crawling and catalogue refresh
- #42 Safe asset-use, download and attribution flow
- #53 Security, abuse and hostile-content review
- #54 Rights correction, source-owner opt-out and takedown
- #55 Privacy-aware product analytics for discovery quality
- #56 Reference-image search: identify this, show similar and adjacent
- #57 Model-agnostic multimodal analysis contracts and a content-addressed cache
- #58 Agent-native catalogue interface via CLI/JSON, later MCP
- #59 Dogfood Asset Hunter on its own portfolio

### Operating it

- #49 Performance and media-delivery budgets for the visual wall
- #50 Production release evidence, exact-SHA verification and restore drills
- #30 Pluggable source/provider expansion with rights metadata
- #28 Recreation recipes and prompt scaffolds, on request only

## What is deliberately not planned yet

- **A hosted schedule for the crawler.** #41 says scheduling may invoke the same
  deterministic command; a second implementation would be worse than none.
- **Paid GitHub Actions.** Hosted checks stay disabled. Verification is local and
  reproducible, and a $0 bill is not the same as a free action that silently
  becomes a paid one.
- **A second CMS, auth system or media library.** EmDash owns all three.
- **A vector database.** EmDash's full-text index is sufficient at catalogue
  scale, and a second index is a second thing that can be wrong.

## Related

- [Architecture](ARCHITECTURE.md) — the boundary between the app and the engine
- [Agent policy](AGENT_POLICY.md) — how work is executed here
- [Autonomous prompt](AUTONOMOUS_PROMPT.md) — the canonical kickoff