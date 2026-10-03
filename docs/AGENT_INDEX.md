# The agent index

What to read, what it decides, and which one wins when they disagree.

This repository has accumulated a lot of durable documentation, which is the
good kind of problem. The risk it creates is an agent finding four plausible
answers to one question and picking the wrong one — or, worse, picking the
right one and not knowing that a fourth document said something subtly
different. So: one index, one precedence rule, and an explicit statement of
which files carry no authority at all.

Read [`AGENTS.md`](../AGENTS.md) first. It is the entry point and it is
sufficient to start work.

## Precedence

When two canonical documents disagree, the earlier row wins.

| # | Authority | Owns |
| - | --------- | ---- |
| 1 | **MP's explicit instruction** | Product direction, and the current task. Supersedes everything below, within the safety and destruction limits in [`docs/AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §1 |
| 2 | [`AGENTS.md`](../AGENTS.md) | The repository invariants: provenance, licensing, untrusted input, EmDash, design authority, Effect 4, no paid Actions |
| 3 | Live GitHub issues and PRs | Requirements, acceptance, dependencies, current status |
| 4 | [`DESIGN.md`](../DESIGN.md) | Visual and interaction authority for the public product |
| 5 | [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) | The system boundary, the content model, the engine↔app publish contract |
| 6 | [`docs/VOCABULARY.md`](VOCABULARY.md) | What every word in the product means |
| 7 | [`docs/AGENT_CONTRACT.md`](AGENT_CONTRACT.md) | MP's role, the agent's authority, initiative, stop conditions |
| 8 | [`docs/AGENT_POLICY.md`](AGENT_POLICY.md) | How an autonomous run executes, and what counts as evidence |
| 9 | [`docs/DEPLOY.md`](DEPLOY.md) | Deployment procedure and production configuration |
| 10 | [`docs/EFFECT_STYLE.md`](EFFECT_STYLE.md) | How Effect is written in this repository |

Two rules sit on top of the table, because the table cannot express them:

- **GitHub outranks the roadmap, and the roadmap outranks nothing.**
  [`docs/ROADMAP.md`](ROADMAP.md) records delivery *order* and why. Status is
  read from GitHub. A roadmap that claimed to be current would rot within a day
  and then be believed.
- **An issue does not outrank an invariant.** #82 can ask for an agent
  contract; it cannot ask for one that waives provenance. If a requirement and a
  boundary conflict, that is a question for MP, not a licence.

## The agent-facing documents

| Document | Owns | Load it when |
| -------- | ---- | ------------ |
| [`AGENTS.md`](../AGENTS.md) | Repository invariants; the entry point | Always, first |
| [`docs/AGENT_CONTRACT.md`](AGENT_CONTRACT.md) | Who MP is; the agent's authority and initiative; stop conditions | Before deciding whether something needs MP; whenever the answer is unclear |
| [`docs/AGENT_INDEX.md`](AGENT_INDEX.md) | This routing table | When you need to know which document decides something |
| [`docs/AGENT_POLICY.md`](AGENT_POLICY.md) | Autonomous execution: the loop, parallelism, evidence, integration, headless operation, stop conditions | Under autonomous mode; whenever completion is being argued |
| [`docs/AUTONOMOUS_PROMPT.md`](AUTONOMOUS_PROMPT.md) | The exact kickoff text | Only to activate a whole-backlog run — it is an input to be sent, not read for its content |
| [`docs/AGENT_API.md`](AGENT_API.md) | The JSON contracts the product serves (`/api/catalogue.json`, `/api/handoff.json`) and the CLI over them | When building or consuming a machine-readable contract, or handing work to another agent |

## The engineering authorities

| Document | Owns | Load it when |
| -------- | ---- | ------------ |
| [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) | Engine↔app boundary, collections and schema, the publish payload, the sync path, directory layout | Any change that crosses the boundary, touches the schema, or writes to EmDash |
| [`docs/VOCABULARY.md`](VOCABULARY.md) | Every product term, in one place, chosen once | Before naming anything a reader sees. Implementation is `src/lib/vocabulary.ts`; the document is the rule |
| [`docs/EFFECT_STYLE.md`](EFFECT_STYLE.md) | The Effect 4 house style, derived from the code | Before writing a loader, a service, a schema, or a config value |
| [`docs/TESTING.md`](TESTING.md) | How tests run here and why they are serial | Before adding or reorganising tests |
| [`docs/PERFORMANCE.md`](PERFORMANCE.md) + [`performance-budgets.json`](performance-budgets.json) | Measured budgets and the gate | Before optimising, and whenever a page gets heavier |
| [`docs/DEPLOY.md`](DEPLOY.md) | Deployment, D1/R2 bindings, freshness verification, rollback | Before anything that touches production |

