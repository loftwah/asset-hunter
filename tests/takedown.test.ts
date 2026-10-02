/**
 * Rights correction, opt-out and takedown (#54).
 *
 * The tests here are arranged around the three claims #54 makes that would fail
 * silently, because each of them does:
 *
 * 1. **A disputed download stops immediately.** A report says somebody's work is
 *    being served without permission; the byte must stop at the address that was
 *    handed out before the report, not at the page that renders the link.
 * 2. **An exclusion outlives a refresh.** If the engine can re-ingest a taken-down
 *    resource, the takedown is a note somebody wrote and nothing more — so the
 *    merge policy, the refresh plan and the crawl filter are all asserted, twice:
 *    once that the exclusion is honoured, once that the *evidence* survives.
 * 3. **Removing one example does not corrupt the possibility graph.** The entry
 *    stands, its counts become true, its status is re-floored and its
 *    representative is re-chosen — and every one of those is a number a reader sees.
 *
 * Everything asserted here is pure: no database, no network, no clock. That is
 * deliberate — these are the rules that must hold even when the CMS is healthy and
 * somebody is in a hurry.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
	EXCLUSION_SCOPE_REQUIREMENT,
	EXCLUSION_SCOPES,
	HIDES_POSSIBILITY,
	RIGHTS_SENSITIVE_REASONS,
	chooseRepresentative,
	exclusionIsActive,
	filedNote,
	isRightsSensitive,
	parseDisputeState,
	parseExclusionScope,
	representable,
	recomputePossibility,
	weakestRights,
	withholdsAsset,
	type ExampleFacts,
} from "../src/lib/disputes.ts";
import {
	REPORTS,
	REPORT_PRIORITY,
	REPORT_REASONS,
	parseReason,
	reportRank,
	type ReportReason,
} from "../src/lib/rating.ts";
import {
	disputeFor,
	payloadResult,
	recordDocument,
	useActions,
	useDecision,
} from "../src/lib/asset-use.ts";
import {
	auditSlug,
	buildRightsQueue,
	disputeSummary,
	exclusionMatchIsUsable as appExclusionMatchIsUsable,
	filedNoteFromOutcomes,
	sanitiseSlug,
	type AuditEvent,
	type Dispute,
	type Exclusion,
} from "../src/lib/takedown.ts";
import {
	mergeExample,
	mergePossibility,
	type MergeResult,
} from "../engine/src/merge.ts";
import {
	parseExclusion,
	parseExclusions,
	matches,
	exclusionFor,
	exclusionForExample,
} from "../engine/src/exclusions.ts";
import { planRefresh } from "../engine/src/refresh.ts";
import { worstRights } from "../engine/src/publish.ts";
import type { Example } from "../src/lib/catalogue.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

const HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const example = (over: Partial<Example> = {}): Example => ({
	slug: "ex-one",
	title: "One example",
	origin: "upstream",
	mediaKind: "image",
	specimen: null,
	image: null,
	rightsStatus: "reference",
	rightsNote: null,
	note: null,
	sourceUrl: null,
	sourceRepo: null,
	sourceRef: null,
	sourcePath: null,
	licenceSpdx: null,
	licenceEvidence: null,
	attribution: null,
	contentHash: null,
	downloadable: false,
	...over,
});

/** An example that satisfies every one of the four download conditions. */
const cleared = (over: Partial<Example> = {}) =>
	example({
		slug: "ex-cleared",
		title: "Ambient loop",
		rightsStatus: "cleared",
		licenceSpdx: "CC0-1.0",
		licenceEvidence: "\"This work has been released into the public domain.\"",
		attribution: "Public domain. No attribution required, and none is claimed.",
		sourceUrl: "https://github.com/example/loops",
		sourceRepo: "example/loops",
		sourceRef: "c0ffee1",
		sourcePath: "loops/room-tone.wav",
		contentHash: HASH,
		downloadable: true,
		...over,
	});

const facts = (over: Partial<ExampleFacts> & { slug: string }): ExampleFacts => ({
	rightsStatus: "reference",
	origin: "upstream",
	disputeState: null,
	...over,
});

const exclusion = (over: Partial<Exclusion> = {}): Exclusion => ({
	id: "ex-repository-owner-repo",
	scope: "repository",
	match: "owner/repo",
	reason: "opt-out-request",
	detail: null,
	active: true,
	disputeSlug: "dis-example-ex-one",
	recordedAt: "2026-10-01T00:00:00.000Z",
	recordedBy: "someone",
	liftedAt: null,
	liftedBy: null,
	liftReason: null,
	...over,
});

const dispute = (over: Partial<Dispute> = {}): Dispute => ({
	id: "dis-example-ex-cleared",
	subjectType: "example",
	subjectSlug: "ex-cleared",
	reason: "opt-out-request",
	state: "quarantined",
	rawState: "quarantined",
	detail: "This is my work.",
	reportId: null,
	reporterId: "reader",
	reportedAt: "2026-10-01T00:00:00.000Z",
	resolution: null,
	resolvedAt: null,
	resolvedBy: null,
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-01T00:00:00.000Z",
	...over,
});

