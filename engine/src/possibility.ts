/**
 * From candidates to possibilities.
 *
 * This is the compression step, and it is where a discovery engine is most
 * tempted to overstate itself. A repository is not a possibility. Fifty
 * repositories that all demonstrate the same treatment are one possibility with
 * fifty examples. Getting that wrong in either direction is a product bug:
 *
 * - Too coarse and the catalogue is a list of repositories wearing a catalogue
 *   costume.
 * - Too fine and it is the warehouse of near-duplicates the product exists to
 *   avoid.
 *
 * So the grouping key is the *technique*, taken from the brief's own framing and
 * the evidence that was read, and everything the engine is unsure about is left
 * null rather than estimated. `novelty` and `coverage` are not computed here at
 * all: they are machine observations that need a second pass over the whole
 * catalogue, and a plausible-looking number produced by a heuristic is worse
 * than a null.
 */

import { createHash } from "node:crypto";
import type { Candidate } from "./candidates.ts";

/** Extensions the engine can say something specific about. */
export const MEDIA_BY_EXTENSION: Record<string, string> = {
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	avif: "image",
	svg: "image",
	webm: "motion",
	mp4: "motion",
	mov: "motion",
	glb: "3d",
	gltf: "3d",
	blend: "3d",
	obj: "3d",
	fbx: "3d",
	wav: "audio",
	mp3: "audio",
	ogg: "audio",
	flac: "audio",
	m4a: "audio",
	ttf: "type",
	otf: "type",
	woff: "type",
	woff2: "type",
	glsl: "shader",
	frag: "shader",
	vert: "shader",
	hlsl: "shader",
	shader: "shader",
	// Source is evidence too. A procedural-audio repository demonstrates its
	// technique in the code, and a hunt that only looked for `.wav` files would
	// miss every one of them.
	py: "code",
	js: "code",
	mjs: "code",
	ts: "code",
	tsx: "code",
	jsx: "code",
	cpp: "code",
	cc: "code",
	c: "code",
	h: "code",
	rs: "code",
	rb: "code",
	cs: "code",
	lua: "code",
	d: "code",
	zig: "code",
};

/** Beyond this, a cluster stops being one treatment and becomes a bucket. */
const MAX_CLUSTER = 6;

export const kindFor = (path: string): string => {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return MEDIA_BY_EXTENSION[ext] ?? "generic";
};

/**
 * Words that carry no information about a technique, removed before grouping.
 * A candidate named "awesome-shaders" and one named "shader-tutorial" describe
 * the same subject at wildly different quality, and the words that look like
 * the technique ("shader") are the ones that cannot distinguish them.
 */
const STOP_WORDS = new Set([
	"a", "an", "and", "the", "for", "with", "of", "in", "on", "to", "from", "by", "is",
	"awesome", "best", "top", "list", "collection", "tutorial", "tutorials", "guide",
	"guides", "example", "examples", "demo", "demos", "lib", "library", "tool", "tools",
	"kit", "assets", "asset", "resource", "resources", "stuff", "things", "project",
	"projects", "repo", "repos", "github", "source", "code", "src", "master", "main",
	"simple", "easy", "modern", "new", "old", "fast", "tiny", "mini", "micro",
]);

/** Content words from a repository's description, name and topics. */
export function keywordsOf(candidate: Candidate): string[] {
	const haystack = [candidate.fullName.replace("/", " "), candidate.description ?? "", ...candidate.topics]
		.join(" ")
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/[\s-]+/)
		.filter((w) => w.length > 2 && !STOP_WORDS.has(w));
	return [...new Set(haystack)].sort();
}

/**
 * A readable title from a repository description.
 *
 * The alternative — title-casing the first three keywords — produces things like
 * "Agateau Effect Effects", which is worse than no title at all. A description
 * usually opens with the thing itself ("Qt port of SFXR, a sound effect
 * generator…"), so the leading clause is both shorter and more true.
 */
