/**
 * The composition root (#62).
 *
 * **This is the only file in `src/` that calls `Effect.runPromise`,
 * `Effect.runFork` or any other `run*`.** If a runner appears anywhere else the
 * architecture has been bypassed, which is the specific failure the issue names
 * ("runners are scattered through UI/game code").
 *
 * Everything above this file is a description: services, schemas, and programs
 * that name what they need in the `R` channel and let someone else supply it.
 * Nothing above it decides *how* it is run, with what clock, against which
 * EmDash. That decision lives here, once, and the framework edges ask for it.
 *
 * ## The layer graph
 *
 * ```
 * RuntimeConfig    ← Config, read from a record of environment values
 * EmDashContent    ← the in-process CMS reader (reads)
 * EmDashContentApi ← the HTTP content API (writes)
 * RateLimits       ← the in-isolate abuse window behind the public POSTs (#53)
 * ```
 *
 * `RequestAbort` and `Clock` are references with defaults rather than layers:
 * both are substitutable, both are invisible in a program's `R`, and neither
 * should cost anything to leave alone. The runners provide `RequestAbort`
 * explicitly so cancellation is real on a real request; `Clock` is left to its
 * default so a test can substitute `TestClock` without the root's involvement.
 *
 * ## Why layers are built per call
 *
 * Not memoised in a module-level `ManagedRuntime`. That would keep the EmDash
 * client alive for the life of the isolate, which is the right shape for a queue
 * worker and the wrong one for a request handler — a memoised graph is a graph
 * keyed on whoever called first. `Layer.effect` here acquires and releases within
 * the run, so nothing leaks between requests and a test gets a fresh graph free.
 *
 * ## What the edges get
 *
 * - {@link runApp} — `Effect.runPromise` for Astro route handlers, `.astro`
 *   frontmatter and scripts. The one deliberate Promise bridge.
 * - {@link runAppExit} — the same, resolving to an `Exit` so a handler can tell
 *   a typed failure from a defect and answer 500 rather than crash.
 * - {@link runScoped} — for a program that needs a `Scope` of its own.
 * - {@link forkApp} — `Effect.runFork` for work that must outlive the response
 *   or that a caller needs to cancel.
 */
import { Clock, Effect, Exit, Fiber, Layer, type Config } from "effect";
import { RequestAbort, cancellable, type AbortedError } from "./abort.ts";
import { RuntimeConfig } from "./config.ts";
import { EmDashContent, EmDashContentApi, type EmDashRequest } from "./emdash.ts";
import { RateLimits } from "./limits.ts";

/**
 * Everything an application program is allowed to name in its `R` channel.
 *
 * Written out rather than inferred so a signature reads as a contract. `Clock` is
 * not listed because a reference with a default is invisible in `R` — a program
 * that wants to be testable in time asks for `Clock.Clock` explicitly, and gets a
 * `TestClock` in a test without the root's involvement.
 */
export type AppServices =
	| EmDashContent
	| EmDashContentApi
	| RateLimits
	| RuntimeConfig;

/** The options every runner takes. One shape, so every edge passes the same thing. */
export interface RunOptions {
	/**
	 * Environment values, as a plain record.
	 *
	 * `process.env` on Node; a binding bag on Cloudflare Workers, where
	 * `process.env` is not reliably present. There is no third path, which is why
	 * there is nowhere for configuration to come from that is not written down.
	 * Omit it and every value falls back to its documented default.
	 */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** The caller's abort signal, so a reader who hangs up stops the work. */
	readonly signal?: AbortSignal | null;
}

/** The live graph for one environment. */
const AppLive = (env: Readonly<Record<string, string | undefined>>) =>
	Layer.mergeAll(EmDashContent.layer, EmDashContentApi.layer, RateLimits.layer).pipe(
		Layer.provideMerge(RuntimeConfig.fromEnv(env)),
	);

/**
 * The layer graph for one request or one command.
 *
 * `RuntimeConfig.fromEnv` supplies the `ConfigProvider` itself, and
 * `RequestAbort` is a reference with a `null` default — so this returns a closed
 * graph, and a program's signature names everything it is allowed to need.
 */
export const appLayer = (options: RunOptions = {}): Layer.Layer<AppServices, Config.ConfigError> =>
	Layer.mergeAll(
		AppLive(options.env ?? ambientEnv()),
		Layer.succeed(RequestAbort, options.signal ?? null),
	);

/**
 * The default environment for a runtime that has one.
 *
 * On Workers `process` is not something a library can rely on, even under
 * `nodejs_compat`, so this is guarded rather than assumed.
 */
const ambientEnv = (): Record<string, string | undefined> =>
	typeof process === "undefined" ? {} : { ...process.env };

/**
 * Prepares a program: cancellation first, then the layer graph.
 *
 * Every runner goes through this, so there is one definition of "how an
 * application program is set up" and no runner can forget a step.
 */
const prepare = <A, E>(effect: Effect.Effect<A, E, AppServices>, options: RunOptions) =>
	Effect.provide(cancellable(effect), appLayer(options));

/**
 * Runs an application program. **The** Promise bridge.
 *
 * Used by Astro route handlers, `.astro` frontmatter, and any script that wants
 * the catalogue. Nothing else calls a runner.
 */
export const runApp = <A, E>(
	effect: Effect.Effect<A, E, AppServices>,
	options: RunOptions = {},
): Promise<A> => Effect.runPromise(prepare(effect, options));

/**
 * Runs an application program and resolves to its `Exit` rather than rejecting.
 *
 * For a handler that wants to answer rather than crash: a typed failure becomes
 * a status code, a defect is logged as a defect. `Effect.runPromise` alone
 * rejects with the whole `Cause` as one opaque value, which is the ad-hoc
 * failure handling this architecture replaced.
 */
export const runAppExit = <A, E>(
	effect: Effect.Effect<A, E, AppServices>,
	options: RunOptions = {},
): Promise<Exit.Exit<A, E | AbortedError | Config.ConfigError>> =>
	Effect.runPromiseExit(prepare(effect, options));

/**
 * Runs a program in a scope of its own, closing it when the program ends.
 *
 * The right runner for a program that acquires something. `Effect.acquireRelease`
 * needs a `Scope` in `R`, and `Effect.runPromise` does not supply one in v4 —
 * which is correct: a scope whose lifetime is implicit is a scope nobody can
 * reason about. Naming it here is the point.
 */
export const runScoped = <A, E>(
	effect: Effect.Effect<A, E, AppServices>,
	options: RunOptions = {},
): Promise<A> => Effect.runPromise(Effect.scoped(prepare(effect, options)));

/**
 * Starts a program in the background and hands back the fiber.
 *
 * For work that must outlive the response — `context.waitUntil` on Workers — or
 * that a caller needs to cancel. The fiber is the cancellation handle: pass it to
 * `Fiber.interrupt`.
 */
export const forkApp = <A, E>(
	effect: Effect.Effect<A, E, AppServices>,
	options: RunOptions = {},
): Fiber.Fiber<A, E | AbortedError | Config.ConfigError> =>
	Effect.runFork(Effect.scoped(prepare(effect, options)));

export { Clock, RequestAbort, RuntimeConfig, EmDashContent, EmDashContentApi, RateLimits };
export type { AbortedError, EmDashRequest };
