/**
 * `GET /api/handoff.json` — the implementation handoff (#51).
 *
 * Read-only, published-only, no token. The slugs it resolves are validated
 * against the catalogue by the same loaders the site uses, so a handoff cannot
 * reference a draft, a withdrawn entry, or anything that does not exist — which
 * is the whole reason this route is a document built from records rather than an
 * upload target.
 *
 * ## Why it is one route with two renderings
 *
 * `?format=json` (the default) is the versioned contract an agent reads.
 * `?format=md` is the same fields rendered as Markdown, which is what a person
 * pastes into an issue, a `DESIGN.md` or the top of a prompt. Two renderings of
 * one document, not two documents: the Markdown carries every rights statement
 * the JSON does, so "read it as Markdown" cannot quietly lose the obligations.
 *
 * ## Caching, and the part that is not the same as the catalogue's
 *
 * A body derived from explicit slugs is `public` — it is the same for everyone
 * and the URL is the whole input. A body derived from a reader's **cookie** is
 * not: it is their shortlist, so it is `private` and sends `Vary: Cookie`. That
 * distinction is the difference between caching a document and leaking one
 * person's board to the next, so it is decided from `board.source` rather than
 * assumed.
 *
 * The module-level cache exists for the same reason the catalogue's does, and it
 * is more necessary here: `loadExamplesFor` resolves a `reference` field by
 * fetching each example individually, so one possibility costs about a hundred
 * reads. Polling this route without a cache would spend a Worker's subrequest
 * budget on repeated identical work. `?fresh=1` bypasses it, which is why it is
 * not a convenience.
 *
 * ## The Effect boundary (#62)
 *
 * This handler is a framework edge and one of the few places allowed to call a
 * runner. `runAppExit` lives in `../../lib/effect/root.ts` and nowhere else in
 * `src/`. Three consequences worth stating: a CMS failure answers 503 rather than
 * throwing out of the handler, `request.signal` is threaded in so a polling agent
 * that disconnects stops the reads, and the TTL comes from `RuntimeConfig` rather
 * than a constant in this file.
 */
import type { APIRoute } from "astro";
import { Cause, Effect, Exit } from "effect";
import { RuntimeConfig } from "../../lib/effect/config.ts";
import { runAppExit } from "../../lib/effect/root.ts";
import { COOKIE_NAME, MAX_PER_BOARD, parseBoards } from "../../lib/board.ts";
import {
	HANDOFF_SCHEMA,
	buildHandoffEffect,
	handoffPaths,
	parseSlugList,
	renderHandoffMarkdown,
	resolveHandoffSlugs,
	type HandoffRequest,
} from "../../lib/handoff.ts";

/** Markdown is opt-in; the contract is the default, as in the catalogue route. */
const MARKDOWN = new Set(["md", "markdown"]);

const plain = (body: string, status: number) =>
	new Response(body, {
		status,
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
		},
	});

