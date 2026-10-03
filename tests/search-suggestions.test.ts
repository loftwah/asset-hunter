import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { searchSuggestions } from "../src/lib/search-text.ts";

describe("suggestions a reader can actually use", () => {
	test("come from the catalogue, so none of them can be a dead end", () => {
		// The defect: three hand-written queries, one of which returned nothing.
		const possibilities = [
			{ verticalLabel: "Logos" }, { verticalLabel: "Logos" }, { verticalLabel: "Logos" },
			{ verticalLabel: "Games" }, { verticalLabel: "Branding" },
		];
		assert.deepEqual(searchSuggestions(possibilities), ["Logos", "Branding", "Games"]);
	});

	test("lead with the populated verticals, not the alphabetical ones", () => {
		// An alphabetical list suggests the emptiest verticals first, which is the
		// opposite of help.
		const possibilities = [
			{ verticalLabel: "AI Products" },
			{ verticalLabel: "Logos" }, { verticalLabel: "Logos" }, { verticalLabel: "Logos" },
		];
		assert.equal(searchSuggestions(possibilities, 1)[0], "Logos");
	});

	test("skip an entry with no vertical rather than suggesting nothing", () => {
		const possibilities = [{ verticalLabel: null }, { verticalLabel: "  " }, { verticalLabel: "Icons" }];
		assert.deepEqual(searchSuggestions(possibilities), ["Icons"]);
	});

	test("are empty rather than absent when the catalogue has no verticals", () => {
		// An empty list must render as nothing, not as a broken chip or the word
		// "undefined" in a search box.
		assert.deepEqual(searchSuggestions([]), []);
		assert.deepEqual(searchSuggestions([{ verticalLabel: null }]), []);
		assert.deepEqual(searchSuggestions([{ verticalLabel: "Icons" }], 0), []);
	});

	test("deduplicate case-insensitively but keep the label as written", () => {
		const possibilities = [{ verticalLabel: "Logos" }, { verticalLabel: "logos" }];
		assert.deepEqual(searchSuggestions(possibilities), ["Logos"], "one suggestion, because both would return the same results");
	});
});
