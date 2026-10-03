#!/usr/bin/env node
/**
 * The agent contract, checked rather than asserted.
 *
 * `AGENTS.md` routes an arriving agent to the document that answers its
 * question. That routing is prose, and prose does not fail a build when it goes
 * stale — it fails quietly, and the agent that needs the answer most is the one
 * that cannot find it. So the load-bearing parts are checked here and called
 * from `scripts/doctor.mjs`, which means `npm run doctor` reports them and
 * `tests/agent-contract.test.ts` fails on them.
 *
 * What is checked, and why each one earns its place:
 *
 * 1. Every canonical document exists. A missing file is a broken link target.
 * 2. Every relative link in the entry point and the index resolves. A dead
 *    `docs/…` link is the specific failure #82 describes: policy that has to be
 *    found by accident.
 * 3. The MP model is reachable from the root entry point. If `AGENTS.md` stops
 *    naming MP, the whole contract becomes undiscoverable while still reading
 *    perfectly well.
 * 4. The autonomous pointers still resolve to current guidance.
 * 5. No unrouted canonical document: a new `docs/*.md` that the index does not
 *    mention is a document nobody will know to load.
 * 6. No stray agent-instruction file, and no wording that contradicts the MP
 *    model. #82 calls for stale duplicates to be removed or explicitly
 *    de-authorised, and the cheapest way to keep them removed is to fail when
 *    one comes back.
 *
 * Usage: `node scripts/agent-contract.mjs [--json]`
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";

/**
 * The canonical set, and what each one owns.
 *
 * Ownership is recorded here rather than only in `docs/AGENT_INDEX.md` so that a
 * document can be *checked* against the index instead of trusted to it: the
 * index has to keep naming every one of these, and this list is the thing it is
 * checked against. Two lists would drift, so there is one.
 */
export const CANONICAL = [
	{
		path: "AGENTS.md",
		owns: "repository invariants, and the entry point into everything else",
	},
	{ path: "docs/AGENT_INDEX.md", owns: "canonical routing and precedence" },
	{ path: "docs/AGENT_CONTRACT.md", owns: "MP, authority, initiative, stop conditions" },
	{ path: "docs/AGENT_POLICY.md", owns: "how an autonomous run executes" },
	{ path: "docs/AUTONOMOUS_PROMPT.md", owns: "the exact kickoff that activates a run" },
	{ path: "docs/AGENT_API.md", owns: "the JSON contracts and CLI an agent reads" },
	{ path: "DESIGN.md", owns: "visual and interaction authority" },
	{ path: "docs/UNSLOP.md", owns: "what the product must not look like" },
	{ path: "docs/ARCHITECTURE.md", owns: "system boundaries and the content model" },
	{ path: "docs/VOCABULARY.md", owns: "product terminology" },
	{ path: "docs/EFFECT_STYLE.md", owns: "the Effect house style" },
	{ path: "docs/TESTING.md", owns: "how tests run here" },
	{ path: "docs/PERFORMANCE.md", owns: "measured budgets and the gate" },
	{ path: "docs/DEPLOY.md", owns: "deployment and production configuration" },
	{ path: "docs/BRAND.md", owns: "the identity and how it is produced" },
	{
		path: "docs/BRAND-DIRECTIONS.md",
		owns: "the protocol for running an identity comparison",
	},
	{ path: "docs/VISUAL_QA.md", owns: "the visual harness and its gates" },
];

/** Files the index is allowed to leave unrouted because they carry no authority. */
const REFERENCE_ONLY = new Set([
	"docs/ROADMAP.md",
	"docs/SECURITY.md",
	"README.md",
	"engine/README.md",
]);

/**
 * Wording that would contradict the MP model if it were reintroduced.
 *
 * #82 is explicit that "MP is only a naming convention" must not survive,
 * because a sentence like that reads as harmless housekeeping to whoever pastes
 * it back and silently inverts the contract. It is checked as a phrase rather
 * than as a paragraph because the paragraph form is unwriteable.
 */
const CONTRADICTIONS = [
	{ pattern: /MP is (only |merely )?a naming convention/i, why: "it denies MP's authority" },
	{ pattern: /MP is (only |merely )?a (label|nickname|title)\b/i, why: "it reduces MP to a label" },
	{
		pattern: /naming convention (for )?(the )?(human|owner|principal)(?!.*capability)/i,
		why: "it re-authorises the wording #82 retired",
	},
];

