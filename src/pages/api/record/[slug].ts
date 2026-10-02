/**
 * The source/licence/provenance record for one example (#42).
 *
 * This is the deliverable the asset half of the catalogue can actually produce
 * today, and it is ungated on purpose. The evidence — where a thing came from,
 * which commit, which file, which licence text was read, which digest — is owed
 * to a reader whatever the rights are. Withholding the provenance of a
 * reference-only example would hide the reason it is reference only, which is
 * the opposite of what the status is for.
 *
 * What is gated is the *asset*, and that is `/api/payload/`, which re-derives
 * the same decision from the same record rather than trusting a link.
 *
 * The response is built by `recordDocument` in `src/lib/asset-use.ts`, so the
 * page, this endpoint and the payload refusal all quote one record.
 */
import type { APIRoute } from "astro";
import { loadExample } from "../../../lib/catalogue";
import { assetUsePaths, recordDocument, runRead } from "../../../lib/asset-use";
import type { Example } from "../../../lib/catalogue";

const text = (body: string, status: number) =>
	new Response(body, {
		status,
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "public, max-age=300",
		},
	});

export const GET: APIRoute = async ({ params }) => {
	const id = String(params.slug ?? "");

	// Through `runRead`, because the loader is the CMS boundary and what it
	// hands back is its decision; this route needs a value either way.
	const example = await runRead(loadExample(id));
	if (!example) {
		// Says what happened and where the record would be found, rather than
		// returning a bare 404 the way a database miss would.
		return text(
			`No example named "${id}" is in the catalogue.\n\n` +
				"Examples are reached from the possibility they belong to: /possibilities/<slug> lists the\n" +
				"ones recorded against it, and each links to its own record.\n",
			404,
		);
	}

	const document = recordDocument(example);
	return new Response(`${JSON.stringify(document, null, "\t")}\n`, {
		status: 200,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "public, max-age=300",
			// The evidence is stable for a given record, and a validator keeps a
			// re-fetch cheap without inventing a freshness claim we cannot make.
			etag: `W/"${document.contentHash ?? document.id}"`,
			"x-ah-use-state": document.useState,
			"x-ah-handoff": document.handoff,
			"x-ah-record-schema": document.schema,
			"x-ah-payload": assetUsePaths.payload(example.slug),
		},
	});
};
