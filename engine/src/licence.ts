/**
 * Licence evidence and rights classification.
 *
 * The single most important rule in this file: **a repository's licence is not
 * an asset's licence.** A repository can be MIT while containing fonts,
 * sprites, audio or images under terms nobody has written down. So the
 * classifier never promotes a repository-level answer to a per-asset one; it
 * records what it read, where it read it, and classifies the *evidence*.
 *
 * The four statuses are the same four the catalogue uses, because they are a
 * product vocabulary rather than a legal one:
 *
 * | Status        | Meaning                                                            |
 * | ------------- | ------------------------------------------------------------------ |
 * | `cleared`     | A permissive licence text was read and permits the use being made   |
 * | `attribution` | Permitted, with a notice that must travel with the asset            |
 * | `review`      | Something was found but is not understood well enough to rely on it |
 * | `reference`   | No licence, or reuse explicitly refused. Kept because it is real    |
 *
 * `reference` is a first-class answer, not a failure. Most of what a discovery
 * engine finds genuinely has no clear permission, and pretending otherwise is
 * the failure this project exists to avoid.
 */

import { createHash } from "node:crypto";
import { decodeBase64 } from "./github.ts";

export type RightsStatus = "cleared" | "attribution" | "review" | "reference";

export interface LicenceEvidence {
	/** SPDX id when the text is recognisably a known licence. */
	spdx: string | null;
	/** Where the text came from, verbatim. A null path means "nothing found". */
	sourcePath: string | null;
	/** URL of the licence blob, so the claim can be re-checked. */
	sourceUrl: string | null;
	/** sha256 of the exact bytes read. The licence changed, the evidence says so. */
	contentHash: string | null;
	/** A short verbatim quote, not a paraphrase. Paraphrase is how licences get misread. */
	quote: string | null;
	/** GitHub's own metadata, kept as a hint and never as the answer. */
	githubSpdxHint: string | null;
	/** What was found and what it means, in one sentence. Shown to the reader. */
	note: string;
}

/** Licences that permit reuse, with the notice obligation they carry. */
const PERMISSIVE: Record<string, { notice: boolean; note: string }> = {
	MIT: { notice: true, note: "MIT: reuse permitted if the copyright notice travels with it." },
	"MIT-0": { notice: false, note: "MIT-0: reuse permitted with no attribution obligation." },
	"BSD-2-Clause": {
		notice: true,
		note: "BSD-2-Clause: reuse permitted if the notice and disclaimer travel with it.",
	},
	"BSD-3-Clause": {
		notice: true,
		note: "BSD-3-Clause: reuse permitted if the notice and disclaimer travel with it.",
	},
	"Apache-2.0": {
		notice: true,
		note: "Apache-2.0: reuse permitted with attribution, a NOTICE file and the licence copy.",
	},
	ISC: { notice: true, note: "ISC: reuse permitted if the notice travels with it." },
	Unlicense: { notice: false, note: "Unlicense: released into the public domain." },
	"CC0-1.0": { notice: false, note: "CC0-1.0: dedicated to the public domain by the author." },
};

/** Licences that permit reuse but carry conditions this engine does not clear. */
const CONDITIONAL: Record<string, { note: string; why: string }> = {
	"GPL-3.0": { note: "GPL-3.0: reuse permitted under copyleft.", why: "copyleft obligations" },
	"GPL-2.0": { note: "GPL-2.0: reuse permitted under copyleft.", why: "copyleft obligations" },
	LGPL: { note: "LGPL: reuse permitted under weaker copyleft.", why: "copyleft obligations" },
	"MPL-2.0": { note: "MPL-2.0: file-level copyleft.", why: "file-level copyleft" },
	"CC-BY-4.0": { note: "CC-BY-4.0: reuse permitted with attribution.", why: "attribution terms" },
	"CC-BY-SA-4.0": {
		note: "CC-BY-SA-4.0: reuse permitted with attribution and share-alike.",
		why: "share-alike terms",
	},
	"CC-BY-NC-4.0": {
		note: "CC-BY-NC-4.0: non-commercial reuse only.",
		why: "a non-commercial restriction",
	},
};

