/**
 * The retained original for one example (#42).
 *
 * The only route in this app that hands over asset bytes, and the one place
 * where "do not show a Download action when rights are not established" has to
 * hold against a hand-typed URL as well as against the rendered page. So the
 * gate is not "did the page offer this?" — the gate is `useDecision` in
 * `src/lib/asset-use.ts`, recomputed from the record here, which is the same
 * function the page used. A hidden control and a typed address get one answer.
 *
 * Two things are honest about being incomplete rather than quietly faked:
 *
 * 1. **No bytes are retained yet.** Every example in the catalogue is a
 *    generated plate with `downloadable: false`, and the `examples` collection
 *    has no field pointing at a retained upstream object — so there is nothing
 *    to read. The route says that (409) instead of serving a preview, a
 *    re-encode, or the upstream file fetched at request time and called
 *    "downloadable". Adding a retained payload means adding a field the engine
 *    writes, and then `retainedPayload` below is where those bytes arrive.
 * 2. **The integrity check is real and runs before anything is sent.** When
 *    bytes do arrive they are hashed and compared with the record's
 *    `content_hash`; a mismatch serves nothing at all. `npm test` exercises that
 *    branch, so it is not a promise about the future — it is code that runs
 *    today on a fixture.
 */
import type { APIRoute } from "astro";
import { loadExample } from "../../../lib/catalogue";
import {
	assetUsePaths,
	payloadResult,
	runRead,
	type RetainedPayload,
} from "../../../lib/asset-use";
import type { Example } from "../../../lib/catalogue";

/**
 * Reads the retained original for an example, if this deployment has one.
 *
 * Null today, and the reason is written down rather than inferred: the schema
 * records no payload object, so there is no key to read. Returning null here
 * makes the route answer "no retained payload" (409) — the true state — rather
 * than reaching for the specimen plate, which is a *different file* and the one
 * thing this route must never hand over under an asset's name.
 */
async function retainedPayload(_example: Example | null): Promise<RetainedPayload | null> {
	return null;
}

export const GET: APIRoute = async ({ params }) => {
	const id = String(params.slug ?? "");
	// Through `runRead`, because the loader is the CMS boundary and the gate
	// below must not depend on how the boundary chooses to return a value.
	const example = await runRead(loadExample(id));

	if (!example) {
		// The id is echoed back, so the response carries the same headers every
		// other refusal here does: `nosniff` plus a sandboxing CSP. Echoing an
		// untrusted string into a body is only safe if the body cannot be
		// re-interpreted as a document, and this is the one place where the id
		// reaches the response with no schema behind it.
		return new Response(
			`No example named "${id.slice(0, 120)}" is in the catalogue, so there is nothing to hand over.\n` +
				"Examples are reached from the possibility they belong to: /possibilities/<slug>.\n",
			{
				status: 404,
				headers: {
					"content-type": "text/plain; charset=utf-8",
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
					"content-security-policy": "sandbox; default-src 'none'; object-src 'none'",
					"x-ah-record": `/api/record/${encodeURIComponent(id.slice(0, 120))}`,
				},
			},
		);
	}

	const result = await payloadResult({ example, retained: await retainedPayload(example) });

	// Workers' `BodyInit` does not accept a bare view, and copying through a
	// fresh buffer is also the honest way to be certain the bytes sent are
	// exactly the bytes hashed above rather than a window onto a larger one.
	const body: BodyInit = result.bytes
		? new Uint8Array(result.bytes).buffer
		: new TextEncoder().encode(result.body ?? "");

	return new Response(body, { status: result.status, headers: result.headers });
};
