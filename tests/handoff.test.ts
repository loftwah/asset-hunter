/**
 * The implementation handoff (#51).
 *
 * Every rule asserted here is a rule that fails by producing a plausible
 * document rather than an error, so they are assertions rather than code review:
 *
 * - reference-only material must never read as reusable in a handoff, including
 *   when the *entry* claims to be cleared, because the weakest example is what
 *   decides;
 * - a field the reader never recorded stays `null` and is named as unrecorded —
 *   the same `null`-is-not-`0` discipline the catalogue JSON holds;
 * - nothing is invented: no goal, no platform, no acceptance criteria appear
 *   unless they were supplied;
 * - a slug the catalogue does not have is reported rather than silently dropped,
 *   because a handoff that quietly omits one of three requested possibilities
 *   cannot be told apart from one where the reader chose two;
 * - the Markdown rendering carries every rights statement the JSON does, so
 *   "read it as Markdown" cannot lose the obligations.
 *
 * `buildHandoff` is pure, so all of this runs with no database, no clock and no
 * server — which is the point of the split with `buildHandoffEffect`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
	HANDOFF_SCHEMA,
	MAX_FIELD_CHARS,
	absolute,
	buildHandoff,
	handoffPaths,
	parseSlugList,
	renderHandoffMarkdown,
	resolveHandoffSlugs,
	weakestUseState,
	type HandoffDocument,
	type HandoffRequest,
} from "../src/lib/handoff.ts";
import { MAX_PER_BOARD } from "../src/lib/board.ts";
import type { Example, Possibility } from "../src/lib/catalogue.ts";
import { recordDocument } from "../src/lib/asset-use.ts";

const SITE = "https://assets.loftwah.com";

const example = (over: Partial<Example> = {}): Example => ({
	slug: "ex-reference",
	title: "An example kept as evidence",
	origin: "generated",
	mediaKind: "image",
	specimen: "/specimens/diegetic-damage.svg",
	image: null,
	rightsStatus: "reference",
	rightsNote: "No licence was found on the source.",
	note: null,
	sourceUrl: "https://example.invalid/repo/blob/main/frame.png",
	sourceRepo: "owner/repo",
	sourceRef: "abc1234",
	sourcePath: "shots/frame.png",
	licenceSpdx: null,
	licenceEvidence: null,
	attribution: null,
	contentHash: null,
	downloadable: false,
	...over,
});

const possibility = (over: Partial<Possibility> = {}): Possibility => ({
	slug: "diegetic-damage",
	title: "Health you read off the world, not off a bar",
	tagline: "Damage as cracked glass instead of a red rectangle",
	summary: "Replace the health bar with a surface that degrades.",
	technique: "Layer a damage-state overlay on a first-person frame.",
	vertical: "games",
	mediaKind: "image",
	specimen: "/specimens/diegetic-damage.svg",
	image: null,
	representativeOrigin: "generated",
	rightsStatus: "reference",
	rightsNote: "The technique is free to use; the asset is not.",
	buildNotes: "Three states rather than a continuous fill.",
	promptScaffold: "First-person frame. A cracked helmet visor overlay.",
	exampleCount: 1,
	distinctSources: 0,
	novelty: null,
	coverage: null,
	editorialRank: 0.5,
	featured: false,
	...over,
});

interface Seed {
	possibilities?: Possibility[];
	examples?: Record<string, Example[]>;
}

const CATALOGUE: Seed = {
	possibilities: [
		possibility(),
		possibility({
			slug: "crowd-fluid",
			title: "Crowds that move as a fluid",
			tagline: "Density field instead of agents",
			// An entry that claims to be cleared while its only example is not.
			// The possibility-level claim is the thing the rules must survive.
			rightsStatus: "cleared",
			rightsNote: null,
			specimen: "/specimens/crowd-fluid.svg",
		}),
		possibility({ slug: "raymarched-sdf", title: "Raymarched distance fields", rightsStatus: null }),
	],
	examples: {
		"diegetic-damage": [example()],
		"crowd-fluid": [example({ slug: "crowd-plate", title: "A generated crowd plate" })],
		"raymarched-sdf": [
			example({
				slug: "sdf-mit",
				title: "An MIT-licensed shader",
				rightsStatus: "attribution",
				rightsNote: "MIT. Attribution required if reused.",
				licenceSpdx: "MIT",
				licenceEvidence: "MIT License … Permission is hereby granted, free of charge …",
				attribution: "© 2024 Example Author",
				contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
				downloadable: true,
			}),
		],
	},
};

function build(
	over: {
		slugs?: string[];
		source?: "slugs" | "cookie";
		boardName?: string | null;
		request?: HandoffRequest;
		now?: Date;
		query?: string;
		seed?: Seed;
	} = {},
): HandoffDocument {
	const seed = { ...CATALOGUE, ...over.seed };
	const known = new Map((seed.possibilities ?? []).map((p) => [p.slug, p]));
	return buildHandoff({
		site: SITE,
		slugs: over.slugs ?? ["diegetic-damage"],
		source: over.source ?? "slugs",
		boardName: over.boardName ?? null,
		known,
		examples: new Map(Object.entries(seed.examples ?? {})),
		request: over.request ?? {},
		now: over.now ?? new Date("2026-02-01T00:00:00.000Z"),
		query: over.query ?? "?slugs=diegetic-damage",
	});
}

/* -------------------------------------------------------------------------- */

