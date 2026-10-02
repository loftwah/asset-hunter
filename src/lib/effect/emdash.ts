/**
 * The EmDash boundary as two Effect services (#62).
 *
 * This is the file the issue is really about. Every public read went through
 * `getEmDashCollection` / `getEmDashEntry` with a bare `await`, and every write
 * went through `fetch` with a hand-rolled status check:
 *
 * ```ts
 * if (!created.ok) {
 *   throw new Error(`create rating → HTTP ${res.status} ${(await res.text()).slice(0, 120)}`)
 * }
 * ```
 *
 * Five things were wrong with that, and all five are fixed here rather than
 * wrapped:
 *
 * 1. **A failed query looked like an empty one.** `getEmDashCollection` does not
 *    reject on a database error — it resolves with `entries: []` and an `error`
 *    field. The old code destructured `entries` and ignored `error`, so a D1
 *    failure rendered a confident, empty catalogue. The one behaviour this
 *    project refuses is showing something other than what EmDash is serving.
 * 2. **No timeout.** A stalled query held the request open until the platform
 *    gave up, with nothing in the logs saying what was waiting on what.
 * 3. **No cancellation.** Nothing observed the caller's `AbortSignal`, so a
 *    client that hung up left the reads running.
 * 4. **No typed failure.** The status was inside a message string, so "is this
 *    worth retrying" was unanswerable and a 401 was indistinguishable from a 500.
 * 5. **No decoding.** Whatever came back was cast (see `./schemas.ts`).
 *
 * Two services rather than one, because the two directions have genuinely
 * different contracts:
 *
 * - {@link EmDashContent} — the in-process CMS reader. No endpoint, no
 *   credentials, no `fetch`: EmDash resolves the binding from Astro's context.
 * - {@link EmDashContentApi} — the HTTP content API, used for writes. It needs
 *   an origin and the reader's session cookie, both of which are per request,
 *   so they are arguments rather than layer construction.
 *
 * `EmDashContent` also reads the two pieces of *site chrome* — the primary
 * menu and a CMS section — rather than those being fetched ad hoc from a
 * layout. The reason is the same as for collections: a read that bypasses this
 * service has no timeout, no retry and no typed failure, and #17's central
 * defect was that the masthead was not reading EmDash at all.
 *
 * ## Why retry is narrow
 *
 * `Effect.retry` here is filtered to `EmDashTransportError` only, and does not
 * cover the timeout. A refusal (401, 409, 422) is a decision EmDash already
 * made, and repeating the request cannot change it — while a create retried after
 * a *successful* write whose response was lost would either duplicate or
 * conflict. A timeout is excluded because the reads here are idempotent but
 * expensive: three 8-second attempts on a page render is 24 seconds of a
 * Worker's budget spent waiting on a database that is already unwell. Failing
 * visibly is the better answer.
 */
import { Context, Effect, Layer, Schedule } from "effect";
import {
	getEmDashCollection,
	getEmDashEntry,
	getMenuWithCacheHint,
	getSection,
	type CacheHint,
} from "emdash";
import { RuntimeConfig } from "./config.ts";
import { decodeOr, decodeResponse } from "./decode.ts";
import { CatalogueDecodeError, EmDashTransportError, EmDashWriteError } from "./errors.ts";
import {
	CreatedEntry,
	EntryResponse,
	MenuData,
	MenuItemData,
	RawEntry,
	SectionData,
	type RawEntryValue,
} from "./schemas.ts";

/** Options accepted by `getEmDashCollection`, narrowed to what this app uses. */
export interface CollectionQuery {
	readonly limit?: number;
	readonly cursor?: string;
	readonly orderBy?: Readonly<Record<string, "asc" | "desc">>;
	/**
	 * Publish state. Defaults to `published`; only the curation cockpit asks for
	 * anything else, and it has to say so.
	 */
	readonly status?: "draft" | "published" | "archived";
}

/** Options accepted by `getEmDashEntry`'s `references`. */
export interface ReferenceQuery {
	readonly references: Readonly<Record<string, boolean | { limit: number }>>;
}

