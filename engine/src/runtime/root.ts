/**
 * The hunt engine's composition root (#62).
 *
 * **The only place in `engine/` that calls a `run*` function.** The engine is a
 * separate process from the app and keeps its own root rather than importing the
 * app's, because `docs/ARCHITECTURE.md` requires the boundary to be real: the
 * engine does not import app code, and a shared runner would make that a
 * suggestion rather than a constraint. What the two share is the *shape* — one
 * `Config`-described service, one `Context.Service` for the external API, one
 * place that decides how a program is run.
 *
 * The CLI (`../cli.ts`) is the program edge, and it is allowed to be imperative:
 * argument parsing, `console.log` lines a human reads, and `process.exitCode`.
 * Everything it does that touches the network goes through {@link GitHubApi}.
 */
import { Effect, Exit, Fiber, Layer, type Config } from "effect";
import { EngineConfig } from "./config.ts";
import { EmDashApi } from "./emdash.ts";
import { GitHubApi } from "./github.ts";

/** Everything an engine program is allowed to name in its `R` channel. */
export type EngineServices = EngineConfig | GitHubApi | EmDashApi;

/** The options the runner takes. */
export interface EngineRunOptions {
	/** Environment values, as a plain record. Omit it to use `process.env`. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** An abort signal, so a cancelled crawl stops rather than finishing quietly. */
	readonly signal?: AbortSignal | null;
}

/** The engine's layer graph for one command. */
export const engineLayer = (
	options: EngineRunOptions = {},
): Layer.Layer<EngineServices, Config.ConfigError> =>
	Layer.mergeAll(GitHubApi.layer, EmDashApi.layer).pipe(
		Layer.provideMerge(EngineConfig.fromEnv(options.env ?? ambientEnv())),
	);

const ambientEnv = (): Record<string, string | undefined> =>
	typeof process === "undefined" ? {} : { ...process.env };

/**
 * Runs an engine program. **The** Promise bridge for `engine/`.
 *
 * Note the scope: `GitHubApi.layer` acquires the call log with
 * `Effect.acquireRelease`, so the program runs in a scope of its own and the log
 * is released when it ends. `Effect.runPromise` in v4 does not supply a `Scope`
 * — which is the correct behaviour, and the reason this is `Effect.scoped`
 * rather than a bare `runPromise`.
 */
export const runEngine = <A, E>(
	effect: Effect.Effect<A, E, EngineServices>,
	options: EngineRunOptions = {},
): Promise<A> =>
	Effect.runPromise(Effect.scoped(Effect.provide(effect, engineLayer(options))));

/** Runs an engine program and resolves to its `Exit`, for a CLI that reports. */
export const runEngineExit = <A, E>(
	effect: Effect.Effect<A, E, EngineServices>,
	options: EngineRunOptions = {},
): Promise<Exit.Exit<A, E | Config.ConfigError>> =>
	Effect.runPromiseExit(Effect.scoped(Effect.provide(effect, engineLayer(options))));

/**
 * Starts an engine program in the background.
 *
 * For work the CLI may need to stop: an interrupt handler takes this fiber and
 * `Fiber.interrupt`s it, which aborts the in-flight `fetch` rather than leaving
 * it to finish.
 */
export const forkEngine = <A, E>(
	effect: Effect.Effect<A, E, EngineServices>,
	options: EngineRunOptions = {},
): Fiber.Fiber<A, E | Config.ConfigError> =>
	Effect.runFork(Effect.scoped(Effect.provide(effect, engineLayer(options))));

export { EngineConfig, EmDashApi, GitHubApi };
