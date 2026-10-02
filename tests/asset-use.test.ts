/**
 * Asset use, handoff and integrity (#42).
 *
 * The rules asserted here are the ones this product exists to protect, and
 * every one of them is a rule that fails silently. A wrong use state renders as
 * a plausible page rather than an error, so they are assertions rather than
 * code review:
 *
 * - uncertain material must never look cleared, and an unrecognised rights
 *   status has to land in the most restrictive bucket;
 * - no download control may exist without a retained, hashed, permitted
 *   payload — including when the record claims to retain one;
 * - a credit is reproduced, never generated, so a missing author stays missing;
 * - bytes are not served unless they match the digest the record claims.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
	UNSTATED_USE_STATE,
	assetUsePaths,
	creditBlockId,
	creditLines,
	creditOf,
	creditReady,
	creditText,
	hashesMatch,
	isContentHash,
	isReusable,
	normaliseHash,
	payloadFilename,
	payloadResult,
	recordDocument,
	revisionRows,
	selectionCreditText,
	sha256Hex,
	summariseUse,
	summaryLine,
	useActions,
	useDecision,
	useStateFor,
} from "../src/lib/asset-use.ts";
import {
	USE_STATE_COLOR,
	USE_STATE_LABEL,
	USE_STATE_MEANING,
	USE_STATE_OBLIGATION,
} from "../src/lib/vocabulary.ts";
import type { Example } from "../src/lib/catalogue.ts";

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

/** A fixture for each use state that is not reference only. */
const cleared = (over: Partial<Example> = {}) =>
	example({
		slug: "ex-cleared",
		title: "Ambient loop",
		rightsStatus: "cleared",
		licenceSpdx: "CC0-1.0",
		attribution: "Public domain. No attribution required, and none is claimed.",
		sourceUrl: "https://github.com/example/loops",
		sourceRepo: "example/loops",
		sourceRef: "c0ffee1",
		sourcePath: "loops/room-tone.wav",
		contentHash: HASH,
		...over,
	});

describe("use states are the four the issue names, and no others", () => {
	test("each rights status maps to exactly one use state", () => {
		assert.equal(useStateFor(example({ rightsStatus: "cleared" })), "reusable");
		assert.equal(
			useStateFor(example({ rightsStatus: "attribution" })),
			"reusable-with-attribution",
		);
		assert.equal(useStateFor(example({ rightsStatus: "review" })), "review-required");
		assert.equal(useStateFor(example({ rightsStatus: "reference" })), "reference-only");
	});

	test("an absent or unrecognised status is never permissive", () => {
		// The failure this guards is the catalogue growing a fifth status and
		// every unrecognised record quietly reading as reusable.
		for (const status of [null, undefined, "", "public-domain", "CLEARED", "toString"]) {
			assert.equal(
				useStateFor(example({ rightsStatus: status as string | null })),
				"reference-only",
				`status ${String(status)} must not read as permission`,
			);
		}
		assert.equal(useStateFor(null), UNSTATED_USE_STATE);
		assert.equal(useStateFor(undefined), UNSTATED_USE_STATE);
	});

	test("every use state has a label, a sentence and a colour", () => {
		for (const state of ["reusable", "reusable-with-attribution", "review-required", "reference-only"] as const) {
			assert.ok(USE_STATE_LABEL[state].length > 0, `no label for ${state}`);
			assert.ok(USE_STATE_MEANING[state].length > 40, `${state} meaning is too thin`);
			assert.ok(USE_STATE_COLOR[state].startsWith("var(--rights-"), `${state} has no colour token`);
		}
	});

	test("reference only never reads as a softer reusable", () => {
		// The single most damaging failure in this vocabulary.
		const meaning = USE_STATE_MEANING["reference-only"].toLowerCase();
		assert.equal(meaning.includes("permitted for use"), false);
		assert.ok(meaning.includes("no licence was found"));
		assert.equal(isReusable("reference-only"), false);
		assert.equal(isReusable("review-required"), false);
	});

	test("review required says the decision is the reader's", () => {
		assert.match(USE_STATE_MEANING["review-required"], /before using any of it/i);
		assert.match(USE_STATE_MEANING["reusable-with-attribution"], /credit/i);
	});

	test("only the unobliged state has no obligation", () => {
		assert.equal(USE_STATE_OBLIGATION.reusable, null);
		for (const state of ["reusable-with-attribution", "review-required", "reference-only"] as const) {
			assert.ok(
				(USE_STATE_OBLIGATION[state] ?? "").length > 20,
				`${state} must state what the reader owes`,
			);
		}
		// The attribution obligation has to name the credit, because the credit is
		// the thing a reader would otherwise skip.
		assert.match(USE_STATE_OBLIGATION["reusable-with-attribution"] ?? "", /credit/i);
	});

	test("an unrecognised status is reported as unstated rather than invented", () => {
		const decision = useDecision(example({ rightsStatus: "public-domain" as string }));
		assert.equal(decision.rightsStatus, null);
		assert.equal(decision.state, "reference-only");
	});
});