export function leadPhrase(description: string | null | undefined, fallback: string): string {
	if (!description) return fallback;
	const cleaned = description
		.replace(/^[\s"'“”‘’(\[—-]+/, "")
		.replace(/^(?:a|an|the)\s+/i, "")
		.trim();
	// A comma usually introduces an appositive restating the subject
	// ("Qt port of SFXR, a sound effect generator, …"), which is a subtitle
	// rather than part of the name. It is only safe to cut there when what
	// precedes it is long enough to stand on its own.
	const firstClause = cleaned.split(/[.;:!?]|\s—\s|\s–\s/)[0].trim();
	const head = firstClause.split(",")[0].trim();
	const base = head.split(/\s+/).length >= 3 ? head : firstClause;
	let words = base.split(/\s+/).slice(0, 9);
	// A title that ends on "of" or "and" reads as truncated, because it is.
	// Dropping the dangling word costs nothing and the full sentence is one
	// click away in the summary.
	while (words.length > 3 && DANGLING.has(words[words.length - 1].toLowerCase().replace(/\W/g, ""))) {
		words = words.slice(0, -1);
	}
	let phrase = words.join(" ").replace(/[,:;]+$/, "");
	/*
	 * Cut on a word, and close what is left open.
	 *
	 * Nine words is not nine words: a README that opens with a sentence of
	 * bracketed formats runs past the cap mid-phrase and the tile reads
	 *
	 *     EasyQRCodeJS-NodeJS is a NodeJS server side javascript QRCode
	 *     image(PNG/JPEG/SVG/Base64
	 *
	 * which is the whole repository description with the ends taken off, and it
	 * is what `h1` on the drill-in and the title on the wall both print. So the
	 * cap is applied to characters rather than words, and then an unbalanced
	 * bracket or quote is closed — a half-open parenthesis in a title reads as a
	 * rendering fault, which it is.
	 *
	 * `search-text.ts` does the same thing for a search excerpt, deliberately
	 * restated rather than imported: the engine does not import app code.
	 */
	if (phrase.length > MAX_TITLE_CHARS) {
		const cut = phrase.slice(0, MAX_TITLE_CHARS);
		const lastSpace = cut.lastIndexOf(" ");
		phrase = (lastSpace > MAX_TITLE_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd();
		phrase += "\u2026";
	}
	phrase = closeBrackets(phrase);
	if (phrase.replace(/\u2026$/, "").length < 4) return fallback;
	return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** How long a title may be before it is cut, in characters. */
const MAX_TITLE_CHARS = 72;

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "\u201c": "\u201d" };

/**
 * Closes whatever the cut left open, and drops a stray closer.
 *
 * Only one level, on purpose: a description with unbalanced brackets in it is
 * repaired here so the title is readable, and left alone everywhere else so the
 * repair is visible rather than silent across the record.
 */
function closeBrackets(phrase: string): string {
	let out = phrase.replace(/[\u2026]$/, (m) => m);
	const stack: string[] = [];
	for (const ch of out) {
		if (OPENERS[ch]) stack.push(OPENERS[ch]);
		else if (stack.length && stack[stack.length - 1] === ch) stack.pop();
	}
	while (stack.length) out += stack.pop();
	// A closer with nothing open is noise the cap can leave behind.
	if (!/[([\u201c]/.test(out)) out = out.replace(/[)\]]/g, "");
	return out;
}

const DANGLING = new Set([
	"a", "an", "the", "of", "and", "or", "to", "in", "on", "for", "with", "at", "by",
	"from", "into", "that", "which", "is", "are", "as", "its", "it", "this", "these",
]);



/**
 * The grouping key for one candidate: the terms that name a treatment.
 *
 * Only content words count. "seamless looping" and "periodic loops" share
 * nothing lexically, and that is a real limitation of a lexical grouper — which
 * is why the grouping below also merges on media kind and on a small number of
 * shared terms, and why a group of one is reported honestly as a group of one.
 */
export function techniqueKey(candidate: Candidate): string {
	const terms = keywordsOf(candidate);
	const key = terms.slice(0, 3).join("-") || candidate.fullName.toLowerCase();
	return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/** The media a candidate actually demonstrates, from the files that were read. */
export function mediaKindsOf(candidate: Candidate): string[] {
	return [...new Set(candidate.files.map((f) => f.kind))].filter((k) => k !== "licence" && k !== "generic").sort();
}

/**
 * How similar two candidates are, in *distinctive* terms.
 *
 * "Distinctive" is a corpus-level judgement: a term that appears in more than
 * about a third of the candidates is the subject of the hunt, not the technique.
 * In an audio hunt that makes `audio`, `sound`, `game` and `generator` generic,
 * and what is left — `sfxr`, `granular`, `wavetable`, `blip` — is the part that
 * actually distinguishes one treatment from another.
 *
 * Without this filter the grouping collapses: every audio repository shares
 * "sound" and "audio", so a naive two-term rule merges all eighteen of them into
 * a single entry, which is a different failure from listing eighteen and just as
 * wrong.
 */
export function similarity(
	a: Candidate,
	b: Candidate,
	corpus: TermCorpus,
): { shared: string[]; score: number } {
	const terms = new Set(keywordsOf(a).filter((t) => !corpus.generic.has(t)));
	const shared = keywordsOf(b).filter((t) => terms.has(t));
	const ka = mediaKindsOf(a);
	const kb = mediaKindsOf(b);
	const sameKind = ka.length > 0 && ka.some((k) => kb.includes(k));
	// Two distinctive terms is a match.
	//
	// One is a match only when that term is rare in this corpus. A single
	// shared word is usually a coincidence of subject — unless nothing else in
	// the hunt mentions it, in which case it is the thing that ties the two
	// together. Media agreement also counts, for repositories whose only
	// evidence is a file type.
	const rare = shared.length === 1 && (corpus.frequency.get(shared[0]) ?? 99) <= corpus.rareThreshold;
	const score = shared.length >= 2 ? 2 : shared.length === 1 && (rare || sameKind) ? 1 : 0;
	return { shared, score };
}

export interface TermCorpus {
	generic: Set<string>;
	frequency: Map<string, number>;
	rareThreshold: number;
}

/**
 * Corpus-level term statistics.
 *
 * A term in more than about a third of the candidates is the subject of the
 * hunt, not the technique: in an audio hunt that makes `audio`, `sound`, `game`
 * and `generator` generic, and what is left — `sfxr`, `wavetable`, `granular` —
 * is the part that actually distinguishes one treatment from another. Without
 * this, the first version of the grouper merged all eighteen audio repositories
 * into one entry that described none of them.
 */
export function termCorpus(candidates: Candidate[]): TermCorpus {
	const frequency = new Map<string, number>();
	for (const candidate of candidates) {
		for (const term of keywordsOf(candidate)) {
			frequency.set(term, (frequency.get(term) ?? 0) + 1);
		}
	}
	return {
		frequency,
		generic: new Set(
			[...frequency.entries()]
				.filter(([, n]) => n > Math.max(2, Math.ceil(candidates.length * 0.35)))
				.map(([t]) => t),
		),
		rareThreshold: Math.max(2, Math.ceil(candidates.length * 0.25)),
	};
}




export interface ExtractedPossibility {
	slug: string;
	title: string;
	tagline: string | null;
	summary: string;
	technique: string;
	vertical: string;
	mediaKind: string;
	/** One representative candidate, and why that one. Never a silent choice. */
	representative: { fullName: string; ref: string; why: string };
	/** Every candidate that maps here, with the evidence that put it here. */
	examples: {
		fullName: string;
		ref: string;
		htmlUrl: string;
		/** The media this source actually demonstrates, from the files read. */
		mediaKind: string;
		rightsStatus: string;
		licenceSpdx: string | null;
		licenceEvidence: string | null;
		attribution: string | null;
		contentHash: string | null;
		origin: "upstream" | "derived" | "generated";
		note: string;
	}[];
	/**
	 * Machine observations. Null means "not measured", which is different from
	 * zero and must not be collapsed into it.
	 */
	novelty: number | null;
	coverage: number | null;
	/**
	 * Sources verified against a licence that was actually read. A candidate
	 * with no readable licence contributes 0, not 1.
	 */
	distinctSources: number;
	/** Fields the engine does not own. Present so the payload is explicit. */
	editorialRank: null;
	featured: null;
	buildNotes: null;
	promptScaffold: null;
}

const slugify = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);

/** Picks the candidate that best represents a group, and says why. */
function chooseRepresentative(candidates: Candidate[]): { candidate: Candidate; why: string } {
	const scored = candidates.map((candidate) => {
		let score = 0;
		// Stars are a maintenance proxy, not a quality claim, and it is
		// weighted below the evidence actually held.
		score += Math.min(candidate.stars, 5000) / 5000;
		if (candidate.rights.assetScoped) score += 1;
		if (candidate.rights.status === "cleared" || candidate.rights.status === "attribution")
			score += 0.75;
		if (candidate.rights.status === "reference") score -= 0.25;
		if (candidate.archived) score -= 1;
		if (candidate.fork) score -= 1;
		score += Math.min(candidate.files.length, 10) / 20;
		if (candidate.description) score += 0.1;
		return { candidate, score };
	});
	scored.sort((a, b) => b.score - a.score || a.candidate.fullName.localeCompare(b.candidate.fullName));
	const winner = scored[0];
	const reasons: string[] = [];
	reasons.push(
		winner.candidate.rights.assetScoped
			? "carries a licence beside the asset"
			: winner.candidate.rights.status === "reference"
				? "no licence was readable, so it is shown as reference only"
				: `repository licence is ${winner.candidate.rights.status}`,
	);
	if (winner.candidate.stars > 0) {
		reasons.push(
			`${winner.candidate.stars} stars is a maintenance signal, not a quality claim`,
		);
	}
	if (!winner.candidate.archived && !winner.candidate.fork) reasons.push("not archived or a fork");
	return { candidate: winner.candidate, why: reasons.join("; ") };
}

export interface ExtractOptions {
	vertical: string;
	/** The brief's intent, used for the summary when nothing better exists. */
	intent: string;
}

/**
 * Groups candidates into possibilities.
 *
 * Grouping is by technique key, then the slug is derived from the shared
 * vocabulary so it is stable across runs: the same evidence always produces
 * the same URL, which is what makes the publish step idempotent.
 */
export function extractPossibilities(
	candidates: Candidate[],
	options: ExtractOptions,
): ExtractedPossibility[] {
	// Star clustering rather than transitive union-find.
	//
	// Chaining is what broke the first version of this: A shares a term with B
	// and B with C, so union-find merged A, B and C into one entry that
	// described none of them. A cluster here is "candidates that are
	// *individually* close to the same seed", and no candidate joins on the
	// strength of a third.
	const corpus = termCorpus(candidates);
	const ordered = [...candidates].sort((a, b) => a.fullName.localeCompare(b.fullName));
	const assigned = new Set<string>();
	const groups: Candidate[][] = [];
	for (const seed of ordered) {
		if (assigned.has(seed.id)) continue;
		const members = [seed];
		assigned.add(seed.id);
		for (const other of ordered) {
			if (assigned.has(other.id)) continue;
			if (similarity(seed, other, corpus).score > 0) {
				members.push(other);
				assigned.add(other.id);
			}
		}
		// A cluster of fifteen is a bucket, not a treatment. Everything past the
		// cap becomes its own entry, so the compression never hides material
		// behind a label that does not fit it.
		for (let i = 0; i < members.length; i += MAX_CLUSTER) {
			groups.push(members.slice(i, i + MAX_CLUSTER));
		}
	}

	const mediaTally = new Map<string, number>();
	for (const c of candidates) {
		for (const kind of mediaKindsOf(c)) mediaTally.set(kind, (mediaTally.get(kind) ?? 0) + 1);
	}
	const dominantMedia =
		[...mediaTally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "image";

	const out: ExtractedPossibility[] = [];
	const taken = new Set<string>();
	for (const members of groups.values()) {
		const sorted = [...members].sort((a, b) => a.fullName.localeCompare(b.fullName));
		const { candidate: representative, why } = chooseRepresentative(sorted);
		const title = leadPhrase(representative.description, representative.repo);
		// The slug is derived from the title, so the URL a reader sees matches
		// the words on the tile and stays stable while the title is stable.
		const slugBase = slugify(title);
		/*
		 * The vertical is part of the slug, and it has to be.
		 *
		 * `toPossibilities` extracts the *whole* candidate set once per vertical in
		 * the brief, because the same repository genuinely demonstrates more than
		 * one treatment — a QR generator is both a `logos` technique and an `icons`
		 * one, and filing it twice is the right answer. But the slug was
		 * `title + techniqueKey`, and neither of those mentions the vertical, so
		 * every multi-vertical brief produced the same slug once per vertical.
		 *
		 * That is not a cosmetic collision. `validatePayload` refuses a payload
		 * with a duplicate possibility slug and `crawl` writes nothing, so **any
		 * brief naming two verticals could never sync at all** — the run looked
		 * successful and the catalogue stayed exactly as it was. The first
		 * acceptance brief named one vertical, so nothing caught it.
		 *
		 * The vertical also makes the URL say what the entry is: a reader who
		 * arrives at `/possibilities/<slug>` can see which field it belongs to
		 * without going back.
		 */
		const slug =
			`${slugBase || slugify(representative.fullName)}-${options.vertical}-` +
			`${techniqueKey(representative).slice(0, 4)}`;

		// The terms that actually put this group together, named rather than
		// implied — a reader should be able to check the grouping.
		const sharedTerms = [...new Set(sorted.flatMap((c) => keywordsOf(c)))].filter((term) =>
			sorted.every((c) => keywordsOf(c).includes(term)),
		);

		// Structural uniqueness inside one vertical: the vertical fixed the
		// cross-vertical case, and this fixes the case it cannot — two genuinely
		// different groups whose representative shares a title and a technique key.
		// A counter keeps the slug readable and the URL stable for a given ordering.
		let unique = slug;
		for (let n = 2; taken.has(unique); n++) unique = `${slug}-${n}`;
		taken.add(unique);

		out.push({
			slug: unique,
			title,
			tagline: representative.description,
			/*
			 * The summary says what the entry *is*; the tagline is what the source
			 * repository says about itself.
			 *
			 * They were the same string, character for character, which put the same
			 * sentence twice on the tile and the drill-in — the #67 duplication again,
			 * one layer up, and worse here because both halves are the *same* sentence
			 * rather than two overlapping ones. A repository description is also a
			 * feature list rather than a description of a technique: "browser/node.js,
			 * transparency, logo, border-radius, opacity, PNG/SVG/PDF" tells a reader
			 * nothing about what the technique is.
			 *
			 * So the summary is composed here — what was found, from what, and at what
			 * commit — and the source's own words stay in the tagline where they
			 * belong.
			 */
			summary: sorted.length === 1
				? `One source found for this treatment: ${representative.fullName} at ${representative.ref.slice(0, 7)}. Nothing else in the hunt was close enough to merge with it, so it stands alone.`
				: `Grouped from ${sorted.length} sources that all demonstrate the same treatment (${sharedTerms.slice(0, 4).join(", ") || "matched on media kind"}). A group is a judgement about the technique, not about the files.`,
			technique:
				sorted.length === 1
					? `One source found for this treatment: ${representative.fullName} at ${representative.ref.slice(0, 7)}. Nothing else in the hunt was close enough to merge with it, so it stands alone.`
					: `Grouped from ${sorted.length} sources that all describe the same treatment (${sharedTerms.slice(0, 4).join(", ") || "matched on media kind"}). A group is a judgement about the technique, not about the files.`,
			vertical: options.vertical,
			mediaKind: dominantMedia,
			representative: { fullName: representative.fullName, ref: representative.ref, why },
			examples: sorted.map((c) => ({
				fullName: c.fullName,
				ref: c.ref,
				htmlUrl: c.htmlUrl,
				// The media this source actually demonstrates, from the files that
				// were read. Guessing from the group would mislabel an evidence
				// record, which is the one thing a provenance row must not do.
				mediaKind: mediaKindsOf(c)[0] ?? dominantMedia,
				rightsStatus: c.rights.status,
				licenceSpdx: c.rights.spdx,
				licenceEvidence: c.rights.note,
				attribution: c.rights.quote,
				contentHash: c.files[0]?.sha256 ?? null,
				// A candidate is a repository, not a file we have permission to
				// republish, so nothing from the crawl is `upstream` media. The
				// repository is the evidence; the plate is generated.
				origin: "generated" as const,
				note: `${c.files.length} ${c.files.length === 1 ? "file" : "files"} read at ${c.ref.slice(0, 7)}. ${c.rights.meaning}`,
			})),
			novelty: null,
			coverage: null,
			distinctSources: sorted.filter(
				(c) => c.rights.status === "cleared" || c.rights.status === "attribution",
			).length,
			editorialRank: null,
			featured: null,
			buildNotes: null,
			promptScaffold: null,
		});
	}

	return out.sort((a, b) => a.slug.localeCompare(b.slug));
}
