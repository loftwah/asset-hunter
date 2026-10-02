/**
 * `GET /api/catalogue.json` — the machine-facing catalogue (#58).
 *
 * Read-only, published-only, no token, no cookies, no drafts. The content it
 * serves is already public, so there is nothing to protect; what there *is* to
 * get right is honesty, which is why it is built from the same loader the site
 * uses rather than from a second query path.
 *
 * Cached briefly and served with an ETag, so an agent polling for changes does
 * not rebuild the catalogue on every request. The fingerprint in the body is the
 * content digest, so a client can compare two fetches without diffing them.
 *
 * ## The Effect boundary (#62)
 *
 * `buildCatalogue` is an Effect, so this handler is where it is run — through
 * `runAppExit` from `../../lib/effect/root.ts`, the single place in `src/` that
 * calls a runner. Three consequences worth stating:
 *
 * - a CMS failure answers 503 rather than throwing out of the handler, and the
 *   error is a typed one rather than a rejection with a message;
 * - `request.signal` is threaded in, so a polling agent that disconnects stops
 *   the rebuild instead of leaving dozens of D1 reads running;
 * - the TTL comes from `RuntimeConfig` rather than a `const` in this file, so it
 *   is one number for the whole app and a test can change it.
 */
import type { APIRoute } from "astro";
import { Cause, Effect, Exit } from "effect";
import { CATALOGUE_SCHEMA, buildCatalogue, openReportCount } from "../../lib/catalogue-json.ts";
import { RuntimeConfig } from "../../lib/effect/config.ts";
import { runAppExit } from "../../lib/effect/root.ts";

export const GET: APIRoute = async ({ site, request }) => {
	const url = new URL(request.url);
	// `?fresh=1` bypasses the cache, for an agent that just changed something
	// and wants to see it rather than wait a minute for it.
	const fresh = url.searchParams.has("fresh");

	// A render is expensive (the N+1 in `buildCatalogue`), so the TTL is
	// configuration rather than a constant buried here.
	const ttlSeconds = await runAppExit(
		Effect.map(RuntimeConfig, (config) => config.catalogueTtlSeconds),
		{ signal: request.signal },
	).then((exit) => (Exit.isSuccess(exit) ? exit.value : 60));

	let body: string | undefined;
	let cachedAt = 0;
	if (!fresh) {
		const hit = CACHE.get(url.origin);
		if (hit && Date.now() - hit.at < ttlSeconds * 1000) {
			body = hit.body;
			cachedAt = hit.at;
		}
	}

	if (body === undefined) {
		// The two reads are independent, so they are combined in one program
		// rather than awaited one after the other. `Effect.all` keeps both types.
		const built = await runAppExit(
			Effect.gen(function* () {
				const catalogue = yield* buildCatalogue({ site: site?.href?.replace(/\/$/, "") });
				// Stamped from the same program that read the content, so the header
				// and the body cannot disagree about when this was generated.
				catalogue.generated = new Date().toISOString();
				const openReports = yield* openReportCount();
				return { body: JSON.stringify({ ...catalogue, openReports }, null, "\t"), generated: catalogue.generated };
			}),
			{ signal: request.signal },
		);
		if (!Exit.isSuccess(built)) {
			// A catalogue that cannot be built is not a catalogue. Serving an empty
			// one with a 200 is precisely the dishonesty this endpoint exists to avoid.
			console.error("catalogue.json: build failed", Cause.pretty(built.cause));
			return new Response("Catalogue unavailable", { status: 503 });
		}
		body = built.value.body;
		cachedAt = Date.now();
		if (!fresh) CACHE.set(url.origin, { body, at: cachedAt });
	}

	// A weak validator over the body: enough to make a poll cheap.
	const etag = `W/"${catalogue_schema_digest(body)}"`;
	if (request.headers.get("if-none-match") === etag) {
		return new Response(null, {
			status: 304,
			headers: {
				etag,
				"cache-control": `public, max-age=${ttlSeconds}`,
			},
		});
	}

	return new Response(body, {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": `public, max-age=${ttlSeconds}`,
			etag,
			"x-catalogue-schema": CATALOGUE_SCHEMA,
			"x-catalogue-generated": new Date(cachedAt).toISOString(),
			// The catalogue is deliberately not framed: nothing should be able to
			// load it into a page and read it as part of another site.
			"x-content-type-options": "nosniff",
		},
	});
};

/**
 * A module-level cache, which on Workers means per-isolate rather than global.
 * That is fine for its only job — not rebuilding the catalogue for every poll —
 * and it is why `?fresh=1` exists rather than being a convenience.
 */
const CACHE = new Map<string, { body: string; at: number }>();

/** A short digest for the ETag. The catalogue body has its own fingerprint. */
function catalogue_schema_digest(body: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < body.length; i++) {
		hash ^= body.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}
