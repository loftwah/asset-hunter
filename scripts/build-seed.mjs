#!/usr/bin/env node
/**
 * Composes seed/atlas.mjs into seed/seed.json.
 *
 * The seed is the schema plus demo content that EmDash inlines and applies once
 * per database. Keeping the readable content in atlas.mjs and generating the
 * JSON means the vocabulary (verticals, origins, rights) is defined once and
 * every entry is validated against it at build time rather than at first
 * request, when an invalid seed is skipped silently.
 *
 * Usage: node scripts/build-seed.mjs [--check]
 *   --check  verify seed.json matches what this script would write (for CI/tests)
 */
import { readFileSync, writeFileSync } from "node:fs";
import atlas from "../seed/atlas.json" with { type: "json" };

const {
	collections: COLLECTIONS,
	media: MEDIA,
	// Every origin field today is a `select`, so the atlas vocabulary is
	// asserted rather than emitted.
	origins: ORIGINS,
	pages: PAGES,
	possibilities: POSSIBILITIES,
	rights: RIGHTS,
	sections: SECTIONS,
	verticals: VERTICALS,
} = atlas;

const OUT = new URL("../seed/seed.json", import.meta.url);

const problems = [];
const requireOneOf = (value, allowed, where) => {
	if (!allowed.includes(value)) problems.push(`${where}: "${value}" not in ${allowed.join(" | ")}`);
};

const verticalSlugs = new Set(VERTICALS.map((v) => v.slug));
const ids = new Set();

/**
 * Every seeded representative is a plate generated for this catalogue, and the
 * examples mirror their possibility. Declared once and asserted below so a
 * hand-edited atlas cannot quietly claim upstream origin for repo-shipped media.
 */
const representativeOrigin = "generated";

const possibilities = POSSIBILITIES.map((p) => {
	requireOneOf(p.vertical, [...verticalSlugs], `${p.id}.vertical`);
	requireOneOf(p.media, MEDIA, `${p.id}.media`);
	requireOneOf(p.rights, RIGHTS, `${p.id}.rights`);
	if (ids.has(p.id)) problems.push(`duplicate id "${p.id}"`);
	ids.add(p.id);
	if (typeof p.editorialRank !== "number" || p.editorialRank < 0 || p.editorialRank > 1) {
		problems.push(`${p.id}.reduction must be a number in 0..1`);
	}
	for (const field of ["title", "tagline", "summary", "technique", "buildNotes", "prompt"]) {
		if (typeof p[field] !== "string" || !p[field].trim()) problems.push(`${p.id}.${field} is empty`);
	}

	return {
		id: p.id,
		slug: p.id,
		status: "published",
		data: {
			title: p.title,
			tagline: p.tagline,
			summary: p.summary,
			technique: p.technique,
			vertical: p.vertical,
			media_kind: p.media,
			specimen: `/specimens/${p.id}.svg`,
			// Every seeded representative is a plate we generated for this
			// catalogue. Never claim upstream origin for our own artwork.
			representative_origin: representativeOrigin,
			rights_status: p.rights,
			rights_note: p.rightsNote,
			build_notes: p.buildNotes,
			prompt_scaffold: p.prompt,
			// Machine observations. Zero until the hunt engine supplies real data —
			// an unverified count is worse than an honest zero.
			example_count: 1,
			distinct_sources: 0,
			// Editorial judgement, stored separately from the machine scores above.
			editorial_rank: p.editorialRank,
			featured: false,
			// Hand-authored, so it is public and it came from a person, not a
			// hunt. The engine fills these in for its own entries.
			visibility: "published",
		},
	};
});

// One example per possibility: the generated plate that represents it.
const examples = POSSIBILITIES.map((p) => {
	requireOneOf(p.rights, RIGHTS, `${p.id} example rights`);
	return {
		id: `ex-${p.id}`,
		slug: p.id,
		status: "published",
		data: {
			title: p.title,
			possibility: `$ref:${p.id}`,
			origin: representativeOrigin,
			media_kind: p.media,
			specimen: `/specimens/${p.id}.svg`,
			rights_status: p.rights,
			rights_note: p.rightsNote,
			note:
				"Plate generated for this catalogue to demonstrate the possibility. It is an original of this project and is not a reproduction of any source asset.",
			// Content addressing: name is derived from bytes, never assigned.
			content_hash: null,
			downloadable: false,
			featured: false,
			visibility: "published",
		},
	};
});

// Reference fields resolve against target entries, so possibilities must be
// declared before the examples that link to them. EmDash enforces this order.
const collections = COLLECTIONS.map((c) => {
	for (const m of c.members) {
		if (!ids.has(m)) problems.push(`collection "${c.id}" references unknown possibility "${m}"`);
	}
	return {
		id: c.id,
		slug: c.slug,
		status: "published",
		data: {
			title: c.title,
			tagline: c.tagline,
			summary: c.summary,
			members: c.members.map((m) => `$ref:${m}`),
			featured: false,
		},
	};
});

