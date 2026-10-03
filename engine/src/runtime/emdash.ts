/**
 * The engine's EmDash content API (#62).
 *
 * The engine is an ordinary API client: it signs in the way the `emdash` CLI
 * does and then reads and writes over HTTP. It does not touch the CMS database
 * and it does not import app code, which is what makes the boundary in
 * `docs/ARCHITECTURE.md` real rather than a naming convention.
 *
 * Three properties of `sync` and `verify` come from this service rather than from
 * the call sites:
 *
 * 1. **Typed failures.** The old client threw
 *    `write possibilities/foo → HTTP 409 <body>` and the CLI caught it with
 *    `err instanceof Error ? err.message : String(err)`. A status inside a message
 *    cannot be branched on, and the body is a CMS error page rather than a reason.
 * 2. **A revision token, or none.** `readEntry` returns `null` for a 404 — "this
 *    entry does not exist yet" is the normal state of a first sync — and returns
 *    the token from `data._rev` when it does. Reading `item._rev` instead yields
 *    `undefined`, which made every sync fall through to the create path and fail
 *    with SLUG_CONFLICT on an entry that plainly existed.
 * 3. **Drafts, and saying so.** A machine entry is created as a draft: a crawl
 *    does not decide what the public catalogue shows. That is the caller's
 *    decision, made explicitly through the `publish` argument.
 */
import { Context, Effect, Layer, Schedule, Schema } from "effect";
import { EngineConfig } from "./config.ts";
import { EntryResponse, revFromToken } from "./schemas.ts";

/**
 * EmDash's content list route caps `limit` at 100 and pages by `offset`.
 *
 * Declared here rather than inlined into the caller so the number that broke the
 * engine is visible at the point that would break it again. See `EmDashApi.list`.
 */
const EMDASH_LIST_PAGE_MAX = 100;

/** A content call that did not succeed. */
export class EmDashApiError extends Schema.TaggedError<EmDashApiError>()("EmDashApiError", {
	operation: Schema.String,
	/** HTTP status, or 0 when no response arrived. */
	status: Schema.Number,
	detail: Schema.String,
}) {}

export interface EmDashSession {
	readonly cookie: string;
	readonly headers: Readonly<Record<string, string>>;
}

export interface EntryFields {
	readonly data: Record<string, unknown>;
	readonly rev: string | null;
}

export class EmDashApi extends Context.Service<
	EmDashApi,
	{
		/** Signs in the way the `emdash` CLI does. */
		readonly session: Effect.Effect<EmDashSession, EmDashApiError>;
		readonly read: (collection: string, slug: string) => Effect.Effect<EntryFields | null, EmDashApiError>;
		/**
		 * Lists a collection.
		 *
		 * Added for #54. A takedown is only durable if the engine can *read* it, and
		 * the exclusions it needs to consult are a collection rather than a single
		 * entry — so this is the read that makes "an exclusion survives a refresh" a
		 * property of the run rather than a property of an operator's memory.
		 *
		 * `status` is not a parameter because the engine never wants drafts here: a
		 * takedown that was never published is not a takedown anybody agreed to, and
		 * acting on it would let an unfinished decision remove a source.
		 */
		readonly list: (
			collection: string,
			limit?: number,
		) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, EmDashApiError>;
		readonly write: (
			collection: string,
			slug: string,
			data: Readonly<Record<string, unknown>>,
			rev: string | null,
			publish: boolean,
		) => Effect.Effect<void, EmDashApiError>;
	}