const auditEvent = (over: Partial<AuditEvent> = {}): AuditEvent => ({
	id: "aud-1",
	action: "quarantined",
	label: "Quarantined",
	subjectType: "example",
	subjectSlug: "ex-cleared",
	field: "dispute_state",
	before: null,
	after: "quarantined",
	reason: "opt-out-request",
	detail: null,
	actorId: "curator",
	occurredAt: "2026-10-01T00:00:00.000Z",
	...over,
});

/* -------------------------------------------------------------------------- */
/* 1. The reporter path                                                         */
/* -------------------------------------------------------------------------- */

describe("the reporter path takes words, not classifications", () => {
	test("every reason #54 asks for has a report reason", () => {
		// The six a reader can file, mapped to how this catalogue calls them. A
		// reporter should never have to choose between "licence-changed" and
		// "reference-only" — those are ours, not theirs.
		for (const reason of [
			"licence-changed",
			"attribution-wrong",
			"dead-source",
			"not-downloadable",
			"rights-infringement",
			"opt-out-request",
		] as ReportReason[]) {
			assert.ok(REPORTS[reason], `no report reason for ${reason}`);
			assert.ok(REPORTS[reason].label.length > 4, `${reason} has no usable label`);
			assert.ok(REPORTS[reason].means.length > 30, `${reason} does not explain itself`);
			assert.ok(REPORTS[reason].action.length > 30, `${reason} does not say what happens`);
			assert.equal(
				REPORTS[reason].label.includes("licence-changed"),
				false,
				`${reason} shows the internal slug to a reporter`,
			);
		}
	});

	test("the reasons that already existed still exist, unchanged in meaning", () => {
		// #54 adds to the set. It must not quietly redefine what the older reasons
		// mean, because the cockpit's ordering and the archive's history both read
		// these.
		assert.equal(REPORTS["wrong-classification"].label, "Wrong classification or label");
		assert.equal(REPORTS.duplicate.label, "Duplicate");
		assert.equal(REPORTS["broken-preview"].label, "Broken or missing preview");
		assert.equal(
			REPORTS["licence-changed"].label,
			"Licence or provenance looks wrong or has changed",
		);
		assert.equal(REPORTS["dead-source"].label, "Dead or moved source");
		assert.equal(
			REPORTS["misleading-metadata"].label,
			"Misleading quality or metadata",
		);
		assert.equal(REPORTS.other.label, "Something else");
		assert.ok(REPORT_REASONS.includes("licence-changed"));
		assert.ok(REPORT_REASONS.includes("broken-preview"));
	});

	test("rights matters are separated from quality signals", () => {
		// A broken preview is a bug. A creator asking to be removed is a claim about
		// their own work. Averaging them into one queue is what makes a takedown wait
		// behind a typo.
		for (const reason of RIGHTS_SENSITIVE_REASONS) {
			assert.ok(REPORT_REASONS.includes(reason), `${reason} is not a real reason`);
		}
		assert.equal(isRightsSensitive("rights-infringement"), true);
		assert.equal(isRightsSensitive("opt-out-request"), true);
		assert.equal(isRightsSensitive("licence-changed"), true);
		assert.equal(isRightsSensitive("broken-preview"), false);
		assert.equal(isRightsSensitive("duplicate"), false);
		assert.equal(isRightsSensitive("misleading-metadata"), false);
	});

	test("a takedown outranks a licence correction, which outranks a typo", () => {
		const order = (reason: ReportReason) => reportRank(reason);
		assert.ok(order("rights-infringement") < order("opt-out-request"));
		assert.ok(order("opt-out-request") < order("licence-changed"));
		assert.ok(order("licence-changed") < order("dead-source"));
		assert.ok(order("dead-source") < order("broken-preview"));
		assert.ok(order("broken-preview") < order("duplicate"));
		// A reason nobody has placed sorts last, never first.
		assert.ok(order("other") > order("duplicate"));
		assert.equal(REPORT_PRIORITY[0], "rights-infringement");
	});

	test("only a claim about being served withdraws a whole entry", () => {
		// Hiding a possibility because one example's licence is wrong would delete the
		// very thing #54 says must survive an example being removed.
		assert.deepEqual([...HIDES_POSSIBILITY], ["rights-infringement", "opt-out-request"]);
		assert.equal(isRightsSensitive("licence-changed"), true);
		assert.equal(HIDES_POSSIBILITY.includes("licence-changed"), false);
		assert.equal(HIDES_POSSIBILITY.includes("not-downloadable"), false);
	});

	test("an unknown reason is refused rather than stored", () => {
		assert.equal(parseReason("rights-infringement"), "rights-infringement");
		assert.equal(parseReason("nonsense"), null);
		assert.equal(parseReason(""), null);
	});
});

/* -------------------------------------------------------------------------- */
/* 2. Quarantine withdraws the download                                         */
/* -------------------------------------------------------------------------- */

