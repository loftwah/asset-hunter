/**
 * The delivery plan may only ever create.
 *
 * Ten entries and three collections were merged, gated, deployed and green in
 * production, and the only way anyone found out was to read the live database
 * against the seed by hand. `deliver-seed` exists so that comparison is code
 * rather than a person at a terminal with production in front of them.
 *
 * Which makes the interesting property of the plan a safety property rather than a
 * correctness one. The claim worth testing is not "these commands would produce
 * the right schema" — that is EmDash's job — it is **"this cannot destroy
 * anything"**. A seed reproduces content nobody has touched and does not
 * reproduce content a curator has edited, so any verb that overwrites is wrong
 * here however it is spelled. `hasUnsafeVerb` therefore enumerates the allowed
 * verbs rather than spot-checking for a few forbidden ones.
 *
 * Two bugs from writing the script are asserted here as well, because both were
 * invisible in a dry run and would have been confusing failures against
 * production:
 *
 * - the verb check originally compared `args[0]`, which is the command *group*
 *   (`schema`, `content`), so it rejected every step at once — a check that fails
 *   everything is not a check;
 * - the `--file` placeholder was read by slicing a prefix, leaving the closing `>`
 *   in ten filenames.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	planDelivery,
	hasUnsafeVerb,
	stepVerb,
	placeholderFor,
	placeholderId,
	PUBLISHED,
} from "../src/lib/deliver-seed.ts";

const seed = {
	collections: [
		{ slug: "possibilities", label: "Possibilities", fields: [{ slug: "title", type: "string" }] },
		{
			slug: "disputes",
			label: "Rights disputes",
			labelSingular: "Rights dispute",
			fields: [
				{ slug: "title", label: "Title", type: "string", required: true },
				{ slug: "reason", label: "Reason", type: "select" },
			],
		},
	],
	content: {
		possibilities: [
			{ id: "p1", data: { title: "One" } },
			{ id: "p2", data: { title: "Two" } },
			{ id: "p3", data: { title: "Three" } },
		],
		collections: [],
		pages: [{ id: "page-1", data: { title: "Unpublished page" } }],
	},
};

const empty = { collections: new Set<string>(), entries: new Set<string>() };
const verbs = (steps: { args: readonly string[] }[]) => steps.map((s) => stepVerb(s.args));

describe("a plan for a database that is missing things", () => {
	const steps = planDelivery(seed, {
		collections: new Set(["possibilities"]),
		entries: new Set(["p1"]),
	});

	test("creates the collections the database lacks, and only those", () => {
		const creates = steps.filter((s) => stepVerb(s.args) === "create" && s.args[0] === "schema");
		assert.deepEqual(
			creates.map((s) => s.args[2]),
			["disputes"],
		);
	});

	test("puts schema before content, because a row needs its collection to exist", () => {
		// Order is the whole reason this is a plan and not a set. Content created
		// first would reference a collection that does not exist yet.
		const firstContent = steps.findIndex((s) => s.args[0] === "content");
		const lastSchema = steps.map((s) => s.args[0]).lastIndexOf("schema");
		assert.ok(lastSchema < firstContent, "every schema step must precede every content step");
	});

	test("passes a field's type and requiredness, because both change the schema", () => {
		const title = steps.find((s) => s.what === "field disputes.title");
		const reason = steps.find((s) => s.what === "field disputes.reason");
		assert.ok(title?.args.includes("--type"));
		assert.equal(title?.args[title.args.indexOf("--type") + 1], "string");
		assert.ok(title?.args.includes("--required"), "a required field must be marked required");
		assert.equal(reason?.args[reason.args.indexOf("--type") + 1], "select");
		assert.ok(!reason?.args.includes("--required"));
	});

	test("creates only the entries the catalogue does not already serve", () => {
		const content = steps.filter((s) => s.args[0] === "content");
		assert.deepEqual(
			content.map((s) => s.args[4]),
			["p2", "p3"],
		);
	});

	test("never plans the creation of a collection that already exists", () => {
		// Recreating `possibilities` would arrive as `["drafts","revisions"]` instead
		// of the declared `["drafts","revisions","search","seo"]` — losing the SEO
		// support the public pages depend on. The only collections this may ever
		// *create* are ones the repository has just introduced.
		//
		// Scoped to `schema create` rather than to every schema step, because a field
		// missing from an existing collection is a real and separate case — see "a
		// collection that was created but not finished".
		const steps = planDelivery(seed, {
			collections: new Set(["possibilities", "disputes"]),
			entries: new Set(["p1", "p2", "p3"]),
			fields: new Set(["possibilities/title", "disputes/title", "disputes/reason"]),
		});
		assert.deepEqual(
			steps.filter((s) => s.args[0] === "schema" && s.args[1] === "create"),
			[],
		);
	});

	test("ignores collections the catalogue endpoint never publishes", () => {
		// `pages` is in the seed and absent from the plan, because
		// `/api/catalogue.json` does not publish it and the parity gate does not
		// compare it. Planning it would mean creating rows the gate cannot then
		// confirm — the plan and the gate would disagree about what is missing.
		assert.ok(!steps.some((s) => s.what.includes("page-1")));
		assert.deepEqual([...PUBLISHED], ["possibilities", "collections"]);
	});
});

describe("a plan that cannot destroy anything", () => {
	test("uses only create and add-field, enumerated rather than spot-checked", () => {
		/*
		 * The load-bearing assertion in this file.
		 *
		 * Enumerating the *allowed* verbs rather than searching for forbidden ones
		 * means a new destructive verb added to the CLI tomorrow fails here, instead
		 * of being quietly accepted because nobody thought to blacklist it.
		 */
		const steps = planDelivery(seed, empty);
		assert.deepEqual([...new Set(verbs(steps))].sort(), ["add-field", "create"]);
		assert.equal(hasUnsafeVerb(steps), false);
	});

	test("rejects update, delete and publish if any ever appear", () => {
		const destructive = [
			{ what: "x", args: ["content", "update", "possibilities", "p1"] },
			{ what: "x", args: ["content", "delete", "possibilities", "p1"] },
			{ what: "x", args: ["schema", "delete", "disputes"] },
			{ what: "x", args: ["content", "publish", "possibilities", "p1"] },
		];
		for (const step of destructive) {
			assert.equal(hasUnsafeVerb([step]), true, `${step.args[1]} must be refused`);
		}
	});

	test("reads the verb after the command group, not before it", () => {
		// `args[0]` is `schema`/`content`. A check comparing it against a verb list
		// rejects every real step — which is how the first version of this script
		// refused its own correct plan.
		assert.equal(stepVerb(["schema", "create", "disputes"]), "create");
		assert.equal(stepVerb(["content", "create", "possibilities"]), "create");
		assert.equal(stepVerb(["schema"]), null, "a group with no verb is not a command");
		assert.equal(stepVerb(["schema", "--json"]), null, "a swallowed flag is not a verb");
		assert.equal(stepVerb(["rm", "-rf", "/"]), null, "an unknown group is not ours to judge");
		assert.equal(stepVerb([]), null);
	});

	test("says nothing is unsafe when the plan is empty", () => {
		assert.equal(hasUnsafeVerb([]), false);
		assert.equal(
			planDelivery(seed, {
				collections: new Set(["possibilities", "disputes"]),
				entries: new Set(["p1", "p2", "p3"]),
				fields: new Set(["possibilities/title", "disputes/title", "disputes/reason"]),
			}).length,
			0,
			"a complete database plans nothing",
		);
	});
});

