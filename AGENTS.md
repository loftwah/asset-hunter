# Asset Hunter agent contract

## Autonomous mode

The owner activates whole-backlog autonomous mode with the exact prompt in [docs/AUTONOMOUS_PROMPT.md](docs/AUTONOMOUS_PROMPT.md).

When activated, follow [docs/AGENT_POLICY.md](docs/AGENT_POLICY.md) and work the complete current GitHub issue/PR set until no executable work remains or the runtime stops you. Do not reinterpret the kickoff as a request for a plan, selected batch, or progress report.

GitHub issues and PRs are the live backlog. Re-check them during the run so new/reopened work joins the active set.

## Product mission

Asset Hunter discovers useful assets/resources and the distinct **possibilities** they demonstrate, preserves provenance/licensing, classifies and previews them, compresses duplicate inventory into representative option-space coverage, and exposes the result through a media-first catalogue.

The product must preserve both halves:
- reusable asset library where rights permit;
- “Envato for possibilities” discovery even when an example is reference-only.

## Non-negotiable boundaries

- Target project repositories are inputs/context unless an issue explicitly authorises modifying them.
- GitHub is the only specialised discovery provider required for the current core. Do not silently expand crawling to unrelated services.
- Downloaded repositories/assets are untrusted data. Do not execute upstream install/build scripts merely to inspect assets.
- Preserve immutable originals, hashes, provenance and exact licence evidence. Unknown/unlicensed/reference material is never presented as cleared for use.
- Generated/derived examples must be distinguishable from upstream originals.
- Do not weaken tests or acceptance criteria to make an issue pass.
- Do not introduce paid GitHub Actions usage. Hosted Actions must remain disabled unless their $0 cost is explicitly demonstrated and justified; prefer local/repository qualification and Cloudflare-native deployment tooling.
- Preserve unrelated user work and secrets.

## EmDash / public application invariant

For work touching the public catalogue, CMS schema/content, admin, media, auth, ratings/curation, site navigation, or deployment:

- use the actual EmDash/Astro application required by #38;
- load and follow the relevant EmDash agent guidance required by #39;
- do not build a parallel CMS/admin/auth/media stack;
- do not create a separate “real app” with EmDash parked beside it;
- use EmDash authentication/RBAC and supported extension points where appropriate;
- use the authorised Cloudflare Workers + D1 + R2 path for the public app unless a later owner-approved issue changes it.

A dependency being installed is not proof that the product uses it. Verify the real public read/edit path.

## Design / product-quality invariant

For work touching public UI, branding, visual composition, responsive behaviour, interaction states or marketing media:

- treat `DESIGN.md` and the repository's UNSLOP guidance from #44 as authoritative once present;
- load the relevant visual/design-review capability (including Impeccable where available);
- use the deterministic visual lab from #45 and headless visual evidence from #47 rather than relying on agent taste alone;
- verify mobile/touch/keyboard/accessibility expectations from #46;
- prefer real product captures and canonical examples over fake/mock marketing UI;
- do not introduce generic SaaS card soup, arbitrary gradients, excessive pills/rounded containers or decorative motion without a concrete product reason.

## Execution expectations

- Inspect the complete issue, source, existing PRs and dependencies before editing.
- Use maximum useful parallelism; serialise only real conflicts/dependencies.
- Continue from investigation into implementation, focused tests, independent review, repair, merge, delivery where applicable, and real verification.
- Reuse existing branches/PRs/work rather than duplicating them.
- Keep machine quality, community ratings and editorial/admin judgement separate.
- Do not manufacture owner/human review gates unless the owner explicitly created one.

## Cleanup and final accounting

Before declaring the autonomous run exhausted:

- clean up exact task-owned temporary worktrees, processes, ports, generated scratch data and disposable downloads;
- do not broadly kill processes, delete caches, reset unrelated changes or remove useful evidence;
- reconcile completed/blocked work back to GitHub;
- account for every current open issue and PR, including merged-but-undelivered obligations;
- leave bounded blockers with exact evidence and an explicit unblock condition;
- continue any independent executable work instead of stopping on one blocked lane.

Stop only on owner instruction, a real runtime/provider limit, a global inability to make useful progress, or verified exhaustion of executable work.

## EmDash skills (vendored)

Official EmDash agent guidance is vendored under `.agents/skills/`, pinned to a
known upstream revision:

| Skill                   | Use for                                                  |
| ----------------------- | -------------------------------------------------------- |
| `building-emdash-site`  | Schema, seeds, queries, rendering, deployment config     |
| `emdash-cli`            | Inspecting and managing content, schema, media, search   |
| `creating-plugins`      | Plugin hooks, routes, storage, admin UI, blocks         |

Each directory carries an `UPSTREAM_REVISION` file. To refresh:

```bash
npm run skills:sync     # re-fetches from emdash-cms/emdash and records the revision
```

**If a task touches the public catalogue, CMS schema or content, admin, media,
auth, ratings/curation, site navigation, or EmDash deployment, load the relevant
skill from `.agents/skills/` before editing code.** Installing the package is not
the same as using it correctly — `npm run doctor` distinguishes installed from
integrated, and `npm run smoke` proves the public read path is actually served by
EmDash.
