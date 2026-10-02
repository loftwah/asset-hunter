/**
 * The engine's configuration slice (#62).
 *
 * The engine is a separate process from the app, so it gets its own description
 * rather than importing the app's — but it is the *same* `RuntimeConfig` service
 * and the same `Config` descriptions, because "where does configuration come
 * from" should have one answer in this repository. The two runtimes differ only
 * in where the record comes from: `process.env` for a CLI, and an explicit record
 * for a test.
 *
 * Every value the engine used to read with a bare `process.env.GITHUB_TOKEN` or
 * hard-code as a magic number is here, named, defaulted and documented. The
 * important one is the rate limit, because it is not a constant: an
 * authenticated request may make 5000/hour and an anonymous one 60/hour, and
 * getting it wrong produces a hunt that reads less than it reports.
 */
import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect";

export interface EngineConfigShape {
	/** GitHub API root. Overridable so a test can point at a local stub. */
	readonly githubApi: string;
	/** Requests per minute. `null` means "derive from whether there is a token". */
	readonly githubPerMinute: number | null;
	/** GitHub token, or `null` for an unauthenticated crawl. Never logged. */
	readonly githubToken: string | null;
	/** How long one GitHub call may take. */
	readonly readTimeoutMs: number;
	/** Transport/5xx retries for one GitHub call. */
	readonly readRetries: number;
	/** EmDash instance the CLI reconciles into. */
	readonly emdashBaseUrl: string;
	/** EmDash token, or `null` to use the local dev-bypass. */
	readonly emdashToken: string | null;
}

export class EngineConfig extends Context.Service<EngineConfig, EngineConfigShape>()(
	"engine/EngineConfig",
) {
	/**
	 * `Layer.provide` rather than `Layer.mergeAll` with the provider: a merged
	 * layer does not put the reference in scope while the *other* layer in the
	 * merge is being built, so the config would read from the default provider
	 * and return the right value for the wrong reason.
	 */
	static readonly fromEnv = (
		env: Readonly<Record<string, string | undefined>> = {},
	): Layer.Layer<EngineConfig, Config.ConfigError> =>
		Layer.effect(
			EngineConfig,
			Effect.gen(function* () {
				const provider = yield* ConfigProvider.ConfigProvider;
				return EngineConfig.of(
					project(yield* Description.parse(provider)),
				);
			}),
		).pipe(
			Layer.provide(
				Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({ ...env })),
			),
		);
}

const Description = Config.all({
	githubApi: Config.String("AH_GITHUB_API").pipe(Config.withDefault("https://api.github.com")),
	githubPerMinute: Config.option(Config.Int("AH_GITHUB_PER_MINUTE")),
	githubToken: Config.option(Config.NonEmptyString("GITHUB_TOKEN")),
	readTimeoutMs: Config.Int("AH_READ_TIMEOUT_MS").pipe(Config.withDefault(20_000)),
	// The engine's calls are bigger than the app's (a tree is megabytes) and there
	// is no request budget to respect, so it is more patient than the web path.
	readRetries: Config.Int("AH_READ_RETRIES").pipe(Config.withDefault(3)),
	emdashBaseUrl: Config.String("AH_EMDASH_BASE_URL").pipe(
		Config.withDefault("http://localhost:4321"),
	),
	emdashToken: Config.option(Config.NonEmptyString("EMDASH_TOKEN")),
});

const project = (values: {
	readonly githubApi: string;
	readonly githubPerMinute: Option.Option<number>;
	readonly githubToken: Option.Option<string>;
	readonly readTimeoutMs: number;
	readonly readRetries: number;
	readonly emdashBaseUrl: string;
	readonly emdashToken: Option.Option<string>;
}): EngineConfigShape => ({
	githubApi: values.githubApi,
	githubPerMinute: Option.getOrUndefined(values.githubPerMinute) ?? null,
	githubToken: Option.getOrUndefined(values.githubToken) ?? null,
	readTimeoutMs: values.readTimeoutMs,
	readRetries: values.readRetries,
	emdashBaseUrl: values.emdashBaseUrl,
	emdashToken: Option.getOrUndefined(values.emdashToken) ?? null,
});
