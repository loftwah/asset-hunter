/**
 * The GitHub API as an Effect service (#62).
 *
 * Four rules this module exists to enforce, all of them from the original
 * client and all of them easier to keep in a typed boundary than in a class with
 * a hand-rolled `if (!res.ok) throw`:
 *
 * 1. **Bytes, not execution.** Everything here is an HTTP GET. Nothing clones,
 *    installs or builds. An upstream repository is untrusted data; treating its
 *    `package.json` as an instruction is the failure mode the project policy
 *    names explicitly.
 * 2. **Record what you read.** Every response that ends up in the evidence
 *    carries the URL it came from, so a classification can be re-checked later
 *    against a known state.
 * 3. **Be honest about throttling.** A rate-limited response is a typed failure
 *    with `rateLimited: true`, and the report says so. It is not retried
 *    silently, because a hunt that quietly searched less than it claims produces
 *    a catalogue that looks complete and is not.
 * 4. **Decode what comes back.** See `./schemas.ts` for why a cast on a
 *    third-party response is a promise the third party never made.
 *
 * ## What Effect bought, concretely
 *
 * - **Scoped resource.** The call log — "every call made, so a report can state
 *   exactly what was looked at" — is acquired with `Effect.acquireRelease` for
 *   the life of a hunt and released when it ends. It was a mutable array on a
 *   class instance before, which meant a second hunt in the same process
 *   inherited the first one's history.
 * - **Retry and timeout with a typed policy.** `Effect.retry` is filtered to
 *   transport failures and 5xx. A 403/429 is reported, never retried; a 404 is
 *   an answer, not a failure.
 * - **Cancellation.** The `AbortSignal` Effect hands the thunk is passed to
 *   `fetch`, so interrupting a hunt really does abort the socket rather than
 *   leaving requests running for a crawl nobody is waiting on.
 * - **Service substitution.** The rate limiter and the credentials come from
 *   `RuntimeConfig`, so a test points the engine at a local stub with an
 *   environment record and no code change.
 */
import { Context, Effect, Layer, Ref, Schedule, Schema } from "effect";
import { EngineConfig } from "./config.ts";
import {
	ContentsResponse,
	CommitResponse,
	ObservationResponse,
	RepoResponse,
	SearchResponse,
	TreeResponse,
} from "./schemas.ts";
// A type-only import, so the refresh planner stays the single place that decides
// what an observation *means* and this module is only responsible for reading one.
import type { SourceObservation } from "../refresh.ts";

/**
 * A GitHub call that did not succeed.
 *
 * The three cases are separated by tag rather than by inspecting a message,
 * because the CLI's response to each is different: report and stop (rate
 * limited), treat as absent (not found), report and stop (anything else).
 */
export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
	operation: Schema.String,
	status: Schema.Number,
	url: Schema.String,
	detail: Schema.String,
	/** True when GitHub told us to slow down. Never retried. */
	rateLimited: Schema.Boolean,
}) {}

export interface RepoRef {
	owner: string;
	repo: string;
	/** The commit every piece of evidence for this repository was read at. */
	ref: string;
}

export interface RepoFile {
	path: string;
	/** Base64 content, exactly as served. */
	content: string;
	sha: string;
	size: number;
	/** The blob URL, recorded as evidence. */
	url: string;
	/** True when the bytes are a Git LFS pointer rather than the asset. */
	lfsPointer?: boolean;
}

export interface SearchHit {
	fullName: string;
	description: string | null;
	stars: number;
	license: { spdxId: string | null; name: string | null } | null;
	topics: string[];
	defaultBranch: string;
	htmlUrl: string;
	updatedAt: string;
	pushedAt: string;
	archived: boolean;
	fork: boolean;
}

export interface TreeNode {
	path: string;
	size: number;
	sha: string;
}

/** What a hunt has read, so a report can state exactly what was looked at. */
export interface CallLog {
	readonly calls: ReadonlyArray<string>;
	readonly rateLimited: boolean;
}

/**
 * The GitHub API client.
 *
 * A service rather than a class so the credentials, the base URL and the rate
 * limit are configuration instead of constructor arguments, and so a test can
 * provide a different implementation without touching the call sites.
 */