/** A decoded collection page. */
export interface CollectionPage {
	readonly entries: ReadonlyArray<RawEntryValue>;
	readonly nextCursor: string | null;
	/** EmDash's own route-cache hint, passed straight to `Astro.cache.set`. */
	readonly cacheHint: CacheHint | undefined;
}

/** One decoded menu item. `children` is undecoded; see `MenuItemData`. */
export type MenuItemValue = typeof MenuItemData.Type;

/** A decoded menu. Absent is `null`, which is not a failure. */
export type MenuValue = Omit<typeof MenuData.Type, "items"> & {
	readonly items: ReadonlyArray<MenuItemValue>;
};

/** A decoded section. `content` is Portable Text, passed on to the renderer. */
export type SectionValue = typeof SectionData.Type;

/** The failure channel of every read. */
export type EmDashReadError = EmDashTransportError | CatalogueDecodeError;

/** The failure channel of every write. */
export type EmDashWrite = EmDashWriteError | EmDashTransportError;

/**
 * The in-process CMS reader.
 *
 * The only way the public catalogue reads content, which is the point: there is
 * deliberately no static JSON fallback and no local mirror.
 */
export class EmDashContent extends Context.Service<
	EmDashContent,
	{
		readonly collection: (name: string, query?: CollectionQuery) => Effect.Effect<CollectionPage, EmDashReadError>;
		readonly entry: (
			name: string,
			slug: string,
			options?: ReferenceQuery,
		) => Effect.Effect<{ entry: RawEntryValue | null; cacheHint: CacheHint | undefined }, EmDashReadError>;
		/**
		 * A named menu with resolved URLs, plus the edge-cache hint that lets
		 * EmDash purge a rendered page when somebody edits the menu in the admin.
		 *
		 * A menu that does not exist is `null`, not a failure — see `menu` in
		 * `src/lib/site-shell.ts` for why a missing menu must not 500 the site.
		 */
		readonly menu: (
			name: string,
		) => Effect.Effect<{ menu: MenuValue | null; cacheHint: CacheHint | undefined }, EmDashReadError>;
		/** One CMS section. Absent is `null`, for the same reason a menu is. */
		readonly section: (slug: string) => Effect.Effect<SectionValue | null, EmDashReadError>;
	}