/** Licences that refuse reuse of the material itself. */
const PROHIBITIVE: Record<string, { note: string }> = {
	"CC-BY-NC-ND-4.0": { note: "CC-BY-NC-ND-4.0: no derivatives and non-commercial only." },
	"CC-BY-ND-4.0": { note: "CC-BY-ND-4.0: no derivatives permitted." },
	"CC-BY-NC-ND-3.0": { note: "CC-BY-NC-ND-3.0: no derivatives and non-commercial only." },
	"CC-BY-ND-3.0": { note: "CC-BY-ND-3.0: no derivatives permitted." },
	"CC-BY-NC-SA-4.0": {
		note: "CC-BY-NC-SA-4.0: non-commercial and share-alike.",
	},
	"CC-BY-NC-3.0": { note: "CC-BY-NC-3.0: non-commercial reuse only." },
};

const SPDX_ALIASES: Record<string, string> = {
	"mit license": "MIT",
	"mit licence": "MIT",
	bsd: "BSD-3-Clause",
	"bsd-3-clause license": "BSD-3-Clause",
	"bsd 3-clause": "BSD-3-Clause",
	"bsd 2-clause": "BSD-2-Clause",
	"apache license 2.0": "Apache-2.0",
	"apache-2.0": "Apache-2.0",
	"gnu general public license v3.0": "GPL-3.0",
	"gnu lesser general public license v2.1": "LGPL-2.1",
	"mozilla public license 2.0": "MPL-2.0",
	"the unlicense": "Unlicense",
	"creative commons zero v1.0 universal": "CC0-1.0",
	"cc0 1.0 universal": "CC0-1.0",
};

/**
 * Canonical casing for every id this engine knows, keyed by lowercase.
 *
 * Built from the classification tables rather than hand-written, so a licence
 * cannot be added to a table and then missed by the lookup. Without it,
 * `LICENSE-MIT` normalised to `mit`, which matched no table and classified a
 * perfectly clear MIT repository as unknown.
 */
const CANONICAL: Record<string, string> = {};
for (const id of [
	...Object.keys(PERMISSIVE),
	...Object.keys(CONDITIONAL),
	...Object.keys(PROHIBITIVE),
]) {
	CANONICAL[id.toLowerCase()] = id;
}
for (const [alias, id] of Object.entries(SPDX_ALIASES)) CANONICAL[alias] = id;

/** Normalises an SPDX id or a licence filename into something comparable. */
export function normaliseSpdx(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.toUpperCase() === "NOASSERTION" || trimmed === "null") return null;
	const lower = trimmed.toLowerCase();
	if (CANONICAL[lower]) return CANONICAL[lower];
	// A declared id is already canonical; keep the base identifier so
	// "GPL-3.0-only" and "GPL-3.0" do not become two different licences.
	const base = trimmed.split(/[\s+]/)[0];
	return base || null;
}


/** Recognises a licence from its text, used when the SPDX id is absent. */
export function detectFromText(text: string): string | null {
	const t = text.toLowerCase();
	if (t.includes("permission is hereby granted, free of charge")) return "MIT";
	if (t.includes("apache license") && t.includes("version 2.0")) return "Apache-2.0";
	if (t.includes("redistribution and use in source and binary forms")) {
		return t.includes("neither the name") ? "BSD-3-Clause" : "BSD-2-Clause";
	}
	if (t.includes("this is free and unencumbered software released into the public domain"))
		return "Unlicense";
	if (t.includes("creative commons legal code") && t.includes("cc0 1.0")) return "CC0-1.0";
	// No-derivatives is checked before the non-commercial variants because
	// "Attribution-NonDerivatives 4.0" also contains "non-", and ND is the
	// stricter of the two.
	if (t.includes("nonderivative") || t.includes("noderivative")) {
		const version = t.includes("4.0") ? "4.0" : "3.0";
		if (t.includes("nc") || t.includes("noncommercial") || t.includes("non-commercial"))
			return `CC-BY-NC-ND-${version}`;
		return `CC-BY-ND-${version}`;
	}
	if (t.includes("sharealike")) {
		return t.includes("nc") || t.includes("noncommercial") || t.includes("non-commercial")
			? "CC-BY-NC-SA-4.0"
			: "CC-BY-SA-4.0";
	}
	if (t.includes("attribution 4.0") || t.includes("attribution 3.0")) return "CC-BY-4.0";
	if (t.includes("noncommercial") || t.includes("non-commercial")) return "CC-BY-NC-4.0";
	if (t.includes("gnu general public license") && t.includes("version 3")) return "GPL-3.0";
	if (t.includes("gnu lesser general public license")) return "LGPL-2.1";
	if (t.includes("mozilla public license") && t.includes("2.0")) return "MPL-2.0";
	return null;
}