/** Where a stray second instruction surface would show up if one appeared. */
const STRAY_PATTERNS = [
	{ re: /^AGENTS(?!\.md$)/, label: "an AGENTS variant" },
	{ re: /^CLAUDE\.md$/i, label: "a CLAUDE.md" },
	{ re: /^AGENT[A-Z-]/, label: "another AGENT*.md" },
	{ re: /\.PROMPT\.md$/i, label: "a *PROMPT.md" },
	{ re: /PROMPT[S]?\.md$/i, label: "a prompt file" },
	{ re: /copilot-instructions\.md$/i, label: "a Copilot instruction file" },
	{ re: /^\.cursorrules$/i, label: "a .cursorrules file" },
];

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	".astro",
	"output",
	".wrangler",
	"screenshots",
	"reference",
	"engine/state",
	".playwright-mcp",
]);

function walk(dir, root, out = []) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) walk(full, root, out);
		else out.push(relative(root, full).split("\\").join("/"));
	}
	return out;
}

/**
 * Directories whose markdown is not this repository's to route.
 *
 * `.agents/skills/` is vendored from `emdash-cms/emdash` and pinned by revision,
 * so its twenty-odd reference files are upstream material — they are routed by
 * directory in the index's skills table, and listing each one would be both noise
 * and a lie, because the next `npm run skills:sync` could add or remove them
 * without anyone making a decision about routing.
 */
const UNROUTED_PREFIXES = [".agents/"];

/** Every markdown link in a document, with the text it was written as. */
function links(markdown) {
	const out = [];
	const re = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
	let m;
	while ((m = re.exec(markdown))) {
		out.push({ text: m[1], target: m[2] });
	}
	return out;
}

/** The files `AGENTS.md` and the index promise exist. */
function markdownFiles(root) {
	return walk(root, root).filter(
		(f) => f.endsWith(".md") && !UNROUTED_PREFIXES.some((p) => f.startsWith(p)),
	);
}

/**
 * Run every agent-contract check.
 *
 * Returns the same `{ name, ok, detail, hint }` shape `doctor.mjs` prints, so
 * this is one report rather than two.
 */
