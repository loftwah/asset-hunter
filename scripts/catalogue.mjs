#!/usr/bin/env node
/**
 * The catalogue client (#58) and the handoff client (#51).
 *
 * An agent should not have to scrape HTML to ask "what does this catalogue
 * know about seams, and what are the rights on it". This reads the documented
 * JSON contract and prints something a person or a model can read, with no
 * dependencies beyond Node.
 *
 * Every command works offline against a saved file, so a change can be reviewed
 * as a diff:
 *
 *   node scripts/catalogue.mjs fetch --out /tmp/catalogue.json
 *   node scripts/catalogue.mjs summary --file /tmp/catalogue.json
 *   node scripts/catalogue.mjs search "loop without a seam" --file /tmp/catalogue.json
 *
 * The `handoff` commands read `/api/handoff.json` — the same records, the same
 * loader, the same use-state decision — and produce the two things a person
 * actually wants from a shortlist: a Markdown file to keep in a repository, and a
 * printed rights summary to read before sending it anywhere.
 *
 * Usage: node scripts/catalogue.mjs <command> [options]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

function flag(name, fallback = undefined) {
	const i = rest.indexOf(`--${name}`);
	return i === -1 ? fallback : rest[i + 1];
}
const has = (name) => rest.includes(`--${name}`);

/**
 * Flags that take a value. Everything else is a boolean switch.
 *
 * Needed to tell an argument from a flag's value: `--url http://localhost:4321
 * get density-gradient` must read `density-gradient` as the id, not the URL. A
 * plain "not starting with `--`" filter cannot make that distinction, and it made
 * `handoff --url … ` build a document about a slug spelled `http://…`.
 */
const VALUE_FLAGS = new Set([
	// `board` has no command here, and is listed anyway: it is a value-taking
	// flag on the endpoint, so a caller who passes it must not have it mistaken
	// for the first positional argument.
	"url", "file", "out", "vertical", "rights", "status", "board",
	"slugs", "chose", "rejected", "goal", "surface", "platform", "constraints", "acceptance",
]);

/** Bare words after the command name, with each flag's value consumed with it. */
const positional = rest.filter((token, i) => {
	if (token.startsWith("--")) return false;
	const previous = rest[i - 1];
	return !(previous?.startsWith("--") && VALUE_FLAGS.has(previous.slice(2)));
});

const DEFAULT_URL = flag("url") ?? "http://localhost:4321";

/** Terms worth matching on. Short words match everything, so they are dropped. */
/**
 * Words that are part of asking rather than of searching.
 *
 * `"loop without a seam"` is a real way to describe a problem, and `without`
 * is not a word any entry uses — so it matched an unrelated palette entry and
 * pushed it up the list. These are the words that show up in the *question* and
 * tell you nothing about the answer.
 */
const STOP = new Set([
	"a", "an", "and", "the", "for", "with", "of", "in", "on", "to", "from", "by", "is", "are",
	"was", "were", "be", "been", "being", "has", "have", "had", "do", "does", "did",
	"show", "me", "find", "looking", "look", "for", "what", "how", "which", "when", "where",
	"want", "need", "like", "that", "this", "these", "those", "there", "their", "them", "then",
	"than", "some", "more", "most", "other", "others", "only", "also", "just", "very", "much",
	"can", "could", "would", "should", "without", "into", "over", "about", "any", "all",
	"way", "ways", "something", "anything", "instead", "rather", "again",
]);

function terms(query) {
	return query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 2 && !STOP.has(t));
}