describe("a field the plan cannot express", () => {
	test("is reported, not skipped silently", () => {
		// A field with no slug or type would fail at apply time against production,
		// which is the one moment a malformed command is most expensive to discover.
		const steps = planDelivery(
			{ collections: [{ slug: "disputes", fields: [{ type: "string" }, { slug: "x" }] }] },
			empty,
		);
		const warning = steps.find((s) => s.warning);
		assert.match(warning?.warning ?? "", /2 field\(s\).*no slug or type/);
		assert.deepEqual(
			steps.filter((s) => s.args.length > 0).map((s) => s.what),
			["collection disputes"],
		);
	});
});

describe("the --file placeholder", () => {
	test("round-trips an id through both halves", () => {
		// They disagreed once: the reader sliced the prefix and kept the closing `>`,
		// naming ten files `monoline-constant-weight>.json`. Harmless in a dry run,
		// confusing against production.
		const id = "monoline-constant-weight";
		const args = ["content", "create", "possibilities", "--slug", id, "--file", placeholderFor(id)];
		assert.equal(placeholderId(args), id);
		assert.ok(!placeholderFor(id).slice(0, -1).includes(">"));
	});

	test("is null for anything that is not a placeholder", () => {
		assert.equal(placeholderId(["content", "create"]), null);
		assert.equal(placeholderId(["content", "create", "--file", "/tmp/real.json"]), null);
		assert.equal(placeholderId(["content", "create", "--file", "<data for x"]), null, "unclosed");
		assert.equal(placeholderId([]), null);
	});

	test("names every content row exactly once", () => {
		const steps = planDelivery(seed, empty);
		const ids = steps
			.filter((s) => s.args[0] === "content")
			.map((s) => placeholderId(s.args));
		assert.deepEqual(ids.sort(), ["p1", "p2", "p3"]);
		assert.equal(new Set(ids).size, ids.length, "no row may be planned twice");
	});
});