describe("the handoff document", () => {
	test("declares its version and repeats it in the contract block", () => {
		const doc = build();
		assert.equal(doc.schema, HANDOFF_SCHEMA);
		assert.equal(doc.schema, "asset-hunter.handoff/1");
		assert.equal(doc.contract.catalogue.schema, "asset-hunter.catalogue/1");
		assert.match(doc.fingerprint, /^[0-9a-f]{8}$/);
	});

	test("references the same canonical routes the site serves", () => {
		const doc = build();
		const p = doc.possibilities[0];
		assert.equal(p.url, `${SITE}/possibilities/diegetic-damage`);
		assert.equal(p.useUrl, `${SITE}/use/diegetic-damage`);
		assert.equal(p.examples[0].record, `${SITE}/api/record/ex-reference`);
		assert.equal(doc.contract.catalogue.url, `${SITE}/api/catalogue.json`);
	});

	test("keeps null distinct from zero, including the unrecorded list", () => {
		const doc = build({ slugs: ["diegetic-damage", "raymarched-sdf"] });
		// Nothing was recorded, so every optional field is null and all five are
		// named. A `""` or a `0` here would read as "recorded as blank".
		assert.equal(doc.objective.goal, null);
		assert.deepEqual(doc.objective.unrecorded, [
			"goal",
			"surface",
			"platform",
			"constraints",
			"acceptance",
		]);
		// And `distinctSources` is 0 here in the record, while the machine
		// observations are null — neither leaks into the other.
		const p = doc.possibilities.find((x) => x.id === "diegetic-damage");
		assert.ok(p);
		assert.equal("novelty" in p, false, "the handoff must not carry machine observations");
		assert.equal("communityRating" in p, false, "the handoff must not carry opinions");
	});

	test("carries what was recorded and names only what was not", () => {
		const doc = build({
			slugs: ["diegetic-damage"],
			request: {
				goal: "A HUD for a first-person game with no health bar",
				platform: "Desktop and Steam Deck, 16:9 and 21:9",
			},
		});
		assert.equal(doc.objective.goal, "A HUD for a first-person game with no health bar");
		assert.equal(doc.objective.platform, "Desktop and Steam Deck, 16:9 and 21:9");
		assert.equal(doc.objective.surface, null);
		assert.deepEqual(doc.objective.unrecorded, ["surface", "constraints", "acceptance"]);
	});

	test("a recorded field is trimmed and capped rather than reflected whole", () => {
		const doc = build({ request: { goal: `   ${"x".repeat(MAX_FIELD_CHARS * 2)}   ` } });
		assert.ok(doc.objective.goal, "the goal was dropped instead of capped");
		assert.equal(doc.objective.goal?.length, MAX_FIELD_CHARS + 1, "length + ellipsis");
		assert.equal(doc.objective.goal?.endsWith("…"), true);
	});
});

