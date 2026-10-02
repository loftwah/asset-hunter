/**
 * `src/lib/build-info.ts` — which commit is this build, and what may be claimed
 * about it (#81).
 *
 * The module has one job and it is a job about honesty: a version stamp that
 * says more than it knows is worse than no version stamp, because it converts
 * "nobody checked" into "somebody checked and it was fine". Every test below is
 * about a way that could go wrong, not about the happy path.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	UNKNOWN_BUILD,
	buildSentence,
	humanAge,
	isCommitish,
	readBuildInfo,
	type BuildInfo,
} from "../src/lib/build-info.ts";

/** A real-shaped commit, so tests do not depend on a specific length. */
const SHA = "3f9a2c1e8b7d4a6f0c5e2b9d8a1f4c7e0b3d6a92";
const CLEAN = { ASSET_HUNTER_COMMIT: SHA, ASSET_HUNTER_DIRTY: "false" };

test("a clean tree claims its commit and nothing else", () => {
	const info = readBuildInfo(CLEAN);
	assert.equal(info.commit, SHA);
	assert.equal(info.dirty, false, "clean is the claim that matters most, so it must be real");
	assert.equal(info.reason, null, "a known build has no reason to doubt itself");
});

test("a dirty tree is published as dirty, not as its commit", () => {
	// `git rev-parse HEAD` names a commit, not a tree. A build with
	// uncommitted changes carries the commit id of code that is not the code
	// being shipped — which is the exact failure this module exists to prevent,
	// so the fact travels with the id.
	const info = readBuildInfo({ ...CLEAN, ASSET_HUNTER_DIRTY: "true" });
	assert.equal(info.commit, SHA);
	assert.equal(info.dirty, true);
	assert.match(
		buildSentence(info),
		/plus uncommitted changes/,
		"a dirty build must not print a bare sha, which reads like certainty",
	);
});

test("no git at all is a first-class answer, not an error", () => {
	// A tarball, a CI export, a Docker image. The build still has to serve, and
	// "I do not know" is truthful. It is never the package version, which would
	// look like evidence and is not.
	const info = readBuildInfo({});
	assert.equal(info.commit, null);
	assert.deepEqual(info, { ...UNKNOWN_BUILD, builtAt: null });

	for (const env of [
		{},
		{ ASSET_HUNTER_COMMIT: "" },
		{ ASSET_HUNTER_COMMIT: "unknown" }, // the sentinel astro.config.mjs writes
		{ ASSET_HUNTER_COMMIT: "HEAD" },
		{ ASSET_HUNTER_COMMIT: "not-a-sha-at-all" },
		{ ASSET_HUNTER_COMMIT: "ZZZZZZZ" }, // right length, not hex
		{ ASSET_HUNTER_COMMIT: 12345 },
		{ ASSET_HUNTER_COMMIT: null },
		{ ASSET_HUNTER_COMMIT: { sha: SHA } },
	]) {
		assert.equal(readBuildInfo(env).commit, null, `${JSON.stringify(env)} must not claim a commit`);
	}
});

test("the sentinel never reaches a reader as a value", () => {
	// `astro.config.mjs` writes the string `"unknown"` when git is missing. That
	// is a sentinel for code, not copy: a page printing "unknown" next to a
	// commit-looking field reads as a *value*, and a reader cannot tell it apart
	// from a build whose commit genuinely could not be read. It must arrive as a
	// sentence instead, and it must never look like a sha.
	const sentence = buildSentence(readBuildInfo({}));
	assert.match(sentence, /provenance unknown/);
	assert.doesNotMatch(sentence, /[0-9a-f]{7}/, "an unknown build must not print anything hex-shaped");
	assert.equal(sentence.trim().endsWith("unknown"), true, "the whole tail is the sentence, not a field");
});

test("a dirty build with no commit is described, not guessed", () => {
	// `dirty: true` with `commit: null` is the state a build with git present but
	// no HEAD reaches. Printing "Asset Hunter · <nothing>" would be a page whose
	// provenance line is blank; printing a sha would be a lie.
	const sentence = buildSentence({ commit: null, dirty: true, builtAt: null, reason: null });
	assert.match(sentence, /uncommitted tree/);
});

test("a commit-shaped string is not a commit", () => {
	assert.equal(isCommitish("abc1234"), true);
	assert.equal(isCommitish(SHA), true);
	// Six characters is short enough that a prefix collision becomes likely, and
	// a short id that *looks* authoritative is the failure mode.
	assert.equal(isCommitish("abc123"), false, "7 characters is the shortest trustworthy abbreviation");
	assert.equal(isCommitish("a".repeat(41)), false);
	assert.equal(isCommitish(` ${SHA}`), false, "leading whitespace is not a commit");
	assert.equal(isCommitish(`${SHA}\n`), false);
	assert.equal(isCommitish(`${SHA} dirty`), false);
	assert.equal(isCommitish(undefined), false);
});

