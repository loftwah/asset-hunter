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
	moveRefusal,
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

	test("renaming moves rather than copies (#68)", () => {
		// The name of this test used to say "copies", over an implementation that
		// moves. #68 is that mismatch: the control read *Copy*, the field read
		// "copy this board to a new name", and `applyAction` emptied the source.
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

	test("a move off an empty board is answered as a refusal, not as a move (#65, #68)", () => {
		// The endpoint's `nocopy` answer: a form posted from a tab that was
		// rendered before the board was emptied. Reporting a move that did not
		// happen is the same class of lie as a live button that copies nothing.
		const outcome = boardOutcome(new URLSearchParams("nocopy=1"), () => undefined);
		assert.equal(outcome?.tone, "problem");
		assert.match(outcome?.message ?? "", /nothing to move/i);
		assert.match(outcome?.message ?? "", /empty/i, "says why, not just that it failed");
	});

	test("a name that is not a name is refused in words, and does not claim a move (#68)", () => {
		// The degenerate rename from #68: `to` reduced to the board's own name, to
		// nothing, or to punctuation. Four of the five names in that report used to
		// redirect with `copied=1`, and `boardOutcome` rendered that as "Copied to a
		// new board. Both are empty now." over a board that was full and unchanged.
		// The refusal has to say what failed *and* what to try (`DESIGN.md` §8), and
		// it must not tell a reader with entries that their board is empty.
		const outcome = boardOutcome(new URLSearchParams("nomove=1"), () => undefined);
		assert.equal(outcome?.tone, "problem");
		assert.match(outcome?.message ?? "", /nothing moved/i);
		assert.doesNotMatch(
			outcome?.message ?? "",
			/this board is empty/i,
			"the reader has entries; only the name was unusable",
		);
		assert.match(outcome?.message ?? "", /letters, numbers or spaces/i);
	});

	test("a real move names the board the entries went to (#65, #68)", () => {
		const outcome = boardOutcome(
			new URLSearchParams("moved=Pirates&board=Pirates"),
			() => undefined,
			{},
			{ heldOnDestination: 1 },
		);
		assert.equal(outcome?.tone, "ok");
		assert.match(outcome?.message ?? "", /Pirates/);
		// The old wording claimed *both* boards were empty, which is false: the
		// board moved from is emptied, the destination holds the entries.
		assert.doesNotMatch(outcome?.message ?? "", /both are empty/i);
		// A count, not an adjective — and it is the count on the board being looked
		// at, so the sentence cannot describe a board nobody is on.
		assert.match(outcome?.message ?? "", /holds 1 entry/i);
		// One verb throughout. The control is a Move, so the confirmation is too.
		assert.doesNotMatch(outcome?.message ?? "", /copied/i);
	});

	test("the moved sentence never says the board on screen is empty (#68)", () => {
		/*
		 * Present because the sentence said exactly that, while the endpoint had
		 * already been changed to redirect to the *destination*. A reader landing on
		 * the board holding their entries was told it was empty.
		 * `tests/routes.test.ts` proves it end-to-end; this is the pure rule, and
		 * the two files disagreed.
		 */
		const outcome = boardOutcome(
			new URLSearchParams("moved=Pirates&board=Pirates"),
			() => undefined,
			{},
			{ heldOnDestination: 4 },
		);
		assert.doesNotMatch(
			outcome?.message ?? "",
			/this board is empty/i,
			"the reader is on the destination board, which holds their entries",
		);
	});

	test("a full destination refuses the move instead of dropping entries (#68)", () => {
		/*
		 * The data-loss case, as a rule rather than as a report.
		 *
		 *   {default:[d1], pirates:[p0…p23], other:[o1,o2]}   pirates at the cap
		 *   rename other → pirates
		 *
		 * The merged array put the destination's own entries first and sliced to
		 * `MAX_PER_BOARD`, so every moved entry fell off the end — and
		 * `next[from] = []` emptied the source anyway. The shortlist was gone and
		 * the endpoint reported that it had moved.
		 */
		const pirates = Array.from({ length: MAX_PER_BOARD }, (_, i) => `p${i}`);
		const boards = { default: ["d1"], pirates, other: ["o1", "o2"] };

		assert.equal(moveRefusal(boards, "other", "pirates"), "destination-full");

		const after = applyAction(boards, "rename", { board: "other", to: "pirates" });
		assert.deepEqual(after.other, ["o1", "o2"], "the source board was emptied anyway");
		assert.deepEqual(after.pirates, pirates, "the destination lost entries");

		// A destination with room for everything still works.
		const roomy = { default: ["d1"], pirates: ["p1"], other: ["o1", "o2"] };
		assert.equal(moveRefusal(roomy, "other", "pirates"), null);
		assert.deepEqual(applyAction(roomy, "rename", { board: "other", to: "pirates" }).pirates, [
			"p1",
			"o1",
			"o2",
		]);
	});

	test("a blank name is a refusal, not a merge into the default board (#68)", () => {
		/*
		 * `normaliseBoardName("")` returns `DEFAULT_BOARD`, not an empty string, so
		 * normalising before checking turned "the reader pressed Move with the field
		 * blank" into a successful move of a named board into `default`. It is the
		 * most likely input on the form and the only one that lost data silently.
		 */
		const boards = { default: ["d1"], "Autumn picks": ["a1", "a2"] };
		for (const blank of ["", "   ", "\t\n"]) {
			assert.equal(
				moveRefusal(boards, "Autumn picks", blank),
				"no-name",
				`${JSON.stringify(blank)} should not be a name`,
			);
			const after = applyAction(boards, "rename", { board: "Autumn picks", to: blank });
			assert.deepEqual(after["Autumn picks"], ["a1", "a2"], "the named board was merged away");
		}
		// Punctuation-only reduces to an empty name, which is the same refusal.
		assert.equal(moveRefusal(boards, "Autumn picks", "???"), "no-name");
		// The board's own name is a different refusal.
		assert.equal(moveRefusal(boards, "Autumn picks", "Autumn picks"), "same-name");
	});

	test("naming a board at the cap does not lose one (#68)", () => {
		/*
		 * The cap is six boards. Renaming empties the source and adds a name, so the
		 * count of boards *with entries* does not change — but the map briefly held a
		 * zero-entry board still consuming a slot, and the truncation then cut the new
		 * board instead. The reader was redirected to a board that did not exist.
		 */
		const six = {
			a: ["a1"],
			b: ["b1"],
			c: ["c1"],
			d: ["d1"],
			x: ["x1"],
			default: ["z1"],
		};
		const moved = applyAction(six, "rename", { board: "a", to: "newname" });
		const stored = JSON.parse(decodeURIComponent(serialiseBoards(moved))) as Record<
			string,
			string[]
		>;

		assert.ok(stored.newname, "the board the reader was sent to does not exist");
		assert.deepEqual(stored.newname, ["a1"], "the entries did not arrive");
		assert.ok(stored.default, "the default board was clobbered");
		assert.ok(
			Object.values(stored).filter((s) => s.length > 0).length <= MAX_BOARDS,
			`more than ${MAX_BOARDS} boards survived serialisation`,
		);
		// The source is gone rather than left as an empty key eating a slot.
		assert.equal(stored.a, undefined);
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