describe("rights survive the handoff", () => {
	test("every example carries its status, its use state and its obligation", () => {
		const doc = build({ slugs: ["raymarched-sdf"] });
		const e = doc.possibilities[0].examples[0];
		assert.equal(e.id, "sdf-mit");
		assert.equal(e.rightsStatus, "attribution");
		assert.equal(e.useState, "reusable-with-attribution");
		assert.equal(e.useStateLabel, "Reusable with attribution");
		assert.match(e.obligation ?? "", /Reproduce the recorded credit/);
		// All four handoff conditions hold for this fixture — permitted, credited,
		// retained and hashed — so nothing blocked it and the original is on offer.
		assert.equal(e.blockedBy, null);
		assert.equal(e.handoff, "payload");
	});

	test("the use state agrees with the record endpoint for the same example", () => {
		// One mapping, in one place: if these two ever disagree, the drill-in, the
		// use page, the payload route and the handoff are describing different
		// catalogues, which is the failure the whole module exists to prevent.
		const source = CATALOGUE.examples?.["raymarched-sdf"]?.[0] as Example;
		const doc = build({ slugs: ["raymarched-sdf"] });
		const record = recordDocument(source);
		const e = doc.possibilities[0].examples[0];
		assert.equal(e.useState, record.useState);
		assert.equal(e.useStateLabel, record.useStateLabel);
		assert.equal(e.obligation, record.obligation);
		assert.equal(e.handoff, record.handoff);
		assert.equal(e.blockedBy, record.handoffBlockedBy);
		assert.equal(e.licence.spdx, record.licenceSpdx);
		assert.equal(e.licence.evidence, record.licenceEvidence);
		assert.deepEqual(e.provenance.contentHash, record.contentHash);
	});

	test("the weakest example decides the entry, computed rather than stored", () => {
		// `crowd-fluid` stores `cleared` while its only example is reference-only.
		// The handoff must not repeat the stored claim as the answer.
		const doc = build({ slugs: ["crowd-fluid"] });
		const p = doc.possibilities[0];
		assert.equal(p.rightsStatus, "cleared", "the stored status is still reported as recorded");
		assert.equal(p.examplesUseState, "reference-only", "…but the computed one is not");
		assert.equal(p.examples[0].useState, "reference-only");
	});

	test("an entry with no examples is not treated as cleared", () => {
		const doc = build({
			slugs: ["diegetic-damage"],
			seed: { possibilities: CATALOGUE.possibilities, examples: {} },
		});
		const p = doc.possibilities[0];
		assert.deepEqual(p.examples, []);
		assert.equal(p.examplesUseState, "reference-only");
	});

	test("reference-only examples are named in do not copy, worst first", () => {
		const doc = build({ slugs: ["diegetic-damage", "raymarched-sdf"] });
		const exampleEntries = doc.doNotCopy.filter(
			(entry) => !entry.subject.endsWith("(the possibility)") && !entry.subject.endsWith("preview"),
		);
		assert.equal(
			exampleEntries.length,
			2,
			`one entry per non-reusable example: ${JSON.stringify(doc.doNotCopy, null, 2)}`,
		);
		// Worst first: the reference-only example precedes the attribution one.
		assert.match(exampleEntries[0].subject, /ex-reference/);
		assert.match(exampleEntries[1].subject, /sdf-mit/);
		assert.match(exampleEntries[0].reason, /Do not copy, ship or redistribute/);
	});

	test("the possibility's own rights note leads the section", () => {
		const doc = build({ slugs: ["diegetic-damage"] });
		assert.equal(doc.doNotCopy[0].subject, "diegetic-damage (the possibility)");
		assert.match(doc.doNotCopy[0].reason, /The technique is free to use/);
	});

	test("a reusable example contributes nothing to do not copy", () => {
		// Padding the section with reassurance trains a reader to skip it.
		const doc = build({
			slugs: ["diegetic-damage"],
			seed: {
				possibilities: CATALOGUE.possibilities,
				examples: {
					"diegetic-damage": [
						example({
							rightsStatus: "cleared",
							attribution: "© 2024 Example Author",
							contentHash:
								"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
							downloadable: true,
						}),
					],
				},
			},
		});
		assert.deepEqual(doc.doNotCopy.filter((entry) => entry.subject.startsWith("ex-reference")), []);
		// The generated plate is still named: it is not the source asset whichever
		// licence the example carries.
		assert.ok(doc.doNotCopy.some((entry) => entry.subject.endsWith("preview")));
	});

	test("the whole-handoff summary keeps the honest zero", () => {
		const doc = build({ slugs: ["diegetic-damage"] });
		assert.equal(doc.rights.examples, 1);
		assert.equal(doc.rights.payloads, 0);
		assert.equal(doc.rights.byState["reference-only"], 1);
		assert.equal(doc.rights.byState.reusable, 0);
		assert.equal(doc.rights.summary, "1 reference only");
	});

	test("credits travel as recorded text, and only where one is owed", () => {
		const withCredit = build({ slugs: ["raymarched-sdf"] });
		assert.match(withCredit.credits ?? "", /© 2024 Example Author/);
		assert.match(withCredit.credits ?? "", /Licence: MIT/);
		const withoutCredit = build({ slugs: ["diegetic-damage"] });
		// A selection of reference-only material owes no credit, so it has no credit
		// block. The provenance those examples do carry travels per example instead —
		// a credits file nobody is meant to publish is noise, and noise is what this
		// document is not allowed to add.
		assert.equal(withoutCredit.credits, null);
		assert.equal(withoutCredit.possibilities[0].examples[0].provenance.sourceRepo, "owner/repo");
	});
});