describe("no download without a retained, hashed, permitted payload", () => {
	test("reference only gets no download even if the record claims one", () => {
		// The record is not the last word: the status is. A stale or wrong
		// `downloadable` must not produce a button.
		const decision = useDecision(
			example({ rightsStatus: "reference", downloadable: true, contentHash: HASH }),
		);
		assert.equal(decision.handoff.as, "record");
		assert.equal(decision.handoff.blockedBy, "rights");
		assert.equal(
			useActions(example({ rightsStatus: "reference", downloadable: true, contentHash: HASH })).some(
				(a) => a.id === "download",
			),
			false,
		);
	});

	test("review required gets no download either", () => {
		const decision = useDecision(
			example({ rightsStatus: "review", downloadable: true, contentHash: HASH }),
		);
		assert.equal(decision.handoff.blockedBy, "rights");
		assert.equal(
			useActions(example({ rightsStatus: "review", downloadable: true, contentHash: HASH })).some(
				(a) => a.id === "download",
			),
			false,
		);
	});

	test("an attribution obligation with no recorded credit blocks the handover", () => {
		// Permitted is not the same as deliverable: the condition on the
		// permission cannot be met, so the asset is withheld.
		const decision = useDecision(
			example({
				rightsStatus: "attribution",
				attribution: null,
				downloadable: true,
				contentHash: HASH,
			}),
		);
		assert.equal(decision.state, "reusable-with-attribution");
		assert.equal(decision.creditReady, false);
		assert.equal(decision.handoff.blockedBy, "obligation");
		assert.match(decision.creditGap ?? "", /no attribution is recorded/i);
	});

	test("permitted but not retained is a record handoff, and says so", () => {
		const decision = useDecision(cleared({ downloadable: false }));
		assert.equal(decision.state, "reusable");
		assert.equal(decision.handoff.as, "record");
		assert.equal(decision.handoff.blockedBy, "not-retained");
		assert.match(decision.handoff.statement, /holds no copy of the original/i);
	});

	test("a retained payload with no usable hash is not served", () => {
		// Serving a file we cannot tie to the record would be the one claim this
		// route cannot support.
		for (const hash of [null, "", "not-a-hash", "abc123"]) {
			const decision = useDecision(cleared({ downloadable: true, contentHash: hash }));
			assert.equal(decision.handoff.blockedBy, "unverified", `hash: ${String(hash)}`);
			assert.equal(decision.handoff.as, "record");
		}
	});

	test("all four conditions together are what earns a download", () => {
		const decision = useDecision(cleared({ downloadable: true }));
		assert.equal(decision.handoff.as, "payload");
		assert.equal(decision.handoff.blockedBy, null);
		const download = useActions(cleared({ downloadable: true })).find((a) => a.id === "download");
		assert.ok(download, "a retained, hashed, cleared example must offer a download");
		assert.equal(download.href, "/api/payload/ex-cleared");
		assert.equal(download.kind, "download");
	});

	test("a download is never offered without a stated hash, whatever the record says", () => {
		for (const state of ["cleared", "attribution"] as const) {
			const actions = useActions(
				cleared({ rightsStatus: state, attribution: "Recorded credit.", downloadable: true, contentHash: null }),
			);
			assert.equal(
				actions.some((a) => a.id === "download"),
				false,
				`${state} offered a download with no hash`,
			);
		}
	});
});

