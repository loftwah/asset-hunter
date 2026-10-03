/**
 * The agent contract, as a build failure rather than a promise (#82).
 *
 * `AGENTS.md` routes an arriving agent to the document that answers its
 * question. That routing is prose, and prose does not fail a build when it goes
 * stale — it fails quietly, at the moment an agent needs the answer most. Every
 * check here exists because the specific thing it catches has already happened in
 * this repository:
 *
 * - the root entry point grew a new section and stopped linking the autonomous
 *   policy, so a run could not find its own execution rules;
 * - a document was added and never routed, so it sat unread and authoritative;
 * - "MP is only a naming convention" was the kind of sentence that reads as
 *   harmless housekeeping and inverts the entire contract;
 * - the wall's tally asserted a literal `0`, so the first real licence read
 *   failed the build and taught the next person to pin the number back.
 *
 * The tests run the checks against this repository, so they are assertions about
 * the actual files rather than about a model of them. `npm run doctor` reports
 * the same checks for a person; this file is what makes them a gate.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkAgentContract, CANONICAL } from "../scripts/agent-contract.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const checks = checkAgentContract(root);
const failed = checks.filter((c) => !c.ok);
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");

/**
 * Prose with its line wrapping removed.
 *
 * Every assertion below matches English sentences in a Markdown file, and these
 * files are wrapped at 79 columns. Asserting on the wrapped text means a
 * re-wrap — a pure formatting change, and one an editor will do without thinking
 * — fails the build with "the root file does not say what it says". That is the
 * same mistake the wall's tally made, in the other direction: a test asserting
 * on a *literal* rather than on a *property*.
 */
const flat = (path: string) => read(path).replace(/\s+/g, " ");

describe("the agent contract holds", () => {
	for (const c of checks) {
		test(c.name, () => {
			assert.ok(
				c.ok,
				`${c.detail || "check failed"}${c.hint ? `\n  → ${c.hint}` : ""}`,
			);
		});
	}

	test("nothing failed", () => {
		assert.deepEqual(
			failed.map((c) => `${c.name}: ${c.detail}`),
			[],
			"the agent contract is broken; fix the documents rather than the check",
		);
	});
});

describe("the checks are wired into the one quality system", () => {
	test("npm run doctor reports them as their own group", () => {
		// Integration, not a second quality system. If `doctor.mjs` stopped calling
		// this module, the checks would keep passing here while disappearing from
		// the report a person actually runs — which is how a gate quietly stops
		// being one.
		//
		// `doctor`'s exit code is deliberately not asserted. It is non-zero on this
		// machine for reasons that have nothing to do with the agent contract — no
		// `GITHUB_TOKEN`, no D1 database id — and a test that required exit 0 would
		// be a test about the developer's shell. What is asserted is that the group
		// exists and is clean.
		const result = spawnSync(process.execPath, ["scripts/doctor.mjs", "--json"], {
			cwd: root,
			encoding: "utf8",
			timeout: 60_000,
		});
		assert.ok(result.stdout, `doctor produced no report: ${result.stderr}`);
		const report = JSON.parse(result.stdout);
		const group = report.checks.filter((c: { group: string }) => c.group === "Agent contract");
		assert.ok(
			group.length > 0,
			"doctor has no `Agent contract` section — the module is not called from anywhere",
		);
		const groupFailed = group.filter((c: { ok: boolean }) => !c.ok);
		assert.deepEqual(
			groupFailed.map((c: { name: string }) => c.name),
			[],
			"doctor reports agent-contract failures that this file does not",
		);
		// The same set, not a subset: a check living here but not in the report is
		// a check nobody sees.
		const here = checks.filter((c) => c.name.startsWith("canonical:")).map((c) => c.name);
		for (const name of here) {
			assert.ok(
				group.some((c: { name: string }) => c.name === name),
				`doctor is missing: ${name}`,
			);
		}
	});
});

