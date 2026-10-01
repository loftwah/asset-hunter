# Vendored EmDash agent skills

Official EmDash guidance, committed so a fresh agent session always has it
available without a network call.

| Directory                                        | Use for                                              |
| ------------------------------------------------ | ---------------------------------------------------- |
| [`building-emdash-site`](building-emdash-site/)   | Schema, seeds, queries, Portable Text, deployment     |
| [`emdash-cli`](emdash-cli/)                       | Inspecting and managing content, schema, media, search |
| [`creating-plugins`](creating-plugins/)           | Plugin hooks, routes, storage, admin UI, blocks       |

## Provenance

| Field                | Value                                                            |
| -------------------- | ---------------------------------------------------------------- |
| Upstream repository  | `github.com/emdash-cms/emdash`                                    |
| Source path          | `skills/<name>/`                                                  |
| Pinned revision      | `3a33f33b1f2e7ca54a36b8f497022b4256993858`                        |
| Retrieved            | 2026-10-01                                                        |
| Licence              | MIT (same as the upstream project)                                |

Each directory contains an `UPSTREAM_REVISION` file recording the revision it
was taken from.

## Updating

```bash
npm run skills:sync          # re-fetch and record the new revision
npm run skills:sync -- --check  # fail if the vendored copy is stale
```

`sync` reports what changed, what is local-only, and — importantly — what is
local-only so a stale reference document left behind after an upstream rename
is visible rather than silently retained.

A skill copied once and never refreshed is worse than no skill, because it looks
current. Re-run the sync when EmDash releases, and read the upstream changelog
for the skill directory rather than the npm version: a patch bump can change
seed semantics without changing guidance, and vice versa.

## Why vendored rather than fetched

Agents cannot be relied on to discover a remote skill directory at the right
moment, and a missed load means a parallel CMS gets built beside EmDash — the
exact failure this repository's policy exists to prevent. Committing the
guidance makes the correct path the default one, and the `npm run doctor` /
`npm run smoke` checks make bypassing it detectable.

## Rules these skills encode

The three that have already caused real bugs in this project, kept here because
they fail silently rather than erroring:

1. **Image fields are objects, not strings.** `data.image` is `{ id, src, alt }`.
   Writing it straight into `<img src>` renders `[object Object]`.
2. **`entry.id` is the slug; `entry.data.id` is the record id.** They are
   different things. Mixing them produces silent empty results.
3. **`reference` fields have no filterable column.** `getEmDashCollection`
   cannot filter or hydrate them; `getEmDashEntry(..., { references })` is
   required. Reading `data.members` returns nothing with no error.