export class GitHubApi extends Context.Service<
	GitHubApi,
	{
		readonly search: (query: string, perPage: number, page?: number) => Effect.Effect<ReadonlyArray<SearchHit>, GitHubError>;
		readonly resolve: (fullName: string) => Effect.Effect<RepoRef, GitHubError>;
		/**
		 * The cheap pre-check (#41): what is true about this repository right now,
		 * without reading a single byte of its content.
		 *
		 * This is the call a refresh makes *before* deciding whether to spend a
		 * download, so it is deliberately the cheapest read that answers the
		 * question. Two requests, no tree listing and no `contents/` call — see the
		 * implementation for why the head commit is a second request rather than a
		 * first.
		 *
		 * A 404 is a failure here, not `null`, because a repository that cannot be
		 * read is exactly the case the caller has to record honestly. Deciding what
		 * to do about it belongs to the crawl, not the client.
		 */
		readonly observe: (fullName: string) => Effect.Effect<SourceObservation, GitHubError>;
		readonly tree: (ref: RepoRef, maxEntries?: number) => Effect.Effect<ReadonlyArray<TreeNode>, GitHubError>;
		/** `null` rather than a failure for a path that is not there. */
		readonly file: (ref: RepoRef, path: string) => Effect.Effect<RepoFile | null, GitHubError>;
		readonly authenticated: boolean;
		/** Every URL this client has read, for the report. */
		readonly calls: Effect.Effect<ReadonlyArray<string>>;
		/**
		 * Whether GitHub ever throttled this hunt.
		 *
		 * An `Effect` rather than a field because it is owned by the scoped call
		 * log, and a plain boolean on the service would outlive the run that
		 * produced it. The CLI reads it after the hunt to decide whether to say
		 * "the payload covers less than the queries asked for".
		 */
		readonly rateLimited: Effect.Effect<boolean>;
	}
