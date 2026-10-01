/**
 * Engine unit tests.
 *
 * These are the rules that must hold even when nothing is crawled: a brief is
 * checked before it is trusted, a licence is classified from evidence rather
 * than from metadata, a payload cannot carry fabricated evidence or a
 * human-owned field, and the same input always produces the same output.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { briefFingerprint, validateBrief } from "../engine/src/brief.ts";
import {
	assetLicenceFor,
	classify,
	detectFromText,
	normaliseSpdx,
	pickLicenceFile,
	spdxFromFilename,
} from "../engine/src/licence.ts";
import { isWorthReading } from "../engine/src/github.ts";
import { candidateId, loadCandidates, recordCandidate, recordWave, summarise } from "../engine/src/candidates.ts";
import {
	extractPossibilities,
	keywordsOf,
	leadPhrase,
	mediaKindsOf,
	similarity,
	termCorpus,
} from "../engine/src/possibility.ts";
import {
	buildPayload,
	validatePayload,
	worstRights,
} from "../engine/src/publish.ts";
import { mergeExample, mergePossibility, shouldPublish } from "../engine/src/merge.ts";
import type { Candidate } from "../engine/src/candidates.ts";

const MERGE_INCOMING = {
	title: "Machine title",
	summary: "Machine summary",
	technique: "Machine technique",
	vertical: "audio-music",
	media_kind: "code",
	representative_origin: "generated",
	rights_status: "reference",
	rights_note: "n",
	example_count: 2,
	distinct_sources: 1,
	novelty: null,
	coverage: null,
	source_hunt: "abc:sfx",
	source_ids: "a/b,c/d",
	source_revision: "abc123",
	machine_synced_at: "2026-10-01T00:00:00.000Z",
};

const MIT_TEXT = `MIT License

Copyright (c) 2020 Someone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.`;

const GPL_TEXT = `GNU GENERAL PUBLIC LICENSE
Version 3, 29 June 2007

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.`;

const ND_TEXT = `Creative Commons Attribution-NonDerivatives 4.0 International

You are free to share the material in any medium or format. You may not
produce derivative material.`;

describe("hunt brief", () => {
	test("accepts a brief that states intent, verticals and queries", () => {
		const { problems, brief } = validateBrief({
			intent: "sound effects",
			verticals: ["audio-music"],
			queries: ["procedural sound effects"],
		});
		assert.deepEqual(problems, []);
		assert.equal(brief.intent, "sound effects");
	});

	test("reports every problem at once rather than only the first", () => {
		const { problems } = validateBrief({ constraints: { minStars: -1 } });
		assert.ok(problems.length >= 3, `expected several problems, got: ${problems.join("; ")}`);
		assert.ok(problems.some((p) => p.includes("intent")));
		assert.ok(problems.some((p) => p.includes("verticals")));
		assert.ok(problems.some((p) => p.includes("queries")));
	});

	test("rejects an unknown rights floor rather than defaulting it", () => {
		const { problems } = validateBrief({
			intent: "x",
			verticals: ["games"],
			queries: ["x"],
			constraints: { rightsFloor: "probably-fine" },
		});
		assert.ok(problems.some((p) => p.includes("rightsFloor")));
	});

	test("the fingerprint ignores prose but not decisions", () => {
		const base = {
			intent: "one thing",
			verticals: ["games"],
			queries: ["a"],
		};
		const same = { ...base, intent: "a completely different sentence" };
		assert.equal(briefFingerprint(base), briefFingerprint(same));
		const different = { ...base, minStars: undefined, queries: ["b"] };
		assert.notEqual(briefFingerprint(base as never), briefFingerprint({ ...base, queries: ["b"] }));
		assert.equal(typeof different.queries[0], "string");
	});
});

describe("licence classification", () => {
	test("reads MIT from the text and requires attribution", () => {
		const c = classify({ licenceText: MIT_TEXT, licencePath: "LICENSE" });
		assert.equal(c.status, "attribution");
		assert.equal(c.evidence.spdx, "MIT");
		assert.match(c.meaning, /MIT/);
	});

	test("a filename is a hint, never the classification", () => {
		// The first version of this engine passed the licence *path* to the
		// normaliser, so "LICENSE-MIT" was classified as an unknown licence
		// called LICENSE-MIT and every MIT repository came out as `review`.
		const c = classify({ licenceText: MIT_TEXT, licencePath: "LICENSE-MIT" });
		assert.equal(c.status, "attribution");
		assert.equal(c.evidence.spdx, "MIT");
		assert.equal(spdxFromFilename("LICENSE-MIT"), "MIT");
		// A filename that does not identify a known licence identifies nothing.
		assert.equal(spdxFromFilename("COPYING.FOO"), null);
		assert.equal(spdxFromFilename("LICENSE"), null);
	});

	test("the text wins over the filename when they disagree", () => {
		const c = classify({ licenceText: GPL_TEXT, licencePath: "LICENSE-MIT" });
		assert.equal(c.status, "review");
		assert.match(c.meaning, /copyleft/);
	});

	test("a no-derivatives licence is reference, not review", () => {
		const c = classify({ licenceText: ND_TEXT, licencePath: "LICENSE" });
		assert.equal(c.status, "reference");
		assert.match(c.meaning, /derivatives/i);
	});

	test("unverified repository metadata is review, never cleared", () => {
		const c = classify({ githubSpdxHint: "MIT" });
		assert.equal(c.status, "review");
		assert.match(c.meaning, /not as permission/);
	});

	test("nothing found is reference with a stated extent of permission", () => {
		const c = classify({});
		assert.equal(c.status, "reference");
		assert.match(c.meaning, /entire extent of its permission/);
		assert.equal(c.evidence.spdx, null);
	});

	test("a licence beside the asset outranks the repository licence", () => {
		const c = classify({
			licenceText: GPL_TEXT,
			licencePath: "LICENSE",
			assetLicenceText: MIT_TEXT,
			assetLicencePath: "fonts/OFL.txt",
		});
		assert.equal(c.status, "attribution");
		assert.equal(c.assetScoped, true);
		assert.equal(c.evidence.sourcePath, "fonts/OFL.txt");
	});

	test("a repository licence is never presented as asset-scoped", () => {
		const c = classify({ licenceText: MIT_TEXT, licencePath: "LICENSE" });
		assert.equal(c.assetScoped, false);
		assert.match(c.evidence.note, /not automatically every file/);
	});

	test("records the hash of the exact bytes it read", () => {
		const a = classify({ licenceText: MIT_TEXT, licencePath: "LICENSE" });
		const b = classify({ licenceText: MIT_TEXT, licencePath: "LICENSE" });
		const c = classify({ licenceText: `${MIT_TEXT} `, licencePath: "LICENSE" });
		assert.equal(a.evidence.contentHash, b.evidence.contentHash);
		assert.notEqual(a.evidence.contentHash, c.evidence.contentHash);
	});

	test("quotes the licence verbatim rather than paraphrasing it", () => {
		const c = classify({ licenceText: MIT_TEXT, licencePath: "LICENSE" });
		assert.ok(c.evidence.quote?.includes("Permission is hereby granted"));
	});

	test("NOASSERTION is not a licence", () => {
		assert.equal(normaliseSpdx("NOASSERTION"), null);
		assert.equal(detectFromText("Some unrelated text"), null);
	});

	test("picks the licence file and finds asset-scoped ones", () => {
		const paths = ["src/index.ts", "node_modules/x/LICENSE", "LICENSE.md", "fonts/OFL.txt", "fonts/a.woff2"];
		assert.equal(pickLicenceFile(paths), "LICENSE.md");
		assert.equal(assetLicenceFor(paths, "fonts/a.woff2"), "fonts/OFL.txt");
		assert.equal(assetLicenceFor(paths, "src/index.ts"), null);
	});
});

describe("candidate store", () => {
	test("is content-addressed, resumable and disposable", () => {
		const dir = mkdtempSync(join(tmpdir(), "ah-engine-"));
		try {
			const candidate: Candidate = {
				id: candidateId({ fullName: "a/b", ref: "abc123", stars: 1 }),
				fullName: "a/b",
				owner: "a",
				repo: "b",
				ref: "abc123",
				stars: 1,
				description: "d",
				topics: [],
				htmlUrl: "https://github.com/a/b",
				defaultBranch: "main",
				archived: false,
				fork: false,
				pushedAt: "2026-01-01T00:00:00Z",
				rights: {
					status: "reference",
					spdx: null,
					licencePath: null,
					licenceUrl: null,
					licenceSha256: null,
					quote: null,
					githubSpdxHint: null,
					note: "none",
					meaning: "none",
					assetScoped: false,
				},
				files: [],
				interesting: [],
				discoveredBy: null,
				policyApplied: "keep",
				firstSeen: "2026-01-01T00:00:00Z",
				lastSeen: "2026-01-01T00:00:00Z",
				observations: 1,
			};

			const { isNew } = recordCandidate(dir, candidate);
			assert.equal(isNew, true);
			const second = recordCandidate(dir, candidate);
			assert.equal(second.isNew, false);

			const stored = [...loadCandidates(dir).values()];
			assert.equal(stored.length, 1);
			assert.equal(stored[0].observations, 2, "a re-crawl counts as another observation");
			assert.equal(stored[0].firstSeen, candidate.firstSeen, "firstSeen is append-only");

			recordWave(dir, { query: "q", page: 1, found: 5, kept: 2, completedAt: "now" });
			assert.equal(summarise(stored).total, 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("skips vendored, minified and lock files", () => {
		assert.equal(isWorthReading("node_modules/x/index.js", 10), false);
		assert.equal(isWorthReading("dist/app.js", 10), false);
		assert.equal(isWorthReading("yarn.lock", 10), false);
		assert.equal(isWorthReading("a/b.min.js", 10), false);
		assert.equal(isWorthReading("a/b.js", 10), true);
		assert.equal(isWorthReading("a/big.wav", 1024 * 1024), false);
	});
});

/** A candidate with only the fields the extractor reads. */
const makeCandidate = (fullName: string, description: string, files: string[] = []): Candidate => ({
	id: candidateId({ fullName, ref: "0".repeat(40), stars: 10 }),
	fullName,
	owner: fullName.split("/")[0],
	repo: fullName.split("/")[1],
	ref: "0".repeat(40),
	stars: 10,
	description,
	topics: [],
	htmlUrl: `https://github.com/${fullName}`,
	defaultBranch: "main",
	archived: false,
	fork: false,
	pushedAt: "2026-01-01T00:00:00Z",
	rights: {
		status: "reference",
		spdx: null,
		licencePath: null,
		licenceUrl: null,
		licenceSha256: null,
		quote: null,
		githubSpdxHint: null,
		note: "none",
		meaning: "none",
		assetScoped: false,
	},
	discoveredBy: null,
	policyApplied: "keep",
	files: files.map((path) => ({
		path,
		size: 10,
		sha256: "deadbeef",
		blobUrl: null,
		kind: path.split(".").pop() === "wav" ? "audio" : "code",
	})),
	interesting: [],
	firstSeen: "2026-01-01T00:00:00Z",
	lastSeen: "2026-01-01T00:00:00Z",
	observations: 1,
});

