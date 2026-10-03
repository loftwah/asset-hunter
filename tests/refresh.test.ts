/**
 * Incremental refresh planning (#41).
 *
 * The acceptance criteria for #41 are mostly about *not doing work*, which is
 * the hardest kind of behaviour to test: a refresh that re-reads everything
 * produces a perfectly correct catalogue and simply costs too much. So these
 * tests are about the plan, not the outcome — `planRefresh` is pure, and the
 * crawl is what reads it.
 *
 * The case that matters most is `unchanged sources perform minimal work on the
 * second run`, and the one that catches a real implementation error is the star
 * count: it moves on nearly every real crawl, so treating it as evidence would
 * make the acceptance criterion false in practice while still passing a
 * fixture that only ever moves `pushedAt`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
	emptyMetrics,
	formatMetrics,
	needsLicenceReread,
	noteVanished,
	planRefresh,
	type SourceObservation,
} from "../engine/src/refresh.ts";
import type { Candidate } from "../engine/src/candidates.ts";

/** A candidate as the store would hold it after one crawl. */
const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
	briefFingerprint: null,
	id: "0123456789abcdef",
	fullName: "owner/repo",
	owner: "owner",
	repo: "repo",
	ref: "sha-old",
	stars: 10,
	description: "a thing",
	topics: [],
	htmlUrl: "https://github.com/owner/repo",
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
		githubSpdxHint: "NOASSERTION",
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
	...overrides,
});

/** The cheap metadata read a refresh would do. */
const observed = (overrides: Partial<SourceObservation> = {}): SourceObservation => ({
	fullName: "owner/repo",
	pushedAt: "2026-01-01T00:00:00Z",
	archived: false,
	fork: false,
	defaultBranch: "main",
	headSha: "sha-old",
	stars: 10,
	...overrides,
});

const NOW = "2026-02-01T00:00:00Z";

describe("refresh planning: what a second run owes", () => {
	test("an unchanged source costs nothing", () => {
		// The headline acceptance criterion. Identical observation, identical
		// result: no inspect, and the skip says why.
		const plan = planRefresh([candidate()], new Map([["owner/repo", observed()]]), NOW);
		assert.equal(plan.inspect.length, 0);
		assert.equal(plan.skip.length, 1);
		assert.deepEqual(plan.skip[0], { kind: "skip", reason: "unchanged", fullName: "owner/repo" });
		assert.equal(plan.unchanged, 1);
	});

	test("stars are not evidence, so a starred repo is still unchanged", () => {
		// This is the one that keeps "minimal work" honest. Star counts move on
		// almost every real crawl; a repository that gained 400 stars since the
		// last run has told us nothing about its licence, its files or its
		// rights, and re-downloading it would make the second run cost as much as
		// the first.
		const plan = planRefresh(
			[candidate({ stars: 10 })],
			new Map([["owner/repo", observed({ stars: 410 })]]),
			NOW,
		);
		assert.equal(plan.inspect.length, 0, "a star change must not trigger a re-read");
		assert.equal(plan.unchanged, 1);
	});

	test("an edited description is a hint, not evidence", () => {
		// Same reasoning as stars, stated once more because the two are the
		// fields that change most and matter least.
		const plan = planRefresh(
			[candidate({ description: "old" })],
			new Map([["owner/repo", observed({})]]),
			NOW,
		);
		assert.equal(plan.inspect.length, 0);
	});

	test("a push upstream owes a re-read, and says which signal caused it", () => {
		const plan = planRefresh(
			[candidate()],
			new Map([["owner/repo", observed({ pushedAt: "2026-01-15T00:00:00Z" })]]),
			NOW,
		);
		assert.deepEqual(plan.inspect, [
			{ kind: "inspect", reason: "upstream-pushed", fullName: "owner/repo" },
		]);
		assert.equal(plan.unchanged, 0);
	});

	test("a moved default branch is named distinctly from a push", () => {
		// The distinction is for the report. "Branch moved" means the tree we
		// read may not exist any more, which is a different repair from "there
		// is new code to read".
		const plan = planRefresh(
			[candidate()],
			new Map([["owner/repo", observed({ defaultBranch: "trunk" })]]),
			NOW,
		);
		assert.equal(plan.inspect[0]?.reason, "branch-moved");
	});

	test("a moved head commit is a re-read even when pushedAt did not move", () => {
		// A force-push, a rebase, or a tag force-update all move the commit
		// without moving the push timestamp in the search index. Trusting
		// `pushedAt` alone would miss exactly those.
		const plan = planRefresh(
			[candidate()],
			new Map([["owner/repo", observed({ headSha: "sha-new" })]]),
			NOW,
		);
		assert.equal(plan.inspect.length, 1);
	});

	test("archiving owes a re-read once, then the source is simply not usable", () => {
		const archived = new Map([["owner/repo", observed({ archived: true })]]);
		const first = planRefresh([candidate()], archived, NOW);
		assert.deepEqual(first.inspect, [
			{ kind: "inspect", reason: "archived", fullName: "owner/repo" },
		]);

		// Second run, once the candidate has been re-recorded as archived. The
		// re-read already happened; doing it every run forever is how a refresh
		// schedule becomes a denial-of-service against GitHub's API.
		const second = planRefresh([candidate({ archived: true })], archived, NOW);
		assert.equal(second.inspect.length, 0);
		assert.deepEqual(second.skip, [
			{ kind: "skip", reason: "not-usable", fullName: "owner/repo" },
		]);
	});

	test("a source nobody looked at is not reported as vanished", () => {
		// "We did not check" and "it is gone" are different facts. Only one of
		// them justifies telling a reader that material disappeared, so a
		// candidate absent from the observation map is left out of the plan
		// entirely rather than reported either way.
		const plan = planRefresh([candidate()], new Map(), NOW);
		assert.equal(plan.inspect.length, 0);
		assert.equal(plan.skip.length, 0);
		assert.equal(plan.vanished.length, 0);
	});

	test("an observation the catalogue has never seen is new work", () => {
		const plan = planRefresh(
			[],
			new Map([["brand/new", observed({ fullName: "brand/new" })]]),
			NOW,
		);
		assert.deepEqual(plan.inspect, [
			{ kind: "inspect", reason: "new-source", fullName: "brand/new" },
		]);
	});

	test("an unreadable timestamp makes the refresh do the work", () => {
		// Failing safe in the expensive direction. A date we cannot parse must
		// never be the reason a licence change goes unnoticed.
		const plan = planRefresh(
			[candidate()],
			new Map([["owner/repo", observed({ pushedAt: "not a date" })]]),
			NOW,
		);
		assert.equal(plan.inspect.length, 1, "an unreadable date must not suppress a re-read");
	});

	test("planning is deterministic", () => {
		// Two runs over the same input must produce the same plan, or a resumed
		// refresh does different work from a fresh one — which is the whole
		// property that makes resume safe.
		const candidates = [candidate(), candidate({ fullName: "other/repo", id: "ffff", repo: "repo" })];
		const observations = new Map([
			["owner/repo", observed()],
			["other/repo", observed({ fullName: "other/repo" })],
		]);
		const a = planRefresh(candidates, observations, NOW);
		const b = planRefresh(candidates, observations, NOW);
		assert.deepEqual(a, b);
	});
});