/** Every field a reader would search, as one lower-case string. */
function haystack(p) {
	return [
		p.title,
		p.tagline,
		p.summary,
		p.technique,
		p.verticalLabel,
		p.media,
		...p.examples.flatMap((e) => [e.title, e.sourceRepo, e.licenceEvidence, e.licenceSpdx]),
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
}

async function load() {
	if (flag("file")) {
		const path = flag("file");
		if (!existsSync(path)) {
			fail(`no such file: ${path}`);
		}
		return JSON.parse(readFileSync(path, "utf8"));
	}
	const url = `${DEFAULT_URL}/api/catalogue.json${has("fresh") ? "?fresh=1" : ""}`;
	const res = await fetch(url);
	if (!res.ok) fail(`${url} → HTTP ${res.status}. Is the dev server running? (\`npm run dev\`)`);
	return res.json();
}

function fail(message) {
	console.error(`✖ ${message}`);
	process.exit(1);
}

/** A compact, scannable line per possibility. */
function line(p, note) {
	const stars =
		p.communityRating.count > 0
			? ` ${p.communityRating.average.toFixed(1)}★/${p.communityRating.count}`
			: " —";
	const sources = `${p.distinctSources} verified`;
	return [
		`${p.id}`,
		`  ${p.title}`,
		`  ${p.verticalLabel ?? "unclassified"} · ${p.media ?? "unknown media"} · ${p.rightsLabel ?? "unstated"}${stars} · ${p.examples.length} examples · ${sources}`,
		note ? `  ${note}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

const commands = {
	async fetch() {
		const catalogue = await load();
		const out = flag("out");
		if (out) {
			writeFileSync(out, `${JSON.stringify(catalogue, null, "\t")}\n`);
			console.log(`✔ wrote ${out} — ${catalogue.fingerprint}`);
			return;
		}
		console.log(JSON.stringify(catalogue, null, "\t"));
	},

	async summary() {
		const c = await load();
		console.log(`${c.schema} · ${c.generated} · fingerprint ${c.fingerprint}`);
		console.log(`site       ${c.site}`);
		console.log(
			`catalogue  ${c.counts.possibilities} possibilities · ${c.counts.examples} examples · ${c.counts.collections} collections · ${c.counts.verticals} verticals`,
		);
		console.log("rights");
		for (const [status, n] of Object.entries(c.counts.rights).sort((a, b) => b[1] - a[1])) {
			console.log(`  ${status.padEnd(12)}${n}`);
		}
		if (c.openReports) console.log(`open reports ${c.openReports}`);
		const measured = c.possibilities.filter(
			(p) => p.novelty !== null || p.coverage !== null,
		).length;
		console.log(`measured  ${measured}/${c.counts.possibilities} have machine observations`);
		const verified = c.possibilities.filter((p) => p.distinctSources > 0).length;
		console.log(`verified  ${verified}/${c.counts.possibilities} have a licence that was read`);
	},

	async list() {
		const c = await load();
		const vertical = flag("vertical");
		const rights = flag("rights");
		const list = c.possibilities
			.filter((p) => !vertical || p.vertical === vertical)
			.filter((p) => !rights || p.rightsStatus === rights);
		for (const p of list) console.log(`${p.id}\t${p.title}\t${p.rightsStatus ?? "unstated"}`);
		console.log(`\n${list.length} of ${c.possibilities.length}`, file ? `(from ${file})` : "");
	},

	async search() {
		const query = positional[0] ?? fail("search needs a query");
		const c = await load();
		const wanted = terms(query);
		if (!wanted.length) fail(`"${query}" has no searchable words`);
		const scored = c.possibilities
			.map((p) => {
				const text = haystack(p);
				const title = p.title.toLowerCase();
				let score = 0;
				for (const t of wanted) {
					if (title.includes(t)) score += 3;
					if ((p.tagline ?? "").toLowerCase().includes(t)) score += 2;
					if (text.includes(t)) score += 1;
				}
				return { p, score, hits: wanted.filter((t) => text.includes(t)) };
			})
			.filter((r) => r.score > 0)
			.sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id));

		if (!scored.length) {
			console.log(`no match for "${query}"`);
			console.log(
				`the catalogue covers ${c.counts.verticals} verticals and is deliberately partial; try browsing /verticals`,
			);
			return;
		}
		for (const { p, hits } of scored) {
			console.log(line(p, `matched: ${hits.join(", ")}`));
		}
		console.log(`\n${scored.length} match(es)`);
	},

	async get() {
		const id = positional[0] ?? fail("get needs an id");
		const c = await load();
		const p = c.possibilities.find((x) => x.id === id);
		if (!p) fail(`no possibility "${id}". Try \`list\`.`);
		console.log(JSON.stringify(p, null, "\t"));
	},

	async rights() {
		const c = await load();
		const status = flag("status");
		const list = c.possibilities.filter((p) => !status || p.rightsStatus === status);
		for (const p of list) {
			console.log(`${p.id}\t${p.rightsStatus ?? "unstated"}\t${p.examples.length} examples\t${p.distinctSources} verified`);
		}
		const reference = list.filter((p) => p.rightsStatus === "reference").length;
		console.log(
			`\n${reference} of ${list.length} are reference-only. A possibility is not permission; read the licence on the source.`,
		);
	},

	async verticals() {
		const c = await load();
		const counts = new Map();
		for (const p of c.possibilities) {
			counts.set(p.vertical ?? "unclassified", (counts.get(p.vertical ?? "unclassified") ?? 0) + 1);
		}
		for (const [slug, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
			const label = c.possibilities.find((p) => p.vertical === slug)?.verticalLabel ?? slug;
			console.log(`${String(n).padStart(3)}  ${slug.padEnd(24)} ${label}`);
		}
	},

	async schema() {
		const c = await load();
		console.log(`${c.schema}`);
		console.log(JSON.stringify(Object.keys(c), null, "\t"));
		if (c.possibilities[0]) {
			console.log("\npossibility fields:");
			for (const key of Object.keys(c.possibilities[0])) {
				console.log(`  ${key}: ${typeof c.possibilities[0][key]}`);
			}
		}
	},
	/* -------------------------------------------------------------------- */
	/* The handoff client (#51)                                             */
	/* -------------------------------------------------------------------- */

	/**
	 * The implementation handoff for a chosen set of possibilities (#51).
	 *
	 * Reads `/api/handoff.json` — the same records, the same loaders and the same
	 * use-state decision as `/use/<slug>` and `/api/payload/<example>` — so a
	 * rights statement printed here is the one the site would print.
	 *
	 * `--markdown` is the server's own rendering rather than a summary written
	 * here, which is why this command holds no copy of the document: a second
	 * renderer in the client is a second answer to "what may I do with this".
	 */
	async handoff() {
		if (flag("format")) fail("use `--markdown` rather than `--format`");
		// `--file` is the other client's offline mode and does not apply here: a
		// handoff is built from the catalogue at request time, so a saved copy is
		// evidence of what was true then rather than an answer. Silently ignoring
		// the flag would read as "here is your saved handoff".
		if (flag("file")) fail("a handoff is built from the live catalogue; `--file` has no handoff to read");
		const markdown = has("markdown") || has("md");
		// The report is printed from the JSON and the document is the rendered
		// Markdown. They are two outputs, not two views of one, and silently
		// dropping a flag the caller asked for is the thing this client keeps
		// refusing to do.
		if (markdown && has("check")) fail("`--markdown` writes the document; `--check` prints the report. Pick one.");
		const params = new URLSearchParams();
		// A flag, or the bare slugs after the command name. Both are how this is
		// actually typed, and neither is a second way of reading the catalogue.
		const slugs = flag("slugs") ?? positional[0];
		if (!slugs) fail("handoff needs --slugs <slug>[,<slug>] (or bare slugs after the command)");
		params.set("slugs", slugs);
		for (const key of ["chose", "rejected", "goal", "surface", "platform", "constraints", "acceptance"]) {
			// Only what was passed is sent. An unsupplied `--goal` is not sent as an
			// empty string, because the endpoint reads an absent field as "not
			// recorded" and there is no reason to make that indistinguishable from
			// "recorded as blank" in the address a decision is traced back through.
			const value = flag(key);
			if (value) params.set(key, value);
		}
		if (markdown) params.set("format", "md");
		if (has("fresh")) params.set("fresh", "1");

		const url = `${DEFAULT_URL}/api/handoff.json?${params.toString()}`;
		const res = await fetch(url);
		if (!res.ok) {
			// The endpoint's 400 explains how to ask, so it is passed through rather
			// than replaced with a one-line guess.
			const text = await res.text().catch(() => "");
			fail(`${url} → HTTP ${res.status}${text ? `\n\n${text.trim()}` : ""}`);
		}
		const text = await res.text();
		// The Markdown rendering is for a person to paste, so the report and the
		// counts below are read from the JSON. A Markdown handoff is never parsed
		// back into a claim about rights by this client.
		const document = markdown ? null : JSON.parse(text);

		/*
		 * Nothing resolved is a refusal, not a document. The endpoint answers 200
		 * because an empty answer is a legitimate answer to the catalogue contract —
		 * `board.unknown` names what was asked for — but handing a person a file
		 * containing no possibilities would read as "there is nothing here to build",
		 * which is a different and untrue claim.
		 */
		if (document) {
			if (document.possibilities.length === 0) {
				fail(
					`nothing in the catalogue matched ${slugs}. ` +
						"`list` and `search` show the slugs that do exist.",
				);
			}
			if (has("check")) {
				rightsReport(document);
				return;
			}
		}

		const out = flag("out");
		if (out) {
			writeFileSync(out, markdown && !text.endsWith("\n") ? `${text}\n` : text);
			console.log(`✔ wrote ${out} — ${res.headers.get("x-ah-handoff-schema")} · ${url}`);
			return;
		}
		process.stdout.write(markdown ? text : `${JSON.stringify(JSON.parse(text), null, "\t")}\n`);
	},
};

/**
 * The rights report a person reads before sending a handoff anywhere.
 *
 * Every example is listed with its own state and obligation. A report that prints
 * a count and hides the entries is a report that lets a reader believe
 * reference-only material was cleared, which is the one failure this whole flow
 * exists to prevent — so the count is a summary of the lines, never a substitute
 * for them.
 */
function rightsReport(handoff) {
	console.log(`${handoff.schema} · ${handoff.contract.json} · fingerprint ${handoff.fingerprint}`);
	console.log(
		`${handoff.rights.examples} example${handoff.rights.examples === 1 ? "" : "s"} · ${handoff.rights.summary}`,
	);
	console.log(`${handoff.rights.payloads} retained original${handoff.rights.payloads === 1 ? "" : "s"} to download.`);
	console.log("");
	for (const p of handoff.possibilities) {
		const mark = p.decision === "chosen" ? "+" : p.decision === "rejected" ? "x" : "-";
		console.log(`${mark} ${p.id}  ${p.title}`);
		console.log(`    entry ${p.rightsLabel ?? "unstated"} · weakest example ${p.examplesUseState}`);
		for (const e of p.examples) {
			const blocked = e.blockedBy ? ` (blocked by ${e.blockedBy})` : "";
			console.log(`    ${e.id}  ${e.useStateLabel}${blocked}`);
			const where = [e.provenance.sourceRepo, e.provenance.sourceRef, e.provenance.sourcePath]
				.filter(Boolean)
				.join(" · ");
			if (where) console.log(`      from ${where}`);
			if (e.licence.spdx) console.log(`      ${e.licence.spdx}`);
			if (e.obligation) console.log(`      ${e.obligation}`);
			console.log(`      ${e.record}`);
		}
	}
	if (handoff.board.unknown.length > 0) {
		console.log(`\nunknown slugs, not in the catalogue: ${handoff.board.unknown.join(", ")}`);
	}
	if (handoff.board.overflow.length > 0) {
		console.log(`cut by the board limit: ${handoff.board.overflow.join(", ")}`);
	}
	if (!handoff.decision.recorded) {
		console.log("\nno option was marked chosen. Add --chose <slug> before this goes to an agent.");
	}
	if (handoff.objective.unrecorded.length > 0) {
		console.log(`not recorded, and therefore not invented: ${handoff.objective.unrecorded.join(", ")}`);
	}
}

const file = flag("file");

if (!command || !commands[command]) {
	console.log(`Asset Hunter catalogue client

  fetch [--out FILE]                 write the whole catalogue as JSON
  summary                             counts, rights mix, what is unmeasured
  list [--vertical S] [--rights S]    one tab-separated line per possibility
  search <query>                      ranked matches, with what matched
  get <id>                            one possibility as JSON
  rights [--status S]                 rights status per possibility
  verticals                           coverage by vertical
  schema                              the contract and its field types

  handoff <slug>[,<slug>]            an implementation handoff for a chosen set
    --markdown                       the Markdown rendering, as the server writes it
    --check                          the rights report in words, one line per example
    --out FILE                       write it to a file instead of stdout
    --chose S[,S] / --rejected S[,S] the decision, recorded so it can be traced
    --goal T --surface T --platform T --constraints T --acceptance T
                                      what the reader recorded; whatever is left
                                      blank is named as unrecorded, never invented

  --url   http://localhost:4321      where to read from
  --file  path.json                   read a saved catalogue instead
  --fresh                            bypass the endpoint's short cache
`);
	process.exit(command ? 1 : 0);
}

await commands[command]();