describe("compression into possibilities", () => {
	const sfxr = makeCandidate("a/sfxr", "A port of the SFXR sound effect generator", ["main.cpp"]);
	const sfxrQt = makeCandidate("b/sfxr-qt", "Qt port of SFXR, a sound effect generator", ["NoiseGenerator.cpp"]);
	const wavetable = makeCandidate("c/wavetable", "Wavetable synthesis for embedded", ["synth.c"]);
	const game = makeCandidate("d/game", "A small game with music", ["main.ts"]);

	test("groups implementations of one treatment and separates others", () => {
		const out = extractPossibilities([sfxr, sfxrQt, wavetable, game], {
			vertical: "audio-music",
			intent: "sound effects",
		});
		const withBoth = out.find((p) => p.examples.length === 2);
		assert.ok(withBoth, "the two SFXR ports should be one possibility");
		assert.deepEqual(
			withBoth.examples.map((e) => e.fullName).sort(),
			["a/sfxr", "b/sfxr-qt"],
		);
		assert.equal(out.length, 3, "18 sources should not become 18 entries");
	});

	test("the subject of the hunt is not mistaken for the technique", () => {
		// Every candidate here is about audio, so `audio` and `sound` cannot
		// distinguish them. Only `wavetable` can.
		const many = Array.from({ length: 8 }, (_, i) =>
			makeCandidate(`x${i}/audio`, `An audio tool number ${i} for sound design`, ["a.c"]),
		);
		const corpus = termCorpus(many);
		assert.ok(corpus.generic.has("audio"), "audio is generic across the corpus");
		assert.equal(similarity(many[0], many[1], corpus).score, 0);
	});

	test("a rare shared term is enough on its own", () => {
		const corpus = termCorpus([sfxr, sfxrQt, wavetable, game]);
		assert.ok(similarity(sfxr, sfxrQt, corpus).score > 0);
		assert.equal(similarity(wavetable, game, corpus).score, 0);
	});

	test("clustering never chains through an intermediary", () => {
		// A and B share two terms. B and C share one. A and C share none, so a
		// transitive grouper would put all three in one entry describing a
		// treatment that does not exist.
		const a = makeCandidate("a/one", "Granular texture pads", ["a.c"]);
		const b = makeCandidate("b/two", "Granular texture mixing", ["b.c"]);
		const c = makeCandidate("c/three", "Mixing reverb chains", ["c.c"]);
		const out = extractPossibilities([a, b, c], { vertical: "audio-music", intent: "x" });
		const sizes = out.map((p) => p.examples.length).sort();
		assert.ok(sizes.includes(1), `at least one candidate must stand alone, got ${sizes.join(",")}`);
		assert.ok(Math.max(...sizes) <= 2, `expected no chain of three, got ${sizes.join(",")}`);
	});

	test("distinct sources count only licences that were actually read", () => {
		const verified = (c: Candidate): Candidate => ({
			...c,
			rights: { ...c.rights, status: "attribution", spdx: "MIT" },
		});
		const both = extractPossibilities([verified(sfxr), verified(sfxrQt)], {
			vertical: "audio-music",
			intent: "x",
		});
		assert.equal(both[0].examples.length, 2, "the two SFXR ports are one group");
		assert.equal(both[0].distinctSources, 2);

		const one = extractPossibilities([sfxr, verified(sfxrQt)], {
			vertical: "audio-music",
			intent: "x",
		});
		assert.equal(one[0].distinctSources, 1, "one readable licence is one verified source");

		const none = extractPossibilities([sfxr, sfxrQt], { vertical: "audio-music", intent: "x" });
		assert.equal(none[0].distinctSources, 0, "no readable licence means 0, not 2");
	});

	test("novelty and coverage are null, not estimated", () => {
		const out = extractPossibilities([sfxr], { vertical: "audio-music", intent: "x" });
		assert.equal(out[0].novelty, null);
		assert.equal(out[0].coverage, null);
	});

	test("human-owned fields are explicitly null in the extraction", () => {
		const out = extractPossibilities([sfxr], { vertical: "audio-music", intent: "x" });
		for (const field of ["editorialRank", "featured", "buildNotes", "promptScaffold"] as const) {
			assert.equal(out[0][field], null, `${field} must be null so the payload cannot carry it`);
		}
	});

	test("titles are readable rather than keyword soup", () => {
		assert.equal(
			leadPhrase("Qt port of SFXR, a sound effect generator, to generate retro sounds.", "fallback"),
			"Qt port of SFXR",
		);
		// Cut at nine words, then drop the dangling word rather than ending on
		// a preposition.
		const long = leadPhrase(
			"A high-speed endless racing audio game submitted to a game jam somewhere in the world",
			"x",
		);
		assert.ok(!/\b(of|and|to|in|for|with|at|by|from)$/i.test(long), `dangling ending: "${long}"`);
		assert.ok(long.split(/\s+/).length <= 9);
		assert.equal(leadPhrase(null, "fallback"), "fallback");
		assert.equal(leadPhrase("Hi.", "fallback"), "fallback");
	});

	test("media kinds come from the files that were read", () => {
		assert.deepEqual(mediaKindsOf(sfxr), ["code"]);
		assert.deepEqual(mediaKindsOf(makeCandidate("e/wav", "wav", ["a.wav"])), ["audio"]);
	});

	test("stop words cannot define a group", () => {
		const terms = keywordsOf(makeCandidate("a/b", "An awesome list of great tools and demos", []));
		assert.ok(!terms.includes("awesome"));
		assert.ok(!terms.includes("tools"));
	});
});

