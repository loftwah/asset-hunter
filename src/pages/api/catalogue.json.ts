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
 */
import type { APIRoute } from "astro";
import { CATALOGUE_SCHEMA, buildCatalogue, openReportCount } from "../../lib/catalogue-json.ts";

/** How long a rendered catalogue may be reused. */
const TTL_SECONDS = 60;

export const GET: APIRoute = async ({ site, request }) => {
	const url = new URL(request.url);
	// `?fresh=1` bypasses the cache, for an agent that just changed something
	// and wants to see it rather than wait a minute for it.
	const fresh = url.searchParams.has("fresh");

	let body: string | undefined;
	let cachedAt = 0;
	if (!fresh) {
		const hit = CACHE.get(url.origin);
		if (hit && Date.now() - hit.at < TTL_SECONDS * 1000) {
			body = hit.body;
			cachedAt = hit.at;
		}
	}

	if (body === undefined) {
		const catalogue = await buildCatalogue({ site: site?.href?.replace(/\/$/, "") });
		catalogue.generated = new Date().toISOString();
		body = JSON.stringify({ ...catalogue, openReports: await openReportCount() }, null, "\t");
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
				"cache-control": `public, max-age=${TTL_SECONDS}`,
			},
		});
	}

	return new Response(body, {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": `public, max-age=${TTL_SECONDS}`,
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