describe("actions appear only when the thing they do is true", () => {
	test("the source and licence record is always offered, whatever the rights", () => {
		// The evidence is owed to a reader even when the asset is not.
		for (const status of ["cleared", "attribution", "review", "reference", null] as const) {
			const record = useActions(example({ rightsStatus: status as string | null })).find(
				(a) => a.id === "record",
			);
			assert.ok(record, `no record action for ${String(status)}`);
			assert.equal(record.href, "/api/record/ex-one");
		}
	});

	test("the canonical source appears only for a real http(s) URL", () => {
		assert.ok(useActions(cleared()).some((a) => a.id === "upstream"));
		for (const url of [null, "", "javascript:alert(1)", "not a url", "file:///etc/passwd"]) {
			const actions = useActions(cleared({ sourceUrl: url as string | null }));
			assert.equal(
				actions.some((a) => a.id === "upstream"),
				false,
				`followed ${String(url)}`,
			);
		}
	});

	test("licence evidence and revision inspection are offered when there is evidence", () => {
		// A record with nothing recorded behind it must not grow controls that
		// lead to an empty disclosure.
		const bare = useActions(
			cleared({ sourceRef: null, sourcePath: null, contentHash: null, sourceUrl: null }),
		);
		assert.equal(bare.some((a) => a.id === "licence-evidence"), false);
		assert.equal(bare.some((a) => a.id === "revision"), false);

		const rich = useActions(
			cleared({
				licenceEvidence: "\"CC0. This work has been released into the public domain.\"",
				sourceRef: "c0ffee1",
			}),
		);
		assert.ok(rich.some((a) => a.id === "licence-evidence"));
		assert.ok(rich.some((a) => a.id === "revision"));
	});

	test("the credit action needs a credit, and names the block it copies", () => {
		assert.equal(useActions(cleared({ attribution: null })).some((a) => a.id === "credit"), false);
		const action = useActions(cleared()).find((a) => a.id === "credit");
		assert.equal(action?.copies, creditBlockId("ex-cleared"));
		assert.equal(action?.kind, "copy");
	});

	test("every action explains itself, because an unexplained control is a claim", () => {
		for (const action of useActions(cleared({ licenceEvidence: "quoted", sourceRef: "abc" }))) {
			assert.ok(action.label.length > 3, `${action.id} has no label`);
			assert.ok(action.note.length > 20, `${action.id} has no explanation`);
		}
	});

	test("paths are built in one place and are encoded", () => {
		assert.equal(assetUsePaths.use("a b"), "/use/a%20b");
		assert.equal(assetUsePaths.record("a/b"), "/api/record/a%2Fb");
		assert.equal(assetUsePaths.payload("a/b"), "/api/payload/a%2Fb");
	});
});