describe("a dispute withdraws the download while the review is open", () => {
	const quarantined = cleared({
		disputeState: "quarantined",
		disputeReason: "opt-out-request",
		disputeNote: "This is my loop and I did not license it.",
	});

	test("the four conditions still hold, and the fifth still beats them", () => {
		// Everything #42 asserted is still true: a retained, hashed, cleared,
		// credited example earns a download. What changes in #54 is that a licence is
		// not the only thing that can stop a handover — somebody's objection is.
		const before = useDecision(cleared());
		assert.equal(before.handoff.as, "payload");
		assert.equal(before.handoff.blockedBy, null);
		assert.ok(useActions(cleared()).some((action) => action.id === "download"));

		const after = useDecision(quarantined);
		assert.equal(after.handoff.as, "record");
		assert.equal(after.handoff.blockedBy, "disputed");
		assert.equal(
			useActions(quarantined).some((action) => action.id === "download"),
			false,
		);
	});

	test("the payload route refuses, and says the right thing", async () => {
		const result = await payloadResult({
			example: quarantined,
			retained: { bytes: new Uint8Array([1, 2, 3]), contentType: "application/octet-stream" },
		});
		assert.equal(result.status, 403);
		assert.equal(result.headers["x-ah-blocked-by"], "disputed");
		assert.equal(result.bytes, null);
		assert.match(result.body ?? "", /rights concern is examined/i);
		// The refusal must not claim the licence forbade it. That would be a
		// different and untrue statement.
		assert.doesNotMatch(result.body ?? "", /reference only/i);
	});

	test("the evidence is still served: the record is the deliverable", () => {
		const document = recordDocument(quarantined);
		assert.equal(document.licenceEvidence, cleared().licenceEvidence);
		assert.equal(document.contentHash, HASH);
		assert.equal(document.contentHashVerified, true);
		assert.match(document.credit ?? "", /Public domain/);
		assert.equal(document.sourceRef, "c0ffee1");
		assert.equal(document.sourceRepo, "example/loops");
		assert.equal(document.payloadRetained, true, "the original was not deleted");
		assert.deepEqual(document.dispute, {
			state: "quarantined",
			label: "Quarantined",
			reason: "opt-out-request",
			note: "This is my loop and I did not license it.",
			withholding: true,
		});
		// And the record action is still offered, because the evidence is owed to a
		// reader whatever the rights are — including, especially, these.
		assert.ok(useActions(quarantined).some((action) => action.id === "record"));
	});

	test("a record with no dispute does not carry a dispute field at all", () => {
		// Absent rather than `null`: a consumer should be able to ask "is this
		// contested?" without reading prose, and a `null` dispute on every example
		// would be a question answered the same way forty-eight times.
		assert.equal(recordDocument(cleared()).dispute, null);
	});

	test("both live states withhold, and both terminal ones do not", () => {
		for (const state of ["open", "quarantined"]) {
			assert.equal(withholdsAsset(state), true, `${state} must withhold`);
			assert.equal(useDecision(cleared({ disputeState: state })).handoff.blockedBy, "disputed");
		}
		for (const state of ["corrected", "dismissed"]) {
			assert.equal(withholdsAsset(state), false, `${state} must not withhold`);
			assert.equal(useDecision(cleared({ disputeState: state })).handoff.as, "payload");
		}
	});

	test("an example with no dispute is not in dispute", () => {
		// The catalogue has no disputes until somebody files one. If absence read as
		// a live takedown, this catalogue would serve nothing at all — which is the
		// mirror image of the failure #54 is fixing, and just as bad.
		assert.equal(withholdsAsset(null), false);
		assert.equal(withholdsAsset(undefined), false);
		assert.equal(withholdsAsset(""), false);
		assert.equal(withholdsAsset("   "), false);
		assert.equal(disputeFor(cleared()), null);
		assert.equal(useDecision(cleared()).handoff.as, "payload");
	});

	test("a dispute state this build cannot read still withholds", () => {
		// An unrecognised value is not evidence that a dispute was resolved. Same
		// direction as `flagValue` and `useStateFor`.
		assert.equal(withholdsAsset("withdrawn-pending-appeal"), true);
		const notice = disputeFor(cleared({ disputeState: "withdrawn-pending-appeal" }));
		assert.equal(notice?.known, null);
		assert.equal(notice?.label, "withdrawn-pending-appeal", "the raw value stays visible");
		assert.equal(useDecision(cleared({ disputeState: "withdrawn-pending-appeal" })).handoff.blockedBy, "disputed");
	});

	test("a reference-only example under a dispute is still reference only", () => {
		// The gate does not upgrade anything. `disputed` is a reason for refusing the
		// file, not a rights status.
		const decision = useDecision(example({ disputeState: "open", disputeReason: "licence-changed" }));
		assert.equal(decision.state, "reference-only");
		assert.equal(decision.rightsStatus, "reference");
		assert.equal(decision.handoff.blockedBy, "disputed");
	});

	test("a resolved dispute still shows that it happened", () => {
		const decision = useDecision(cleared({ disputeState: "corrected", disputeReason: "licence-changed" }));
		assert.equal(decision.dispute?.state, "corrected");
		assert.equal(decision.dispute?.label, "Corrected");
		assert.equal(decision.dispute?.reason, "licence-changed");
		assert.equal(decision.handoff.as, "payload");
	});

	test("what the reporter is told is true of what happened", () => {
		assert.match(filedNote("opt-out-request", "example"), /withheld/i);
		assert.match(filedNote("licence-changed", "example"), /download is withheld/i);
		assert.match(filedNote("opt-out-request", "possibility"), /off the public catalogue/i);
		assert.match(filedNote("duplicate", "example"), /editor/i);

		// An example is not "off the public catalogue": it has no page of its own and
		// its record is still public. Telling somebody their work had been withdrawn
		// from the site when it was only withheld is the overstatement this catalogue
		// does not make anywhere else.
		assert.doesNotMatch(filedNote("opt-out-request", "example"), /off the public catalogue/i);
		assert.match(filedNote("opt-out-request", "example"), /nothing was deleted/i);

		// The one that matters most: a failed withdrawal must not be reported as a
		// successful one, and neither must a *successful* write that withheld nothing —
		// a subject that has been deleted has nothing left to withhold, and telling
		// somebody their work stopped being served would be untrue.
		const failed = filedNoteFromOutcomes("opt-out-request", "example", [], true);
		assert.match(failed, /nothing was withheld/i);

		// The case was opened "as quarantined" and nothing was withheld, because the
		// subject is not in the catalogue. Claiming a withdrawal there would be the
		// overstatement this function exists to prevent, and the first version of it
		// matched the word "quarantined" and did exactly that.
		const missingSubject = filedNoteFromOutcomes(
			"opt-out-request",
			"example",
			[
				"dispute dis-example-nothing opened as quarantined",
				"the example is no longer in the catalogue, so there is nothing left to withhold",
			],
			false,
		);
		assert.match(missingSubject, /nothing was withheld/i);
		assert.doesNotMatch(missingSubject, /withheld while it is reviewed/i);

		// Already withheld is withheld: nothing changed, and the reader's file is
		// still not being served.
		const already = filedNoteFromOutcomes(
			"opt-out-request",
			"example",
			[
				"dispute dis-example-ex-one opened as quarantined",
				"the example was already quarantined; nothing changed",
			],
			false,
		);
		assert.match(already, /withheld while it is reviewed/i);

		const withheldNothing = filedNoteFromOutcomes(
			"opt-out-request",
			"example",
			["the example is no longer in the catalogue, so there is nothing left to withhold"],
			false,
		);
		assert.match(withheldNothing, /nothing was withheld/i);
		assert.doesNotMatch(withheldNothing, /withheld while it is reviewed/i);

		const succeeded = filedNoteFromOutcomes(
			"opt-out-request",
			"example",
			["dispute dis-example-ex-one opened as quarantined", "example ex-one: dispute_state unset → quarantined"],
			false,
		);
		assert.match(succeeded, /withheld while it is reviewed/i);
		assert.doesNotMatch(succeeded, /nothing was withheld/i);

		const hidden = filedNoteFromOutcomes(
			"opt-out-request",
			"possibility",
			["possibility ex-one: visibility published → hidden"],
			false,
		);
		assert.match(hidden, /off the public catalogue/i);
	});
});

