/**
 * An example is identified by something of its own, or says it has no name (#69).
 *
 * The defect was that `example.title` is written from the *technique* an example
 * demonstrates, so it is usually character-identical to the possibility's title.
 * `/use/<slug>` printed that string three times — breadcrumb, `h1`, and a heading
 * over each example block.
 *
 * With one example per page that reads as repetition. With two it is the more
 * serious half: the blocks are indistinguishable, so a reader deciding what they
 * may reuse cannot tell which evidence belongs to which decision. Every use-page
 * fixture had exactly one example, which is why nobody saw it.
 *
 * `exampleIdentity` is the rule and it is pure, so it is tested here without a
 * browser. The rendered consequence is checked against the live two-example
 * fixture, because a pure test cannot prove the page uses it.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
	UNNAMED_EXAMPLE,
	exampleIdentity,
	originLabelFor,
} from "../src/lib/vocabulary.ts";
import { USE_PAGE_FIXTURES, usePageFixtureFor } from "../src/lib/fixtures.ts";

const baseUrl = process.env.AH_URL ?? "http://localhost:4321";
const TWO = "fixture-use-page-two-examples";

describe("exampleIdentity prefers what is about the example", () => {
	test("a path in the source repository is the best name there is", () => {
		// Two files in one project, distinguished only by where they are. This is the
		// case the rule exists for.
		assert.equal(
			exampleIdentity({
				title: "Bento layouts with a deliberate density ramp",
				origin: "generated",
				sourcePath: "layouts/compact.png",
				sourceRepo: "example/bento",
			}),
			"layouts/compact.png",
		);
	});

	test("without a path, the origin identifies it", () => {
		// A derived preview and the upstream asset it previews are different files,
		// and the origin is the only thing in the record that says which is which.
		assert.equal(
			exampleIdentity({ title: "Some title", origin: "derived" }),
			originLabelFor("derived"),
		);
	});

	test("a title is used when there is nothing better", () => {
		// A generated plate with no source has no path and no origin that
		// distinguishes it, so its title is the honest answer.
		assert.equal(
			exampleIdentity({ title: "Plate generated for this catalogue" }),
			"Plate generated for this catalogue",
		);
	});

	test("an example with no name of its own gets none", () => {
		// `DESIGN.md` §1.5's honest zero, applied to a name. Returning the parent's
		// title here is what makes two blocks indistinguishable, so the rule returns
		// null and lets the caller say so in words.
		for (const empty of [
			{},
			{ title: null, origin: null, sourcePath: null },
			{ title: "   ", origin: null },
			{ title: "???", origin: null },
			{ title: "" },
		]) {
			assert.equal(
				exampleIdentity(empty),
				null,
				`${JSON.stringify(empty)} should have no identity of its own`,
			);
		}
	});

	test("a whitespace-only path falls through to the origin", () => {
		// A path of spaces is not a path. Treating it as one would print an empty
		// heading, which is worse than printing the origin.
		assert.equal(
			exampleIdentity({ title: "T", origin: "upstream", sourcePath: "   " }),
			originLabelFor("upstream"),
		);
	});
});

describe("the fixtures contain the state #69 is about", () => {
	test("a two-example selection exists", () => {
		// Every other use-page fixture has one example, so the state was unrenderable
		// — which is why the defect survived a full visual matrix.
		const two = usePageFixtureFor(TWO);
		assert.ok(two, `no fixture named ${TWO}`);
		assert.equal(
			two.examples.length,
			2,
			"the fixture must have two examples or the state is still not visible",
		);
	});

	test("its two examples resolve to different identities", () => {
		const two = usePageFixtureFor(TWO)!;
		const identities = two.examples.map((e) => exampleIdentity(e));
		assert.equal(
			new Set(identities).size,
			2,
			`the two examples resolve to ${JSON.stringify(identities)} — they must be tellable apart`,
		);
		for (const id of identities) {
			assert.ok(id, "an example resolved to no identity at all");
			assert.notEqual(id, two.possibility.title, "an example is named by its parent");
		}
	});
});

describe("the use page prints the identity, not the entry's title", () => {
	let server = false;
	before(async () => {
		try {
			const res = await fetch(`${baseUrl}/use/${TWO}`, { redirect: "manual" });
			server = res.status === 200;
		} catch {
			server = false;
		}
	});
	after(() => {
		server = false;
	});

	const text = (html: string) =>
		html
			.replace(/<script[\s\S]*?<\/script>/gi, "")
			.replace(/<style[\s\S]*?<\/style>/gi, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ");

	test("two example headings, and they are different", async (t) => {
		if (!server) {
			t.skip(`no server at ${baseUrl} — start it with \`npm run dev\``);
			return;
		}
		const html = await (await fetch(`${baseUrl}/use/${TWO}`)).text();
		const headings = [...html.matchAll(/<h3 class="pick__title"[^>]*>([\s\S]*?)<\/h3>/g)].map(
			(m) => text(m[1]).trim(),
		);
		assert.equal(headings.length, 2, `expected two example headings, got ${headings.length}`);
		assert.notEqual(
			headings[0],
			headings[1],
			`both examples are headed "${headings[0]}"`,
		);
		for (const heading of headings) {
			assert.ok(heading.length > 0, "an example heading is empty");
			assert.notEqual(
				heading,
				"Two readings of the same plate",
				"an example is headed with its parent's title",
			);
		}
	});

	test("the structural copies are the breadcrumb and the h1", async (t) => {
		if (!server) {
			t.skip(`no server at ${baseUrl} — start it with \`npm run dev\``);
			return;
		}
		/*
		 * Counted in the positions a title legitimately appears, not across the whole
		 * document.
		 *
		 * An earlier version counted every occurrence and expected two. It found eight,
		 * and all eight were correct: the `<title>`, the breadcrumb, the `h1`, two
		 * credit lines, the credits section heading, and a "Back to <possibility>" link.
		 * The assertion was wrong about what it measured, not the page about what it
		 * printed — a page that names its subject in its own `<title>` and lists credits
		 * is going to repeat that string.
		 *
		 * So the claim is about the two *structural* positions #69 names, and the
		 * per-example heading is asserted above, where the defect actually was.
		 */
		const html = await (await fetch(`${baseUrl}/use/${TWO}`)).text();
		const title = "Two readings of the same plate";

		const crumbs = html.match(/<nav class="crumbs"[\s\S]*?<\/nav>/)?.[0] ?? "";
		assert.ok(crumbs.includes(title), "the breadcrumb should name the entry");

		const h1 = text(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
		assert.ok(h1.includes(title), "the h1 should name the entry");

		for (const heading of [
			...html.matchAll(/<h3 class="pick__title"[^>]*>([\s\S]*?)<\/h3>/g),
		]) {
			assert.ok(
				!text(heading[1]).includes(title),
				`an example is headed with the entry's title: "${text(heading[1]).trim()}"`,
			);
		}
	});

	test("an unnamed example says so in words", () => {
		// The fallback's own sentence, asserted as content rather than as a string
		// constant: it is what a reader sees, so it is what has to be right.
		assert.match(UNNAMED_EXAMPLE, /no name/i);
		assert.doesNotMatch(UNNAMED_EXAMPLE, /undefined|null|NaN/);
		assert.ok(UNNAMED_EXAMPLE.length > 10, "the fallback is too terse to be a statement");
	});
});

describe("every use-page fixture still renders", () => {
	test("the fixture set is unchanged in shape", () => {
		// Adding a fixture must not have displaced one: each of the four use states
		// needs its own page, and the new one is a fifth.
		const slugs = USE_PAGE_FIXTURES.map((f) => f.slug);
		for (const state of ["reference", "review", "attribution", "reusable", "not-retained"]) {
			assert.ok(
				slugs.includes(`fixture-use-page-${state}`),
				`the ${state} use page fixture went missing`,
			);
		}
		assert.ok(slugs.includes(TWO));
		assert.equal(new Set(slugs).size, slugs.length, "two fixtures share a slug");
	});
});