describe("the decision", () => {
	test("no recorded choice is null, not an empty array", () => {
		const doc = build({ slugs: ["diegetic-damage"] });
		assert.equal(doc.decision.recorded, false);
		assert.equal(doc.decision.chosen, null);
		assert.deepEqual(doc.decision.rejected, []);
		assert.equal(doc.possibilities[0].decision, "candidate");
		// And the prose says so rather than promoting the only entry.
		assert.ok(doc.achieve.some((line) => line.startsWith("Not yet chosen:")));
	});

	test("chosen entries lead, and rejected ones trail", () => {
		const doc = build({
			slugs: ["diegetic-damage", "crowd-fluid", "raymarched-sdf"],
			request: { chose: ["raymarched-sdf"], rejected: ["crowd-fluid"] },
		});
		assert.equal(doc.decision.recorded, true);
		assert.deepEqual(doc.decision.chosen, ["raymarched-sdf"]);
		assert.deepEqual(doc.decision.rejected, ["crowd-fluid"]);
		assert.deepEqual(
			doc.possibilities.map((p) => p.decision),
			["chosen", "candidate", "rejected"],
		);
	});

	test("a mark naming something not in the handoff is dropped, not honoured", () => {
		const doc = build({ slugs: ["diegetic-damage"], request: { chose: ["not-in-here"] } });
		assert.equal(doc.decision.recorded, false);
		assert.equal(doc.decision.chosen, null);
	});

	test("unknown slugs are reported rather than silently dropped", () => {
		const doc = build({ slugs: ["diegetic-damage", "nope-not-real"] });
		assert.equal(doc.board.requested, 2);
		assert.equal(doc.board.resolved, 1);
		assert.deepEqual(doc.board.unknown, ["nope-not-real"]);
		const md = renderHandoffMarkdown(doc);
		assert.match(md, /Unknown slugs/);
		assert.match(md, /nope-not-real/);
	});

	test("a request past the board cap is reported as overflow", () => {
		const many = Array.from({ length: MAX_PER_BOARD + 3 }, (_, i) => `p-${i}`);
		const doc = build({
			slugs: many,
			seed: { possibilities: many.map((slug) => possibility({ slug })), examples: {} },
		});
		assert.equal(doc.board.requested, MAX_PER_BOARD + 3);
		assert.equal(doc.possibilities.length, MAX_PER_BOARD);
		assert.deepEqual(doc.board.overflow, ["p-24", "p-25", "p-26"]);
		assert.equal(doc.board.unknown.length, 0);
	});

	test("the fingerprint is content, not the timestamp or the address", () => {
		const a = build({ now: new Date("2026-02-01T00:00:00.000Z"), query: "?slugs=a" });
		const b = build({ now: new Date("2030-09-09T09:09:09.000Z"), query: "?slugs=b" });
		assert.notEqual(a.generated, b.generated);
		assert.equal(a.fingerprint, b.fingerprint, "same records, different clock and address");

		const c = build({ request: { goal: "Something different" } });
		assert.notEqual(a.fingerprint, c.fingerprint, "different content, different digest");
	});

	test("weakest use state is null for no examples and worst-first otherwise", () => {
		assert.equal(weakestUseState([]), null);
		assert.equal(
			weakestUseState(["reusable", "reference-only", "reusable-with-attribution"]),
			"reference-only",
		);
		assert.equal(weakestUseState(["reusable", "review-required"]), "review-required");
		assert.equal(weakestUseState(["reusable", "reusable-with-attribution"]), "reusable-with-attribution");
	});
});

