#!/usr/bin/env node
/**
 * The catalogue client (#58).
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
		const query = rest.filter((a) => !a.startsWith("--"))[0] ?? fail("search needs a query");
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
		const id = rest.filter((a) => !a.startsWith("--"))[0] ?? fail("get needs an id");
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
};

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

  --url   http://localhost:4321      where to read from
  --file  path.json                   read a saved catalogue instead
  --fresh                            bypass the endpoint's short cache
`);
	process.exit(command ? 1 : 0);
}

await commands[command]();