>()("asset-hunter/EmDashContent") {
	static readonly layer: Layer.Layer<EmDashContent, never, RuntimeConfig> = Layer.effect(
		EmDashContent,
		Effect.gen(function* () {
			const config = yield* RuntimeConfig;
			const decodeRow = decodeOr(RawEntry, "EmDash row");
			const decodeMenu = decodeOr(MenuData, "EmDash menu");
			const decodeMenuItem = decodeOr(MenuItemData, "EmDash menu item");
			const decodeSection = decodeOr(SectionData, "EmDash section");

			/**
			 * The one place an EmDash read becomes an Effect.
			 *
			 * `tryPromise` catches a rejection as a typed transport failure;
			 * `timeout` bounds a read that never settles; `retry` repeats only the
			 * transport case. The order matters — the timeout sits inside the retry,
			 * so each attempt gets its own budget rather than the whole retry chain
			 * sharing one.
			 */
			const read = <A>(operation: string, call: () => Promise<A>) =>
				Effect.tryPromise({
					try: call,
					catch: (cause) =>
						new EmDashTransportError({
							operation,
							detail: cause instanceof Error ? cause.message : String(cause),
						}),
				}).pipe(
					Effect.timeout(config.readTimeoutMs),
					Effect.retry({
						schedule: Schedule.spaced(150),
						times: config.readRetries,
						while: (error) => error._tag === "EmDashTransportError",
					}),
					Effect.catchTag("TimeoutError", () =>
						Effect.fail(
							new EmDashTransportError({
								operation,
								detail: `no response within ${config.readTimeoutMs}ms`,
							}),
						),
					),
				);

			const collection = Effect.fn("EmDashContent.collection")(function* (
				name: string,
				query: CollectionQuery = {},
			) {
				const operation = `read ${name}`;
				const page = yield* read(operation, () =>
					getEmDashCollection(name, {
						// Published unless a caller says otherwise. The public
						// catalogue must never see a draft, and that default is the
						// guarantee — so a caller that *wants* drafts has to name it.
						//
						// The curation cockpit is that caller: it reads this same
						// service to surface held crawl output. It used to get
						// published rows and call them drafts, so the queue claimed
						// 24 held drafts against a database holding 5, and listed
						// published seed entries as unreviewed crawl output. A queue
						// that cannot be trusted is worse than no queue, because an
						// editor learns to skip it.
						status: query.status ?? "published",
						limit: query.limit ?? 100,
						cursor: query.cursor,
						orderBy: query.orderBy as Record<string, "asc" | "desc"> | undefined,
					}),
				);
				// The line that was missing. EmDash reports a database failure as a
				// resolved value with `error` set and `entries` empty, so a query that
				// failed and a collection that is genuinely empty are otherwise
				// indistinguishable — and the second one gets a 200 and a page.
				if (page.error) {
					return yield* Effect.fail(
						new EmDashTransportError({ operation, detail: page.error.message }),
					);
				}
				const entries = yield* Effect.forEach(page.entries, (row) =>
					decodeRow(row).pipe(
						Effect.mapError(
							(error) =>
								new CatalogueDecodeError({ subject: `${name} row`, detail: error.detail }),
						),
					),
				);
				return {
					entries,
					nextCursor: page.nextCursor ?? null,
					cacheHint: page.cacheHint,
				} satisfies CollectionPage;
			});

			const entry = Effect.fn("EmDashContent.entry")(function* (
				name: string,
				slug: string,
				options?: ReferenceQuery,
			) {
				const operation = `read ${name}/${slug}`;
				const found = yield* read(operation, () => getEmDashEntry(name, slug, options as never));
				if (found.error) {
					return yield* Effect.fail(
						new EmDashTransportError({ operation, detail: found.error.message }),
					);
				}
				// A slug that is not there is an answer, not a failure: it is how a
				// drill-in on a deleted entry gets to its 404. The cache hint still
				// travels with it — a route may legitimately cache the 404.
				if (!found.entry) return { entry: null, cacheHint: found.cacheHint };
				const decoded = yield* decodeRow(found.entry).pipe(
					Effect.mapError(
						(error) => new CatalogueDecodeError({ subject: `${name}/${slug}`, detail: error.detail }),
					),
				);
				return { entry: decoded, cacheHint: found.cacheHint };
			});

			/**
			 * A menu, read the same way a collection is.
			 *
			 * `getMenuWithCacheHint` rather than `getMenu` because the whole point
			 * of the masthead being CMS-managed is that editing it in the admin
			 * changes the public site — and on a cached route, a change that does
			 * not invalidate the route is a change that appears to do nothing.
			 *
			 * Items are decoded individually rather than as part of the menu
			 * struct, so one malformed item names *itself* in the failure rather
			 * than failing the whole menu and taking the navigation with it. A
			 * menu with four good items and one broken one is still four working
			 * links, and the fifth is a bug worth seeing in the log.
			 */
			const menu = Effect.fn("EmDashContent.menu")(function* (name: string) {
				const operation = `read menu ${name}`;
				const found = yield* read(operation, () => getMenuWithCacheHint(name));
				// `getMenuWithCacheHint` has no `error` field — it rejects on a
				// database failure, which `read` has already turned into a typed
				// transport error. A resolved `null` really does mean "no such menu".
				if (!found.data) return { menu: null, cacheHint: found.cacheHint };
				const decoded = yield* decodeMenu(found.data).pipe(
					Effect.mapError(
						(error) => new CatalogueDecodeError({ subject: `menu ${name}`, detail: error.detail }),
					),
				);
				const items = yield* Effect.forEach(decoded.items, (item) =>
					decodeMenuItem(item).pipe(
						Effect.mapError(
							(error) =>
								new CatalogueDecodeError({
									subject: `menu ${name} item ${item.id}`,
									detail: error.detail,
								}),
						),
					),
				);
				return { menu: { ...decoded, items }, cacheHint: found.cacheHint };
			});

			/**
			 * One section by slug.
			 *
			 * A section is CMS content like any other, so it gets the same
			 * timeout, retry and decoding. The Portable Text inside it does not
			 * get re-validated: EmDash's `PortableText` component is the
			 * authority on that, and a second opinion here would only reject
			 * content the renderer handles.
			 */
			const section = Effect.fn("EmDashContent.section")(function* (slug: string) {
				const operation = `read section ${slug}`;
				const found = yield* read(operation, () => getSection(slug));
				if (!found) return null;
				return yield* decodeSection(found).pipe(
					Effect.mapError(
						(error) => new CatalogueDecodeError({ subject: `section ${slug}`, detail: error.detail }),
					),
				);
			});

			return EmDashContent.of({ collection, entry, menu, section });
		}),
	);
}

