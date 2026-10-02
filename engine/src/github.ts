/**
 * The engine's GitHub *rules*, with no client in them (#62).
 *
 * What is left here after #62 is the part that was never effectful: two
 * predicates over bytes and paths, and the base64 decode. They are pure,
 * synchronous, and `tests/engine.test.ts` exercises them directly — which is
 * exactly the case the house style says should not be wrapped in an Effect.
 *
 * The client itself moved to `./runtime/github.ts`, where it is a
 * `Context.Service` with a `Layer`, typed failures, retry, timeout, cancellation
 * and a scoped call log. `GitHubError` is re-exported from there so a caller
 * that wants to match on a rate limit has one name for it.
 *
 * The four rules the module still enforces:
 *
 * 1. **Bytes, not execution.** Nothing here clones, installs or builds. An
 *    upstream repository is untrusted data; treating its `package.json` as an
 *    instruction is the failure mode the project policy names explicitly.
 * 2. **Record what you read.** The live client records every URL it read; see
 *    `GitHubApi.calls`.
 * 3. **Be honest about throttling.** A rate-limited response is a typed failure
 *    with `rateLimited: true` and is never retried, because a hunt that quietly
 *    searched less than it claims produces a catalogue that looks complete and
 *    is not.
 * 4. **Never treat a pointer as an asset.** {@link isLfsPointer} is the reason
 *    this file still exists at all.
 */
export { GitHubError, isLfsPointer, decodeBase64 } from "./runtime/github.ts";
export type { RepoFile, RepoRef, SearchHit, TreeNode } from "./runtime/github.ts";

/**
 * Paths that are never worth fetching, whatever a hunt is looking for.
 *
 * A lockfile is the clearest case: it is large, it is generated, and it says
 * nothing about the technique a repository demonstrates.
 */
const SKIP_PATHS = [
	/^node_modules\//,
	/^\.git\//,
	/^vendor\//,
	/^dist\//,
	/^\.next\//,
	/^target\//,
	/^__pycache__\//,
	/\.min\.(js|css)$/,
	/\.map$/,
	/\.lock$/,
	/^package-lock\.json$/,
	/^pnpm-lock\.yaml$/,
	/^yarn\.lock$/,
	/^Cargo\.lock$/,
];

/**
 * Whether a path is worth spending a request on.
 *
 * The size bound is what keeps a hunt inside its byte budget before it reads
 * anything: a 4MB video in a repository of 4000 files is a fact discoverable
 * from the tree, and finding it out by downloading is how a budget disappears.
 */
export function isWorthReading(path: string, size: number): boolean {
	if (size > 512 * 1024) return false;
	return !SKIP_PATHS.some((re) => re.test(path));
}
