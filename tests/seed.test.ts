/**
 * Contract tests for the seed and the catalogue atlas.
 *
 * The seed is applied once per database and never re-applied, and an invalid
 * seed is skipped silently on first request. That makes seed validity a
 * correctness property worth asserting rather than something to eyeball.
 *
 * These also encode the honesty rules the product depends on: a generated plate
 * is never labelled upstream, an unverified count is never invented, and
 * reference-only material is never described as cleared.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { allFixtures } from "../src/lib/fixtures.ts";
import { MEDIA_LABEL } from "../src/lib/vocabulary.ts";

const root = new URL("../", import.meta.url).pathname;

const atlas = JSON.parse(readFileSync(`${root}seed/atlas.json`, "utf8"));
const seed = JSON.parse(readFileSync(`${root}seed/seed.json`, "utf8"));

const SLUG_RE = /^[a-z][a-z0-9_]*$/;

describe("atlas integrity", () => {
	test("every possibility has an id matching its specimen filename", () => {
		for (const p of atlas.possibilities) {
			assert.ok(existsSync(`${root}public/specimens/${p.id}.svg`), `missing plate for ${p.id}`);
		}
	});

	test("ids are unique", () => {
		const ids = atlas.possibilities.map((p: { id: string }) => p.id);
		assert.equal(new Set(ids).size, ids.length);
	});

	test("every vertical used is declared", () => {
		const declared = new Set(atlas.verticals.map((v: { slug: string }) => v.slug));
		for (const p of atlas.possibilities) {
			assert.ok(declared.has(p.vertical), `${p.id} uses undeclared vertical ${p.vertical}`);
		}
	});

	test("every media kind used is declared", () => {
		for (const p of atlas.possibilities) {
			assert.ok(atlas.media.includes(p.media), `${p.id} uses undeclared media ${p.media}`);
		}
	});

	test("every rights value used is declared", () => {
		for (const p of atlas.possibilities) {
			assert.ok(atlas.rights.includes(p.rights), `${p.id} uses undeclared rights ${p.rights}`);
		}
	});

	test("editorial rank is a fraction, not a percentage", () => {
		for (const p of atlas.possibilities) {
			assert.ok(
				p.editorialRank > 0 && p.editorialRank <= 1,
				`${p.id} editorialRank ${p.editorialRank} outside 0..1`,
			);
		}
	});

	test("every collection member exists and no collection is empty", () => {
		const ids = new Set(atlas.possibilities.map((p: { id: string }) => p.id));
		for (const c of atlas.collections) {
			assert.ok(c.members.length > 0, `${c.id} is empty`);
			for (const m of c.members) {
				assert.ok(ids.has(m), `${c.id} references unknown ${m}`);
			}
			assert.equal(new Set(c.members).size, c.members.length, `${c.id} has duplicate members`);
		}
	});

	test("collections overlap rather than partitioning the catalogue", () => {
		// The product model explicitly allows overlap; a partition would mean
		// the second axis had collapsed into the vertical taxonomy.
		const counts = new Map<string, number>();
		for (const c of atlas.collections) {
			for (const m of c.members) counts.set(m, (counts.get(m) ?? 0) + 1);
		}
		const shared = [...counts.values()].filter((n) => n > 1).length;
		assert.ok(shared > 0, "no possibility appears in more than one collection");
	});

	test("every vertical has at least one possibility", () => {
		const used = new Set(atlas.possibilities.map((p: { vertical: string }) => p.vertical));
		for (const v of atlas.verticals) {
			assert.ok(used.has(v.slug), `vertical ${v.slug} has no entries`);
		}
	});

	test("every possibility carries real prose, not a placeholder", () => {
		// Titles and taglines are short by design — they are labels on a wall
		// tile. The explanatory fields must be substantial enough to be useful.
		const shortFields = { title: 18, tagline: 20 } as Record<string, number>;
		const longFields = ["summary", "technique", "buildNotes", "prompt"];

		for (const p of atlas.possibilities) {
			for (const field of ["title", "tagline", ...longFields]) {
				const value = p[field];
				const min = shortFields[field] ?? 80;
				assert.ok(typeof value === "string" && value.length > min, `${p.id}.${field} is thin`);
			}
			// Nothing may read as unfinished.
			for (const field of ["title", "tagline", "rightsNote", ...longFields]) {
				assert.ok(
					!/\b(TODO|TBD|lorem|FIXME|placeholder)\b/i.test(p[field] ?? ""),
					`${p.id}.${field} contains placeholder text`,
				);
			}
		}
	});
});

describe("seed structure", () => {
	test("collection slugs are valid", () => {
		for (const c of seed.collections) {
			assert.match(c.slug, SLUG_RE, `invalid collection slug ${c.slug}`);
			assert.ok(c.fields.length > 0, `${c.slug} has no fields`);
			for (const f of c.fields) {
				assert.ok(f.slug && f.label && f.type, `${c.slug} has an incomplete field`);
			}
		}
	});

	test("possibilities can be ordered by the field the wall sorts on", () => {
		const fields = seed.collections
			.find((c: { slug: string }) => c.slug === "possibilities")
			.fields.map((f: { slug: string }) => f.slug);
		assert.ok(fields.includes("editorial_rank"), "wall orders by editorial_rank");
	});

	test("reference fields declare a target collection", () => {
		for (const c of seed.collections) {
			for (const f of c.fields) {
				if (f.type !== "reference") continue;
				assert.ok(f.validation?.targetCollection, `${c.slug}.${f.slug} has no target`);
				const target = f.validation.targetCollection;
				assert.ok(
					seed.collections.some((x: { slug: string }) => x.slug === target),
					`${c.slug}.${f.slug} targets unknown collection ${target}`,
				);
			}
		}
	});

	test("reference targets are declared before the entries that link to them", () => {
		// EmDash resolves $ref: against entries already loaded in the same seed.
		const order = Object.keys(seed.content);
		for (const c of seed.collections) {
			for (const f of c.fields) {
				if (f.type !== "reference") continue;
				const target = f.validation.targetCollection;
				if (!order.includes(target)) continue;
				assert.ok(
					order.indexOf(target) < order.indexOf(c.slug),
					`${c.slug} links to ${target}, which is declared later`,
				);
			}
		}
	});

	test("every $ref resolves to a seeded entry", () => {
		const slugsByCollection: Record<string, Set<string>> = {};
		for (const [collection, entries] of Object.entries(seed.content)) {
			slugsByCollection[collection] = new Set(
				(entries as { id: string }[]).map((e) => e.id),
			);
		}
		for (const c of seed.collections) {
			const refs = (c.fields ?? []).filter((f: { type: string }) => f.type === "reference");
			for (const f of refs) {
				const target = f.validation.targetCollection;
				const known = slugsByCollection[target];
				assert.ok(known, `no seeded entries for ${target}`);
				for (const entry of seed.content[c.slug] ?? []) {
					const value = entry.data[f.slug];
					const list = Array.isArray(value) ? value : [value];
					for (const v of list) {
						if (typeof v !== "string" || !v.startsWith("$ref:")) continue;
						const target_id = v.slice("$ref:".length);
						assert.ok(
							known.has(target_id),
							`${c.slug}/${entry.id}.${f.slug} → unknown ${target_id}`,
						);
					}
				}
			}
		}
	});

	test("every $media reference is an absolute URL", () => {
		// EmDash downloads $media at seed time; a relative path would fail
		// silently and leave a field unset.
		const walk = (node: unknown, path: string) => {
			if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
			if (node && typeof node === "object") {
				for (const [k, v] of Object.entries(node)) {
					if (k === "$media") {
						const url = (v as { url?: string })?.url ?? "";
						assert.match(url, /^https?:\/\//, `${path}.$media is not absolute`);
					} else {
						walk(v, `${path}.${k}`);
					}
				}
			}
		};
		walk(seed.content, "content");
	});

	test("portable text block styles are ones the renderer supports", () => {
		const allowed = new Set(["normal", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"]);
		const pages = seed.content.pages ?? [];
		for (const page of pages) {
			for (const block of page.data.content ?? []) {
				if (block._type !== "block") continue;
				assert.ok(allowed.has(block.style), `${page.id} uses style ${block.style}`);
			}
		}
	});

	test("site settings carry the canonical origin", () => {
		assert.equal(seed.settings.url, "https://assets.loftwah.com");
	});

	test("the primary menu points at routes that exist", () => {
		const menu = seed.menus.find((m: { name: string }) => m.name === "primary");
		assert.ok(menu, "no primary menu");
		const internal = menu.items
			.map((i: { url: string }) => i.url)
			.filter((u: string) => u.startsWith("/"));
		// Strip page slugs: /pages/<slug> is resolved from CMS content.
		const known = ["/", "/verticals", "/collections"];
		for (const url of internal) {
			if (url.startsWith("/pages/")) continue;
			assert.ok(known.includes(url), `menu points at unimplemented route ${url}`);
		}
	});
});

describe("honesty invariants", () => {
	test("no repo-shipped plate is labelled upstream", () => {
		for (const p of seed.content.possibilities) {
			if (!p.data.specimen) continue;
			assert.notEqual(
				p.data.representative_origin,
				"upstream",
				`${p.id} uses repo media but claims upstream origin`,
			);
		}
		for (const e of seed.content.examples) {
			if (!e.data.specimen) continue;
			assert.notEqual(e.origin, "upstream", `${e.id} uses repo media but claims upstream`);
		}
	});

	test("unverified counts are zero rather than estimated", () => {
		for (const p of seed.content.possibilities) {
			// distinct_sources counts verified upstream repositories. Seeding
			// a plausible-looking number would be fabricating evidence.
			assert.equal(p.data.distinct_sources, 0, `${p.id} claims verified sources`);
			assert.equal(p.data.example_count, 1, `${p.id} should count exactly its own plate`);
		}
	});

	test("machine scores are not seeded as if observed", () => {
		for (const p of seed.content.possibilities) {
			assert.equal(p.data.novelty ?? null, null, `${p.id} seeds an unobserved novelty score`);
			assert.equal(p.data.coverage ?? null, null, `${p.id} seeds an unobserved coverage score`);
		}
	});

	test("editorial judgement is stored separately from machine evidence", () => {
		const fields = seed.collections
			.find((c: { slug: string }) => c.slug === "possibilities")
			.fields.map((f: { slug: string }) => f.slug);
		assert.ok(fields.includes("editorial_rank"));
		assert.ok(fields.includes("novelty"));
		assert.ok(fields.includes("coverage"));
	});

	test("every entry declares a rights status", () => {
		for (const p of seed.content.possibilities) {
			assert.ok(p.data.rights_status, `${p.id} has no rights status`);
		}
		for (const e of seed.content.examples) {
			assert.ok(e.data.rights_status, `${e.id} has no rights status`);
		}
	});

	test("downloaded examples are not marked downloadable without evidence", () => {
		for (const e of seed.content.examples) {
			if (e.data.source_url || e.data.source_repo) continue;
			assert.equal(e.data.downloadable, false, `${e.id} offers a download with no source`);
		}
	});

	test("an example with no source carries no content hash", () => {
		for (const e of seed.content.examples) {
			if (e.data.content_hash === null || e.data.content_hash === undefined) continue;
			assert.ok(e.data.source_repo, `${e.id} has a hash but no source to verify it against`);
		}
	});
});

describe("generated artefacts are current", () => {
	test("seed.json matches what build-seed.mjs produces", () => {
		const result = spawnSync(process.execPath, ["scripts/build-seed.mjs", "--check"], {
			cwd: root,
			encoding: "utf8",
		});
		assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
	});

	test("build-seed refuses to write an invalid atlas", () => {
		// Exercises the validation path without touching the real atlas: an
		// out-of-vocabulary value must fail the build rather than silently
		// producing a seed EmDash would skip on first request.
		const result = spawnSync(
			process.execPath,
			["-e", `
				const { readFileSync, writeFileSync, mkdtempSync } = require("node:fs");
				const { tmpdir } = require("node:os");
				const { join } = require("node:path");
				const root = ${JSON.stringify(root)};
				// Rewrite the atlas in place with one bad vertical, run the
				// generator, then restore. Restored unconditionally so a failing
				// assertion cannot leave the repository broken.
				const path = join(root, "seed/atlas.json");
				const original = readFileSync(path, "utf8");
				try {
					const broken = JSON.parse(original);
					broken.possibilities[0].vertical = "not-a-declared-vertical";
					writeFileSync(path, JSON.stringify(broken, null, "\\t"));
					const r = require("node:child_process").spawnSync(
						process.execPath, ["scripts/build-seed.mjs"], { cwd: root, encoding: "utf8" }
					);
					process.stdout.write(JSON.stringify({ status: r.status, stderr: r.stderr }));
				} finally {
					writeFileSync(path, original);
				}
			`],
			{ cwd: root, encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		const { status, stderr } = JSON.parse(result.stdout);
		assert.equal(status, 1, "generator accepted an invalid vertical");
		assert.match(stderr, /not a declared vertical|not one of|atlas validation failed/i);

		// The real seed must be untouched and still valid.
		const after = spawnSync(process.execPath, ["scripts/build-seed.mjs", "--check"], {
			cwd: root,
			encoding: "utf8",
		});
		assert.equal(after.status, 0, `${after.stdout}${after.stderr}`);
	});

	test("all specimen plates are valid", () => {
		const result = spawnSync(process.execPath, ["scripts/check-specimens.mjs"], {
			cwd: root,
			encoding: "utf8",
		});
		assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
	});

	test("every lab fixture references a plate that exists", () => {
		// The first version of the lab named `edge-to-solid.svg`, which does not
		// exist. Nothing in the unit tests or the type checker noticed; the
		// visual-QA sweep did, as a broken image on a page that is supposed to be
		// the evidence that media works. A fixture pointing at a missing plate is
		// worse than no fixture, because it looks like coverage.
		const missing = new Set<string>();
		for (const fixture of allFixtures()) {
			const specimen = fixture.possibility.specimen;
			const image = fixture.possibility.image?.src;
			for (const path of [specimen, image].filter(Boolean) as string[]) {
				if (!existsSync(join(root, "public", path.replace(/^\//, "")))) missing.add(path);
			}
		}
		assert.deepEqual([...missing], [], `fixtures reference missing plates: ${[...missing].join(", ")}`);
	});

	test("the lab covers every media kind the vocabulary knows", () => {
		const covered = new Set(
			allFixtures().map((f) => f.possibility.mediaKind).filter(Boolean) as string[],
		);
		const missing = Object.keys(MEDIA_LABEL).filter((kind) => !covered.has(kind));
		assert.deepEqual(
			missing,
			[],
			`media kinds with no lab fixture: ${missing.join(", ")}. A new handler has to add one.`,
		);
	});

	test("the lab covers every rights status", () => {
		const covered = new Set(
			allFixtures().map((f) => f.possibility.rightsStatus).filter(Boolean) as string[],
		);
		for (const status of ["cleared", "attribution", "review", "reference"]) {
			assert.ok(covered.has(status), `no lab fixture for rights status "${status}"`);
		}
	});
});