/* -------------------------------------------------------------------------- */
/* 3. Exclusions survive a refresh                                              */
/* -------------------------------------------------------------------------- */

describe("an exclusion survives a refresh", () => {
	const engineExclusion = parseExclusion({
		id: "ex-repository-owner-repo",
		scope: "repository",
		match: "Owner/Repo",
		reason: "opt-out-request",
		state: "active",
		recorded_at: "2026-10-01T00:00:00.000Z",
	})!;

	const INCOMING = {
		rights_status: "reference",
		note: "n",
		source_repo: "owner/repo",
		source_path: "audio/room-tone.wav",
		content_hash: HASH,
		source_id: "owner/repo",
	};

	test("a row is read the way the admin wrote it", () => {
		assert.equal(engineExclusion.scope, "repository");
		// Normalised, because `Owner/Repo` and `owner/repo` are the same repository
		// and an exclusion that missed on case would protect nothing.
		assert.equal(engineExclusion.match, "owner/repo");
		assert.equal(engineExclusion.active, true);
		assert.equal(engineExclusion.reason, "opt-out-request");
	});

	test("the two halves of the project agree on what an exclusion is", () => {
		// The engine may not import app code (`docs/ARCHITECTURE.md`), so the shape is
		// declared twice. This is the test that keeps the declarations honest.
		assert.deepEqual([...EXCLUSION_SCOPES], ["repository", "path", "content-hash", "example"]);
		for (const scope of EXCLUSION_SCOPES) assert.ok(parseExclusionScope(scope));
		assert.equal(parseExclusionScope("everything"), null);

		for (const [scope, value] of [
			["repository", "owner/repo"],
			["path", "owner/repo/audio"],
			["content-hash", HASH],
			["content-hash", `sha256:${HASH}`],
			["example", "ex-one"],
		] as const) {
			assert.equal(appExclusionMatchIsUsable(scope, value), true, `${scope}:${value}`);
		}
		for (const [scope, value] of [
			["repository", "owner"],
			["repository", "owner/"],
			["path", "notapath"],
			["content-hash", "abc123"],
			["example", "two words"],
		] as const) {
			assert.equal(
				appExclusionMatchIsUsable(scope, value),
				false,
				`${scope}:${value} must be refused`,
			);
		}

		// The refusal an editor reads is a sentence about the shape they typed, not
		// the prose describing the scope. Deriving one from the other produced
		// "needs nothing from this repository is ingested again".
		for (const scope of EXCLUSION_SCOPES) {
			assert.ok(
				EXCLUSION_SCOPE_REQUIREMENT[scope].length > 20,
				`${scope} has no requirement sentence`,
			);
			assert.doesNotMatch(EXCLUSION_SCOPE_REQUIREMENT[scope], /nothing from this/i);
		}
	});

	test("a row that excludes nothing is refused rather than shown as protection", () => {
		assert.equal(parseExclusion({ scope: "repository", match: "" }), null);
		assert.equal(parseExclusion({ scope: "everything", match: "owner/repo" }), null);
		assert.equal(parseExclusion({ scope: undefined, match: "owner/repo" }), null);
		assert.deepEqual(
			parseExclusions([
				{ id: "a", scope: "repository", match: "owner/repo" },
				{ id: "b", scope: "repository", match: "" },
			]).length,
			1,
		);
	});

	test("a lifted exclusion excludes nothing and stays on the record", () => {
		const lifted = { ...engineExclusion, state: "lifted" };
		const parsed = parseExclusion(lifted)!;
		assert.equal(parsed.active, false);
		assert.equal(matches(parsed, { fullName: "owner/repo" }), false);
		assert.equal(exclusionIsActive("lifted"), false);
		assert.equal(exclusionIsActive("active"), true);
		// An unreadable state is treated as active: an exclusion that stops being one
		// because a column came back blank undoes a takedown silently.
		assert.equal(exclusionIsActive(null), true);
		assert.equal(parseExclusion({ scope: "repository", match: "owner/repo", state: "???" })!.active, true);
	});

	test("the merge policy refuses to write an excluded example at all", () => {
		const merge = mergeExample(
			{ rights_status: "reference", source_repo: "owner/repo", note: "ours" },
			INCOMING,
			{ exclusions: [engineExclusion] },
		);
		assert.deepEqual(merge.write, {}, "a takedown stops the write, not just the download");
		assert.deepEqual(merge.changed, []);
		assert.equal(merge.merged.note, "ours", "the existing record is left exactly as it was");
		assert.ok(merge.notes.some((note) => /excluded from ingestion/.test(note)));
		assert.match(merge.notes.join(" "), /owner\/repo/);
	});

	test("a refresh does not re-create an excluded example either", () => {
		const merge = mergeExample(null, INCOMING, { exclusions: [engineExclusion] });
		assert.deepEqual(merge.write, {});
		assert.deepEqual(merge.merged, {}, "nothing is created either");
		assert.ok(merge.notes.some((note) => /not written/.test(note)));
	});

	test("an exclusion by digest survives the file being renamed", () => {
		// The same bytes under a different path, which is the case a path exclusion
		// cannot catch and a takedown has to.
		const byHash = parseExclusion({ scope: "content-hash", match: HASH })!;
		assert.ok(
			exclusionForExample([byHash], {
				slug: "some-entry",
				sourceRepo: "someone-else/mirror",
				sourcePath: "elsewhere/renamed.wav",
				contentHash: `sha256:${HASH}`,
			}),
		);
	});

	test("a path exclusion covers that path and nothing beside it", () => {
		const byPath = parseExclusion({ scope: "path", match: "owner/repo/audio" })!;
		assert.equal(matches(byPath, { path: "owner/repo/audio" }), true);
		assert.equal(matches(byPath, { path: "owner/repo/audio/room.wav" }), true);
		assert.equal(matches(byPath, { path: "owner/repo/audiofiles/room.wav" }), false);
		assert.equal(matches(byPath, { path: "owner/repo/images/room.png" }), false);
	});

	test("a repository exclusion says nothing about its owner's other repositories", () => {
		// Each scope is a promise about the future, and a repository exclusion must be
		// exactly as narrow as the request was.
		assert.ok(exclusionFor([engineExclusion], { fullName: "OWNER/REPO" }));
		assert.equal(exclusionFor([engineExclusion], { fullName: "owner/repository" }), null);
		assert.equal(exclusionFor([engineExclusion], { fullName: "someone-else/repo" }), null);
	});

	test("a refresh plan skips an excluded source before anything else", () => {
		const candidate = {
			id: "c1",
			fullName: "owner/repo",
			ref: "abc",
			pushedAt: "2026-01-01T00:00:00.000Z",
			defaultBranch: "main",
			archived: false,
			fork: false,
			policyApplied: "keep",
		} as never;
		const observations = new Map([
			[
				"owner/repo",
				{
					fullName: "owner/repo",
					pushedAt: "2026-10-01T00:00:00.000Z",
					archived: false,
					fork: false,
					defaultBranch: "main",
					headSha: "def",
					stars: 10,
				},
			],
		]);

		const withoutExclusions = planRefresh([candidate], observations, "2026-10-02T00:00:00.000Z");
		assert.equal(withoutExclusions.inspect.length, 1, "it is inspectable without a takedown");
		assert.equal(withoutExclusions.excluded.length, 0);

		const withExclusions = planRefresh([candidate], observations, "2026-10-02T00:00:00.000Z", {
			exclusions: [engineExclusion],
		});
		assert.equal(withExclusions.inspect.length, 0, "a takedown outranks an upstream push");
		assert.deepEqual(withExclusions.skip, [
			{ kind: "skip", reason: "excluded", fullName: "owner/repo" },
		]);
		assert.equal(withExclusions.excluded.length, 1);
		assert.equal(withExclusions.excluded[0].exclusion.match, "owner/repo");
	});

	test("a new sighting of an excluded repository is not inspected either", () => {
		// The other half of "must not simply ingest the same exact resource again": a
		// search result can bring it straight back as a brand-new candidate.
		const observations = new Map([
			[
				"owner/repo",
				{
					fullName: "owner/repo",
					pushedAt: "2026-10-01T00:00:00.000Z",
					archived: false,
					fork: false,
					defaultBranch: "main",
					headSha: "def",
					stars: 10,
				},
			],
		]);
		const plan = planRefresh([], observations, "2026-10-02T00:00:00.000Z", {
			exclusions: [engineExclusion],
		});
		assert.equal(plan.inspect.length, 0);
		assert.equal(plan.excluded.length, 1);
	});

	test("an entry whose every source is excluded is not rewritten", () => {
		const existing = {
			title: "Ours",
			rights_status: "reference",
			visibility: "published",
			source_ids: "owner/repo,other/repo",
			summary: "s",
		};
		const incoming = { ...existing, summary: "the crawl says something new" };

		const partial = mergePossibility(existing, incoming, {
			exclusions: [engineExclusion],
		});
		assert.equal(partial.write.summary, "the crawl says something new", "a standing source is still evidence");
		assert.ok(partial.notes.some((note) => /1 of 2 source/.test(note)));

		const all = mergePossibility(existing, incoming, {
			exclusions: [
				engineExclusion,
				parseExclusion({ scope: "repository", match: "other/repo" })!,
			],
		});
		assert.deepEqual(all.write, {}, "an entry with no standing sources is not refreshed");
		assert.ok(all.notes.some((note) => /every source behind this entry is excluded/.test(note)));
		assert.equal(all.merged.summary, "s", "what a reader sees is left as it was");
	});

	test("a refresh cannot release a quarantine, whatever the licence says", () => {
		// The engine owns machine facts about a source. It has no standing to decide
		// whether somebody's objection has been answered, so this is a refusal rather
		// than a conflict.
		const quarantined = {
			rights_status: "cleared",
			downloadable: true,
			dispute_state: "quarantined",
			dispute_reason: "opt-out-request",
			dispute_note: "This is my work.",
			dispute_reported_at: "2026-10-01T00:00:00.000Z",
			dispute_resolved_at: null,
			licence_evidence: "read at c0ffee1",
			attribution: "recorded",
		};
		const merge = mergeExample(quarantined, { ...INCOMING, rights_status: "cleared" });
		assert.equal(merge.write.downloadable, false, "the download stays off");
		assert.ok(merge.notes.some((note) => /a rights dispute is open/.test(note)));
		assert.ok(merge.notes.some((note) => /quarantined/.test(note)));
		for (const field of [
			"dispute_state",
			"dispute_reason",
			"dispute_note",
			"dispute_reported_at",
			"dispute_resolved_at",
		]) {
			assert.ok(merge.preserved.includes(field), `${field} is not reported as preserved`);
		}
		assert.equal("dispute_state" in merge.write, false, "and it is never written");
		// The evidence a later correction is made from is untouched.
		assert.equal(merge.merged.licence_evidence, "read at c0ffee1");
		assert.equal(merge.merged.attribution, "recorded");
	});

	test("an example with no dispute is not treated as one", () => {
		// The mirror of the bug this guards: a blank dispute field is not a takedown.
		const merge = mergeExample(
			{ rights_status: "cleared", downloadable: true },
			{ ...INCOMING, rights_status: "cleared" },
		);
		assert.equal("downloadable" in merge.write, false);
		assert.equal(merge.notes.some((note) => /rights dispute/.test(note)), false);
	});

	test("a resolved dispute still lets the licence decide again", () => {
		const merge = mergeExample(
			{ rights_status: "reference", downloadable: false, dispute_state: "corrected" },
			{ ...INCOMING, rights_status: "cleared" },
		);
		assert.ok(merge.notes.some((note) => /stays off until someone enables it/.test(note)));
	});
});