describe("what an agent arriving from AGENTS.md can work out", () => {
	/*
	 * #82's first acceptance criterion is behavioural: an agent reading only the
	 * root file should be able to say who MP is, what MP is for, when MP is
	 * required, and what the agent owns. A routing table that resolves is
	 * necessary but not sufficient — the root file has to actually carry those
	 * four answers, because an agent that has to open a second document to learn
	 * who it is working for has already started the session wrong.
	 */
	test("the root entry point answers all four questions itself", () => {
		const agents = flat("AGENTS.md");

		// 1. Who MP is.
		assert.match(agents, /MP is the human principal/i);
		assert.match(agents, /final authority/i);

		// 2. What MP is for — a capability bridge, explicitly not a decision one.
		assert.match(agents, /capability proxy, not a decision proxy/i);
		for (const capability of [
			/physical action/i,
			/authentication/i,
			/credentials/i,
			/product direction/i,
		]) {
			assert.match(agents, capability, `the root file does not name ${capability}`);
		}

		// 3. When MP is genuinely required, which is the boundary that keeps the
		//    model honest in both directions.
		assert.match(
			agents,
			/production, credentials, external communication, legal and financial/i,
			"the root file does not say which things are never the agent's",
		);
		assert.match(
			agents,
			/safety, security and irreversible destruction/i,
			"the root file does not bound MP's authority",
		);

		// 4. What the agent owns.
		assert.match(
			agents,
			/Routine questions are answered by reasoning, not by asking/i,
			"the root file does not state that routine permission-seeking is a failure",
		);
		assert.match(
			agents,
			/A finding the agent can fix is a finding to fix/i,
			"the root file does not state that findings are fixed, not handed over",
		);
	});

	test("the contract distinguishes the three authority bands", () => {
		// The distinction #82 asks for explicitly, and the one that decides whether
		// the agent under-asks or over-assumes. Collapsing it back into one list is
		// the regression this guards.
		const contract = read("docs/AGENT_CONTRACT.md");
		assert.match(contract, /### 4a\. The agent decides, without asking/);
		assert.match(contract, /### 4b\. Already authorised by the active task/);
		assert.match(contract, /### 4c\. Genuinely MP's, or the outside world's/);
		// Each band has to carry something concrete, or it is a heading with a
		// promise under it. Four lines is the floor: prose is prose, and a band
		// shorter than that has stopped answering the question it exists for.
		for (const band of ["4a", "4b", "4c"]) {
			const section = contract.split(`### ${band}.`)[1]?.split(/\n#{2,3} /)[0] ?? "";
			const lines = section.split("\n").filter((l) => l.trim().length > 0);
			assert.ok(
				lines.length >= 4,
				`band ${band} has ${lines.length} line(s) under it; it is a heading, not a rule`,
			);
		}
		// The bands are not interchangeable, and each has to say which is which.
		assert.match(flat("docs/AGENT_CONTRACT.md"), /could a competent senior engineer/i);
		assert.match(flat("docs/AGENT_CONTRACT.md"), /under any reading of a task/i);
	});

	test("the repository's own gates survive the rewrite", () => {
		// #82's acceptance: the contract must not have been bought with a weakened
		// boundary. These are the load-bearing ones, asserted by name.
		const agents = flat("AGENTS.md");
		for (const boundary of [
			/Preserve immutable originals, hashes, provenance and exact licence evidence/i,
			/untrusted data/i,
			/Do not weaken tests or acceptance criteria/i,
			/Do not introduce paid GitHub Actions usage/i,
			/Preserve unrelated user work and secrets/i,
			/do not build a parallel CMS\/admin\/auth\/media stack/i,
			/DESIGN\.md/i,
		]) {
			assert.match(agents, boundary, `AGENTS.md lost the boundary: ${boundary}`);
		}
		// And the binding is explicit, not implied by ordering.
		assert.match(
			agents,
			/These hold in every authority band/i,
			"the boundaries do not say they outrank an instruction",
		);
	});

	test("an issue cannot be read as permission to break an invariant", () => {
		// The failure this prevents is subtle and has happened in both directions:
		// a ticket demanding something that trades a boundary, read as a licence.
		const index = flat("docs/AGENT_INDEX.md");
		assert.match(index, /An issue is not permission to break an invariant/i);
		assert.match(index, /A closed issue does not retire a rule/i);
	});

	test("the index routes every canonical document", () => {
		const index = read("docs/AGENT_INDEX.md");
		for (const doc of CANONICAL) {
			assert.ok(
				index.includes(doc.path),
				`docs/AGENT_INDEX.md does not route ${doc.path}, which owns ${doc.owns}`,
			);
		}
	});

	test("the index says which files carry no authority", () => {
		// An index that lists only canonical documents leaves an arriving agent
		// unable to tell a completed review from current instruction — which is how
		// `docs/SECURITY.md` and `docs/ROADMAP.md` would get read as live policy.
		const index = flat("docs/AGENT_INDEX.md");
		assert.match(index, /## Reference and history/);
		for (const path of ["docs/SECURITY.md", "docs/ROADMAP.md"]) {
			assert.ok(index.includes(path), `${path} is not marked with its status`);
		}
		assert.match(index, /no authority/i);
	});

	test("the autonomous kickoff still resolves to current guidance", () => {
		// The kickoff is an input to be sent, so it carries no content — which means
		// the only thing keeping it correct is that its pointer still works.
		const kickoff = read("docs/AUTONOMOUS_PROMPT.md");
		assert.match(kickoff, /AGENTS\.md/);
		assert.ok(
			kickoff.length < 400,
			"the kickoff has grown content; it is meant to be a pointer, not a prompt",
		);
		const policy = read("docs/AGENT_POLICY.md");
		assert.match(policy, /## 11\. Stop conditions/);
	});
});