/**
 * The HTTP content API, for writes.
 *
 * EmDash keeps an update as a draft revision until it is published, and the
 * public read shows the live revision — so a write that is not published
 * succeeds, returns 200, and changes nothing a reader can see. That is why every
 * mutating call here is explicit about the publish step rather than assuming one.
 */
export class EmDashContentApi extends Context.Service<
	EmDashContentApi,
	{
		/** Creates an entry and returns the slug it landed on. */
		readonly create: (
			request: EmDashRequest,
			collection: string,
			slug: string,
			data: Readonly<Record<string, unknown>>,
		) => Effect.Effect<string, EmDashWrite>;
		/** Replaces an entry's data. `rev` is the revision token from a read. */
		readonly update: (
			request: EmDashRequest,
			collection: string,
			slug: string,
			data: Readonly<Record<string, unknown>>,
			rev: string | null,
		) => Effect.Effect<void, EmDashWrite>;
		/** Publishes a saved revision so the public read can see it. */
		readonly publish: (
			request: EmDashRequest,
			collection: string,
			slug: string,
		) => Effect.Effect<void, EmDashWrite>;
		/** Reads one entry back, with the revision token a later write needs. */
		readonly read: (
			request: EmDashRequest,
			collection: string,
			slug: string,
		) => Effect.Effect<{ data: Record<string, unknown>; rev: string | null } | null, EmDashWrite>;
	}