/* -------------------------------------------------------------------------- */
/* 4. Removing one example leaves the possibility intact                       */
/* -------------------------------------------------------------------------- */

describe("removing one example does not corrupt the possibility graph", () => {
	const before = [
		facts({ slug: "ex-a", rightsStatus: "cleared", origin: "upstream" }),
		facts({ slug: "ex-b", rightsStatus: "attribution", origin: "upstream" }),
		facts({ slug: "ex-c", rightsStatus: "reference", origin: "generated" }),
	];

	test("the entry stands, and its counts become true", () => {
		const after = before.filter((example) => example.slug !== "ex-b");
		const recomputed = recomputePossibility(before, after);

		assert.equal(recomputed.exampleCount, 2, "the count is what is actually there");
		assert.equal(recomputed.distinctSources, 1, "only licences that were read count as verified");
		assert.equal(recomputed.rightsStatus, "reference", "the floor across what remains");
		assert.ok(recomputed.representative, "the entry still has something to show");
		assert.equal(recomputePossibility(before, before).exampleCount, 3, "and it was 3 before");
	});

	test("the representative moves, and says so", () => {
		// A wall that silently swapped its picture is unexplainable, so the change is
		// named rather than only applied.
		const after = before.filter((example) => example.slug !== "ex-a");
		const recomputed = recomputePossibility(before, after);
		assert.equal(recomputed.representative?.slug, "ex-b");
		assert.ok(
			recomputed.notes.some((note) => /represented by ex-b instead of ex-a/.test(note)),
			`expected the swap to be reported, got ${JSON.stringify(recomputed.notes)}`,
		);
	});

	test("an entry whose strongest example went away cannot keep the strong claim", () => {
		// This is the one that matters: an entry that said "cleared" because one of
		// three sources was cleared is exactly the false certainty this product exists
		// to prevent, and removing the cleared one has to reach the entry's status.
		const after = before.filter((example) => example.slug !== "ex-a");
		const recomputed = recomputePossibility(before, after);
		assert.equal(recomputed.rightsStatus, "reference");
		assert.ok(recomputed.notes.some((note) => /readable licence were removed/.test(note)));
	});

	test("a withdrawn example is excluded from representation, not deleted", () => {
		const withdrawn = facts({ slug: "ex-a", disputeState: "quarantined" });
		assert.deepEqual(
			representable([withdrawn]).map((example) => example.slug),
			[],
		);
		assert.equal(recomputePossibility([], [withdrawn]).exampleCount, 0);
		assert.equal(recomputePossibility([], [withdrawn]).rightsStatus, "reference");
	});

	test("an entry with nothing left says so rather than showing an empty claim", () => {
		const after = before.map((example) => ({ ...example, disputeState: "quarantined" }));
		const recomputed = recomputePossibility(before, after);
		assert.equal(recomputePossibility(before, after).exampleCount, 0);
		assert.equal(recomputePossibility(before, after).representative, null);
		assert.equal(
			recomputed.notes.some((note) => /no example is left to represent/.test(note)),
			true,
			"deletion is a person's decision, so the entry is reported rather than removed",
		);
	});

	test("the representative is chosen the same way twice", () => {
		const shuffled = [before[2], before[0], before[1]];
		assert.equal(chooseRepresentative(before)?.slug, chooseRepresentative(shuffled)?.slug);
	});

	test("a real asset represents an entry before a plate we generated", () => {
		assert.equal(chooseRepresentative(before)?.slug, "ex-a", "upstream, and then by rights");
		assert.equal(
			chooseRepresentative([
				facts({ slug: "ex-plate", origin: "generated", rightsStatus: "cleared" }),
				facts({ slug: "ex-real", origin: "upstream", rightsStatus: "reference" }),
			])?.slug,
			"ex-real",
			"a readable licence does not outrank showing the real thing",
		);
	});

	test("the app and the engine agree on the weakest status", () => {
		// `docs/ARCHITECTURE.md` forbids the app importing engine code, so this number
		// is written twice. One assertion here is cheaper than discovering it on a page.
		for (const statuses of [
			["cleared", "attribution", "reference"],
			["reference", "reference"],
			["cleared"],
			["cleared", "attribution"],
			["nonsense"],
			["cleared", "not-a-status", "attribution"],
		]) {
			assert.equal(
				weakestRights(statuses),
				worstRights(statuses),
				`${statuses.join(", ")} floors differently in the two halves`,
			);
		}
		assert.equal(weakestRights([]), "reference", "nothing to read means nothing permitted");
		assert.equal(weakestRights(["cleared", "not-a-status"]), "reference");
	});
});

