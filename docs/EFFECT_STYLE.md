# Effect 4 house style

This is the authority for how Effect is used in this repository. It is derived
from the code #62 landed, not from a tutorial, and it is short on purpose: a
future agent should be able to read it and then read the code and find the same
thing in both.

Current guidance lives at:

- [Effect 4.0 release notes](https://effect.website/blog/releases/effect/40)
- [v3 → v4 migration guide](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)
- [Installation and toolchain requirements](https://effect.website/docs/v4/getting-started/installation)
- [Running effects / program edges](https://effect.website/docs/v4/getting-started/running-effects)
- [The two kinds of error](https://effect.website/docs/v4/error-management/two-error-types)

**Check the current docs before inventing a pattern.** Effect 4 is a rewrite, not
a version bump; several APIs that look familiar moved, were renamed, or are
broken. The gotchas this repository has actually hit are listed under
[Known-bad in 4.0.0](#known-bad-in-400).

---

## The split

```text
PURE DOMAIN / DETERMINISTIC LOGIC        plain TypeScript
  vocabulary, board rules, rating aggregation, licence classification,
  payload building and validation, schema and geometry helpers

EFFECTFUL APPLICATION + INFRASTRUCTURE   Effect 4, by default
  typed failures, services, configuration, external I/O, resource lifetime,
  decoding, retry/timeout/cancellation

Astro / CLI / script edges                thin adapters
  `runApp`, `runAppExit`, `runScoped`, `forkApp` — and nothing else
```

**Effect is the default for new effectful code.** A new external call, a new
config value, a new service, a new decoding boundary: write it as an Effect
unless there is a specific reason not to, and say the reason in a comment.

## What stays plain, and why

Keep these as ordinary functions. They are the cases where an Effect is worse,
not merely different:

| Keep plain | Why |
| --- | --- |
| `src/lib/vocabulary.ts` | Lookup tables and label formatting. Synchronous and total. |
| `src/lib/board.ts` | Cookie rules. `tests/board.test.ts` exercises them with no runtime at all. |
| `src/lib/rating.ts` aggregation | Arithmetic over a list. `aggregateRatings` is called from `.astro` frontmatter and from a test. |
| `engine/src/licence.ts` | Classification is a pure function of evidence text. |
| `engine/src/publish.ts` `buildPayload` / `validatePayload` | Must be byte-identical across runs; a pure function is what makes that provable. |
| `toMeasure`, `flagValue` in `src/lib/catalogue.ts` | Named rules with named tests. See [Where Schema belongs](#where-schema-belongs). |
| `serialisePossibility`, `fingerprint` in `src/lib/catalogue-json.ts` | The published JSON contract. Pure and directly tested. |

The test is simple: **if it is synchronous, deterministic, and has no failure
modes, it stays a function.** A loader that awaits a database is an Effect; a
function that shapes a value it was handed is not.

## Services and layers

A service is a real dependency this application needs at runtime, not a bag of
configuration:

| Service | File | Layer | Notes |
| --- | --- | --- | --- |
| `EmDashContent` | `src/lib/effect/emdash.ts` | `EmDashContent.layer` | The in-process CMS reader. The **only** way the public catalogue reads content. |
| `EmDashContentApi` | `src/lib/effect/emdash.ts` | `EmDashContentApi.layer` | The HTTP content API, for writes. Per-request origin and cookie are *arguments*, not layer state. |
| `RuntimeConfig` | `src/lib/effect/config.ts` | `RuntimeConfig.fromEnv(record)` | Every timeout, retry count and URL. |
| `GitHubApi` | `engine/src/runtime/github.ts` | `GitHubApi.layer` | Read-only GitHub access, with a scoped call log. |
| `EmDashApi` | `engine/src/runtime/emdash.ts` | `EmDashApi.layer` | The engine's authenticated content client. |
| `EngineConfig` | `engine/src/runtime/config.ts` | `EngineConfig.fromEnv(record)` | The engine's slice of configuration. |

Rules:

- **`Context.Service<Self, Shape>()("asset-hunter/Name")`**, with a
  `static readonly layer`. v4 removed `Effect.Tag` accessors; use `yield*` for
  the service and the `static` layer for the implementation.
- Name the layer `layer` or a descriptive suffix (`fromEnv`, `layerTest`). v4's
  convention, and it is why there is no `Logger.Default` here.
- **Wire dependencies with `Layer.provide` / `Layer.provideMerge`.** Do not use
  `Layer.mergeAll` to inject a `Context.Reference` into a layer that reads it —
  a merged layer is not in scope while the other is being built, so the read
  silently falls back to the default. `RuntimeConfig.fromEnv` exists because of
  this and `tests/effect.test.ts` asserts it.
- **Two roots, not one.** The app's is `src/lib/effect/root.ts`; the engine's is
  `engine/src/runtime/root.ts`. `docs/ARCHITECTURE.md` requires the engine not to
  import app code, and a shared runner would make that a suggestion.
- Inside a static layer's `Effect.gen`, use the **class name**, not `this`. `this`
  is not the class once the generator runs later.

### References, not services

`RequestAbort` (`src/lib/effect/abort.ts`) and Effect's own `Clock` are
`Context.Reference`s with defaults, not services with layers. A per-request value
that has a sensible default is a reference: it costs nothing to leave alone, and
its requirement type is `never`, so it never appears in a program's `R`.

## Where runners belong

**`src/lib/effect/root.ts` and `engine/src/runtime/root.ts` are the only files
that call a `run*` function.** If a runner appears anywhere else, the architecture
has been bypassed.

| Runner | Use it for |
| --- | --- |
| `runApp(effect, options?)` | Astro route handlers, `.astro` frontmatter, scripts. The one deliberate Promise bridge. |
| `runAppExit(effect, options?)` | Handlers that must answer rather than throw: a typed failure becomes a status code. |
| `runScoped(effect, options?)` | A program that needs a `Scope` of its own. |
| `forkApp(effect, options?)` | Work that outlives the response, or that a caller must be able to cancel. |
| `runEngine` / `runEngineExit` / `forkEngine` | The same three, for the hunt engine. |

Always pass `options.signal` (`request.signal`, or `Astro.request.signal` in
frontmatter). A page render that nobody is waiting for should not be paying for
its queries.

`Effect.runPromise` supplies no `Scope` in v4, which is correct: a scope whose
lifetime is implicit is a scope nobody can reason about. Use `runScoped` when the
program acquires something.

## Where Schema belongs

**Every value this application did not produce.** That is:

- EmDash collection rows and their `data` bags — `src/lib/effect/schemas.ts`
- EmDash request and response bodies — same file
- GitHub API responses — `engine/src/runtime/schemas.ts`
- The publish payload read off disk

Pure projections onto the domain model stay functions. `toPossibility` takes a
*validated* row and returns a `Possibility`.

Three rules the schemas encode, each with a reason that is about honesty:

1. **Absent is `null`, not `0`.** A `0` in `example_count` is a claim that
   something was measured. The whole catalogue contract depends on this.
2. **Accept the forms the runtime actually produces.** D1 writes some numbers as
   TEXT and booleans as `0`/`1`.
3. **A field of the wrong shape is a failure, not a coercion.** Decoding is the
   boundary; past it the types are real.

### The shape/meaning split

The schema checks the **shape**. A named projection decides the **meaning**:

```ts
// schemas.ts — shape only
export const LooseNumber = Schema.Union([Schema.Number, Schema.String]);

// catalogue.ts — meaning, in one named function with its own tests
export function toMeasure(value: number | string | null | undefined): number | null
export function flagValue(value: unknown): boolean
```

This is not a stylistic preference. `Schema.NumberFromString` decodes `"nope"` to
`NaN` and `""` to `0` — both *successes* — so converting in the schema would
publish a blank CMS field as a measurement of exactly zero. Keeping the raw text
until `toMeasure` loses nothing and puts the rule where it can be tested.

`Schema.optional(Schema.NullOr(X))` is how "absent means null" is expressed. See
the next section for why it is not `withDecodingDefaultKey`.

## Failures, retry, timeouts, cancellation

**Typed errors, always.** `Schema.TaggedError<Self>()(tag, fields)` in
`src/lib/effect/errors.ts`. A failure carries the fields a caller *acts on* —
`status` for a refusal, `operation` for context — and nothing else. If a failure
can be described as a string today, it should be a tag.

Two kinds, and the difference is the whole point:

- `EmDashTransportError` — **no status**. Retryable, and the only retryable kind.
- `EmDashWriteError` — a status. A decision EmDash already made; repeating the
  request cannot change it.

**Retry narrowly.** `Effect.retry(..., { while: isRetryable })`, never a bare
schedule. Retrying a create whose response was lost is how a duplicate row reaches
a public catalogue. Timeouts are excluded too: the reads here are idempotent but
expensive, and three 8-second attempts on a page render spends a Worker's budget
waiting on a database that is already unwell. Failing visibly is better.

**Every external call has a timeout.** `Effect.timeout(config.readTimeoutMs)`,
with the timeout *inside* the retry so each attempt gets its own budget.

**Cancellation is a resource.** `Effect.tryPromise` hands its thunk an
`AbortSignal` wired to the fiber — verified in `tests/effect.test.ts` — so
interrupting a fiber really does abort the socket. The missing half is noticing
the *caller* going away, which is what `cancellable` in
`src/lib/effect/abort.ts` adds: `Effect.raceFirst` against the request's
`AbortSignal`, with the listener released when the work finishes.

Use `Effect.acquireRelease` when a thing has a real lifetime. The engine's GitHub
call log is the worked example: it belonged to a hunt, not to a process, and a
field on a class could not say so.

## Observability

`Effect.fn("name")` on a service method opens a tracing span, which is what makes
"the wall took four seconds" actionable — you can see which of the six queries it
was waiting on. `Effect.fnUntraced` is for hot paths and library functions that are
not a useful tracing boundary.

`Effect.log` / `logInfo` / `logWarning` / `logError` go to the default logger,
which writes to `console` and therefore to the Workers observability pipeline
that `wrangler.jsonc` already enables.

**The detail goes to the log; the reader gets the sentence.** This is the specific
bug #62 fixed in `src/pages/api/signal.ts`, which used to paste
`create rating → HTTP 409 <EmDash's body>` into a redirect note the reader sees.
`describeError` and `describeDetail` in `src/lib/effect/errors.ts` are the two
halves of the fix; use both.

## Testing Effect code

Plain `node:test`, same as everything else here. The rules that matter:

- **Time is virtual.** `TestClock.layer()` and `TestClock.adjust("1 hour")` make
  retry and timeout tests instant and deterministic. Never assert on real
  durations.
- **A service is substituted, not mocked.** `Layer.succeed(EmDashContent,
  EmDashContent.of({ ... }))` gives a fixture CMS. This is the whole reason the
  services exist: a projection can be tested with no database.
- **Assert the failure, not the absence of an exception.**
  `Exit.isFailure(exit)` plus `Cause.findErrorOption(exit.cause)`.
- **Prefer `Option.match` / `Exit.isSuccess` to reading `.value`.** They narrow;
  `assert.ok(tag === "Some")` does not.
- **Let the runtime settle.** A freshly forked child is *queued*. Interrupting one
  before it has run asserts on work that never happened. `Effect.sleep("10
  millis")` then `Fiber.interrupt` then await the fiber is the shape that works;
  `tests/effect.test.ts` has the comment and the reason.
- `fiberAwait` in the test file exists because `Fiber.await` is a reserved word
  and the module export is only reachable by index.

## Preferred v4 APIs

| Prefer | Not | Why |
| --- | --- | --- |
| `Context.Service` | `Context.Tag`, `Effect.Tag`, `Effect.Service` | All removed in v4. Accessors are gone; `yield*` the service. |
| `Context.Reference` for defaults | a service with a layer | A value with a sensible default should cost nothing to leave alone. |
| `Effect.catch` | `Effect.catchAll` | Renamed. `catchSome` → `catchFilter`, `catchAllCause` → `catchCause`. |
| `Effect.fn(name)` / `fnUntraced(body)` | a hand-written span | `fnUntraced` takes **no** name argument in v4. |
| `cause.reasons` (flat) | recursive `Sequential`/`Parallel` matching | `Cause` is flattened. `isFailureType` → `Cause.isFailReason`. |
| `Cause.findError` returning `Result` | an `Option` | Use `findErrorOption` when you want the `Option`. |
| `Config.withDefault` + `.parse(provider)` | `Config.unwrap` | `Config<A>` is `Effect<A, ConfigError, never>` with `.parse`. The provider is not in `R`, so nothing reads ambient config by accident. |
| `ConfigProvider.fromEnvRecord(record)` | `fromEnv()` | One record works in both runtimes: `process.env` on Node, a binding bag on Workers. |
| `DateTime.nowAsDate` | `new Date()` | Clock-driven, so a test can pin it. |
| `Effect.all([...])` | `Promise.all` | Same shape, interruptible. |
| `Effect.forEach(xs, f, { concurrency: n })` | a hand-rolled loop | Preserve order, bound the fan-out. `n` is a number, not `unbounded` — see `REFERENCE_CONCURRENCY`. |
| `predicate` from `effect/Predicate` | hand-written `isObject` | The library's runtime checks. |

## Gated and broken

### Unstable modules — do not use without a written reason

v4 marks these `@stability unstable` or `experimental`, and they import from
`effect/<name>` with **no** `unstable` segment in the path:

`ai`, `cli`, `cluster`, `devtools`, `eventlog`, `http`, `http-api`,
`jsonschema`, `observability`, `persistence`, `process`, `reactivity`, `rpc`,
`schema`, `socket`, `sql`, `workflow`, `workers`.

This repository uses **none** of them. The reason is concrete: `effect/http`
would have been the natural fit for the EmDash client, and it is unstable; the
alternative — `Effect.tryPromise` over the platform `fetch`, which the Workers
runtime provides natively — is stable, needs no Node shims inside workerd, and is
what `src/lib/effect/emdash.ts` does. Adopting an unstable module needs an issue
that says why stability is not required, not a preference.

### Broken in `effect@4.0.0`

Found the hard way while building this, and asserted against in
`tests/effect.test.ts`. `4.0.0` is the only stable release; `4.0.0-rc.118` is the
last release candidate and is not a production dependency.

| API | Symptom | What this repository does instead |
| --- | --- | --- |
| `Schema.withDecodingDefault`, `…Key`, `…Type`, `…TypeKey` | Builds a schema whose `ast` is `undefined`; the compiler throws `Invalid value used as weak map key` on first use. | `Schema.optional(Schema.NullOr(X))` plus a projection. |
| `Schema.Defect` | Same failure. | A `string` field for the cause. |
| `Schema.decodeTo(To, { decode, encode })(From)` | The interpreter calls the getter as a function; `SchemaGetter.forbidden`/`transform` are objects. | Keep the value raw to the projection — see [the shape/meaning split](#the-shape-meaning-split). |
| `Schema.NumberFromString` | Decodes `"nope"` to `NaN` and `""` to `0`, both as successes. | Never for CMS numerics. Use `toMeasure`. |

Re-check these against the current release before assuming they are still broken,
and delete the workarounds when they are fixed.

### Do not

- **No `any` casts to get a type to fit.** If it cannot typecheck, say so in the
  issue. Every cast in this repository is a narrowing cast at a boundary, and each
  one has a comment saying what it narrows.
- **No `effect/http`, `effect/cli`, `effect/sql`, `effect/workers`** without a
  written reason.
- **No `Effect.runPromise` outside a composition root.**
- **No `as Effect<...>` to widen a typed failure into `unknown`.** Widen the
  channel with a union, or match on `_tag`.
- **No new `@effect/*` packages** without matching them to `effect@4`. v4 shares
  one version across the ecosystem; a mismatched pair is a bug waiting for a
  runtime assertion.

## Runtime notes

- Node **22.18+** and TypeScript **5.9+** are Effect 4's floor, and
  `package.json` says so (`engines.node`, `typescript`).
- TypeScript is pinned to 6.x, not 7.x, because `@astrojs/check@0.9.10` — the
  repository's only typecheck path — declares
  `peerDependencies: { typescript: "^5.0.0 || ^6.0.0" }`. Effect recommends 7 for
  its own tooling; that is a separate change with its own justification.
- `effect` is in `vite.optimizeDeps.exclude` in `astro.config.mjs`. Left to the
  optimiser it produces a stale `deps_ssr` chunk and **every route 500s** with
  "The file does not exist at …/deps_ssr/effect.js". The same trap already applies
  to EmDash's own packages; the comment there is now shared.
- The Cloudflare adapter is on `nodejs_compat`, and Effect's core is
  dependency-free and uses only standard web APIs, so it runs inside workerd
  unchanged. That is a large part of why the unstable `effect/http` was not
  needed.

## Where things are

```text
src/lib/effect/
  errors.ts     typed failures + describeError / describeDetail
  schemas.ts    EmDash rows, request and response bodies
  decode.ts     the two boundary decoders
  config.ts     RuntimeConfig, described with Effect Config
  emdash.ts     EmDashContent (reads) and EmDashContentApi (writes)
  abort.ts      RequestAbort and cancellable
  root.ts       THE composition root for src/

engine/src/runtime/
  schemas.ts    GitHub responses, the EmDash entry response
  config.ts     EngineConfig
  github.ts     GitHubApi, the scoped call log, the rate limiter
  emdash.ts     EmDashApi, the engine's session and content calls
  root.ts       THE composition root for engine/

tests/effect.test.ts   the semantics this document promises
```

## The rule that matters most

**Old hand-written decoding, error, retry and service plumbing is not the way to
build a new feature here.** If you catch yourself writing `try { … } catch (e) {
throw new Error(\`… → HTTP ${res.status}\`) }` next to code that has `EmDashWriteError`
two files away, stop and use the service. That is the difference between an
architecture and a convention.
