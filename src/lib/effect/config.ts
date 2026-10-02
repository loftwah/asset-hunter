/**
 * Runtime configuration, described with Effect `Config` (#62).
 *
 * Configuration is environment, which means it is untrusted and absent in
 * different ways depending on the runtime. The old code read `process.env`
 * directly in one place (`engine/src/github.ts`) and hard-coded the rest, so a
 * timeout was a magic number in the middle of a function and a token's absence
 * was indistinguishable from a token's emptiness.
 *
 * This module makes the whole set explicit and gives every value a default, so
 * the service below can be built in any runtime without a failure path in the
 * common case — while still having a real `ConfigError` when someone sets a value
 * to something unreadable. `AH_`-prefixed, so it cannot collide with EmDash's own
 * `EMDASH_*` or the engine's `GITHUB_TOKEN`.
 *
 * Two runtimes, one description:
 *
 * - Node (tests, the engine, scripts) — `ConfigProvider.fromEnvRecord(process.env)`.
 * - Cloudflare Workers — `process.env` is not reliably present there, so a
 *   caller with a record (a binding bag, a test) passes it explicitly. With no
 *   record, every value falls back to its documented default, which is the
 *   correct behaviour: the app is fully functional with no configuration at all.
 *
 * ## A v4 detail that matters
 *
 * `Config<A>` in v4 is `Effect<A, ConfigError, never>` with a `.parse(provider)`
 * method. The provider is not in the `R` channel, so a config cannot be read
 * from an ambient source by accident — something has to hand it one. That is the
 * whole reason this layer exists.
 */
import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect";

export interface RuntimeConfigShape {
	/** Canonical public origin, used for canonical URLs and the catalogue's `site`. */
	readonly site: string;
	/** How long a single EmDash read may take before it is called a timeout. */
	readonly readTimeoutMs: number;
	/** Writes get longer than reads: a publish is two round trips. */
	readonly writeTimeoutMs: number;
	/** Transport-level retries for a read. Refusals are never retried. */
	readonly readRetries: number;
	/** Transport-level retries for a write. */
	readonly writeRetries: number;
	/** How long a rendered `/api/catalogue.json` body may be reused. */
	readonly catalogueTtlSeconds: number;
	/** Default EmDash instance for the engine's CLI, which runs outside Astro. */
	readonly emdashBaseUrl: string;
	/** GitHub API root, overridable so a test can point at a local stub. */
	readonly githubApi: string;
	/** Requests per minute the engine will make. `null` means "derive from the token". */
	readonly githubPerMinute: number | null;
	/** GitHub token, if the operator has one. Never logged, never returned in a body. */
	readonly githubToken: string | null;
}

/**
 * The whole configuration set, resolved once.
 *
 * A `Context.Service` rather than a bag of exported values because it is
 * substitutable: a test that wants a 5ms timeout or a stub endpoint provides a
 * different layer, and the code under test cannot tell.
 */
export class RuntimeConfig extends Context.Service<RuntimeConfig, RuntimeConfigShape>()(
	"asset-hunter/RuntimeConfig",
) {
	/**
	 * The production layer, wired to a record of environment values.
	 *
	 * `Layer.provide(Layer.succeed(ConfigProvider.ConfigProvider, …))` rather
	 * than a `Layer.mergeAll` of the two. A merged layer does not put the
	 * reference in scope while the *other* layer in the merge is being built, so
	 * the config would silently read from the default provider and return the
	 * right value for the wrong reason. Asserted in `tests/effect.test.ts`.
	 */
	static readonly fromEnv = (
		env: Readonly<Record<string, string | undefined>> = {},
	): Layer.Layer<RuntimeConfig, Config.ConfigError> =>
		Layer.effect(
			RuntimeConfig,
			Effect.gen(function* () {
				const provider = yield* ConfigProvider.ConfigProvider;
				return RuntimeConfig.of(project(yield* Runtime.parse(provider)));
			}),
		).pipe(
			Layer.provide(
				Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({ ...env })),
			),
		);
}

/**
 * The configuration as Effect describes it, before it is projected onto the
 * service shape.
 *
 * Every entry has a default except the two that are genuinely optional. A
 * missing `GITHUB_TOKEN` is a real operating mode for the engine — it crawls
 * unauthenticated and slowly, and the report says so — so it is `Option` rather
 * than a default of `""`, which would read as an empty token rather than none.
 */
const Runtime = Config.all({
	site: Config.String("AH_SITE").pipe(Config.withDefault("https://assets.loftwah.com")),
	readTimeoutMs: Config.Int("AH_READ_TIMEOUT_MS").pipe(Config.withDefault(8_000)),
	writeTimeoutMs: Config.Int("AH_WRITE_TIMEOUT_MS").pipe(Config.withDefault(10_000)),
	readRetries: Config.Int("AH_READ_RETRIES").pipe(Config.withDefault(2)),
	writeRetries: Config.Int("AH_WRITE_RETRIES").pipe(Config.withDefault(1)),
	catalogueTtlSeconds: Config.Int("AH_CATALOGUE_TTL_SECONDS").pipe(Config.withDefault(60)),
	emdashBaseUrl: Config.String("AH_EMDASH_BASE_URL").pipe(
		Config.withDefault("http://localhost:4321"),
	),
	githubApi: Config.String("AH_GITHUB_API").pipe(Config.withDefault("https://api.github.com")),
	githubPerMinute: Config.option(Config.Int("AH_GITHUB_PER_MINUTE")),
	githubToken: Config.option(Config.NonEmptyString("GITHUB_TOKEN")),
});

/** Projects the described config onto the service shape, dropping the `Option`s. */
const project = (values: {
	readonly site: string;
	readonly readTimeoutMs: number;
	readonly writeTimeoutMs: number;
	readonly readRetries: number;
	readonly writeRetries: number;
	readonly catalogueTtlSeconds: number;
	readonly emdashBaseUrl: string;
	readonly githubApi: string;
	readonly githubPerMinute: Option.Option<number>;
	readonly githubToken: Option.Option<string>;
}): RuntimeConfigShape => ({
	site: values.site,
	readTimeoutMs: values.readTimeoutMs,
	writeTimeoutMs: values.writeTimeoutMs,
	readRetries: values.readRetries,
	writeRetries: values.writeRetries,
	catalogueTtlSeconds: values.catalogueTtlSeconds,
	emdashBaseUrl: values.emdashBaseUrl,
	githubApi: values.githubApi,
	githubPerMinute: Option.getOrUndefined(values.githubPerMinute) ?? null,
	githubToken: Option.getOrUndefined(values.githubToken) ?? null,
});

/**
 * Builds a config layer from a plain record of environment values.
 *
 * The one place a `ConfigProvider` is constructed, so "where does configuration
 * come from" has a single answer: a record.
 */
export const runtimeConfigFrom = (
	env: Readonly<Record<string, string | undefined>>,
): Layer.Layer<RuntimeConfig, Config.ConfigError> => RuntimeConfig.fromEnv(env);