describe("a credit is reproduced, never generated", () => {
	test("no recorded attribution means no credit, not a template", () => {
		assert.equal(creditOf(example()), null);
		assert.equal(creditReady(example()), false);
		assert.equal(creditText(example()), null);
		assert.equal(creditOf(example({ attribution: "   " })), null);
	});

	test("the recorded attribution is kept exactly as written", () => {
		const recorded = "  \"Paper textures\" by Wren Aliyeva, CC BY 4.0.  ";
		assert.equal(creditOf(example({ attribution: recorded })), recorded.trim());
	});

	test("the credit block carries recorded facts and nothing else", () => {
		const text = creditText(cleared());
		assert.ok(text);
		assert.match(text, /Public domain\. No attribution required, and none is claimed\./);
		assert.match(text, new RegExp(`Licence: CC0-1\\.0`));
		assert.match(text, new RegExp(`Source: https://github\\.com/example/loops`));
		assert.match(text, new RegExp(`Path: loops/room-tone\\.wav`));
		assert.match(text, new RegExp(HASH));
		// No author is invented for a record that never recorded one.
		assert.equal(/author|by <|unknown/i.test(text as string), false);
	});

	test("the licence evidence quote is not pasted into a credits file", () => {
		const text = creditText(cleared({ licenceEvidence: "A QUOTE ONLY" }));
		assert.equal(text?.includes("A QUOTE ONLY"), false);
		// It is still inspectable, as its own row.
		assert.ok(creditLines(cleared({ licenceEvidence: "A QUOTE ONLY" })).some(
			(row) => row.label === "Licence evidence",
		));
	});

	test("row labels are the vocabulary's and empty rows are dropped", () => {
		const rows = creditLines(cleared());
		const labels = rows.map((row) => row.label);
		// "Attribution" and "Licence evidence" are the terms docs/VOCABULARY.md
		// fixes; "Evidence" alone is not.
		assert.equal(labels.includes("Attribution"), true);
		assert.equal(labels.includes("Evidence"), false);
		for (const row of rows) assert.ok(row.value.length > 0, `${row.label} rendered empty`);
		// Order is stable, so two renders diff cleanly.
		assert.deepEqual(creditLines(cleared()), rows);
	});

	test("the revision disclosure carries the pointer to the file", () => {
		const labels = revisionRows(cleared({ licenceEvidence: "quoted" })).map((r) => r.label);
		assert.deepEqual(labels, ["Source", "Repository", "Ref", "Path", "Content hash"]);
		assert.equal(labels.includes("Licence evidence"), false);
	});

	test("a selection credit is one block with a heading per example", () => {
		const text = selectionCreditText(
			[cleared(), example({ slug: "ex-two", title: "Two", rightsStatus: "reference" })],
			(e) => e.title,
		);
		assert.ok(text);
		assert.match(text, /^# Credits/);
		// The reference-only example contributes no credit, because it recorded
		// no evidence at all.
		assert.equal(text.includes("## Two"), false);
		assert.match(text, /## Ambient loop/);
	});

	test("a selection with nothing recorded has no credit block", () => {
		assert.equal(selectionCreditText([example()], (e) => e.title), null);
		assert.equal(selectionCreditText([], (e) => e.title), null);
	});
});

describe("content hashes", () => {
	test("a recorded hash is recognised, and a broken one is not", () => {
		assert.equal(isContentHash(HASH), true);
		assert.equal(isContentHash(HASH.toUpperCase()), true);
		assert.equal(isContentHash(`sha256:${HASH}`), true);
		for (const value of [null, undefined, "", "   ", HASH.slice(0, 63), `${HASH}0`, "zz", "1234"]) {
			assert.equal(isContentHash(value as string | null), false, `accepted ${String(value)}`);
		}
	});

	test("a prefix and a case difference are not a mismatch", () => {
		// Refusing to compare these would report a false mismatch for an
		// identical file, and a false mismatch on a rights record is how people
		// stop reading provenance.
		assert.equal(normaliseHash(`SHA-256:${HASH.toUpperCase()}`), HASH);
		assert.equal(hashesMatch(`sha256:${HASH.toUpperCase()}`, HASH), true);
		assert.equal(hashesMatch(HASH, HASH), true);
	});

	test("a different file, a missing hash and a broken hash all fail to match", () => {
		assert.equal(hashesMatch(HASH, "f".repeat(64)), false);
		assert.equal(hashesMatch(HASH, null), false);
		assert.equal(hashesMatch(null, HASH), false);
		assert.equal(hashesMatch("nope", "nope"), false);
	});

	test("the digest is SHA-256 of the bytes, not of their length", async () => {
		// Known vector: SHA-256 of the empty input.
		assert.equal(await sha256Hex(new Uint8Array(0)), HASH);
		assert.equal(
			await sha256Hex(new TextEncoder().encode("abc")),
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("the payload route serves bytes only when they are provably the record's", () => {
	test("a reference-only example is refused, whatever the address", async () => {
		const result = await payloadResult({
			example: example({ rightsStatus: "reference", downloadable: true, contentHash: HASH }),
			retained: { bytes: new Uint8Array([1, 2, 3]) },
		});
		assert.equal(result.status, 403);
		assert.equal(result.headers["x-ah-blocked-by"], "rights");
		assert.equal(result.headers["x-ah-use-state"], "reference-only");
		assert.equal(result.bytes, null);
		// A refusal says what the rule is, not just that the rule fired.
		assert.match(result.body ?? "", /do not copy, ship or redistribute/i);
		assert.match(result.body ?? "", /no file is served/i);
	});

	test("a missing credit is refused, and the reason names the credit", async () => {
		const result = await payloadResult({
			example: cleared({ rightsStatus: "attribution", attribution: null, downloadable: true }),
			retained: { bytes: new Uint8Array([1]) },
		});
		assert.equal(result.status, 403);
		assert.equal(result.headers["x-ah-blocked-by"], "obligation");
		assert.match(result.body ?? "", /no attribution is recorded/i);
	});

	test("permitted but not retained answers 409 with the record, not a 404", async () => {
		// 404 would say the record does not exist, which is a different and
		// untrue claim: the record exists and the file does not.
		const result = await payloadResult({ example: cleared(), retained: null });
		assert.equal(result.status, 409);
		assert.equal(result.headers["x-ah-blocked-by"], "not-retained");
		assert.equal(result.headers["x-ah-handoff"] ?? result.headers["x-ah-blocked-by"], "not-retained");
		const body = JSON.parse(result.body ?? "{}") as Record<string, unknown>;
		assert.equal(body.schema, "asset-hunter.record/1");
		assert.equal(body.handoff, "record");
		assert.equal(body.payloadRetained, false);
		assert.equal(body.sourceRepo, "example/loops");
	});

	test("an unverified payload is refused rather than served on trust", async () => {
		const result = await payloadResult({
			example: cleared({ downloadable: true, contentHash: null }),
			retained: { bytes: new Uint8Array([1]) },
		});
		assert.equal(result.status, 409);
		assert.equal(result.headers["x-ah-blocked-by"], "unverified");
		assert.equal(result.bytes, null);
	});

	test("a retained payload that cannot be read serves nothing", async () => {
		const result = await payloadResult({ example: cleared({ downloadable: true }), retained: null });
		assert.equal(result.status, 409);
		assert.equal(result.bytes, null);
		assert.match(result.body ?? "", /could not be read/i);
	});

	test("the retained original is served unmodified, with its digest", async () => {
		const bytes = new TextEncoder().encode("the exact bytes that were hashed");
		const source = cleared({ downloadable: true });
		const result = await payloadResult({
			example: { ...source, contentHash: await sha256Hex(bytes) },
			retained: { bytes },
		});
		assert.equal(result.status, 200);
		assert.equal(result.headers["x-ah-integrity"], "verified");
		assert.equal(result.headers["x-ah-sha256"], await sha256Hex(bytes));
		assert.equal(result.headers["content-length"], String(bytes.byteLength));
		assert.equal(result.headers["x-content-type-options"], "nosniff");
		assert.match(result.headers["content-disposition"] ?? "", /attachment; filename="room-tone\.wav"/);
		assert.equal(result.body, null);
		assert.deepEqual(result.bytes, bytes);
	});

	test("a corrupted payload is refused and nothing is sent", async () => {
		// The #10 criterion in one assertion: corrupting a manifested file makes
		// verification fail, here it makes the download fail.
		const result = await payloadResult({
			example: cleared({ downloadable: true, contentHash: HASH }),
			retained: { bytes: new TextEncoder().encode("tampered") },
		});
		assert.equal(result.status, 503);
		assert.equal(result.headers["x-ah-integrity"], "mismatch");
		assert.equal(result.bytes, null);
		assert.match(result.body ?? "", /do not match the content hash/i);
	});

	test("a payload response is never cached", async () => {
		const result = await payloadResult({ example: example(), retained: null });
		assert.equal(result.headers["cache-control"], "no-store");
	});

	test("the filename is derived from the source path and cannot inject a header", async () => {
		assert.equal(payloadFilename(cleared()), "room-tone.wav");
		assert.equal(
			payloadFilename(cleared({ sourcePath: 'evil"; drop\r\nX-Injected: 1/x' })).includes("\r"),
			false,
		);
		assert.equal(/["\\]/.test(payloadFilename(cleared({ sourcePath: 'a"b\\c' }))), false);
		// With no recorded path, the example's own id stands in.
		assert.equal(payloadFilename(cleared({ sourcePath: null })), "ex-cleared");
	});
});

describe("the machine-readable record invents nothing", () => {
	test("every field is a recorded value or null", () => {
		const record = recordDocument(example());
		assert.equal(record.schema, "asset-hunter.record/1");
		for (const key of ["sourceUrl", "sourceRepo", "sourceRef", "sourcePath", "licenceSpdx", "licenceEvidence", "contentHash", "credit"] as const) {
			assert.equal(record[key], null, `${key} was invented on an empty record`);
		}
		assert.equal(record.contentHashVerified, false);
		assert.equal(record.payloadRetained, false);
		assert.equal(record.useState, "reference-only");
	});

	test("the record states what it can and cannot hand over", () => {
		const refused = recordDocument(example());
		assert.equal(refused.handoff, "record");
		assert.equal(refused.handoffBlockedBy, "rights");
		assert.ok(refused.handoffStatement.length > 40);

		const offered = recordDocument(cleared({ downloadable: true }));
		assert.equal(offered.handoff, "payload");
		assert.equal(offered.handoffBlockedBy, null);
		assert.equal(offered.payloadRetained, true);
		assert.equal(offered.contentHashVerified, true);
		assert.equal(offered.creditReady, true);
	});
});

describe("the selection summary keeps the honest zero", () => {
	test("counts every state and orders the sentence worst first", () => {
		const summary = summariseUse([
			cleared({ slug: "a", downloadable: true }),
			cleared({ slug: "b", rightsStatus: "attribution", downloadable: true }),
			example({ slug: "c", rightsStatus: "review" }),
			example({ slug: "d" }),
		]);
		assert.equal(summary.total, 4);
		assert.equal(summary.byState.reusable, 1);
		assert.equal(summary.byState["reusable-with-attribution"], 1);
		assert.equal(summary.byState["review-required"], 1);
		assert.equal(summary.byState["reference-only"], 1);
		assert.equal(summary.creditRequired, 1);
		// Both reuse states earn a download once all four conditions hold, which
		// is the point: the obligation is a condition to satisfy, not a veto.
		assert.equal(summary.payloads, 2);
		assert.equal(
			summaryLine(summary),
			"1 reference only · 1 review required · 1 reusable with attribution · 1 reusable",
		);
	});

	test("an empty selection is a real answer, not an error", () => {
		const summary = summariseUse([]);
		assert.equal(summary.total, 0);
		assert.equal(summary.payloads, 0);
		assert.equal(summaryLine(summary), "No examples yet");
	});

	test("states with no examples are not mentioned", () => {
		// A count of zero for a state nobody reached is noise, and the payload
		// zero is stated separately with its own wording.
		assert.equal(summaryLine(summariseUse([example()])), "1 reference only");
		assert.equal(summariseUse([example()]).payloads, 0);
	});
});