>()("asset-hunter/EmDashContentApi") {
	static readonly layer: Layer.Layer<EmDashContentApi, never, RuntimeConfig> = Layer.effect(
		EmDashContentApi,
		Effect.gen(function* () {
			const config = yield* RuntimeConfig;

			/**
			 * One HTTP call, typed.
			 *
			 * A non-2xx becomes `EmDashWriteError` carrying the status, because the
			 * status is the thing a caller branches on. The body is kept to a short
			 * prefix: EmDash puts the actual reason there, and a 40KB HTML error page
			 * in a log line helps nobody.
			 *
			 * The `AbortSignal` Effect hands the thunk is passed to `fetch`, so
			 * interrupting the fiber really does abort the socket rather than leaving
			 * a request running for a reader who has gone.
			 */
			const call = (
				operation: string,
				url: string,
				init: { method: string; headers: Record<string, string>; body?: string },
			) =>
				Effect.tryPromise({
					async try(signal: AbortSignal) {
						const response = await fetch(url, { ...init, signal });
						if (!response.ok) {
							const detail = await response.text().catch(() => "");
							throw new EmDashWriteError({
								operation,
								status: response.status,
								detail: detail.slice(0, 200),
							});
						}
						return response;
					},
					catch: (cause) =>
						cause instanceof EmDashWriteError
							? cause
							: new EmDashTransportError({
									operation,
									detail: cause instanceof Error ? cause.message : String(cause),
								}),
				}).pipe(
					Effect.timeout(config.writeTimeoutMs),
					Effect.retry({
						schedule: Schedule.spaced(250),
						times: config.writeRetries,
						while: (error) => error._tag === "EmDashTransportError",
					}),
					Effect.catchTag("TimeoutError", () =>
						Effect.fail(
							new EmDashTransportError({
								operation,
								detail: `no response within ${config.writeTimeoutMs}ms`,
							}),
						),
					),
				);

			const itemPath = (collection: string, slug: string) =>
				`/_emdash/api/content/${collection}/${encodeURIComponent(slug)}`;
			const collectionPath = (collection: string) => `/_emdash/api/content/${collection}`;
			const url = (request: EmDashRequest, path: string) =>
				`${request.endpoint.replace(/\/$/, "")}${path}`;

			const create = Effect.fn("EmDashContentApi.create")(function* (
				request: EmDashRequest,
				collection: string,
				slug: string,
				data: Readonly<Record<string, unknown>>,
			) {
				const operation = `create ${collection}`;
				const response = yield* call(operation, url(request, collectionPath(collection)), {
					method: "POST",
					headers: { ...request.headers },
					body: JSON.stringify({ slug, data }),
				});
				const body = yield* decodeResponse(CreatedEntry, operation)(response);
				// An absent slug is a failure, not an empty string: the caller needs it
				// to publish, and a silent `""` produces a publish to `/publish` on the
				// collection, which reads as a CMS bug.
				const landed = body.data?.item?.slug;
				if (!landed) {
					return yield* Effect.fail(
						new EmDashWriteError({
							operation,
							status: response.status,
							detail: "EmDash accepted the write but returned no slug",
						}),
					);
				}
				return landed;
			});

			const update = Effect.fn("EmDashContentApi.update")(function* (
				request: EmDashRequest,
				collection: string,
				slug: string,
				data: Readonly<Record<string, unknown>>,
				rev: string | null,
			) {
				yield* call(`update ${collection}/${slug}`, url(request, itemPath(collection, slug)), {
					method: "PUT",
					headers: { ...request.headers },
					body: JSON.stringify(rev ? { data, _rev: rev } : { data }),
				});
			});

			const publish = Effect.fn("EmDashContentApi.publish")(function* (
				request: EmDashRequest,
				collection: string,
				slug: string,
			) {
				yield* call(
					`publish ${collection}/${slug}`,
					url(request, `${itemPath(collection, slug)}/publish`),
					{ method: "POST", headers: { ...request.headers } },
				);
			});

			const read = Effect.fn("EmDashContentApi.read")(function* (
				request: EmDashRequest,
				collection: string,
				slug: string,
			) {
				const operation = `read ${collection}/${slug}`;
				const response = yield* call(operation, url(request, itemPath(collection, slug)), {
					method: "GET",
					headers: { ...request.headers },
				});
				const body = yield* decodeResponse(EntryResponse, operation)(response);
				// The record is nested at `data.item.data` and the revision token sits
				// *beside* the item at `data._rev`. Reading `item._rev` yields
				// `undefined`, which makes a sync fall through to the create path and
				// fail with SLUG_CONFLICT on an entry that plainly exists.
				const item = body.data?.item;
				if (body.success === false || !item) return null;
				const fields = item.data;
				return {
					data:
						typeof fields === "object" && fields !== null && !Array.isArray(fields)
							? (fields as Record<string, unknown>)
							: {},
					rev: body.data?._rev ?? item._rev ?? null,
				};
			});

			return EmDashContentApi.of({ create, update, publish, read });
		}),
	);
}

/** Where a write is going, and as whom. Per request, so never a layer. */
export interface EmDashRequest {
	/** The origin serving this request. */
	readonly endpoint: string;
	/**
	 * Headers to send verbatim.
	 *
	 * For a reader-initiated write this carries their own session cookie, so a
	 * rating is attributable to them and is limited to what their RBAC role
	 * allows. The cookie is forwarded, never re-issued.
	 */
	readonly headers: Readonly<Record<string, string>>;
}
