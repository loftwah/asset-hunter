/**
 * Does the deployed database hold the schema and the content this repository
 * declares? The verdict, as a pure function.
 *
 * ## What was actually wrong, which is two things and not one
 *
 * `assets.loftwah.com` was running the current commit, serving 22/22 smoke
 * checks, and answering `/api/catalogue.json` without complaint. It was also
 * missing **ten seeded entries** and **three collections**.
 *
 * The collections are the serious half. `seed/seed.json` declares nine;
 * production had six. The three absent were `disputes`, `exclusions` and
 * `audit_events` — the exact collections the rights-correction and takedown
 * workflow writes to (#54). So the deployed app contained a working
 * implementation of a feature that could not run: `openDispute`,
 * `excludeSource`, `liftExclusion` and `resolveDispute` all address collections
 * that do not exist in the live database, and every one of those writes is
 * supposed to append an audit row to the third missing collection. The feature
 * was gated, tested, documented, deployed and green, and inoperable.
 *
 * Nothing caught it because nothing asked. `check-deploy-freshness` proved
 * production ran this commit. `seed:check` proved the seed was reproducible from
 * the atlas. `check:specimens` proved each entry had a plate. `npm run smoke`
 * proved the public read path worked — and the public read path does not touch
 * `ec_disputes`, because the dispute state lives as fields *on the example row*,
 * not in a table of its own.
 *
 * That is the shape of the defect, and it is the same shape as every other one
 * worth a gate: **every existing check is about an artefact, and none is about
 * whether the artefact arrived.** A fresh commit proves the code shipped. It says
 * nothing about the database, which travels a different path — schema and rows
 * are written by a seed applied once, at some point, by a command nobody has run
 * since. `wrangler deploy` does not carry them.
 *
 * ## Why the axes are separate, and both failures
 *
 * Entries and collections are checked separately because they fail differently
 * and matter differently. A missing entry is invisible content. A missing
 * collection is a **feature that cannot execute**: the code path is deployed,
 * the acceptance criteria are met, and the write lands on a table that is not
 * there. Only the first is visible to a reader, so only the first is tempting to
 * ignore — which is why both are failures and why collections are named first.
 *
 * ## `extra` is reported, never a failure
 *
 * Production holding something the repository does not declare is usually the
 * system working: a hunt publishes drafts, a curator promotes one, a plugin
 * adds a collection. Failing on it would train somebody towards re-seeding over
 * a human's edit, and `--on-conflict=update` is exactly that. So `extra` is
 * printed and the run still passes.
 */
export type ParityVerdict = "aligned" | "drifted" | "unknown";

export interface ParityInput {
	/** False when either axis could not be read. */
	readonly reachable: boolean;
	/** Entry ids `seed/seed.json` declares. */
	readonly seedEntries: ReadonlySet<string>;
	/** Entry ids the deployed catalogue serves. */
	readonly liveEntries: ReadonlySet<string>;
	/** Collection slugs `seed/seed.json` declares. */
	readonly seedCollections: ReadonlySet<string>;
	/** Collection slugs the deployed database actually has. */
	readonly liveCollections: ReadonlySet<string>;
	/**
	 * Possibilities the seed gives at least one example to.
	 *
	 * Optional, because it cannot be compared as an id set. `/api/catalogue.json`
	 * publishes **one** example per possibility — the representative — and gives it
	 * the *possibility's* slug as its `id`, while `seed.json` stores examples as their
	 * own rows keyed `ex-<slug>`. So example ids are not comparable across the two
	 * sides, and a seed that declares 34 examples is not a claim that 34 example ids
	 * should come back.
	 *
	 * What *is* comparable, and what actually broke, is the pairing: a possibility the
	 * seed gives an example to, served with none. That is a reader arriving at an
	 * entry with no specimen on it, and it is exactly what the first delivery to
	 * production produced — ten new possibilities, live, with `exampleCount: 0`.
	 */
	readonly seedPossessionsWithExamples?: ReadonlySet<string>;
	/** Possibilities the deployed catalogue reports at least one example for. */
	readonly livePossessionsWithExamples?: ReadonlySet<string>;
}