export const GET: APIRoute = async ({ site, request, cookies }) => {
	const url = new URL(request.url);
	const params = url.searchParams;
	const markdown = MARKDOWN.has((params.get("format") ?? "").toLowerCase());
	const fresh = params.has("fresh");

	const asked: HandoffRequest = {
		slugs: parseSlugList(params.get("slugs")),
		board: params.get("board"),
		chose: parseSlugList(params.get("chose")),
		rejected: parseSlugList(params.get("rejected")),
		goal: params.get("goal"),
		surface: params.get("surface"),
		platform: params.get("platform"),
		constraints: params.get("constraints"),
		acceptance: params.get("acceptance"),
	};

	/*
	 * The board is read from the reader's own cookie, and only when the address
	 * did not name slugs itself. `parseBoards` validates the shape; whether a slug
	 * exists is decided by the catalogue read below, exactly as it is on /board.
	 */
	const raw = cookies.get(COOKIE_NAME)?.value;
	const resolved = resolveHandoffSlugs(
		{ slugs: asked.slugs ?? [], board: asked.board ?? null },
		parseBoards(raw),
	);
	if (!resolved) {
		return plain(
			"No handoff to build.\n\n" +
				"Name the possibilities you chose, or ask for one of your boards:\n\n" +
				`  ${handoffPaths.json("slugs=<possibility-slug>[,<possibility-slug>]")}\n` +
				`  ${handoffPaths.json("board=shortlist")}\n\n` +
				"A board lives in this browser's cookies, so it has to be asked for from the browser that has it.\n" +
				`Boards hold up to ${MAX_PER_BOARD} possibilities. The catalogue lists the slugs at ${handoffPaths.catalogue()}.\n`,
			400,
		);
	}

	/*
	 * Echoed into the document so the two renderings and the address that produced
	 * them can be correlated without guessing. `fresh` is a cache control rather
	 * than part of the request and `format` is the rendering, so neither belongs in
	 * a self-referential address; `handoffPaths` adds the separators back.
	 */
	const query = echoQuery(url);
	const ttlSeconds = await runAppExit(
		Effect.map(RuntimeConfig, (config) => config.catalogueTtlSeconds),
		{ signal: request.signal },
	).then((exit) => (Exit.isSuccess(exit) ? exit.value : 60));

	const cacheKey = `${resolved.source}:${url.pathname}${url.search}${raw ? `:${raw}` : ""}`;

	let body: string | undefined;
	let cachedAt = 0;
	if (!fresh) {
		const hit = CACHE.get(cacheKey);
		if (hit && Date.now() - hit.at < ttlSeconds * 1000) {
			body = hit.body;
			cachedAt = hit.at;
		}
	}

	if (body === undefined) {
		const built = await runAppExit(
			buildHandoffEffect(asked, resolved, {
				site: site?.href?.replace(/\/$/, "") ?? "https://assets.loftwah.com",
				query,
			}),
			{ signal: request.signal },
		);
		if (!Exit.isSuccess(built)) {
			// A handoff that cannot be built from the catalogue is not a handoff.
			// Serving an empty one with a 200 would be the exact dishonesty this
			// document exists to prevent.
			console.error("handoff.json: build failed", Cause.pretty(built.cause));
			return plain("Catalogue unavailable, so no handoff could be built.", 503);
		}
		const document = built.value;
		// Both renderings come from the same document object, produced by the same
		// program that read the records, so a Markdown paste cannot describe a
		// different catalogue than the JSON an agent reads.
		body = markdown ? renderHandoffMarkdown(document) : `${JSON.stringify(document, null, "\t")}\n`;
		cachedAt = Date.now();
		if (!fresh) remember(cacheKey, { body, at: cachedAt });
	}

	const etag = `W/"${digest(body)}"`;
	const cacheHeaders = {
		"cache-control": cacheControl(resolved.source, ttlSeconds),
		vary: varyHeader(resolved.source),
	};
	if (request.headers.get("if-none-match") === etag) {
		return new Response(null, { status: 304, headers: { etag, ...cacheHeaders } });
	}

	return new Response(body, {
		headers: {
			"content-type": markdown ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
			...cacheHeaders,
			etag,
			"x-ah-handoff-schema": HANDOFF_SCHEMA,
			"x-ah-handoff-format": markdown ? "markdown" : "json",
			"x-ah-handoff-source": resolved.source,
			"x-ah-handoff-generated": new Date(cachedAt).toISOString(),
			// Nothing here should be loadable into a page on another site.
			"x-content-type-options": "nosniff",
		},
	});
};

/**
 * A body derived from a cookie is one reader's board, so it is private and varies
 * on the cookie; a body derived from slugs in the address is the same for
 * everybody. `Vary: Cookie` on the private branch too, because a shared cache
 * that ignored `private` would still be wrong — and Astro's own middleware already
 * adds `Vary: Origin`, which this joins rather than replaces.
 */
const cacheControl = (source: "slugs" | "cookie", ttlSeconds: number) =>
	source === "cookie" ? `private, max-age=${ttlSeconds}` : `public, max-age=${ttlSeconds}`;

const varyHeader = (source: "slugs" | "cookie") => (source === "cookie" ? "Cookie, Origin" : "Origin");

/**
 * The address's own query as a bare string — no leading `?` — with the parts that
 * are about this response rather than about the request removed: `format` chooses
 * the rendering and `fresh` only bypasses the cache. One echo serves both
 * renderings, and `handoffPaths` adds the separators back.
 */
function echoQuery(url: URL): string {
	const copy = new URLSearchParams(url.searchParams);
	copy.delete("format");
	copy.delete("fresh");
	return copy.toString();
}

/** A short digest for the ETag. The body carries its own fingerprint. */
function digest(body: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < body.length; i++) {
		hash ^= body.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * A module-level cache, which on Workers means per-isolate rather than global.
 *
 * The key carries the board cookie when the body came from one, so two readers
 * on the same isolate cannot be served each other's board from here. The limit
 * is a backstop against an address that varies a field the key ignores: a short
 * list, evicted oldest-first, because its only job is not redoing a hundred CMS
 * reads for the same answer.
 */
const CACHE = new Map<string, { body: string; at: number }>();
const CACHE_LIMIT = 32;

function remember(key: string, value: { body: string; at: number }): void {
	if (CACHE.size >= CACHE_LIMIT) {
		const oldest = CACHE.keys().next();
		if (!oldest.done) CACHE.delete(oldest.value);
	}
	CACHE.set(key, value);
}