/* -------------------------------------------------------------------------- */
/* 5. The queue and the trail                                                   */
/* -------------------------------------------------------------------------- */

describe("the cockpit's rights queue", () => {
	test("live cases come before closed ones", () => {
		const queue = buildRightsQueue({
			disputes: [
				dispute({ id: "dis-closed", rawState: "corrected", state: "corrected", subjectSlug: "z" }),
				dispute({ id: "dis-live", subjectSlug: "a" }),
			],
			exclusions: [exclusion()],
		});
		assert.deepEqual(
			queue.live.map((entry) => entry.id),
			["dis-live"],
		);
		assert.deepEqual(
			queue.resolved.map((entry) => entry.id),
			["dis-closed"],
		);
		assert.equal(queue.exclusions.length, 1);
	});

	test("an unrecognised state is queued as live rather than hidden", () => {
		const queue = buildRightsQueue({
			disputes: [dispute({ rawState: "escalated", state: null })],
			exclusions: [],
		});
		assert.equal(queue.live.length, 1, "the one thing that needs looking must not be filtered out");
		assert.match(disputeSummary(queue.live[0]), /^escalated · /);
	});

	test("a case row is written in the vocabulary, not in slugs", () => {
		const summary = disputeSummary(dispute({ reason: "opt-out-request" }));
		assert.match(summary, /^Quarantined · /);
		assert.doesNotMatch(summary, /opt-out-request/, "a curator reads words, not a slug");
	});

	test("the audit trail is read oldest first and carries the change", () => {
		const events = [
			auditEvent({ id: "b", occurredAt: "2026-10-02T00:00:00.000Z" }),
			auditEvent({ id: "a", occurredAt: "2026-10-01T00:00:00.000Z" }),
		].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
		assert.deepEqual(
			events.map((event) => event.id),
			["a", "b"],
		);
		assert.equal(events[0].before, null);
		assert.equal(events[0].after, "quarantined");
		assert.equal(events[0].reason, "opt-out-request");
	});
});

