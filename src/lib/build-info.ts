/**
 * Which commit is this build, recorded at build time and readable at runtime.
 *
 * Issue #81 found the deployed site serving code from three commits behind
 * `main`, and the reason nobody noticed is that nothing in the product said
 * what it was. Nine accessibility defects were live at `assets.loftwah.com` —
 * 195 controls under the tap floor — while `main` had already fixed every one of
 * them, for several commits. Anyone judging the product by its public URL was
 * judging code from before the work.
 *
 * So the build states its own commit, in three places:
 *
 * - `<meta name="asset-hunter:commit">` on every page, so a reader can check it
 *   from view-source;
 * - `GET /version.json`, so a script can check it without parsing HTML;
 * - the footer, in text a person can see rather than one they have to fetch.
 *
 * The value is injected by `astro.config.mjs` at config-load time, which is
 * before the bundle is written. `ASSET_HUNTER_COMMIT` overrides it, so a release
 * build can pin a tag instead of whatever `HEAD` happened to be.
 *
 * ## `dirty` is not decoration
 *
 * `git rev-parse HEAD` names a commit, not a working tree. A build with
 * uncommitted changes carries the commit id of code that is not the code being
 * shipped, which is precisely the failure this module exists to prevent — so
 * the tree is checked and the fact is published. `null` means "this is exactly
 * commit X"; `true` means "commit X plus changes nobody can name"; `null` for
 * `commit` itself means the answer is unknown and no claim is made.
 *
 * `unknown` is a first-class value rather than an error. A build from a source
 * tarball, a CI export, or a Docker image with no `.git` still has to serve, and
 * "I do not know" is a truthful answer. It is not silently replaced by the
 * package version, which would look like evidence.
 */

export interface BuildInfo {
	/** The commit this build came from, or `null` when it could not be determined. */
	readonly commit: string | null;
	/** True when the tree had uncommitted changes; `null` when unknowable. */
	readonly dirty: boolean | null;
	/** When the bundle was written, ISO 8601, or `null` if the environment did not say. */
	readonly builtAt: string | null;
	/** Why `commit` is null, when it is. Never null when `commit` is not. */
	readonly reason: string | null;
}

/** A short, non-empty, lowercase-hex-or-nothing validation of a claimed commit. */
export function isCommitish(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{7,40}$/.test(value);
}

/** A build made with no git available, which is a real build and says so. */
export const UNKNOWN_BUILD: BuildInfo = {
	commit: null,
	dirty: null,
	builtAt: null,
	reason: "no git metadata was available when this build ran",
};

/**
 * Reads the injected globals, defensively.
 *
 * Every one of these can be absent: a test importing this module directly, a
 * build from a tarball, a bundler that dropped an unused define. A missing
 * constant must produce an unknown build, never a crash and never a guess.
 */
export function readBuildInfo(env: BuildEnv = {} as BuildEnv): BuildInfo {
	const builtAt = readTimestamp(env.ASSET_HUNTER_BUILT_AT);
	const commit = env.ASSET_HUNTER_COMMIT;
	if (!isCommitish(commit)) {
		return { ...UNKNOWN_BUILD, builtAt };
	}
	// `true`/`false` arrive as strings through `define`. Anything else — absent,
	// "unknown", a boolean the bundler stringified oddly — is recorded as unknown
	// rather than guessed at, because "clean" is the claim that matters most.
	const dirtyRaw = env.ASSET_HUNTER_DIRTY;
	const dirty: boolean | null = dirtyRaw === "true" ? true : dirtyRaw === "false" ? false : null;

	return { commit, dirty, builtAt, reason: null };
}

/**
 * The build this bundle is, read from the constants `astro.config.mjs`
 * injected.
 *
 * The keys are written out literally because that is the only form a bundler can
 * replace — `env[key]` and `import.meta.env[key]` are both left alone, and a
 * dynamic lookup that silently resolves to `undefined` is how a version stamp
 * ends up claiming nothing. `readBuildInfo` above takes a record so a test can
 * drive every branch without running a build.
 */
export function buildInfo(): BuildInfo {
	return readBuildInfo({
		ASSET_HUNTER_COMMIT: import.meta.env.ASSET_HUNTER_COMMIT,
		ASSET_HUNTER_DIRTY: import.meta.env.ASSET_HUNTER_DIRTY,
		ASSET_HUNTER_BUILT_AT: import.meta.env.ASSET_HUNTER_BUILT_AT,
	} as BuildEnv);
}

/** The shape `readBuildInfo` accepts. Every key is optional and may be absent. */
export interface BuildEnv {
	readonly ASSET_HUNTER_COMMIT?: unknown;
	readonly ASSET_HUNTER_DIRTY?: unknown;
	readonly ASSET_HUNTER_BUILT_AT?: unknown;
}

/**
 * An ISO-8601 date-time with an explicit time component.
 *
 * Deliberately stricter than `new Date(value)`, which accepts a great deal it
 * should not. `"0"` parses as `1999-12-31T13:00:00.000Z` — a real date, 27 years
 * before the build — so a stray `ASSET_HUNTER_BUILT_AT=0` would print "built 27
 * years ago" on every page of a live site and look entirely plausible. `"1"`
 * gives 2001, `""` gives the epoch, and `"12"` gives 2001-12-01. The parser is
 * not the guard; the shape is.
 */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function readTimestamp(value: unknown): string | null {
	if (typeof value !== "string" || !ISO_DATE_TIME.test(value)) return null;
	const parsed = new Date(value);
	// The shape can match and still be out of range — `2026-13-45T00:00:00Z` is
	// syntactically fine and semantically impossible — so both are checked.
	if (Number.isNaN(parsed.getTime())) return null;
	return parsed.toISOString();
}

/**
 * One sentence for a person, and never more than the evidence supports.
 *
 * "Asset Hunter · deployed 2 hours ago" is a claim about a deployment. What is
 * actually known is a build time, so that is what is said — with no
 * manufactured precision and no "live" or "healthy", which are properties of a
 * system rather than of a file.
 */
export function buildSentence(info: BuildInfo, now: Date = new Date()): string {
	if (info.commit === null) {
		return info.dirty === true
			? "Asset Hunter · built from an uncommitted tree"
			: "Asset Hunter · build provenance unknown";
	}
	const short = info.commit.slice(0, 7);
	if (info.dirty === true) return `Asset Hunter · ${short} plus uncommitted changes`;
	if (info.builtAt === null) return `Asset Hunter · ${short}`;
	return `Asset Hunter · ${short} · built ${humanAge(info.builtAt, now)}`;
}

/**
 * A coarse age, because a precise one is a false precision.
 *
 * "just now", "14 minutes ago", "3 hours ago", "6 days ago". Beyond a month the
 * month itself is more useful than a day count nobody will convert.
 */
export function humanAge(iso: string, now: Date = new Date()): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "at an unknown time";
	const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
	if (seconds < 45) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	const days = Math.round(hours / 24);
	if (days < 31) return `${days} day${days === 1 ? "" : "s"} ago`;
	const months = Math.round(days / 30.44);
	return `${months} month${months === 1 ? "" : "s"} ago`;
}
