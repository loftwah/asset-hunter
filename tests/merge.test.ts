/**
 * The merge policy, tested on its own.
 *
 * Issue #40 requires an explicit merge policy rather than last-write-wins, and
 * these are the cases where last-write-wins is specifically wrong: a curator's
 * title surviving a crawl, a licence regression reaching the public page anyway,
 * and a re-run writing nothing at all.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mergeExample, mergePossibility, shouldPublish } from "../engine/src/merge.ts";

const INCOMING = {
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
	source_hunt: "abc123:sfx",
	source_ids: "a/b,c/d",
	source_revision: "abc123",
	machine_synced_at: "2026-10-01T00:00:00.000Z",
};

describe("merge policy", () => {
	test("a new entry is a draft at rank 0, never public", () => {
		const merge = mergePossibility(null, INCOMING);
		assert.equal(merge.write.visibility, "draft");
		assert.equal(merge.write.editorial_rank, 0);
		assert.ok(merge.notes.some((n) => n.includes("human")));
	});

	test("machine facts are written and editorial fields are not", () => {
		const existing = {
			...INCOMING,
			title: "A title a person wrote",
			editorial_rank: 0.9,
			featured: true,
			visibility: "published",
			build_notes: "hand written",
		};
		const merge = mergePossibility(existing, { ...INCOMING, title: "A new machine title" });
		assert.equal(merge.write.title, "A new machine title", "a machine field is updated");
		assert.equal(merge.changed.includes("editorial_rank"), false);
		assert.ok(merge.preserved.includes("editorial_rank"), "reported from the catalogue, not the payload");
		assert.ok(merge.preserved.includes("featured"));
		assert.ok(merge.preserved.includes("visibility"));
		assert.equal("build_notes" in merge.write, false, "a hand-written note is not overwritten");
		assert.equal("editorial_rank" in merge.write, false);
		assert.equal("visibility" in merge.write, false, "a crawl cannot publish an entry");
	});

	test("an identical refresh writes nothing at all", () => {
		const existing = { ...INCOMING, editorial_rank: 0, visibility: "draft" };
		const merge = mergePossibility(existing, INCOMING);
		assert.deepEqual(merge.write, {}, "a re-run must be a no-op");
		assert.deepEqual(merge.changed, []);
	});

	test("a rights regression is written even over a human review", () => {
		const existing = {
			...INCOMING,
			rights_status: "cleared",
			visibility: "published",
			editorial_rank: 0.9,
		};
		const merge = mergePossibility(existing, INCOMING);
		assert.equal(merge.write.rights_status, "reference");
		assert.ok(merge.notes.some((n) => n.includes("regressed")));
		assert.ok(
			merge.notes.some((n) => n.includes("published")),
			"a published entry that just lost its permission is worth saying out loud",
		);
	});

	test("a rights improvement is written too, but never auto-publishes", () => {
		const existing = { ...INCOMING, visibility: "draft" };
		const merge = mergePossibility(existing, { ...INCOMING, rights_status: "cleared" });
		assert.equal(merge.write.rights_status, "cleared");
		assert.equal(shouldPublish(existing), false);
	});

	test("null and zero are not confused", () => {
		// The engine withdraws an estimate rather than leaving it standing: a
		// machine that stops measuring does not get to keep the number it
		// guessed last time.
		const merge = mergePossibility(
			{ ...INCOMING, novelty: 0, coverage: 0 },
			INCOMING,
		);
		assert.equal(merge.write.novelty, null);
		assert.equal(merge.write.coverage, null);
	});

	test("a download is switched off when the licence stops permitting it", () => {
		const merge = mergeExample(
			{ rights_status: "cleared", downloadable: true },
			{ rights_status: "reference", note: "n" },
		);
		assert.equal(merge.write.downloadable, false);
		assert.ok(merge.notes.some((n) => n.includes("download disabled")));
	});

	test("a permitted licence does not silently re-enable a download", () => {
		const merge = mergeExample(
			{ rights_status: "reference", downloadable: false },
			{ rights_status: "attribution", note: "n" },
		);
		assert.equal("downloadable" in merge.write, false);
		assert.ok(merge.notes.some((n) => n.includes("stays off")));
	});

	test("EmDash's 0/1 booleans are not read as a human turning a download on", () => {
		const merge = mergeExample(
			// Stored as 1 rather than true, which is how a boolean round-trips
			// through some EmDash paths.
			{ rights_status: "cleared", downloadable: 1 },
			{ rights_status: "reference", note: "n" },
		);
		assert.equal(merge.write.downloadable, false);
	});

	test("visibility is only ever published when a person set it", () => {
		assert.equal(shouldPublish(null), false);
		assert.equal(shouldPublish({ visibility: "draft" }), false);
		assert.equal(shouldPublish({ visibility: "published" }), true);
		assert.equal(shouldPublish({}), false, "an entry with no visibility is not public");
	});
});