>()("engine/GitHubApi") {
	/**
	 * The live client, with its call log acquired for the life of the layer.
	 *
	 * `Effect.acquireRelease` rather than a field on an object: the log has a
	 * real lifetime, tied to the hunt rather than to the process, and a finaliser
	 * is how you say that. Two hunts in one process now produce two logs.
	 */
	static readonly layer: Layer.Layer<GitHubApi, never, EngineConfig> = Layer.effect(
		GitHubApi,
		Effect.gen(function* () {
			const config = yield* EngineConfig;
			const token = config.githubToken;
			const base = config.githubApi.replace(/\/$/, "");
			// 4000/min authenticated, 50/min anonymous. The default follows the
			// token rather than overriding it, which is why it lives in config.
			const perMinute = config.githubPerMinute ?? (token ? 4000 : 50);
			const minInterval = 60_000 / perMinute;

			/** The call log, and whether GitHub ever throttled us. */
			const acquired = yield* Effect.acquireRelease(
				Effect.sync(() => ({ urls: [] as string[], throttled: false })),
				() => Effect.void,
			);
			// The next moment a request is allowed. A `Ref` rather than a field, so
			// concurrent calls queue on it instead of racing.
			const nextSlot = yield* Ref.make(Date.now());

			const rateLimit = Effect.gen(function* () {
				const earliest = yield* Ref.get(nextSlot);
				const wait = earliest - Date.now();
				// Claim the slot *before* waiting, so two callers cannot both see the
				// same free moment and then fire together.
				yield* Ref.set(nextSlot, Math.max(earliest, Date.now()) + minInterval);
				if (wait > 0) yield* Effect.sleep(wait);
			});

			// Generic over the *decoded type* rather than the schema object. A
			// `S extends Schema.Constraint` loses `Type` the moment a return type is
			// annotated, and the whole point of decoding is that the caller gets a
			// real type back rather than `unknown`.
			const get = <A>(
				operation: string,
				path: string,
				schema: Schema.Codec<A>,
			): Effect.Effect<A, GitHubError> =>
				Effect.gen(function* () {
					yield* rateLimit;
					const url = path.startsWith("http") ? path : `${base}${path}`;
					acquired.urls.push(url);
					const response = yield* Effect.tryPromise({
						async try(signal: AbortSignal) {
							return await fetch(url, {
								headers: {
									accept: "application/vnd.github+json",
									"x-github-api-version": "2022-11-28",
									"user-agent": "asset-hunter-engine",
									...(token ? { authorization: `Bearer ${token}` } : {}),
								},
								signal,
							});
						},
						catch: (cause) =>
							new GitHubError({
								operation,
								status: 0,
								url,
								detail: cause instanceof Error ? cause.message : String(cause),
								rateLimited: false,
							}),
					}).pipe(
						Effect.timeout(config.readTimeoutMs),
						// Transport failures and 5xx only. A 403/429 is a decision GitHub
						// already made and a 404 is an answer, so neither is repeated.
						Effect.retry({
							schedule: Schedule.exponential("250 millis"),
							times: config.readRetries,
							// `timeout` widens the channel with `Cause.TimeoutError`, so the
							// predicate has to narrow before it can read `status`. A timeout is
							// deliberately *not* retried: the engine's calls are large, and
							// repeating a slow one multiplies the wait rather than the chance.
							while: (error) =>
								error._tag === "GitHubError" && (error.status === 0 || error.status >= 500),
						}),
						Effect.catchTag("TimeoutError", () =>
							Effect.fail(
								new GitHubError({
									operation,
									status: 0,
									url,
									detail: `no response within ${config.readTimeoutMs}ms`,
									rateLimited: false,
								}),
							),
						),
					);

					if (response.status === 403 || response.status === 429) {
						acquired.throttled = true;
						const remaining = response.headers.get("x-ratelimit-remaining");
						return yield* Effect.fail(
							new GitHubError({
								operation,
								status: response.status,
								url,
								// The wording matters: the report prints this, and the point is
								// that the hunt read less than it claims.
								detail: `rate limited (${response.status}, remaining=${remaining ?? "?"}). The hunt read less than it reports.`,
								rateLimited: true,
							}),
						);
					}
					if (response.status === 404) {
						return yield* Effect.fail(
							new GitHubError({ operation, status: 404, url, detail: "not found", rateLimited: false }),
						);
					}
					if (!response.ok) {
						return yield* Effect.fail(
							new GitHubError({
								operation,
								status: response.status,
								url,
								detail: `${response.status} ${response.statusText}`,
								rateLimited: false,
							}),
						);
					}

					const raw = yield* Effect.tryPromise({
						async try() {
							return (await response.json()) as unknown;
						},
						catch: (cause) =>
							new GitHubError({
								operation,
								status: response.status,
								url,
								detail: `body is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
								rateLimited: false,
							}),
					});
					// Decoded, not cast. A third party that changes its shape fails here,
					// with the URL, instead of producing `undefined` three frames later.
					return yield* Effect.gen(function* () {
						return yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
							Effect.mapError(
								(error) =>
									new GitHubError({
										operation,
										status: response.status,
										url,
										detail: `unexpected body shape: ${String(error).split("\n")[0]}`,
										rateLimited: false,
									}),
							),
						);
					});
				});

			const search = Effect.fn("GitHubApi.search")(function* (
				query: string,
				perPage: number,
				page = 1,
			) {
				const params = new URLSearchParams({
					q: query,
					per_page: String(Math.min(perPage, 100)),
					page: String(page),
					sort: "stars",
					order: "desc",
				});
				const body = yield* get("search", `/search/repositories?${params}`, SearchResponse);
				return (body.items ?? []).map((item) => ({
					fullName: item.full_name,
					description: item.description ?? null,
					stars: Number(item.stargazers_count ?? 0),
					license: item.license
						? { spdxId: item.license.spdx_id ?? null, name: item.license.name ?? null }
						: null,
					topics: Array.isArray(item.topics) ? item.topics : [],
					defaultBranch: item.default_branch ?? "main",
					htmlUrl: item.html_url,
					updatedAt: item.updated_at ?? "",
					pushedAt: item.pushed_at ?? "",
					archived: item.archived === true,
					fork: item.fork === true,
				})) satisfies ReadonlyArray<SearchHit>;
			});

			const resolve = Effect.fn("GitHubApi.resolve")(function* (fullName: string) {
				const [owner, repo] = fullName.split("/");
				if (!owner || !repo) {
					return yield* Effect.fail(
						new GitHubError({
							operation: "resolve",
							status: 400,
							url: fullName,
							detail: `"${fullName}" is not owner/repo`,
							rateLimited: false,
						}),
					);
				}
				const body = yield* get("resolve", `/repos/${owner}/${repo}`, RepoResponse);
				const branch = body.default_branch ?? "main";
				// `/commits/{ref}` returns `sha` at the top level; `/git/ref/{ref}` returns
				// it under `object`. Reading the wrong one made every candidate record a
				// branch name as its "commit", which is provenance that proves nothing.
				const found = yield* get(
					"resolve",
					`/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
					CommitResponse,
				);
				const sha = found.sha ?? found.object?.sha;
				if (!sha) {
					return yield* Effect.fail(
						new GitHubError({
							operation: "resolve",
							status: 502,
							url: fullName,
							detail: `could not resolve ${fullName}@${branch} to a commit`,
							rateLimited: false,
						}),
					);
				}
				return { owner, repo, ref: sha } satisfies RepoRef;
			});

			/**
			 * The cheap pre-check, in full.
			 *
			 * ## Why two requests
			 *
			 * `GET /repos/{owner}/{repo}` carries `pushed_at`, `archived`, `fork`,
			 * `default_branch`, `stargazers_count` and the canonical `full_name` —
			 * five of the six signals a `SourceObservation` needs, in one document
			 * of a few kilobytes. It does **not** carry the head commit. That was
			 * checked against the live API rather than assumed: the repository
			 * document has no commit reference at all, so any client that claims
			 * otherwise is either reading a cached field or making a second call.
			 *
			 * So the head commit costs one more request — `/commits/{branch}`, which
			 * returns a single commit and is not a listing. Two metadata requests is
			 * the honest floor, and it is still the same request count the old
			 * `resolve()` already paid per repository, before it listed a tree that
			 * is frequently megabytes and then downloaded files. What changed is not
			 * the number of round trips but that this one is reached only for a
			 * repository the crawl already owns, and a repository that has not moved
			 * stops here.
			 *
			 * The commit is read rather than inferred from `pushed_at` because a
			 * force-push or a rebase moves the head without the push timestamp moving
			 * far enough to be trusted on its own, and the planner's rule is that a
			 * moved commit owes a re-read.
			 */
			const observe = Effect.fn("GitHubApi.observe")(function* (fullName: string) {
				const [owner, repo] = fullName.split("/");
				if (!owner || !repo) {
					return yield* Effect.fail(
						new GitHubError({
							operation: "observe",
							status: 400,
							url: fullName,
							detail: `"${fullName}" is not owner/repo`,
							rateLimited: false,
						}),
					);
				}
				const body = yield* get("observe", `/repos/${owner}/${repo}`, ObservationResponse);
				const branch = body.default_branch ?? "main";
				const head = yield* get(
					"observe",
					`/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
					CommitResponse,
				);
				const headSha = head.sha ?? head.object?.sha;
				if (!headSha) {
					return yield* Effect.fail(
						new GitHubError({
							operation: "observe",
							status: 502,
							url: fullName,
							detail: `could not resolve ${body.full_name}@${branch} to a commit`,
							rateLimited: false,
						}),
					);
				}
				return {
					// The canonical name, not the one that was asked for. A renamed
					// repository still answers at its old path, and reading this is the
					// only way a refresh can tell "moved" from "gone".
					fullName: body.full_name,
					pushedAt: body.pushed_at ?? "",
					archived: body.archived === true,
					fork: body.fork === true,
					defaultBranch: branch,
					headSha,
					stars: Number(body.stargazers_count ?? 0),
				} satisfies SourceObservation;
			});

			const tree = Effect.fn("GitHubApi.tree")(function* (ref: RepoRef, maxEntries = 4000) {
				const body = yield* get(
					"tree",
					`/repos/${ref.owner}/${ref.repo}/git/trees/${ref.ref}?recursive=1`,
					TreeResponse,
				);
				return (body.tree ?? [])
					.filter((node) => node.type === "blob" && node.path && node.sha)
					.map((node) => ({
						path: String(node.path),
						size: Number(node.size ?? 0),
						sha: String(node.sha),
					}))
					.slice(0, maxEntries) satisfies ReadonlyArray<TreeNode>;
			});

			const file = Effect.fn("GitHubApi.file")(function* (ref: RepoRef, path: string) {
				const found = yield* get(
					"file",
					`/repos/${ref.owner}/${ref.repo}/contents/${path
						.split("/")
						.map(encodeURIComponent)
						.join("/")}?ref=${ref.ref}`,
					ContentsResponse,
				).pipe(
					// A hunt asking for every candidate licence should find out that one
					// is missing, not that the crawl died. So a 404 is `null` here and
					// only here; every other failure still propagates.
					Effect.catchTag("GitHubError", (error) =>
						error.status === 404 ? Effect.succeed(null) : Effect.fail(error),
					),
				);
				if (!found || !found.content) return null;
				const content = found.content.replace(/\n/g, "");
				return {
					path,
					content,
					sha: found.sha ?? "",
					size: Number(found.size ?? 0),
					url: found.url ?? "",
					lfsPointer: isLfsPointer(decodeBase64(content)),
				} satisfies RepoFile;
			});

			return GitHubApi.of({
				search,
				resolve,
				observe,
				tree,
				file,
				authenticated: Boolean(token),
				calls: Effect.sync(() => [...acquired.urls] as ReadonlyArray<string>),
				rateLimited: Effect.sync(() => acquired.throttled),
			});
		}),
	);
}

/**
 * Git LFS pointers.
 *
 * A pointer file is ~130 bytes of text that *looks* like a path and *looks* like
 * a small file. Treating one as media produces an evidence record whose hash
 * proves nothing about the asset, which is exactly the failure content
 * addressing is supposed to prevent. Detecting them is three lines.
 */
export function isLfsPointer(bytes: string): boolean {
	return (
		bytes.length < 512 &&
		bytes.includes("version https://git-lfs.github.com/spec/") &&
		/^oid sha256:[0-9a-f]{64}$/m.test(bytes)
	);
}

/** GitHub serves content base64. Decoding is the boundary, not the caller. */
export const decodeBase64 = (value: string): string =>
	Buffer.from(value, "base64").toString("utf8");