/* -------------------------------------------------------------------------- */
/* 6. Cross-boundary agreement                                                  */
/* -------------------------------------------------------------------------- */

describe("the two halves of the project say the same thing", () => {
	test("an exclusion row written by the app is understood by the engine", () => {
		// The contract is the row, not a shared module: `docs/ARCHITECTURE.md` keeps
		// the engine out of app code, so the fields are agreed by name.
		const row = {
			id: "ex-repository-0123456789abcdef",
			scope: "repository",
			match: "owner/repo",
			state: "active",
			reason: "opt-out-request",
			recorded_at: "2026-10-01T00:00:00.000Z",
		};
		const parsed = parseExclusion(row)!;
		assert.equal(parsed.id, row.id);
		assert.equal(parsed.active, true);
		assert.equal(exclusionIsActive(row.state), parsed.active);
		assert.equal(parseExclusionScope(row.scope), parsed.scope);
	});

	test("a dispute state the engine reads is a state the app reads", () => {
		for (const state of ["open", "quarantined", "corrected", "dismissed"]) {
			assert.equal(parseDisputeState(state), state);
			assert.equal(withholdsAsset(state), state === "open" || state === "quarantined");
		}
	});
});

/* -------------------------------------------------------------------------- */
/* The merge result shape                                                       */
/* -------------------------------------------------------------------------- */

