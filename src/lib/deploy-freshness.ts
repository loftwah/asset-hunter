/**
 * Is the deployed site the code this branch claims? The verdict, as a pure
 * function. (#81)
 *
 * Issue #81 found `assets.loftwah.com` serving code from three commits behind
 * `main`, with nine accessibility defects live in production and every one of
 * them already fixed on `main`. Nobody noticed, because nothing the product
 * served said what it was. Discovering it required auditing the live site, which
 * is the most expensive possible way to find out — so the answer lives here, as
 * something testable, and `scripts/check-deploy-freshness.mjs` only does the I/O.
 *
 * ## The four verdicts, and why "unknown" is one of them
 *
 * - `current` — the deployed commit is the expected one. Nothing to do.
 * - `behind` — the deployed commit is an ancestor of the expected one. The site
 *   is missing merged work, including fixes. This is the #81 case.
 * - `diverged` — neither is an ancestor of the other. Someone deployed from a
 *   branch, or a rebase rewrote history under a live site, or a force-push.
 *   **Worse than `behind`**: the next deploy silently replaces whatever is there
 *   with something unrelated and nothing records what it was.
 * - `unknown` — the answer cannot be established. The build cannot name its
 *   commit, the commit is not in this repository, or a history query failed.
 *
 * `unknown` is a failure, not a pass. Reporting "cannot tell" as green is the
 * same mistake one level up: it converts an absence of evidence into a claim.
 * The caller may choose to allow it explicitly; this function will not choose it.
 *
 * ## Why `ancestor` is injected
 *
 * The real question is `git merge-base --is-ancestor`, which needs a repository.
 * Passing the answer in rather than shelling out keeps every verdict reachable
 * from a test — including the ones that are awkward to produce on purpose, like a
 * commit that is genuinely not in this clone.
 */

/** What we know about the deployed build, from `/api/version.json`. */
export interface DeployedReport {
	/** The commit the build came from, or `null` when it cannot say. */
	readonly commit: string | null;
	/** True when that build's tree had uncommitted changes. */
	readonly dirty: boolean | null;
	/** When the bundle was written, ISO 8601, or `null`. */
	readonly builtAt: string | null;
	/** True when the endpoint answered at all. False means a build from before it existed. */
	readonly reachable: boolean;
}

export type Freshness = "current" | "behind" | "diverged" | "unknown";

export interface Verdict {
	readonly kind: Freshness;
	/** One line for a person. Never mentions "live", "healthy" or "current" — those are properties of a system, not of a sha. */
	readonly summary: string;
	/** What to do next, or `null` when there is nothing to do. */
	readonly remedy: string | null;
	/**
	 * True when this is a dirty *deployed* build.
	 *
	 * Separate from `kind` because it is orthogonal: a deploy can be current,
	 * behind, or diverged *and* have been built from a tree nobody can name. It
	 * is always worth saying, because the sha in that case does not identify the
	 * shipped code.
	 */
	readonly deployedDirty: boolean;
}

/** The questions this function cannot answer for itself. */
export interface HistoryOracle {
	/** True when `older` is an ancestor of `newer`; false when it is not; null when git could not tell. */
	isAncestor(older: string, newer: string): boolean | null;
	/** True when this repository has the commit at all. */
	has(commit: string): boolean;
}

function short(sha: string): string {
	return sha.slice(0, 7);
}

/**
 * Decide, from the evidence available.
 *
 * @param deployed What `/api/version.json` reported.
 * @param expected The commit this branch says should be live — `HEAD` normally.
 * @param history The repository questions. Injected; see {@link HistoryOracle}.
 */