describe("publish payload", () => {
	const built = () =>
		buildPayload(
			extractPossibilities(
				[
					makeCandidate("a/sfxr", "A port of the SFXR sound effect generator", ["main.cpp"]),
					{ ...makeCandidate("b/blip", "A sound effect generator inspired by SFXR", ["blip.cpp"]), rights: { status: "attribution", spdx: "MIT", licencePath: "LICENSE", licenceUrl: "u", licenceSha256: "h", quote: "q", githubSpdxHint: "MIT", note: "n", meaning: "m", assetScoped: true } },
				],
				{ vertical: "audio-music", intent: "sound effects" },
			),
		);

	test("passes its own invariants", () => {
		const result = validatePayload(built());
		assert.deepEqual(result.problems, []);
		assert.ok(result.ok);
	});

	test("is deterministic", () => {
		assert.equal(JSON.stringify(built()), JSON.stringify(built()));
	});

	test("refuses to carry a human-owned field", () => {
		const payload = built();
		payload.possibilities[0].data.editorial_rank = 0.9 as never;
		const result = validatePayload(payload);
		assert.ok(result.problems.some((p) => p.includes("editorial_rank")));
		assert.ok(result.problems.some((p) => p.includes("a person owns")));
	});

	test("refuses a distinct_sources count no licence supports", () => {
		const payload = built();
		payload.possibilities[0].data.distinct_sources = 9;
		assert.ok(validatePayload(payload).problems.some((p) => p.includes("distinct_sources")));
	});

	test("refuses an upstream example with no source", () => {
		const payload = built();
		const example = payload.possibilities[0].examples[0];
		example.data.source_repo = null;
		example.data.origin = "upstream";
		assert.ok(validatePayload(payload).problems.some((p) => p.includes("upstream")));
	});

	test("refuses a declared licence with no evidence", () => {
		const payload = built();
		payload.possibilities[0].examples[0].data.licence_spdx = "MIT";
		payload.possibilities[0].examples[0].data.licence_evidence = null;
		assert.ok(validatePayload(payload).problems.some((p) => p.includes("no recorded evidence")));
	});

	test("refuses a made-up machine observation", () => {
		const payload = built();
		payload.possibilities[0].data.novelty = "high" as never;
		assert.ok(validatePayload(payload).problems.some((p) => p.includes("novelty")));
	});

	test("a possibility's rights are the floor across its examples", () => {
		assert.equal(worstRights(["cleared", "attribution"]), "attribution");
		assert.equal(worstRights(["cleared", "reference"]), "reference");
		assert.equal(worstRights(["cleared", "review", "attribution"]), "review");
		assert.equal(worstRights([]), "reference");
	});

	test("the payload takes the weakest status, not the best", () => {
		const payload = built();
		assert.equal(payload.possibilities[0].data.rights_status, "reference");
	});
});
