/**
 * `src/lib/deploy-freshness.ts` — the verdict on whether production is the code
 * this branch claims. (#81)
 *
 * Issue #81: the deployed site served code three commits behind `main` while nine
 * accessibility defects were live and every one of them already fixed on `main`.
 * Nothing said so. This is the function that would have caught it, and it is a
 * pure function specifically so that all four verdicts — including the two that
 * are awkward to produce on purpose — are reachable from a test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	assessFreshness,
	isFailure,
	provenanceWarnings,
	type DeployedReport,
	type HistoryOracle,
} from "../src/lib/deploy-freshness.ts";

const A = "1111111111111111111111111111111111111111";
const B = "2222222222222222222222222222222222222222";
const C = "3333333333333333333333333333333333333333";
const SHA = "3f9a2c1e8b7d4a6f0c5e2b9d8a1f4c7e0b3d6a92";

/** A straight-line history A → B → C, which is the easy case to reason about. */
const linear: HistoryOracle = {
	isAncestor: (older, newer) => {
		const order = [A, B, C];
		const from = order.indexOf(older);
		const to = order.indexOf(newer);
		if (from === -1 || to === -1) return null;
		return from < to;
	},
	has: (commit) => [A, B, C].includes(commit),
};

const deployedOf = (commit: string | null, over: Partial<DeployedReport> = {}): DeployedReport => ({
	reachable: true,
	commit,
	dirty: false,
	builtAt: "2026-10-02T10:00:00.000Z",
	...over,
});

test("the same commit is current, and only the same commit is", () => {
	const verdict = assessFreshness(deployedOf(A), A, linear);
	assert.equal(verdict.kind, "current");
	assert.equal(verdict.remedy, null, "there is nothing to do and nothing to suggest doing");
	assert.equal(isFailure(verdict), false);
	assert.match(verdict.summary, new RegExp(A.slice(0, 7)));
});

test("a deploy behind main is behind, and says how to fix it", () => {
	// The #81 case. Production at A, main at C: everything merged since is missing
	// in production, including the fixes.
	const verdict = assessFreshness(deployedOf(A), C, linear);
	assert.equal(verdict.kind, "behind");
	assert.equal(isFailure(verdict), true);
	assert.match(verdict.remedy ?? "", /deploy/i);
	assert.match(verdict.summary, new RegExp(A.slice(0, 7)), "names what is live, not just what should be");
});

test("a deploy ahead of main is not a pass and not 'behind'", () => {
	// Production has commits this branch does not. The next deploy removes them
	// and records nothing, which is the opposite of the safe assumption.
	const verdict = assessFreshness(deployedOf(C), A, linear);
	assert.equal(verdict.kind, "diverged");
	assert.equal(isFailure(verdict), true);
	assert.match(verdict.remedy ?? "", /removes them without a record|replaces/i);
});

test("two unrelated lines are diverged, not behind", () => {
	// The worst case, and the one that looks most like `behind` to a reader. A
	// deploy from a deleted branch, or a rebase under a live site.
	const oracle: HistoryOracle = { isAncestor: () => false, has: () => true };
	const verdict = assessFreshness(deployedOf(B), C, oracle);
	assert.equal(verdict.kind, "diverged");
	assert.match(verdict.summary, /diverged/);
	assert.match(verdict.remedy ?? "", /replaces whatever is live/);
});

test("a commit that is not in this repository is diverged, immediately", () => {
	// Checked before any ancestry question, because a commit git cannot find has
	// no ancestry to reason about — and "not in my clone" is the likeliest real
	// explanation for it: a shallow clone, or a machine that has been fetched
	// since the deploy.
	const oracle: HistoryOracle = { isAncestor: () => null, has: () => false };
	const verdict = assessFreshness(deployedOf("f" + SHA.slice(1)), A, oracle);
	assert.equal(verdict.kind, "diverged");
	assert.match(verdict.summary, /not in this repository/);
});

test("git that cannot answer is unknown, never a guess with a scary remedy", () => {
	// A shallow clone returns null for both ancestry questions. Calling that
	// "diverged" would attach "the next deploy replaces whatever is live" to a
	// guess, which is the kind of false alarm that trains people to ignore alarms.
	const oracle: HistoryOracle = { isAncestor: () => null, has: () => true };
	const verdict = assessFreshness(deployedOf(B), C, oracle);
	assert.equal(verdict.kind, "unknown");
	assert.match(verdict.remedy ?? "", /shallow|fetch/i);
	assert.equal(isFailure(verdict), true, "unknown is a failure; only `current` passes");
});

