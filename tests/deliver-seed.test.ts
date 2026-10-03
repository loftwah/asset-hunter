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
	DELIVERED,
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
		entries: new Set(["possibilities/p1"]),
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
		const firstContent = steps.findIndex((s) => s.kind === "content");
		const lastSchema = steps.map((s) => s.kind).lastIndexOf("schema");
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
		const content = steps.filter((s) => s.kind === "content");
		assert.deepEqual(
			content.map((s) => s.entry?.slug),
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
			entries: new Set(["possibilities/p1", "possibilities/p2", "possibilities/p3"]),
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
		assert.deepEqual([...DELIVERED], ["possibilities", "examples", "collections"]);
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
		// Content steps carry no CLI verb at all: a relation field cannot be written
		// through `emdash content create`, so they are API steps. So the enumeration is
		// over the schema steps, and "content steps use no CLI" is asserted separately
		// below rather than left implied.
		const steps = planDelivery(seed, empty);
		const schema = steps.filter((s) => s.kind === "schema");
		assert.deepEqual([...new Set(verbs(schema))].sort(), ["add-field", "create"]);
		assert.equal(hasUnsafeVerb(steps), false);
		assert.ok(
			steps.filter((s) => s.kind === "content").every((s) => s.args.length === 0),
			"no content step is expressed as a CLI command",
		);
	});

	test("rejects update, delete and publish if any ever appear", () => {
		const destructive = [
			{ what: "x", args: ["content", "update", "possibilities", "p1"] },
			{ what: "x", args: ["content", "delete", "possibilities", "p1"] },
			{ what: "x", args: ["schema", "delete", "disputes"] },
			{ what: "x", args: ["content", "publish", "possibilities", "p1"] },
		];
		for (const step of destructive) {
			assert.equal(
				hasUnsafeVerb([{ ...step, kind: "schema" }]),
				true,
				`${step.args[1]} must be refused`,
			);
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
				entries: new Set(["possibilities/p1", "possibilities/p2", "possibilities/p3"]),
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

describe("a relation field", () => {
	/*
	 * The last thing standing between a delivery and a correct catalogue.
	 *
	 * A seed row writes its parent as `possibility: "$ref:<slug>"`, which reads like
	 * data and is not: EmDash refuses a `data` payload that sets a field bound to a
	 * relation, and `emdash content create --file` cannot carry one either, because
	 * its file *is* the data bag — a `references` key there is rejected as an unknown
	 * field. So the split has to happen here, and `references` values are arrays.
	 *
	 * Getting it wrong is invisible rather than loud: the write succeeds with nothing
	 * linked, and the entry reaches the public catalogue as a possibility with no
	 * specimen. That is what the first delivery to production did.
	 */
	const withRelations = {
		collections: [],
		content: {
			possibilities: [{ id: "p1", slug: "p1", status: "published", data: { title: "One" } }],
			examples: [
				{
					id: "ex-p1",
					slug: "p1",
					status: "published",
					data: { title: "A specimen", possibility: "$ref:p1", origin: "generated" },
				},
			],
			collections: [],
		},
	};

	/** The `examples` step specifically: the possibility sorts first. */
	const exampleStep = () =>
		planDelivery(withRelations, { collections: new Set(), entries: new Set() })
			.find((s) => s.entry?.collection === "examples")!;

	test("is split out of `data` into `references`, as an array", () => {
		const step = exampleStep();
		assert.equal(step.entry?.data.possibility, undefined, "and it is gone from data");
		assert.deepEqual(step.entry?.references, { possibility: ["p1"] });
		assert.equal(step.entry?.data.title, "A specimen", "and the rest of data survives");
	});

	test("is delivered under the row's slug, not its id", () => {
		// Everything refers to an example by slug — including the route a reader lands
		// on and the `$ref:` above. Delivering `id` would create `ex-p1` as a slug,
		// which nothing points at.
		const step = exampleStep();
		assert.equal(step.entry?.slug, "p1");
		assert.equal(step.entry?.collection, "examples");
	});

	test("carries the seed's published state rather than defaulting to draft", () => {
		assert.equal(exampleStep().entry?.publish, true);

		const draft = planDelivery(
			{
				...withRelations,
				content: {
					possibilities: [],
					examples: [{ ...withRelations.content.examples[0], status: "draft" }],
					collections: [],
				},
			},
			{ collections: new Set(), entries: new Set() },
		).find((s) => s.entry?.collection === "examples")!;
		assert.equal(draft.entry?.publish, false, "a draft row stays a draft");
	});

	test("an example is planned once, and never as a possibility too", () => {
		const steps = planDelivery(withRelations, { collections: new Set(), entries: new Set() });
		const content = steps.filter((s) => s.kind === "content");
		assert.deepEqual(
			content.map((s) => `${s.entry?.collection}/${s.entry?.slug}`),
			["possibilities/p1", "examples/p1"],
			"same slug, different collections, both planned",
		);
	});
});