>()("engine/EmDashApi") {
	static readonly layer: Layer.Layer<EmDashApi, never, EngineConfig> = Layer.effect(
		EmDashApi,
		Effect.gen(function* () {
			const config = yield* EngineConfig;
			const base = config.emdashBaseUrl.replace(/\/$/, "");

			const call = (
				operation: string,
				path: string,
				init: { method: string; headers: Record<string, string>; body?: string },
				session: EmDashSession,
			) =>
				Effect.tryPromise({
					async try(signal: AbortSignal) {
						const response = await fetch(`${base}${path}`, { ...init, signal });
						if (!response.ok) {
							const detail = await response.text().catch(() => "");
							throw new EmDashApiError({
								operation,
								status: response.status,
								detail: detail.slice(0, 200),
							});
						}
						return response;
					},
					catch: (cause) =>
						cause instanceof EmDashApiError
							? cause
							: new EmDashApiError({
									operation,
									status: 0,
									detail: cause instanceof Error ? cause.message : String(cause),
								}),
				}).pipe(
					Effect.timeout(config.readTimeoutMs),
					// Transport failures and 5xx only. A 401 is a session problem and a 409
					// is a decision EmDash already made; repeating either cannot help.
					Effect.retry({
						schedule: Schedule.exponential("250 millis"),
						times: config.readRetries,
						while: (error) =>
							error._tag === "EmDashApiError" && (error.status === 0 || error.status >= 500),
					}),
					Effect.catchTag("TimeoutError", () =>
						Effect.fail(
							new EmDashApiError({
								operation,
								status: 0,
								detail: `no response within ${config.readTimeoutMs}ms`,
							}),
						),
					),
				);

			/**
			 * A token is preferred; the local dev-bypass exists only on a dev server
			 * and only for development. The engine is an ordinary API client, not
			 * something with special access, and saying so is the point of the
			 * `X-EmDash-Request` header it sends.
			 */
			const session = Effect.gen(function* () {
				// Each branch is annotated rather than `satisfies`-ed, so the generator
				// has one return type. A union of two header bags would push the
				// `authorization?: undefined` / `cookie?: undefined` noise into every
				// caller, for a difference that does not exist at runtime.
				if (config.emdashToken) {
					const withToken: EmDashSession = {
						cookie: "",
						headers: {
							authorization: `Bearer ${config.emdashToken}`,
							"X-EmDash-Request": "1",
							"content-type": "application/json",
						},
					};
					return withToken;
				}
				const response = yield* call(
					"session",
					"/_emdash/api/setup/dev-bypass",
					{ method: "GET", headers: {} },
					{ cookie: "", headers: {} },
				).pipe(
					// A 404 here means "not a dev server", which is the common case in
					// production and needs its own message rather than an HTTP status.
					Effect.catchTag("EmDashApiError", (error) =>
						error.status === 404
							? Effect.fail(
									new EmDashApiError({
										operation: "session",
										status: 404,
										detail:
											"this instance is not a dev server and no EMDASH_TOKEN was set; the engine has no way to authenticate",
									}),
								)
							: Effect.fail(error),
					),
				);
				const cookie = (response.headers.get("set-cookie") ?? "")
					.split(/,(?=[^;]+?=)/)
					.map((part) => part.split(";")[0].trim())
					.filter(Boolean)
					.join("; ");
				if (!cookie.includes("astro-session")) {
					return yield* Effect.fail(
						new EmDashApiError({
							operation: "session",
							status: 401,
							detail: "dev-bypass issued no session cookie",
						}),
					);
				}
				const fromBypass: EmDashSession = {
					cookie,
					headers: {
						cookie,
						// EmDash's same-origin CSRF proof. Without it every
						// state-changing request is rejected.
						"X-EmDash-Request": "1",
						"content-type": "application/json",
					},
				};
				return fromBypass;
			});

			/**
			 * The session, reused by every read and write in a run.
			 *
			 * An alias rather than a second sign-in, so `read` and `write` cannot
			 * drift into authenticating differently. EmDash issues one session per
			 * run; a second dev-bypass call would be a second identity.
			 */
			const signIn: Effect.Effect<EmDashSession, EmDashApiError> = session;

			const read = Effect.fn("EmDashApi.read")(function* (collection: string, slug: string) {
				const session = yield* signIn;
				const operation = `read ${collection}/${slug}`;
				const path = `/_emdash/api/content/${collection}/${encodeURIComponent(slug)}`;
				const response = yield* call(
					operation,
					path,
					{ method: "GET", headers: { ...session.headers } },
					session,
				).pipe(
					// A 404 is `null`, which is the normal state of a first sync and the
					// whole reason `read` is nullable. The point 2 note above describes
					// this and the code did not do it: `call` rejects a 404 like any other
					// non-2xx, so the failure escaped `read` and every caller read "not
					// there" as "the CMS is broken". `sync` then reported every missing
					// entry as a failure and created nothing — a first sync could not work
					// at all — and `verify` aborted with an unreadable error instead of
					// reporting the one thing it exists to report.
					//
					// Only a 404 is absorbed. A 401 is a session problem and a 5xx is a
					// broken one; both stay failures, because a catalogue that silently
					// reads as empty is the failure this project refuses.
					Effect.catchTag("EmDashApiError", (error) =>
						error.status === 404 ? Effect.succeed(null) : Effect.fail(error),
					),
				);
				if (!response) return null;
				const raw = yield* Effect.tryPromise({
					async try() {
						return (await response.json()) as unknown;
					},
					catch: (cause) =>
						new EmDashApiError({
							operation,
							status: response.status,
							detail: `body is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
						}),
				});
				// The content API nests the record at `data.item.data` and the revision
				// token at `data._rev`. Reading `data.data` returns an empty object, which
				// looks exactly like "the entry has no fields" and makes every merge look
				// like a creation.
				const body = yield* Schema.decodeUnknownEffect(EntryResponse)(raw).pipe(
					Effect.mapError(
						(error) =>
							new EmDashApiError({
								operation,
								status: response.status,
								detail: `unexpected body shape: ${String(error).split("\n")[0]}`,
							}),
					),
				);
				const item = body.data?.item;
				if (body.success === false || !item) return null;
				const fields = item.data;
				return {
					data:
						typeof fields === "object" && fields !== null && !Array.isArray(fields)
							? (fields as Record<string, unknown>)
							: {},
					/*
					 * `body.data._rev` first, because that is where the route puts it
					 * (`handleContentGet` returns `{ item, _rev: encodeRev(item) }`).
					 *
					 * The fallback below is genuinely a fallback, and it was previously
					 * documented as the *cause* of a bug that had not happened: the
					 * comment claimed "the route does not return the token" and that
					 * `rev` was therefore `null` for every written entry, so every sync
					 * POSTed a fresh revision of everything and no version conflict could
					 * ever be detected. None of that was true — the token has been in
					 * the body all along.
					 *
					 * A wrong rationale is worse than none, because the next person reads
					 * it, believes the primary path is broken, and removes it. The
					 * fallback stays because a response shaped slightly differently —
					 * a proxy that reshapes, a future route change — should degrade to
					 * a rebuilt token rather than to a silent POST.
					 *
					 * `revFromToken` reproduces EmDash's own construction
					 * (`encodeBase64(\`${version}:${updatedAt}\`)`,
					 * `node_modules/emdash/src/api/rev.ts`), so a rebuilt token
					 * validates identically to a delivered one.
					 */
					rev: body.data?._rev ?? item._rev ?? revFromToken(item.version, item.updatedAt),
				} satisfies EntryFields;
			});

			/**
			 * The list route is **cursor-paginated and hard-capped at 100 rows**.
			 *
			 * This asked for `limit=200`, which the route rejects with a 400. That is
			 * not a cosmetic failure. `list("exclusions")` is how a takedown becomes
			 * visible to a run, and `hunt` catches the error and continues with an
			 * empty list — so every hunt announced, in its own output, that it *could
			 * not honour a takedown it cannot see*, and then crawled anyway. A
			 * withdrawn repository kept coming back and the only signal that anything
			 * was wrong was a line of stderr above the results.
			 *
			 * So: page. `limit=100` per request, walking the `nextCursor` the route
			 * returns, bounded by the caller's own limit. A takedown at row 150 has
			 * to be as visible as one at row 1 — clamping to the first hundred would
			 * be the same failure in a quieter shape, which is worse.
			 *
			 * ## Why the cursor, and not an offset
			 *
			 * This used to send `?limit=100&offset=100`. `contentListQuery` extends
			 * `cursorPaginationQuery`, which is `{ cursor?, limit? }` — so zod
			 * **strips** `offset` before the handler sees it. Every request after the
			 * first re-fetched page 1, `rows.length < page` never became true for a
			 * collection of 100 or more, and the loop only ended when the accumulated
			 * length passed the caller's limit. So `list("exclusions")` over 150
			 * takedowns returned the first hundred, twice, and rows 101–150 were never
			 * seen by anything.
			 *
			 * That is the exact failure the comment above promises not to be, and it
			 * was invisible because the duplicates made the count *rise* fast enough to
			 * exit early. `nextCursor` is the token the route actually hands back
			 * (`node_modules/emdash/src/api/handlers/content.ts`, `nextCursor:
			 * result.nextCursor`), so it is the token used here.
			 *
			 * A repeated cursor is a refusal rather than a loop: if the route ever
			 * hands back a cursor it has already served, stop and say so, because
			 * continuing would spin until the caller's limit with duplicates in place
			 * of pages.
			 */
			const list = Effect.fn("EmDashApi.list")(function* (collection: string, limit = 400) {
				const session = yield* signIn;
				const operation = `list ${collection}`;
				const page = Math.min(limit, EMDASH_LIST_PAGE_MAX);
				const out: Record<string, unknown>[] = [];
				const seenCursors = new Set<string>();
				let cursor: string | null = null;

				while (out.length < limit) {
					const path =
						`/_emdash/api/content/${encodeURIComponent(collection)}` +
						`?limit=${page}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
					const response = yield* call(
						operation,
						path,
						{ method: "GET", headers: { ...session.headers } },
						session,
					);
					const raw = yield* Effect.tryPromise({
						async try() {
							return (await response.json()) as unknown;
						},
						catch: (cause) =>
							new EmDashApiError({
								operation,
								status: response.status,
								detail: `body is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
							}),
					});
					// EmDash nests the list under `data` on this route, so both shapes are
					// accepted — a stricter schema here would fail a run over a field
					// placement that is not what anybody is being asked to reason about.
					const envelope = raw as {
						data?: {
							items?: unknown;
							total?: unknown;
							nextCursor?: unknown;
						} | null;
						items?: unknown;
						total?: unknown;
						nextCursor?: unknown;
					} | null;
					const rows = envelope?.data?.items ?? envelope?.items;
					const total = envelope?.data?.total ?? envelope?.total;
					const next = envelope?.data?.nextCursor ?? envelope?.nextCursor;
					if (!Array.isArray(rows) || rows.length === 0) break;
					out.push(
						...rows.filter(
							(row): row is Record<string, unknown> =>
								typeof row === "object" && row !== null && !Array.isArray(row),
						),
					);
					/*
					 * Three ends, and which one fires depends on the route:
					 *
					 * - a short page is the end on a route that ignores the cursor;
					 * - a `total` we have reached is the end, because an absent `total`
					 *   must not become an infinite loop and a wrong one must not stop
					 *   us before the last takedown;
					 * - no `nextCursor` at all is the end, which is the normal
					 *   last-page signal.
					 *
					 * A repeated cursor is not an end — it is a fault, and stopping
					 * quietly would put duplicates where pages should be, which is the
					 * bug this whole block exists to remove.
					 */
					if (rows.length < page) break;
					if (typeof total === "number" && out.length >= total) break;
					if (typeof next !== "string" || !next) break;
					if (seenCursors.has(next)) {
						yield* Effect.logWarning(
							`${operation}: the route returned a cursor it had already served, so pagination stopped at ${out.length} rows rather than looping.`,
						);
						break;
					}
					seenCursors.add(next);
					cursor = next;
				}
				return out.slice(0, limit);
			});

			const write = Effect.fn("EmDashApi.write")(function* (
				collection: string,
				slug: string,
				data: Readonly<Record<string, unknown>>,
				rev: string | null,
				publish: boolean,
			) {
				const session = yield* signIn;
				const itemPath = `/_emdash/api/content/${collection}/${encodeURIComponent(slug)}`;
				// Creation POSTs to the collection and carries the slug in the body;
				// update PUTs to the item. Posting to the item path returns 401 rather
				// than 405, which reads like an auth failure and sends you looking for a
				// session problem.
				yield* call(
					`write ${collection}/${slug}`,
					rev ? itemPath : `/_emdash/api/content/${collection}`,
					{
						method: rev ? "PUT" : "POST",
						headers: { ...session.headers },
						body: JSON.stringify(rev ? { data, _rev: rev } : { slug, data }),
					},
					session,
				);
				if (publish) {
					yield* call(
						`publish ${collection}/${slug}`,
						`${itemPath}/publish`,
						{ method: "POST", headers: { ...session.headers } },
						session,
					);
				}
			});

			return EmDashApi.of({ session, read, list, write });
		}),
	);
}