test("no version endpoint is unknown, with the deploy as the remedy", () => {
	// Before this module there was no way to ask, which is why #81 needed an audit.
	const verdict = assessFreshness(
		{ reachable: false, commit: null, dirty: null, builtAt: null },
		A,
		linear,
	);
	assert.equal(verdict.kind, "unknown");
	assert.match(verdict.remedy ?? "", /build-info\.ts/);
	assert.equal(isFailure(verdict), true);
});

test("a build that cannot name its commit is unknown", () => {
	const verdict = assessFreshness(deployedOf(null, { dirty: null }), A, linear);
	assert.equal(verdict.kind, "unknown");
	assert.match(verdict.remedy ?? "", /ASSET_HUNTER_COMMIT|tarball|checkout/i);
});

test("no expected commit to compare against is unknown, not a pass", () => {
	// The runner outside git prints its own error and exits 2 for this; inside the
	// function it must still never come back `current`.
	const verdict = assessFreshness(deployedOf(A), "", linear);
	assert.equal(verdict.kind, "unknown");
	assert.equal(isFailure(verdict), true);
	assert.match(verdict.remedy ?? "", /--expect|inside the repository/);
});

test("a dirty deployed build is flagged even when the commit matches", () => {
	// The orthogonal case: up to date, and still not verifiable, because the sha
	// does not identify the shipped code. `current` is the verdict; the warning is
	// separate and always accompanies it.
	const report = deployedOf(A, { dirty: true });
	const verdict = assessFreshness(report, A, linear);
	assert.equal(verdict.kind, "current", "the commit comparison is unaffected");
	assert.equal(verdict.deployedDirty, true, "and the dirtiness is not lost");

	const warnings = provenanceWarnings(report);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /not the shipped code/);
});

test("a build that cannot say whether it was clean says that too", () => {
	// `clean` is the claim that matters most, so an absent flag is reported rather
	// than treated as clean.
	const warnings = provenanceWarnings(deployedOf(A, { dirty: null }));
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /whether its tree was clean/);
});

test("a clean build warns about nothing", () => {
	assert.deepEqual(provenanceWarnings(deployedOf(A)), []);
});

test("an unknown commit does not also produce a cleanliness warning", () => {
	// With no commit there is no tree to have been dirty; saying "could not say
	// whether its tree was clean" would be confusing rather than careful.
	assert.deepEqual(provenanceWarnings({ reachable: true, commit: null, dirty: null, builtAt: null }), []);
});

test("every verdict carries a summary that names a real commit or says it cannot", () => {
	const cases: Array<[DeployedReport, string, HistoryOracle]> = [
		[deployedOf(A), A, linear],
		[deployedOf(A), C, linear],
		[deployedOf(C), A, linear],
		[deployedOf(B), C, { isAncestor: () => false, has: () => true }],
		[deployedOf(null), A, linear],
		[deployedOf("f" + SHA.slice(1)), A, linear],
		[{ reachable: false, commit: null, dirty: null, builtAt: null }, A, linear],
	];
	for (const [report, want, oracle] of cases) {
		const { summary, remedy } = assessFreshness(report, want, oracle);
		assert.ok(summary.length > 10, summary);
		assert.doesNotMatch(summary, /undefined|null|NaN/, summary);
		// The sentence is about commits, never about a system's health — that is a
		// claim this tool cannot make and must not appear to make.
		assert.doesNotMatch(summary, /\blive\b|\bhealthy\b|up to date/i, summary);
		if (isFailure(assessFreshness(report, want, oracle))) {
			assert.ok(remedy, `a failure must say what to do: ${summary}`);
		}
	}
});

test("only `current` passes", () => {
	// One assertion of the predicate itself, because it is the gate: `verify:full`
	// and the deploy step both branch on it, and a predicate that quietly passed
	// `unknown` would put #81 straight back.
	assert.equal(isFailure({ kind: "current" } as never), false);
	for (const kind of ["behind", "diverged", "unknown"] as const) {
		assert.equal(isFailure({ kind } as never), true, `${kind} must fail`);
	}
});