export function assessFreshness(
	deployed: DeployedReport,
	expected: string,
	history: HistoryOracle,
): Verdict {
	const deployedDirty = deployed.dirty === true;

	// The build cannot be asked, or the endpoint is not there. Both are the same
	// failure from here: there is no evidence, and this function does not invent
	// any. The two are worded differently because the remedies differ — one needs
	// a redeploy, the other needs nothing.
	if (!deployed.reachable) {
		return {
			kind: "unknown",
			summary: "the deployed site has no /api/version.json, so it cannot say which commit it serves",
			remedy:
				"Deploy a build that includes src/lib/build-info.ts. Until then, freshness is unverifiable rather than fine.",
			deployedDirty,
		};
	}
	if (deployed.commit === null) {
		return {
			kind: "unknown",
			summary: "the deployed build cannot name its commit, so freshness cannot be verified",
			remedy:
				"The build was made without git metadata — a tarball, an export, a container image. " +
				"Set ASSET_HUNTER_COMMIT at build time, or build from a checkout.",
			deployedDirty,
		};
	}
	if (!expected) {
		return {
			kind: "unknown",
			summary: "no expected commit to compare against",
			remedy: "Run this from inside the repository, or pass --expect <sha>.",
			deployedDirty,
		};
	}

	if (deployed.commit === expected) {
		return {
			kind: "current",
			summary: `production is exactly ${short(expected)}`,
			remedy: null,
			deployedDirty,
		};
	}

	if (!history.has(deployed.commit)) {
		return {
			kind: "diverged",
			summary: `${short(deployed.commit)} is not in this repository — the deployed code came from somewhere else`,
			remedy:
				"A branch that was deleted, a rebase, or a different machine's clone. " +
				"Deploying now replaces it with something unrelated and records nothing.",
			deployedDirty,
		};
	}

	const deployedIsOlder = history.isAncestor(deployed.commit, expected);
	if (deployedIsOlder === true) {
		return {
			kind: "behind",
			summary: `production is behind ${short(expected)} — everything merged since ${short(deployed.commit)} is missing in production`,
			remedy: "npm run deploy && npm run deploy:check",
			deployedDirty,
		};
	}

	const expectedIsOlder = history.isAncestor(expected, deployed.commit);
	if (expectedIsOlder === true) {
		return {
			kind: "diverged",
			summary: `production is ahead of ${short(expected)} — it has commits this branch does not`,
			remedy: "Deploying now removes them without a record. Find out what they are first.",
			deployedDirty,
		};
	}
	if (deployedIsOlder === null || expectedIsOlder === null) {
		// Git could not answer — a shallow clone, most often. Saying "diverged"
		// here would be a guess with a scary remedy attached.
		return {
			kind: "unknown",
			summary: `git could not relate ${short(deployed.commit)} to ${short(expected)} — the clone is probably shallow`,
			remedy: "Fetch enough history to compare, then re-run: git fetch --unshallow",
			deployedDirty,
		};
	}

	return {
		kind: "diverged",
		summary: `production (${short(deployed.commit)}) and ${short(expected)} have diverged — neither is an ancestor of the other`,
		remedy:
			"A rebase, a force-push, or a deploy from a different branch. " +
			"The next deploy replaces whatever is live with something unrelated.",
		deployedDirty,
	};
}

/** Whether a verdict should fail a gate. `current` is the only pass. */
export function isFailure(verdict: Verdict): boolean {
	return verdict.kind !== "current";
}

/**
 * Warnings that belong with the verdict rather than inside it.
 *
 * A deployed build from a dirty tree is a problem whatever the commit
 * comparison says, because the sha does not identify the shipped code. It is
 * separated so a `current` verdict can still carry it — a deploy can be
 * up-to-date and unverifiable at the same time.
 */
export function provenanceWarnings(deployed: DeployedReport): string[] {
	const warnings: string[] = [];
	if (deployed.dirty === true) {
		warnings.push(
			"the deployed build was made from a tree with uncommitted changes — its sha is not the shipped code",
		);
	}
	if (deployed.commit !== null && deployed.dirty === null) {
		warnings.push("the deployed build could not say whether its tree was clean");
	}
	return warnings;
}