export interface ParityResult {
	readonly kind: ParityVerdict;
	/** One line for a person, naming the worst thing found. */
	readonly summary: string;
	readonly missingEntries: string[];
	readonly extraEntries: string[];
	readonly missingCollections: string[];
	readonly extraCollections: string[];
	/**
	 * Possibilities the seed gives an example to and the catalogue serves with none.
	 *
	 * Reported separately from {@link missingEntries} because the ids are not
	 * comparable: the entry exists, so `missingEntries` is empty and `aligned` would
	 * otherwise be the verdict. An entry with no specimen is a real defect and an
	 * invisible one.
	 */
	readonly possibilitiesWithoutExamples: string[];
	/**
	 * What to do, or `null`.
	 *
	 * Names delivery rather than a seed re-application. Delivery is a sequence of
	 * creates and POSTs, which cannot delete a row and cannot overwrite one, so it
	 * cannot destroy a curator's edit. `emdash seed --on-conflict=update` would bring
	 * the missing rows in *and* overwrite every editorial change made since the last
	 * seed — the one call in this repository that can silently destroy a person's
	 * work, and it reads as harmless.
	 */
	readonly remedy: string | null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const list = (ids: string[], cap = 6) => {
	const shown = ids.slice(0, cap).join(", ");
	return ids.length > cap ? `${shown}, …and ${ids.length - cap} more` : shown;
};

/**
 * Compare a seed against a deployed database.
 *
 * Takes four id sets rather than the documents so every verdict is reachable from
 * a test without a seed file, a network, a database or wrangler — the same reason
 * `assessFreshness` takes a `HistoryOracle` instead of shelling out to git.
 */
export function assessDeployParity(input: ParityInput): ParityResult {
	const empty = {
		missingEntries: [] as string[],
		extraEntries: [] as string[],
		missingCollections: [] as string[],
		extraCollections: [] as string[],
		possibilitiesWithoutExamples: [] as string[],
	};

	if (!input.reachable) {
		return {
			kind: "unknown",
			summary:
				"the deployed database could not be read, so whether it holds this repository's schema and content is unknown",
			...empty,
			remedy:
				"check that /api/catalogue.json answers and that `wrangler d1 execute --remote` is authenticated, then re-run: npm run deploy:parity",
		};
	}

	const missingCollections = [...input.seedCollections]
		.filter((slug) => !input.liveCollections.has(slug))
		.sort();
	const extraCollections = [...input.liveCollections]
		.filter((slug) => !input.seedCollections.has(slug))
		.sort();
	const missingEntries = [...input.seedEntries]
		.filter((id) => !input.liveEntries.has(id))
		.sort();
	const extraEntries = [...input.liveEntries]
		.filter((id) => !input.seedEntries.has(id))
		.sort();
	const possibilitiesWithoutExamples = [
		...(input.seedPossessionsWithExamples ?? new Set<string>()),
	]
		.filter((id) => !(input.livePossessionsWithExamples ?? new Set<string>()).has(id))
		.sort();

	if (!missingCollections.length && !missingEntries.length && !possibilitiesWithoutExamples.length) {
		return {
			kind: "aligned",
			summary: `the deployed database serves all ${input.seedEntries.size} seeded entries across all ${input.seedCollections.size} collections`,
			missingEntries,
			extraEntries,
			missingCollections,
			extraCollections,
			possibilitiesWithoutExamples,
			remedy: null,
		};
	}

	// An entry with no specimen reads as complete and is not, so it is named in the
	// same sentence as the entries rather than only in the arrays.
	const specimens = possibilitiesWithoutExamples.length
		? `; ${possibilitiesWithoutExamples.length} of them have no example`
		: "";

	// Collections first: a missing collection is a feature that cannot run, and it
	// is invisible to anybody reading the site.
	const summary = missingCollections.length
		? `the deployed database is missing ${missingCollections.length} ${plural(
				missingCollections.length,
				"collection",
				"collections",
			)} (${list(missingCollections)}), so the code paths that write to ${plural(
				missingCollections.length,
				"it",
				"them",
			)} cannot run${
				missingEntries.length
					? `; it also does not serve ${missingEntries.length} seeded ${plural(
							missingEntries.length,
							"entry",
							"entries",
						)}`
					: ""
			}`
		: missingEntries.length
			? `the deployed catalogue does not serve ${missingEntries.length} seeded ${plural(
					missingEntries.length,
					"entry",
					"entries",
				)}: ${list(missingEntries)}${specimens}`
			: `${possibilitiesWithoutExamples.length} seeded ${plural(
					possibilitiesWithoutExamples.length,
					"entry has",
					"entries have",
				)} no example: ${list(possibilitiesWithoutExamples)}`;

	return {
		kind: "drifted",
		summary,
		missingEntries,
		extraEntries,
		missingCollections,
		extraCollections,
		possibilitiesWithoutExamples,
		remedy:
			"deliver it additively: `npm run deliver:seed --apply`. Never `emdash seed --on-conflict=update`, which would overwrite editorial changes. See docs/DEPLOY.md",
	};
}

/**
 * Whether the verdict should fail the run.
 *
 * `extra` on either axis is not a failure; see the module note. `unknown` is,
 * for the same reason `unknown` is a failure in `assessFreshness`: an absence of
 * evidence is not a claim, and reporting "cannot tell" as green is the mistake
 * one level up.
 */
export function isParityFailure(kind: ParityVerdict): boolean {
	return kind !== "aligned";
}
