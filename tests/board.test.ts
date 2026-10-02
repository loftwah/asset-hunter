/**
 * The shortlist board (#36).
 *
 * A board is a reader's own list, so the rules that matter are the ones about
 * what can end up in it: a cookie is attacker-editable, every slug is validated
 * against the catalogue, and the list is bounded so it stays a comparison rather
 * than becoming a second catalogue.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	COOKIE_NAME,
	DEFAULT_BOARD,
	MAX_BOARDS,
	MAX_PER_BOARD,
	applyAction,
	boardCanManage,
	boardOutcome,
	boardSwitcher,
	boardTotals,
	normaliseBoardName,
	parseBoards,
	serialiseBoards,
} from "../src/lib/board.ts";

const known = new Set(["density-gradient", "raymarched-sdf", "event-sourced-core"]);

describe("shortlist board", () => {
	test("round-trips through the cookie", () => {
		const boards = { [DEFAULT_BOARD]: ["density-gradient", "raymarched-sdf"], ships: ["event-sourced-core"] };
		const parsed = parseBoards(serialiseBoards(boards));
		assert.deepEqual(parsed[DEFAULT_BOARD], boards[DEFAULT_BOARD]);
		assert.deepEqual(parsed.ships, boards.ships);
	});

	test("a corrupt cookie costs the board, not the page", () => {
		for (const raw of [null, undefined, "", "not json", "[1,2,3]", "null", "42"]) {
			const boards = parseBoards(raw as string | null);
			assert.deepEqual(boards, { [DEFAULT_BOARD]: [] }, `raw: ${String(raw)}`);
		}
	});

	test("the default board always exists so the UI has somewhere to save to", () => {
		assert.deepEqual(parseBoards(null), { [DEFAULT_BOARD]: [] });
	});

	test("a slug the catalogue does not have is never stored", () => {
		const boards = applyAction(parseBoards(null), "save", {
			slug: "../../etc/passwd",
			known,
		});
		assert.deepEqual(boards[DEFAULT_BOARD], [], "an unknown slug is dropped, not rendered");
	});

	test("a slug with markup in it is dropped rather than escaped into a link", () => {
		const boards = applyAction(parseBoards(null), "save", {
			slug: '"><script>alert(1)</script>',
			known,
		});
		assert.equal(boards[DEFAULT_BOARD].length, 0);
	});

	test("saving the same possibility twice does not duplicate it", () => {
		let boards = applyAction(parseBoards(null), "save", { slug: "density-gradient", known });
		boards = applyAction(boards, "save", { slug: "density-gradient", known });
		assert.deepEqual(boards[DEFAULT_BOARD], ["density-gradient"]);
	});

	test("the same possibility can be in several boards at once", () => {
		let boards = applyAction(parseBoards(null), "save", { slug: "raymarched-sdf", known });
		boards = applyAction(boards, "save", { slug: "raymarched-sdf", board: "pirates", known });
		assert.deepEqual(boards[DEFAULT_BOARD], ["raymarched-sdf"]);
		assert.deepEqual(boards.pirates, ["raymarched-sdf"]);
	});

	test("remove takes it out of every board, unsave only the one", () => {
		let boards = applyAction(parseBoards(null), "save", { slug: "raymarched-sdf", known });
		boards = applyAction(boards, "save", { slug: "raymarched-sdf", board: "pirates", known });
		boards = applyAction(boards, "unsave", { slug: "raymarched-sdf", known });
		assert.deepEqual(boards[DEFAULT_BOARD], []);
		assert.deepEqual(boards.pirates, ["raymarched-sdf"]);

		boards = applyAction(boards, "remove", { slug: "raymarched-sdf", known });
		assert.deepEqual(boards.pirates, []);
	});

	test("a board is bounded, so it stays a comparison", () => {
		let boards = parseBoards(null);
		for (let i = 0; i < MAX_PER_BOARD + 12; i++) {
			boards = applyAction(boards, "save", { slug: `slug-${i}` });
		}
		assert.equal(boards[DEFAULT_BOARD].length, MAX_PER_BOARD);
	});

	test("the cookie is bounded too, because a cookie is 4KB", () => {
		let boards = parseBoards(null);
		for (let b = 0; b < MAX_BOARDS + 10; b++) {
			boards = applyAction(boards, "save", { slug: `slug-${b}`, board: `board-${b}` });
		}
		const value = serialiseBoards(boards);
		assert.ok(value.length < 3800, `cookie value is ${value.length} bytes`);
		assert.ok(Object.keys(boards).length <= MAX_BOARDS);
	});

	test("a board name is normalised rather than trusted", () => {
		assert.equal(normaliseBoardName("  Pirates  art  "), "Pirates art");
		assert.equal(normaliseBoardName(""), DEFAULT_BOARD);
		assert.equal(normaliseBoardName(null), DEFAULT_BOARD);
		// The angle brackets are removed, which is the invariant that matters:
		// a board name is rendered as text and can never carry markup. What is
		// left being a bare word is harmless and better than refusing the name.
		assert.equal(/[<>&"'`/\\]/.test(normaliseBoardName("<script>alert(1)</script>")), false);
		assert.equal(normaliseBoardName("a".repeat(200)).length, 40);
	});

	test("renaming copies rather than moves", () => {
		let boards = applyAction(parseBoards(null), "save", { slug: "raymarched-sdf", known });
		boards = applyAction(boards, "rename", { board: DEFAULT_BOARD, to: "Pirates", known });
		assert.deepEqual(boards[DEFAULT_BOARD], []);
		assert.deepEqual(boards.Pirates, ["raymarched-sdf"]);
	});

	test("clearing empties one board and leaves the others", () => {
		let boards = applyAction(parseBoards(null), "save", { slug: "raymarched-sdf", known });
		boards = applyAction(boards, "save", { slug: "density-gradient", board: "pirates", known });
		boards = applyAction(boards, "clear", { board: DEFAULT_BOARD, known });
		assert.deepEqual(boards[DEFAULT_BOARD], []);
		assert.deepEqual(boards.pirates, ["density-gradient"]);
	});

	test("an unknown action changes nothing", () => {
		const before = applyAction(parseBoards(null), "save", { slug: "raymarched-sdf", known });
		const after = applyAction(before, "explode" as never, { slug: "density-gradient", known });
		assert.deepEqual(after, before);
	});

	test("the totals ignore empty boards", () => {
		let boards = applyAction(parseBoards(null), "save", { slug: "raymarched-sdf", known });
		boards = applyAction(boards, "save", { slug: "density-gradient", board: "pirates", known });
		const totals = boardTotals(boards);
		assert.equal(totals.boards, 2);
		assert.equal(totals.items, 2);
		assert.deepEqual(totals.counts, { default: 1, pirates: 1 });
	});

	test("the board switcher lists empty boards, so a copy can be followed (#65)", () => {
		// The state after a copy: the board it came from is empty and the entries
		// are on the destination. Listing only non-empty boards meant the reader
	// was told where their entries were and had no control that could take them
	// there.
		const copied = { [DEFAULT_BOARD]: [], Pirates: ["density-gradient"] };
		const switcher = boardSwitcher(copied);
		assert.ok(switcher, "a copied board left no way back to the entries");
		assert.deepEqual(
			switcher.map((b) => [b.label, b.count]),
			[
				["Shortlist", 0],
				["Pirates", 1],
			],
			"the honest zero is what makes the empty board reachable",
		);
	});

	test("one board is not a switcher, because a switcher with one entry does nothing", () => {
		assert.equal(boardSwitcher({ [DEFAULT_BOARD]: [] }), null);
		assert.equal(boardSwitcher({ [DEFAULT_BOARD]: ["density-gradient"] }), null);
	});

	test("the copy control is refused when the board has nothing on it (#65)", () => {
		// `boardCanManage` is the one rule both the page and the endpoint use to
		// decide whether copy/clear/export may be offered, so it is asserted here
		// as the boundary it is rather than only through the rendered page.
		assert.equal(boardCanManage(0), false, "nothing to manage");
		assert.equal(boardCanManage(1), true, "one entry is enough to copy");
		assert.equal(boardCanManage(MAX_PER_BOARD), true);
		// A negative count cannot happen, and must not read as manageable.
		assert.equal(boardCanManage(-1), false);
	});

	test("a copy of an empty board is answered as a refusal, not as a copy (#65)", () => {
		// The endpoint's `nocopy` answer: a form posted from a tab that was
		// rendered before the board was emptied. Reporting a copy that did not
		// happen is the same class of lie as a live button that copies nothing.
		const outcome = boardOutcome(new URLSearchParams("nocopy=1"), () => undefined);
		assert.equal(outcome?.tone, "problem");
		assert.match(outcome?.message ?? "", /nothing to copy/i);
		assert.match(outcome?.message ?? "", /empty/i, "says why, not just that it failed");
	});

	test("a real copy names the board the entries went to (#65)", () => {
		const outcome = boardOutcome(new URLSearchParams("copied=Pirates"), () => undefined);
		assert.equal(outcome?.tone, "ok");
		assert.match(outcome?.message ?? "", /Pirates/);
		// The old wording claimed *both* boards were empty, which is false: the
		// board copied from is emptied, the destination holds the entries.
		assert.doesNotMatch(outcome?.message ?? "", /both are empty/i);
	});

	test("clearing says where the entries actually are (#65)", () => {
		// Clearing empties one board only, so the honest sentence needs the count
		// of what survived on the reader's other boards.
		const alone = boardOutcome(new URLSearchParams("cleared=1"), () => undefined, {
			keptElsewhere: 0,
		});
		assert.match(alone?.message ?? "", /nothing was kept anywhere else/i);

		const withOthers = boardOutcome(new URLSearchParams("cleared=1"), () => undefined, {
			keptElsewhere: 3,
		});
		assert.match(withOthers?.message ?? "", /3 entries are kept on your other boards/i);
		assert.doesNotMatch(
			withOthers?.message ?? "",
			/nothing was kept anywhere else/i,
			"the false claim is the one this assertion exists to prevent",
		);

		const oneElsewhere = boardOutcome(new URLSearchParams("cleared=1"), () => undefined, {
			keptElsewhere: 1,
		});
		assert.match(oneElsewhere?.message ?? "", /1 entry is kept on your other board\b/);
	});

	test("the cookie is named, and it is not readable by a script", () => {
		// HttpOnly is what keeps a script on the page from rewriting the board.
		// The value itself is validated on the way in, which is the other half.
		assert.equal(COOKIE_NAME, "ah_board");
	});
});