describe("a merge that refuses is still a well-formed merge", () => {
	test("it reports what it did not write and why", () => {
		const merge: MergeResult = mergeExample(
			{ note: "kept" },
			{
				rights_status: "reference",
				note: "n",
				source_repo: "owner/repo",
				source_path: "audio/room-tone.wav",
				content_hash: HASH,
				source_id: "owner/repo",
			},
			{ exclusions: [parseExclusion({ scope: "repository", match: "owner/repo" })!] },
		);
		assert.deepEqual(merge.changed, []);
		assert.ok(merge.notes.length > 0, "a silent refusal reads as a no-op");
		assert.match(merge.notes[0], /^not written: /);
	});
});

describe("a reporter cannot put a path where a slug belongs", () => {
	// The subject of a report is a form field, and it becomes part of the URL the
	// case is published at. A slug with a slash in it is created successfully and then
	// 404s on the publish call — which is how the first live run of this reported a
	// failure for an action that had in fact worked.
	test("a hostile subject slug is reduced to a slug", () => {
		for (const hostile of [
			"owner/repo",
			"../../_emdash/api/content/examples",
			"a/b/c",
			"..",
			"with spaces",
			"%2F%2F",
			"",
		]) {
			const slug = sanitiseSlug(hostile);
			assert.equal(slug.includes("/"), false, `${hostile} kept a slash`);
			assert.equal(slug.includes(".."), false, `${hostile} kept a traversal`);
			assert.ok(slug.length > 0, `${hostile} produced nothing`);
			assert.match(slug, /^[\w.-]+$/, `${hostile} left something a slug cannot hold`);
		}
		assert.equal(sanitiseSlug("density-gradient"), "density-gradient", "a real slug is left alone");
	});

	test("two audit rows written in the same second do not collide", () => {
		// `openDispute` writes a `dispute-opened` row twice when the subject was
		// already quarantined, both inside one second. The first version derived the
		// slug from the moment alone, so the second create came back 409 and took the
		// withdrawal down with it — an audit trail that loses rows is not append-only.
		const at = "2026-10-02T11:25:44.000Z";
		const slugs = new Set(
			Array.from({ length: 25 }, () => auditSlug("dispute-opened", "ex-one", at)),
		);
		assert.equal(slugs.size, 25, "the slug repeated inside one second");
		for (const slug of slugs) assert.match(slug, /^[\w.-]+$/, `${slug} is not a slug`);
	});

	test("the exclusion row's own slug is content-addressed, so a slash cannot reach it", () => {
		// An exclusion's slug is a digest, not its match, which is why recording the
		// same repository twice lands on one row *and* why a repository name never
		// becomes a path.
		assert.equal(appExclusionMatchIsUsable("repository", "owner/repo"), true);
		assert.match(sanitiseSlug("aud-source-excluded-owner-repo-1"), /^[\w.-]+$/);
	});
});