describe("choosing what to build from", () => {
	test("explicit slugs win over the reader's board", () => {
		const resolved = resolveHandoffSlugs(
			{ slugs: ["a", "b"], board: "shortlist" },
			{ default: ["x"] },
		);
		assert.deepEqual(resolved, { slugs: ["a", "b"], source: "slugs", name: null });
	});

	test("a named board is read through the same normaliser as the board page", () => {
		const resolved = resolveHandoffSlugs({ slugs: [], board: "  launch  " }, { launch: ["x"] });
		assert.deepEqual(resolved, { slugs: ["x"], source: "cookie", name: "launch" });
		// The default board answers to both its name and no name at all.
		const fallback = resolveHandoffSlugs({ slugs: [], board: null }, { default: ["y"] });
		assert.equal(fallback?.source, "cookie");
	});

	test("nothing to build from is null, so the route can ask for it", () => {
		assert.equal(resolveHandoffSlugs({ slugs: [], board: null }, { default: [] }), null);
		assert.equal(resolveHandoffSlugs({ slugs: [], board: "empty" }, { default: ["x"] }), null);
	});

	test("a slug list parses from commas or whitespace, de-duplicated", () => {
		assert.deepEqual(parseSlugList("a,b c,,a"), ["a", "b", "c"]);
		assert.deepEqual(parseSlugList(""), []);
		assert.deepEqual(parseSlugList(null), []);
	});

	test("absolute joins a site and a path without doubling the slash", () => {
		assert.equal(absolute(SITE, "/x"), `${SITE}/x`);
		assert.equal(absolute(`${SITE}/`, "/x"), `${SITE}/x`);
		assert.equal(absolute(SITE, "https://other.invalid/y"), "https://other.invalid/y");
		assert.equal(absolute(SITE, ""), null);
	});

	test("the markdown link is the same address with the format on it", () => {
		assert.equal(handoffPaths.markdown("slugs=a"), "/api/handoff.json?slugs=a&format=md");
		assert.equal(handoffPaths.markdown(""), "/api/handoff.json?format=md");
		// A leading `?` from a caller must not produce `?=slugs=a` or `?slugs=aformat=md`.
		assert.equal(handoffPaths.markdown("?slugs=a"), "/api/handoff.json?slugs=a&format=md");
		assert.equal(handoffPaths.json("?slugs=a"), "/api/handoff.json?slugs=a");
		assert.equal(handoffPaths.json(), "/api/handoff.json");
	});
});

describe("the Markdown rendering", () => {
	test("names what to achieve and the rights, in a pasteable document", () => {
		const doc = build({
			slugs: ["raymarched-sdf"],
			request: { goal: "A skybox for a flight sim", acceptance: "A capture at four angles" },
		});
		const md = renderHandoffMarkdown(doc);
		assert.match(md, /^# Implementation handoff — Raymarched distance fields/m);
		assert.match(md, /Achieve: A skybox for a flight sim/);
		assert.match(md, /Evidence required: A capture at four angles/);
		assert.match(md, /Do not copy these/);
		assert.match(md, /Reusable with attribution/);
		assert.match(md, /asset-hunter\.record|Record: https:\/\/assets\.loftwah\.com\/api\/record\//);
		assert.match(md, /Licence: MIT/);
	});

	test("carries the same rights statements the JSON does", () => {
		const doc = build({ slugs: ["diegetic-damage", "raymarched-sdf"] });
		const md = renderHandoffMarkdown(doc);
		for (const p of doc.possibilities) {
			for (const e of p.examples) {
				assert.ok(md.includes(e.id), `Markdown lost ${e.id}`);
				assert.ok(md.includes(e.useStateLabel), `Markdown lost the use state of ${e.id}`);
				if (e.obligation) assert.ok(md.includes(e.obligation), `Markdown lost the obligation of ${e.id}`);
			}
		}
		// And the standing rule survives into the paste.
		assert.match(md, /Possibility is not permission/);
	});

	test("lists what was not recorded rather than omitting it", () => {
		const md = renderHandoffMarkdown(build());
		assert.match(md, /## Not recorded/);
		assert.match(md, /`goal` — not recorded/);
		assert.match(md, /`chosen` — no option was marked/);
	});

	test("says nothing is reference-only only when it computed that", () => {
		const clean = build({
			slugs: ["diegetic-damage"],
			seed: {
				possibilities: [
					possibility({
						// No rights note and an upstream representative, so the only
						// thing left that could warn is an example.
						rightsNote: null,
						representativeOrigin: "upstream",
					}),
				],
				examples: {
					"diegetic-damage": [
						example({
							origin: "upstream",
							rightsStatus: "cleared",
							attribution: "© 2024 Example Author",
							contentHash:
								"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
							downloadable: true,
						}),
					],
				},
			},
		});
		assert.deepEqual(clean.doNotCopy, []);
		const md = renderHandoffMarkdown(clean);
		assert.match(md, /Nothing on this handoff is reference-only/);
		// …and it says that as a claim about the evidence rather than a promise.
		assert.match(md, /does not survive a change to it/);
	});

	test("records where the document came from, so a decision can be traced", () => {
		const doc = build({ source: "cookie", boardName: "launch", slugs: ["diegetic-damage"] });
		const md = renderHandoffMarkdown(doc);
		assert.match(md, /Catalogue contract: `asset-hunter\.catalogue\/1`/);
		assert.match(md, /fingerprint `[0-9a-f]{8}`/);
		assert.match(md, /the reader's board/);
		assert.equal(doc.board.source, "cookie");
	});
});