/** A verbatim quote, so a reader can check the classification against the text. */
function quoteFrom(text: string): string | null {
	const sentences = text
		.split(/\n\s*\n/)
		.map((s) => s.replace(/\s+/g, " ").trim())
		.filter((s) => s.length > 40);
	const grant = sentences.find((s) => /permission is hereby granted|is hereby granted|licensed under/i.test(s));
	const picked = grant ?? sentences[0];
	if (!picked) return null;
	return picked.length > 240 ? `${picked.slice(0, 237)}…` : picked;
}

export interface ClassifyInput {
	/** The licence file's bytes, as read. */
	licenceText?: string | null;
	licencePath?: string | null;
	licenceUrl?: string | null;
	/** GitHub's `license.spdx_id` from search results. A hint only. */
	githubSpdxHint?: string | null;
	/**
	 * A licence *name* found in the asset's own directory (an `OFL.txt` next to
	 * a font, for instance). Its presence is evidence; its absence says nothing
	 * about the repository.
	 */
	assetLicenceText?: string | null;
	assetLicencePath?: string | null;
	assetLicenceUrl?: string | null;
}

export interface Classification {
	status: RightsStatus;
	evidence: LicenceEvidence;
	/** One sentence a reader can act on. Never a bare status. */
	meaning: string;
	/** True only when the *asset* itself has a licence, not just its repository. */
	assetScoped: boolean;
}

const hashOf = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Recognises a licence from its *filename*.
 *
 * Repositories name their licence file after it often enough to be worth
 * reading (`LICENSE-MIT`, `COPYING.APACHE`), but only as a hint: the text is
 * still what decides. A filename alone never produces a classification.
 */
export function spdxFromFilename(path: string | null | undefined): string | null {
	if (!path) return null;
	const name = path.split("/").pop() ?? "";
	const match = /^(?:licen[cs]e|copying|unlicen[cs]e)[-_. ]*(.*)$/i.exec(name);
	if (!match) return null;
	const suffix = match[1].trim().toLowerCase();
	// Only a recognised id is a hint. "COPYING.APACHE" identifies Apache 2.0;
	// "COPYING.FOO" identifies nothing, and returning "foo" would classify an
	// unknown licence as a known one.
	return CANONICAL[suffix] ?? (SPDX_ALIASES[suffix] ?? null);
}

/** Classifies what was actually read. */
export function classify(input: ClassifyInput): Classification {
	// 1. A licence next to the asset is the strongest evidence available, and
	//    the only kind that speaks about the asset rather than the repository.
	if (input.assetLicenceText?.trim()) {
		return classifyBySpdx(
			detectFromText(input.assetLicenceText) ?? spdxFromFilename(input.assetLicencePath),
			input.assetLicenceText,
			{
				spdxHint: null,
				path: input.assetLicencePath ?? null,
				url: input.assetLicenceUrl ?? null,
				hash: hashOf(input.assetLicenceText),
				scope: "asset",
			},
		);
	}

	// 2. The repository licence. The text is authoritative and the filename is
	//    a hint; the other way round is how "LICENSE-MIT" ends up classified as
	//    an unknown licence called LICENSE-MIT.
	if (input.licenceText?.trim()) {
		return classifyBySpdx(
			detectFromText(input.licenceText) ?? spdxFromFilename(input.licencePath),
			input.licenceText,
			{
				spdxHint: input.githubSpdxHint ?? null,
				path: input.licencePath ?? null,
				url: input.licenceUrl ?? null,
				hash: hashOf(input.licenceText),
				scope: "repository",
			},
		);
	}

	// 3. GitHub's metadata with no readable text behind it. This is a hint that
	//    could not be verified, which is precisely what `review` is for.
	const hint = normaliseSpdx(input.githubSpdxHint);
	if (hint) {
		return {
			status: "review",
			assetScoped: false,
			meaning: `GitHub reports ${hint} but no licence text was found to read. Recorded as a hint, not as permission.`,
			evidence: {
				spdx: hint,
				sourcePath: null,
				sourceUrl: null,
				contentHash: null,
				quote: null,
				githubSpdxHint: hint,
				note: "Detected from repository metadata only; the licence text itself was not read.",
			},
		};
	}

	// 4. Nothing. This is the honest default for the open web.
	return {
		status: "reference",
		assetScoped: false,
		meaning:
			"No licence was found at the source. Kept because it demonstrates a real possibility; that is the entire extent of its permission.",
		evidence: {
			spdx: null,
			sourcePath: null,
			sourceUrl: null,
			contentHash: null,
			quote: null,
			githubSpdxHint: null,
			note: "No licence file and no licence metadata. Reuse is not established.",
		},
	};
}