test("an unrecognised dirty flag is unknown, never clean", () => {
	// The dangerous direction is asymmetric. Reading a garbled flag as `false`
	// would publish "clean" for a tree nobody checked, which is the one answer
	// this module must never invent.
	for (const value of ["unknown", "", "1", "yes", "TRUE", null, undefined, 0]) {
		const info = readBuildInfo({ ...CLEAN, ASSET_HUNTER_DIRTY: value });
		assert.equal(info.commit, SHA, "the commit is still known");
		assert.equal(info.dirty, null, `${JSON.stringify(value)} must not read as clean`);
	}
});

test("a build time is parsed or dropped, never passed through as text", () => {
	const ok = readBuildInfo({ ...CLEAN, ASSET_HUNTER_BUILT_AT: "2026-10-02T12:00:00+01:00" });
	assert.equal(ok.builtAt, "2026-10-02T11:00:00.000Z", "normalised, so two builds compare");

	// A string that is not a date is not a date. `new Date(garbage).toISOString()`
	// throws, which would 500 every page of the site over a build timestamp.
	for (const bad of ["yesterday", "", "0", "2026-13-45", "null", 1750000000000]) {
		assert.equal(
			readBuildInfo({ ...CLEAN, ASSET_HUNTER_BUILT_AT: bad }).builtAt,
			null,
			`${JSON.stringify(bad)} must not become a timestamp`,
		);
	}
});

test("the sentence is as coarse as the evidence", () => {
	const now = new Date("2026-10-02T12:00:00.000Z");
	const at = (iso: string) => buildSentence(readBuildInfo({ ...CLEAN, ASSET_HUNTER_BUILT_AT: iso }), now);

	assert.match(at("2026-10-02T11:59:40.000Z"), /just now/);
	assert.match(at("2026-10-02T11:45:00.000Z"), /15 minutes ago/);
	assert.match(at("2026-10-02T11:00:00.000Z"), /1 hour ago/);
	assert.match(at("2026-10-01T09:00:00.000Z"), /1 day ago/);
	// Past a month the month is the more useful number than a day count nobody
	// will convert.
	assert.match(at("2026-07-02T12:00:00.000Z"), /3 months ago/);
});

test("the sentence singularises, because '1 minutes ago' is a typo a reader sees", () => {
	const now = new Date("2026-10-02T12:00:00.000Z");
	assert.equal(humanAge("2026-10-02T11:00:00.000Z", now), "1 hour ago");
	assert.equal(humanAge("2026-10-01T12:00:00.000Z", now), "1 day ago");
	assert.equal(humanAge("2026-10-02T11:58:00.000Z", now), "2 minutes ago");
});

test("a clock that disagrees with the build cannot print a negative age", () => {
	// A skewed clock or a mis-set build timestamp would otherwise say a build is
	// "-4 minutes old", which is nonsense on a public page.
	const now = new Date("2026-10-02T12:00:00.000Z");
	assert.equal(humanAge("2026-10-02T12:30:00.000Z", now), "just now");
});

test("the sentence never claims a deployment, only a build", () => {
	// "Deployed 2 hours ago" is a claim about a system; "built" is a claim about
	// a file. The version endpoint knows exactly one thing, and it is the file.
	const sentence = buildSentence(readBuildInfo({ ...CLEAN, ASSET_HUNTER_BUILT_AT: "2026-10-02T10:00:00Z" }));
	assert.doesNotMatch(sentence, /live|healthy|up to date|current/i, sentence);
	assert.match(sentence, /built/);
});

test("a BuildInfo from anywhere renders without throwing", () => {
	// Anything can reach this: a test fixture, a preview build, a future field.
	const shapes: BuildInfo[] = [
		{ commit: SHA, dirty: false, builtAt: null, reason: null },
		{ commit: SHA, dirty: true, builtAt: "2026-10-02T10:00:00Z", reason: null },
		{ commit: null, dirty: false, builtAt: "2026-10-02T10:00:00Z", reason: null },
		{ commit: null, dirty: true, builtAt: null, reason: "no git" },
	];
	for (const shape of shapes) {
		const sentence = buildSentence(shape);
		assert.equal(typeof sentence, "string");
		assert.ok(sentence.startsWith("Asset Hunter"), sentence);
		assert.doesNotMatch(sentence, /undefined|null|NaN/, sentence);
	}
});