describe("a collection that was created but not finished", () => {
	/*
	 * The failure this closes.
	 *
	 * A run against production creates `disputes` and then fails on its ninth field —
	 * a token expires, a rate limit, a typo in a label. The collection now exists and
	 * is wrong. A plan keyed only on "does this collection exist?" would skip it from
	 * then on, so one transient failure became a permanently half-built collection
	 * with no way to complete it through this script — and the parity gate would
	 * report it as present, because the collection *is* present.
	 *
	 * So fields are planned independently of their collection. Keying on fields makes
	 * the plan resumable, which is the only useful property for a step that talks to
	 * production.
	 */
	const disputes = {
		slug: "disputes",
		label: "Rights disputes",
		fields: [
			{ slug: "title", type: "string" },
			{ slug: "state", type: "string" },
			{ slug: "reason", type: "select" },
		],
	};
	const only = {
		collections: [disputes],
		content: { possibilities: [], collections: [] },
	};

	test("plans the fields it is missing, and not the collection again", () => {
		const steps = planDelivery(only, {
			collections: new Set(["disputes"]),
			entries: new Set(),
			fields: new Set(["disputes/title", "disputes/state"]),
		});
		assert.deepEqual(
			steps.map((s) => s.what),
			["field disputes.reason"],
			"only the absent field is planned, and the collection is not recreated",
		);
	});

	test("plans nothing at all when the collection is complete", () => {
		const steps = planDelivery(only, {
			collections: new Set(["disputes"]),
			entries: new Set(),
			fields: new Set(["disputes/title", "disputes/state", "disputes/reason"]),
		});
		assert.deepEqual(steps, []);
	});

	test("adds a field missing from a collection that already has most of them", () => {
		// The production case: `examples` is fully built except for the five
		// `dispute_*` fields, so the read path degrades to "no dispute recorded"
		// rather than failing — and nothing says the feature is inert.
		const steps = planDelivery(
			{
				collections: [
					{ slug: "examples", fields: [{ slug: "title", type: "string" }, { slug: "dispute_state", type: "string" }] },
				],
				content: { possibilities: [], collections: [] },
			},
			{
				collections: new Set(["examples"]),
				entries: new Set(),
				fields: new Set(["examples/title"]),
			},
		);
		assert.deepEqual(steps.map((s) => s.what), ["field examples.dispute_state"]);
		assert.equal(hasUnsafeVerb(steps), false);
	});

	test("plans every field when nothing is known about the collection", () => {
		// `fields` is optional, so an older caller still gets the complete plan rather
		// than silently nothing.
		const steps = planDelivery(only, { collections: new Set(), entries: new Set() });
		assert.equal(steps.length, 4, "one create and three fields");
	});
});