export function checkAgentContract(root) {
	const checks = [];
	const check = (name, ok, detail = "", hint = "") => checks.push({ name, ok, detail, hint });
	const read = (p) => {
		const full = join(root, p);
		return existsSync(full) ? readFileSync(full, "utf8") : null;
	};

	// 1 — canonical files exist.

	for (const doc of CANONICAL) {
		const present = existsSync(join(root, doc.path));
		check(
			`canonical: ${doc.path}`,
			present,
			present ? doc.owns : "missing",
			present ? "" : `${doc.path} owns ${doc.owns}, and every link to it is now dead`,
		);
	}

	const agents = read("AGENTS.md") ?? "";
	const index = read("docs/AGENT_INDEX.md") ?? "";
	const contract = read("docs/AGENT_CONTRACT.md") ?? "";

	// 2 — routing links resolve.

	for (const [from, markdown] of [
		["AGENTS.md", agents],
		["docs/AGENT_INDEX.md", index],
	]) {
		if (!markdown) continue;
		const dead = [];
		for (const link of links(markdown)) {
			const target = link.target;
			if (/^(https?:|mailto:|tel:)/i.test(target)) continue;
			if (target.startsWith("#")) continue;
			const path = target.split("#")[0];
			if (!path) continue;
			const full = resolve(dirname(join(root, from)), path);
			if (!existsSync(full)) dead.push(`${link.text || "?"} → ${target}`);
		}
		check(
			`links resolve: ${from}`,
			dead.length === 0,
			dead.length ? `${dead.length} dead: ${dead.join(", ")}` : "every relative link resolves",
			dead.length ? "A dead link here is policy an arriving agent cannot find" : "",
		);
	}

	// 3 — the MP model is reachable from the root entry point.

	const mpInRoot = /\bMP\b/.test(agents) && /AGENT_CONTRACT\.md/.test(agents);
	check(
		"MP model reachable from AGENTS.md",
		mpInRoot,
		mpInRoot ? "AGENTS.md defines MP and links the contract" : "AGENTS.md does not route to the MP model",
		mpInRoot ? "" : "AGENTS.md is the entry point; an MP model nobody lands on does not exist",
	);

	const mpPrincipal = /human principal/i.test(agents) && /final authority/i.test(agents);
	check(
		"MP is named as principal and final authority",
		mpPrincipal,
		mpPrincipal ? "stated in AGENTS.md" : "the principal/authority sentence is missing",
		mpPrincipal ? "" : "See docs/AGENT_CONTRACT.md §1",
	);

	const capabilityProxy =
		/capability proxy/i.test(contract) && /not a decision proxy/i.test(contract);
	check(
		"MP is a capability proxy, not a decision proxy",
		capabilityProxy,
		capabilityProxy ? "stated in docs/AGENT_CONTRACT.md" : "the distinction is missing",
		capabilityProxy ? "" : "This is the distinction that keeps MP out of the planning loop",
	);

	const authorityBands =
		/decides, without asking/i.test(contract) &&
		/already authorised by the active task/i.test(contract) &&
		/genuinely MP's, or the outside world's/i.test(contract);
	check(
		"three authority bands are stated",
		authorityBands,
		authorityBands ? "decide alone / already authorised / requires MP" : "a band is missing",
		authorityBands ? "" : "See docs/AGENT_CONTRACT.md §4",
	);

	// 4 — autonomous-run pointers resolve to current guidance.

	const kickoff = read("docs/AUTONOMOUS_PROMPT.md") ?? "";
	const kickoffPointsAtPolicy = /AGENTS\.md/.test(kickoff);
	check(
		"autonomous kickoff points at AGENTS.md",
		kickoffPointsAtPolicy,
		kickoffPointsAtPolicy ? "docs/AUTONOMOUS_PROMPT.md" : "it does not route anywhere",
		kickoffPointsAtPolicy ? "" : "The kickoff is an input to be sent; it has no content of its own",
	);

	const policy = read("docs/AGENT_POLICY.md") ?? "";
	const stopConditions = /## 11\. Stop conditions/i.test(policy);
	check(
		"autonomous policy owns stop conditions",
		stopConditions,
		stopConditions ? "docs/AGENT_POLICY.md §11" : "no stop conditions section",
		stopConditions ? "" : "A run that cannot tell when to stop is a run that asks MP instead",
	);

	// 5 — no unrouted canonical document.

	const allMarkdown = markdownFiles(root);
	const unrouted = allMarkdown.filter(
		(f) =>
			!CANONICAL.some((c) => c.path === f) &&
			!REFERENCE_ONLY.has(f) &&
			!/^(docs\/)?(AGENT|AGENTS)/.test(f) &&
			!index.includes(f) &&
			!agents.includes(f),
	);
	check(
		"every markdown document is routed",
		unrouted.length === 0,
		unrouted.length ? `not in docs/AGENT_INDEX.md: ${unrouted.join(", ")}` : `${allMarkdown.length} documents routed`,
		unrouted.length
			? "Add it to docs/AGENT_INDEX.md, or mark it reference-only — an unrouted document is one nobody knows to load"
			: "",
	);

	for (const doc of CANONICAL) {
		if (doc.path === "AGENTS.md") continue;
		const routed = index.includes(doc.path) || agents.includes(doc.path);
		check(
			`routed: ${doc.path}`,
			routed,
			routed ? "" : "not named by docs/AGENT_INDEX.md",
			routed ? "" : `${doc.path} exists but nothing tells an agent to read it`,
		);
	}

	// 6 — no stray instruction surface, and nothing that contradicts the model.

	const known = new Set(CANONICAL.map((c) => c.path));
	const strays = allMarkdown.filter(
		(f) => !known.has(f) && STRAY_PATTERNS.some((p) => p.re.test(f)),
	);
	check(
		"no stray agent-instruction file",
		strays.length === 0,
		strays.length ? strays.join(", ") : "one canonical surface",
		strays.length
			? "A second instruction surface is how #82's de-authorised prompt variants came back"
			: "",
	);

	const contradictions = [];
	for (const file of allMarkdown) {
		const text = read(file) ?? "";
		for (const rule of CONTRADICTIONS) {
			const m = text.match(rule.pattern);
			if (m) contradictions.push(`${file}: "${m[0]}" (${rule.why})`);
		}
	}
	check(
		"no wording that contradicts the MP model",
		contradictions.length === 0,
		contradictions.length ? contradictions.join("; ") : "none found",
		contradictions.length
			? "docs/AGENT_CONTRACT.md §1 is canonical — rewrite the sentence rather than deleting the file"
			: "",
	);

	return checks;
}

// --- CLI --------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
	const root = new URL("../", import.meta.url).pathname;
	const checks = checkAgentContract(root);
	const failed = checks.filter((c) => !c.ok);
	if (process.argv.includes("--json")) {
		console.log(JSON.stringify({ checks, failed: failed.length }, null, "\t"));
	} else {
		console.log("Agent contract\n");
		for (const c of checks) {
			console.log(`  ${c.ok ? "✔" : "✖"} ${c.name}${c.detail ? `  ${c.detail}` : ""}`);
			if (!c.ok && c.hint) console.log(`      → ${c.hint}`);
		}
		console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
	}
	process.exit(failed.length ? 1 : 0);
}