## The product authorities

| Document | Owns | Load it when |
| -------- | ---- | ------------ |
| [`DESIGN.md`](../DESIGN.md) | Visual language, tokens, spacing, motion, component rules | Any UI, brand or product-media change. Not negotiable style preference — it is the spec |
| [`docs/UNSLOP.md`](UNSLOP.md) | What the product must not look like | Whenever a design proposal is being generated; read it *before* proposing |
| [`docs/BRAND.md`](BRAND.md) | The mark, where it lives in source, how assets are produced, what was and was not decided | Touching the identity, the favicon, OG images, or share cards |
| [`docs/BRAND-DIRECTIONS.md`](BRAND-DIRECTIONS.md) | The protocol for running an identity comparison | Considering an identity change |
| [`docs/VISUAL_QA.md`](VISUAL_QA.md) | The visual harness: routes, viewports, gates, and what it does not cover | Before claiming a UI change is verified |
| [`README.md`](../README.md) | Human orientation: what the product is, how to run it | Once, at the start, for context |

## Reference and history

These carry no authority. They are kept because a decision or a failure is only
worth something if the reasoning survives it.

| Document | Status | Why it is still here |
| -------- | ------ | -------------------- |
| [`docs/SECURITY.md`](SECURITY.md) | **Record of a completed review (#53)** | Every finding carries the command that demonstrated it, the fix and the test. Read it to understand *why* the defences are shaped as they are. Where it describes behaviour that must not regress, that behaviour is now asserted in `tests/security.test.ts` — the test is the authority, this is the argument |
| [`docs/ROADMAP.md`](ROADMAP.md) | **Live for order and rationale only** | Status is GitHub. Do not treat a band as a commitment |
| [`docs/performance-budgets.json`](performance-budgets.json) | **Machine-owned** | Regenerated by `npm run check:perf:write`. Edit `docs/PERFORMANCE.md`'s reasoning, never the numbers by hand |
| `seed/atlas.json` | **Machine-owned** | The seed source of truth, composed into `seed/seed.json` by `scripts/build-seed.mjs`. Edit the atlas, never the seed |
| `screenshots/` | **Generated, gitignored** | `npm run check:visual` output |

Nothing in this repository is a superseded prompt left in place as plausible
current instruction. If one appears, that is a bug — `npm run doctor` reports it
(see `Agent contract` in its output).

## Skills

| Skill | Use for |
| ----- | ------- |
| `.agents/skills/building-emdash-site` | Schema, seeds, queries, Portable Text rendering, deployment config |
| `.agents/skills/emdash-cli` | Inspecting and managing content, schema, media and search |
| `.agents/skills/creating-plugins` | Plugin hooks, routes, storage, admin UI, blocks |

Vendored from `emdash-cms/emdash`, pinned by a revision per directory — see
[`.agents/skills/README.md`](../.agents/skills/README.md). Refresh with
`npm run skills:sync`.

**Load the relevant skill before editing code** whenever the work touches the
public catalogue, CMS schema or content, admin, media, auth, ratings/curation,
site navigation, or EmDash deployment. Installing the package is not the same as
using it correctly: `npm run doctor` distinguishes installed from integrated,
and `npm run smoke` proves the public read path is actually served by EmDash.

There is also a browser-driven design review capability available
(Impeccable). It is a review instrument, not an authority: it does not replace
`DESIGN.md`, an issue's acceptance criteria, or an independent look at the
rendered result.

## GitHub and durable documentation

They answer different questions, and the difference is not cosmetic.

| | GitHub issues and PRs | Documents in this repository |
| - | --------------------- | --------------------------- |
| Answers | *What is being asked for, right now, and is it done?* | *What is true regardless of what is being asked?* |
| Lifespan | A ticket closes; the work may recur | Long-lived |
| Holds | Requirements, acceptance criteria, dependencies, owner holds, the review record | Invariants, vocabulary, architecture, design, procedure |
| Authority | Live, and re-read during a run | Stable; changed deliberately, in a commit |

Two consequences worth stating, because each has been got wrong:

- **An issue is not permission to break an invariant.** Authority flows from MP
  and the repository boundaries, never from a ticket body.
- **A closed issue does not retire a rule.** When an issue closes by landing a
  boundary, that boundary moves into `AGENTS.md`, the tests, or the relevant
  document — not into the issue, where the next agent will not look.

Status is never inferred from a document. `gh issue list` is the answer to "what
is open", and `git log` is the answer to "what shipped".