const pages = PAGES.map((p) => ({
	id: p.id,
	slug: p.slug,
	status: "published",
	data: { title: p.title, summary: p.summary, content: p.body },
}));

const seed = {
	$schema: "https://emdashcms.com/seed.schema.json",
	version: "1",
	meta: {
		name: "Asset Hunter",
		description: "A discovery engine for creative and technical possibilities.",
		author: "Dean Lofts",
	},
	settings: {
		title: "Asset Hunter",
		tagline: "A field guide to what can be made.",
		url: "https://assets.loftwah.com",
		postsPerPage: 24,
		timezone: "UTC",
	},
	blockTypes: [],
	collections: [
		{
			slug: "possibilities",
			label: "Possibilities",
			labelSingular: "Possibility",
			supports: ["drafts", "revisions", "search", "seo"],
			commentsEnabled: false,
			fields: [
				{ slug: "title", label: "Title", type: "string", required: true, searchable: true },
				{ slug: "tagline", label: "Tagline", type: "string", searchable: true },
				{ slug: "summary", label: "Summary", type: "text", required: true, searchable: true },
				{ slug: "technique", label: "Technique", type: "text", required: true, searchable: true },
				{ slug: "vertical", label: "Vertical", type: "select", required: true, searchable: true },
				{ slug: "media_kind", label: "Media", type: "select", required: true },
				{ slug: "image", label: "Representative image", type: "image" },
				{ slug: "specimen", label: "Specimen path", type: "string" },
				{ slug: "representative_origin", label: "Representative origin", type: "select", required: true },
				{ slug: "rights_status", label: "Rights", type: "select", required: true },
				{ slug: "rights_note", label: "Rights note", type: "text", searchable: true },
				{ slug: "build_notes", label: "Build notes", type: "text", searchable: true },
				{ slug: "prompt_scaffold", label: "Prompt scaffold", type: "text", searchable: true },
				{ slug: "example_count", label: "Example count", type: "integer" },
				{ slug: "distinct_sources", label: "Distinct sources", type: "integer" },
				{ slug: "novelty", label: "Novelty", type: "number" },
				{ slug: "coverage", label: "Coverage", type: "number" },
				{ slug: "editorial_rank", label: "Editorial rank", type: "number" },
				{ slug: "featured", label: "Featured", type: "boolean" },
				// --- Sync bookkeeping (#40) --------------------------------------
				// These are the fields that let a machine refresh be idempotent and
				// auditable: which hunt produced this, at which source revision,
				// when it was last written by the engine, and whether anyone has
				// decided it should be public. `visibility` is deliberately not
				// machine-set to "published" — a crawl does not get to decide what
				// the public catalogue shows.
				{ slug: "source_hunt", label: "Source hunt", type: "string" },
				{ slug: "source_ids", label: "Source candidate ids", type: "string" },
				{ slug: "source_revision", label: "Source revision", type: "string" },
				{ slug: "machine_synced_at", label: "Machine synced at", type: "string" },
				{ slug: "visibility", label: "Visibility", type: "string" },
			],
		},
		{
			slug: "examples",
			label: "Examples",
			labelSingular: "Example",
			supports: ["drafts", "revisions", "search", "seo"],
			commentsEnabled: false,
			fields: [
				{ slug: "title", label: "Title", type: "string", required: true, searchable: true },
				{
					slug: "possibility",
					label: "Possibility",
					type: "reference",
					validation: { targetCollection: "possibilities", multiple: false },
				},
				{ slug: "origin", label: "Origin", type: "select", required: true },
				{ slug: "media_kind", label: "Media", type: "select", required: true },
				{ slug: "image", label: "Image", type: "image" },
				{ slug: "specimen", label: "Specimen path", type: "string" },
				{ slug: "rights_status", label: "Rights", type: "select", required: true },
				{ slug: "rights_note", label: "Rights note", type: "text" },
				{ slug: "note", label: "Note", type: "text", searchable: true },
				{ slug: "source_url", label: "Source URL", type: "url" },
				{ slug: "source_repo", label: "Source repository", type: "string" },
				{ slug: "source_ref", label: "Source ref", type: "string" },
				{ slug: "source_path", label: "Source path", type: "string" },
				{ slug: "licence_spdx", label: "Licence SPDX", type: "string" },
				{ slug: "licence_evidence", label: "Licence evidence", type: "text" },
				{ slug: "attribution", label: "Attribution", type: "text" },
				{ slug: "content_hash", label: "Content hash", type: "string" },
				{ slug: "technical", label: "Technical data", type: "json" },
				{ slug: "downloadable", label: "Downloadable", type: "boolean" },
				{ slug: "featured", label: "Featured", type: "boolean" },
				// --- Sync bookkeeping (#40) --------------------------------------
				{ slug: "source_id", label: "Source candidate id", type: "string" },
				{ slug: "source_revision", label: "Source revision", type: "string" },
				{ slug: "source_hash", label: "Source content hash", type: "string" },
				{ slug: "machine_synced_at", label: "Machine synced at", type: "string" },
				{ slug: "visibility", label: "Visibility", type: "string" },
			],
		},
		{
			slug: "collections",
			label: "Collections",
			labelSingular: "Collection",
			supports: ["drafts", "revisions", "search", "seo"],
			commentsEnabled: false,
			fields: [
				{ slug: "title", label: "Title", type: "string", required: true, searchable: true },
				{ slug: "tagline", label: "Tagline", type: "string", searchable: true },
				{ slug: "summary", label: "Summary", type: "text", required: true, searchable: true },
				{
					slug: "members",
					label: "Members",
					type: "reference",
					validation: { targetCollection: "possibilities", multiple: true },
				},
				{ slug: "image", label: "Cover image", type: "image" },
				{ slug: "featured", label: "Featured", type: "boolean" },
			],
		},
		{
			// Community ratings (#37). An entry per rating rather than a counter on
			// the subject, so one person has one active rating and can change it,
			// and so the raw values stay inspectable instead of collapsing into a
			// single opaque score.
			slug: "ratings",
			label: "Ratings",
			labelSingular: "Rating",
			supports: ["drafts", "search"],
			commentsEnabled: false,
			fields: [
				{ slug: "title", label: "Title", type: "string", required: true },
				{ slug: "subject_type", label: "Subject type", type: "select", required: true },
				{ slug: "subject_slug", label: "Subject", type: "string", required: true, searchable: true },
				{ slug: "stars", label: "Stars", type: "integer", required: true },
				{ slug: "user_id", label: "User", type: "string", required: true },
				{ slug: "user_email", label: "User email", type: "string" },
				{ slug: "signal", label: "Signal", type: "select", required: true },
			],
		},
		{
			// Reports are not ratings. A bug report dressed up as one star is
			// indistinguishable from a bad opinion once it is averaged, so they get
			// their own queue with their own reasons.
			slug: "reports",
			label: "Reports",
			labelSingular: "Report",
			supports: ["drafts", "search"],
			commentsEnabled: false,
			fields: [
				{ slug: "title", label: "Title", type: "string", required: true },
				{ slug: "subject_type", label: "Subject type", type: "select", required: true },
				{ slug: "subject_slug", label: "Subject", type: "string", required: true, searchable: true },
				{ slug: "reason", label: "Reason", type: "select", required: true },
				{ slug: "detail", label: "Detail", type: "text" },
				{ slug: "user_id", label: "User", type: "string" },
				{ slug: "user_email", label: "User email", type: "string" },
				{ slug: "resolution", label: "Resolution", type: "text" },
			],
		},
		{
			slug: "pages",
			label: "Pages",
			labelSingular: "Page",
			supports: ["drafts", "revisions", "search", "seo"],
			commentsEnabled: false,
			fields: [
				{ slug: "title", label: "Title", type: "string", required: true, searchable: true },
				{ slug: "summary", label: "Summary", type: "text", searchable: true },
				{ slug: "content", label: "Content", type: "portableText", searchable: true },
			],
		},
	],
	taxonomies: [
		{
			name: "vertical",
			label: "Verticals",
			labelSingular: "Vertical",
			hierarchical: false,
			collections: ["possibilities", "examples"],
			terms: VERTICALS.map((v) => ({ slug: v.slug, label: v.label })),
		},
	],
	menus: [
		{
			name: "primary",
			label: "Primary",
			items: [
				{ type: "custom", label: "Catalogue", url: "/" },
				{ type: "custom", label: "Verticals", url: "/verticals" },
				{ type: "custom", label: "Collections", url: "/collections" },
				{ type: "custom", label: "Licensing", url: "/pages/licensing" },
				{ type: "custom", label: "About", url: "/pages/about" },
			],
		},
	],
	widgetAreas: [],
	sections: SECTIONS,
	bylines: [{ id: "byline-catalog", slug: "catalogue", displayName: "Catalogue" }],
	content: {
		possibilities,
		examples,
		collections,
		pages,
		// Ratings and reports are created by readers through the app, not seeded.
		ratings: [],
		reports: [],
	},
};

if (!ORIGINS.includes(representativeOrigin)) {
	problems.push(`origin vocabulary is missing "${representativeOrigin}"`);
}

if (problems.length) {
	console.error("✖ atlas validation failed:\n");
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}

const json = `${JSON.stringify(seed, null, "\t")}\n`;

if (process.argv.includes("--check")) {
	const current = readFileSync(OUT, "utf8");
	if (current !== json) {
		console.error("✖ seed/seed.json is stale — run: npm run seed:build");
		process.exit(1);
	}
	console.log("✔ seed/seed.json is up to date");
} else {
	writeFileSync(OUT, json);
	console.log(
		`✔ wrote seed/seed.json — ${possibilities.length} possibilities, ${examples.length} examples, ${collections.length} collections, ${pages.length} pages, ${VERTICALS.length} verticals`,
	);
}
