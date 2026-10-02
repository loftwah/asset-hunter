/**
 * RSS feed of catalogued possibilities.
 *
 * A discovery catalogue is worth subscribing to: someone can follow entries
 * without checking the wall. Served from the same CMS data as the public site,
 * so there is no separate feed store to fall out of sync.
 *
 * ## The Effect boundary (#62)
 *
 * The read is an Effect and the runner lives in `../lib/effect/root.ts` — one
 * composition root, one place that decides how a program is run. The feed's own
 * serialisation stays plain TypeScript: it is pure, synchronous and completely
 * deterministic, which is the case the house style says not to wrap.
 */
import type { APIRoute } from "astro";
import { Exit } from "effect";
import { loadPossibilities } from "../lib/catalogue";
import { runAppExit } from "../lib/effect/root.ts";
import { RIGHTS_LABEL, VERTICAL_LABEL } from "../lib/vocabulary";

export const GET: APIRoute = async () => {
	// `runAppExit` so a CMS failure is an empty feed rather than an unhandled
	// rejection: a feed that cannot be built is not a feed anyone can read.
	const loaded = await runAppExit(loadPossibilities());
	if (!Exit.isSuccess(loaded)) {
		return new Response(
			'<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Asset Hunter</title><description>Catalogue temporarily unavailable</description></channel></rss>',
			{ status: 503, headers: { "content-type": "application/rss+xml; charset=utf-8" } },
		);
	}
	const { possibilities } = loaded.value;
	// Editorial rank is not a date, so order by slug for a stable, reproducible
	// feed rather than inventing a "newest" ordering the data does not carry.
	const items = [...possibilities].sort((a, b) => b.slug.localeCompare(a.slug)).slice(0, 50);

	const site = new URL("https://assets.loftwah.com");
	const updated = new Date().toUTCString();

	const escape = (value: string) =>
		value
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");

	const urlFor = (slug: string) => new URL(`/possibilities/${slug}`, site).href;

	const body = items
		.map((p) => {
			const description = [
				p.tagline,
				p.summary,
				p.vertical ? `Vertical: ${VERTICAL_LABEL[p.vertical] ?? p.vertical}` : null,
				p.rightsStatus
					? `Representative: ${RIGHTS_LABEL[p.rightsStatus as keyof typeof RIGHTS_LABEL] ?? p.rightsStatus} — possibility discovery does not grant rights to the source asset.`
					: null,
			]
				.filter(Boolean)
				.join("\n\n");

			return [
				"\t\t<item>",
				`\t\t\t<title>${escape(p.title)}</title>`,
				`\t\t\t<link>${urlFor(p.slug)}</link>`,
				`\t\t\t<guid isPermaLink="true">${urlFor(p.slug)}</guid>`,
				`\t\t\t<description>${escape(description)}</description>`,
				"\t\t</item>",
			].join("\n");
		})
		.join("\n");

	const xml = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
		"\t<channel>",
		"\t\t<title>Asset Hunter</title>",
		`\t\t<link>${site.href}</link>`,
		"\t\t<description>A discovery engine for creative and technical possibilities.</description>",
		"\t\t<language>en</language>",
		`\t\t<lastBuildDate>${updated}</lastBuildDate>`,
		`\t\t<atom:link href="${new URL("/rss.xml", site).href}" rel="self" type="application/rss+xml" />`,
		body,
		"\t</channel>",
		"</rss>",
		"",
	].join("\n");

	return new Response(xml, {
		headers: {
			"Content-Type": "application/rss+xml; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
};
