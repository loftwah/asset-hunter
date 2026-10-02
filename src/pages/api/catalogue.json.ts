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
 *
 * ## `?fresh` is a nudge, not a bypass (#53)
 *
 * `?fresh=1` used to skip the cache entirely — read *and* write. That made an
 * unauthenticated, unauthenticated-shaped GET a way to force a full catalogue
 * rebuild, which is `possibilities + collections + collections×members +
 * examples×possibilities` D1 reads, on demand, from anywhere, forever. The
 * cache exists precisely to stop that, and the parameter handed it back.
 *
 * So a fresh request is now rate-limited against the *rebuild*, not against the
 * cache entry: {@link FRESH_COOLDOWN_MS}. Within the window it serves the cached
 * body it would have served anyway, with `x-catalogue-fresh: served-stale`. A
 * caller who genuinely needs the newest content within seconds rather than a
 * minute gets it; a caller in a loop gets one rebuild per window.
 *
 * The platform-native control is still the right place for the outer limit — see
 * the rate-limiting rule in `docs/DEPLOY.md`. This one is here because a
 * dashboard rule can be turned off by accident and this cannot.
 */
import type { APIRoute } from "astro";
import { Cause, Effect, Exit } from "effect";
import { CATALOGUE_SCHEMA, buildCatalogue, openReportCount } from "../../lib/catalogue-json.ts";
import { RuntimeConfig } from "../../lib/effect/config.ts";
import { runAppExit } from "../../lib/effect/root.ts";

/** How often `?fresh` may actually cause a rebuild, per isolate. */
export const FRESH_COOLDOWN_MS = 5_000;

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

	const key = url.origin;
	let body: string | undefined;
	let cachedAt = 0;
	// Whether this request was refused a rebuild by the cooldown, so the header
	// can say which of the two happened rather than leaving it to be guessed.
	let freshSuppressed = false;
	const now = Date.now();

	if (!fresh) {
		const hit = CACHE.get(key);
		if (hit && now - hit.at < ttlSeconds * 1000) {
			body = hit.body;
			cachedAt = hit.at;
		}
	} else {
		// The hit is still read, and still used: a caller asking for fresh while
		// the cooldown holds gets the freshest body this isolate has, which is
		// exactly what it would have got without the parameter.
		const hit = CACHE.get(key);
		// `?? 0` rather than an optional chain: an origin with no recorded rebuild
		// has never rebuilt on request, so `now - 0` is larger than any cooldown and
		// it is allowed its first one. `undefined` here would be a `NaN` comparison,
		// and `NaN < x` is false, which would silently mean the opposite.
		const lastFresh = FRESH_REBUILD.last.get(key) ?? 0;
		if (hit && now - lastFresh < FRESH_COOLDOWN_MS) {
			freshSuppressed = Boolean(hit);
			body = hit?.body;
			cachedAt = hit?.at ?? 0;
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
		// A fresh build is also the cache: it is strictly newer than whatever was in
		// there, so writing it back is what makes the next poll cheap. The
		// cooldown is recorded only for a rebuild somebody *asked* for.
		CACHE.set(key, { body, at: cachedAt });
		if (fresh) FRESH_REBUILD.last.set(key, cachedAt);
	}

	// A weak validator over the body: enough to make a poll cheap.
	const etag = `W/"${catalogue_schema_digest(body)}"`;
	if (request.headers.get("if-none-match") === etag) {
		return new Response(null, {
			status: 304,
			headers: {
				etag,
				"cache-control": `public, max-age=${ttlSeconds}`,
				...(freshSuppressed ? { "x-catalogue-fresh": "served-stale" } : {}),
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
			// Says out loud when `?fresh` did not get what it asked for, so a
			// polling agent can tell "nothing changed" from "I was rate limited".
			...(freshSuppressed ? { "x-catalogue-fresh": "served-stale" } : {}),
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

/** When each origin last rebuilt *because someone asked for fresh*. */
const FRESH_REBUILD = { last: new Map<string, number>() };

/** A short digest for the ETag. The catalogue body has its own fingerprint. */
function catalogue_schema_digest(body: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < body.length; i++) {
		hash ^= body.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}