describe("disappearance is recorded, never inferred", () => {
	test("a vanished source keeps the commit we last read", () => {
		// The provenance obligation: a record that said only "gone" could not be
		// reconciled against anything. The commit is the only thing that makes a
		// disappearance investigable.
		const gone = noteVanished(candidate({ ref: "sha-old" }), "404 Not Found", NOW);
		assert.deepEqual(gone, {
			fullName: "owner/repo",
			lastSeenRef: "sha-old",
			noticedAt: NOW,
			reason: "404 Not Found",
		});
	});
});

describe("licence re-reading", () => {
	const base = candidate();

	test("a status change owes a re-read", () => {
		const after = candidate({
			rights: { ...base.rights, status: "cleared", spdx: "MIT", licenceSha256: "abc" },
		});
		assert.equal(needsLicenceReread(base, after), true);
	});

	test("a changed licence file hash owes a re-read", () => {
		// Same status, same SPDX, different bytes. The status is a classification
		// of evidence; if the evidence changed, the classification must be redone
		// rather than assumed to still hold.
		const after = candidate({
			rights: { ...base.rights, licenceSha256: "different-hash" },
		});
		assert.equal(needsLicenceReread(base, after), true);
	});

	test("an asset-scoped classification change owes a re-read", () => {
		// "The repository is MIT" and "the MIT file sits beside this asset" are
		// different claims, and the difference is the whole reason this project
		// reads licence files rather than trusting repository metadata.
		const after = candidate({
			rights: { ...base.rights, assetScoped: true },
		});
		assert.equal(needsLicenceReread(base, after), true);
	});

	test("identical evidence owes nothing", () => {
		assert.equal(needsLicenceReread(base, candidate()), false);
	});
});

describe("run metrics", () => {
	test("every field can honestly be zero", () => {
		// A run that found nothing must report zeros, not nulls and not blanks.
		const m = emptyMetrics();
		assert.deepEqual(m, {
			sourcesChecked: 0,
			sourcesChanged: 0,
			sourcesUnchanged: 0,
			newSources: 0,
			vanished: 0,
			bytesDownloaded: 0,
			licenceRereads: 0,
		});
	});

	test("unchanged is reported alongside changed, not omitted", () => {
		// A refresh report that only shows what it did gives no signal about what
		// it skipped. If "unchanged" is invisible, an over-eager crawl and a
		// perfectly efficient one look identical from the outside.
		const lines = formatMetrics({ ...emptyMetrics(), sourcesChecked: 40, sourcesUnchanged: 38, sourcesChanged: 2 });
		assert.match(lines.join("\n"), /unchanged\s+38/);
		assert.match(lines.join("\n"), /changed\s+2/);
	});

	test("zero-valued optional lines are omitted rather than printed as 0", () => {
		// `vanished 0` on every ordinary run is noise that trains an operator to
		// skim past the line that matters.
		const lines = formatMetrics(emptyMetrics()).join("\n");
		assert.equal(/vanished/.test(lines), false);
		assert.equal(/downloaded/.test(lines), false);
	});

	test("a vanished source is loud when it happens", () => {
		const lines = formatMetrics({ ...emptyMetrics(), vanished: 1 }).join("\n");
		assert.match(lines, /vanished\s+1/);
	});
});