function classifyBySpdx(
	spdx: string | null,
	text: string,
	context: {
		spdxHint: string | null;
		path: string | null;
		url: string | null;
		hash: string;
		scope: "asset" | "repository";
	},
): Classification {
	const evidenceBase = {
		spdx,
		sourcePath: context.path,
		sourceUrl: context.url,
		contentHash: context.hash,
		quote: quoteFrom(text),
		githubSpdxHint: context.spdxHint,
	};
	const scopeNote =
		context.scope === "asset"
			? "Read from a licence file beside the asset."
			: "Read from the repository's licence file. This covers the repository, not automatically every file in it.";

	if (!spdx) {
		return {
			status: "review",
			assetScoped: context.scope === "asset",
			meaning: `A licence file was found but is not a licence this engine recognises. Read it before use. ${scopeNote}`,
			evidence: { ...evidenceBase, spdx: null, note: `Unrecognised licence text at ${context.path}.` },
		};
	}

	if (PROHIBITIVE[spdx]) {
		return {
			status: "reference",
			assetScoped: context.scope === "asset",
			meaning: `${PROHIBITIVE[spdx].note} Kept as a demonstration of the technique, not as material to copy.`,
			evidence: { ...evidenceBase, note: `${PROHIBITIVE[spdx].note} ${scopeNote}` },
		};
	}

	if (CONDITIONAL[spdx]) {
		return {
			status: "review",
			assetScoped: context.scope === "asset",
			meaning: `${CONDITIONAL[spdx].note} Read before use: this engine does not clear ${CONDITIONAL[spdx].why}.`,
			evidence: { ...evidenceBase, note: `${CONDITIONAL[spdx].note} ${scopeNote}` },
		};
	}

	const permissive = PERMISSIVE[spdx];
	if (permissive) {
		return {
			status: permissive.notice ? "attribution" : "cleared",
			assetScoped: context.scope === "asset",
			meaning: permissive.note,
			evidence: { ...evidenceBase, note: `${permissive.note} ${scopeNote}` },
		};
	}

	return {
		status: "review",
		assetScoped: context.scope === "asset",
		meaning: `${spdx} is not a licence this engine can classify. Read it before use. ${scopeNote}`,
		evidence: { ...evidenceBase, note: `${spdx} is unclassified by this engine. ${scopeNote}` },
	};
}

/** Candidate licence filenames, in the order a repository usually puts them. */
export const LICENCE_FILENAMES = [
	"LICENSE",
	"LICENSE.md",
	"LICENSE.txt",
	"LICENCE",
	"LICENCE.md",
	"LICENCE.txt",
	"COPYING",
	"COPYING.md",
	"COPYING.txt",
	"UNLICENSE",
	"license",
	"License",
];

/** Picks the licence file from a tree, ignoring vendored third-party copies. */
export function pickLicenceFile(paths: string[]): string | null {
	const top = LICENCE_FILENAMES.find((name) => paths.includes(name));
	if (top) return top;
	const root = paths.filter((p) => !p.includes("/")).find((p) => /^(licen[cs]e|copying|unlicen[cs]e)/i.test(p));
	return root ?? null;
}

/** Licence files that sit beside an asset rather than at the repository root. */
export function assetLicenceFor(paths: string[], assetPath: string): string | null {
	const dir = assetPath.includes("/") ? assetPath.slice(0, assetPath.lastIndexOf("/")) : "";
	if (!dir) return null;
	return (
		paths.find(
			(p) =>
				p.startsWith(`${dir}/`) &&
				!p.slice(dir.length + 1).includes("/") &&
				/^(licen[cs]e|copying|o[fl]|font-licen[cs]e)/i.test(p.slice(dir.length + 1)),
		) ?? null
	);
}

export { decodeBase64 };
