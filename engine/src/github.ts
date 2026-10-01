/**
 * Read-only GitHub access.
 *
 * Three rules this module exists to enforce:
 *
 * 1. **Bytes, not execution.** Everything here is an HTTP GET against the API.
 *    Nothing clones, installs or builds. An upstream repository is untrusted
 *    data; treating its `package.json` as an instruction is the failure mode
 *    this project policy names explicitly.
 * 2. **Record what you read.** Every response that ends up in the evidence
 *    carries the URL it came from and the commit it was read at, so a
 *    classification can be re-checked later against a known state.
 * 3. **Be honest about throttling.** A rate-limited response is reported, not
 *    retried silently, because a hunt that quietly searched less than it claims
 *    produces a catalogue that looks complete and is not.
 */

const API = "https://api.github.com";

export interface GitHubOptions {
	token?: string;
	/** Requests per minute. The authenticated limit is 5000/hour. */
	perMinute?: number;
	fetchImpl?: typeof fetch;
}

export class GitHubError extends Error {
	readonly status: number;
	readonly url: string;

	constructor(message: string, status: number, url: string) {
		super(message);
		this.name = "GitHubError";
		this.status = status;
		this.url = url;
	}
}

export interface RepoRef {
	owner: string;
	repo: string;
	/** The commit every piece of evidence for this repository was read at. */
	ref: string;
}

/**
 * Git LFS pointers.
 *
 * A pointer file is ~130 bytes of text that *looks* like a path and *looks* like
 * a small file. Treating one as media produces an evidence record whose hash
 * proves nothing about the asset, which is exactly the failure content
 * addressing is supposed to prevent. Detecting them is three lines.
 */
export function isLfsPointer(bytes: string): boolean {
	return (
		bytes.length < 512 &&
		bytes.includes("version https://git-lfs.github.com/spec/") &&
		/^oid sha256:[0-9a-f]{64}$/m.test(bytes)
	);
}

export interface RepoFile {
	path: string;
	/** Base64 content, exactly as served. */
	content: string;
	sha: string;
	size: number;
	/** The blob URL, recorded as evidence. */
	url: string;
	/** True when the bytes are a Git LFS pointer rather than the asset. */
	lfsPointer?: boolean;
}

export interface SearchHit {
	fullName: string;
	description: string | null;
	stars: number;
	license: { spdxId: string | null; name: string | null } | null;
	topics: string[];
	defaultBranch: string;
	htmlUrl: string;
	updatedAt: string;
	pushedAt: string;
	archived: boolean;
	fork: boolean;
}

/** Paths that are never worth fetching, whatever a hunt is looking for. */
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

export function isWorthReading(path: string, size: number): boolean {
	if (size > 512 * 1024) return false;
	return !SKIP_PATHS.some((re) => re.test(path));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GitHub {
	private readonly token: string | undefined;
	private readonly minInterval: number;
	private readonly doFetch: typeof fetch;
	private lastRequest = 0;
	/** Every call made, so a report can state exactly what was looked at. */
	readonly calls: string[] = [];
	rateLimited = false;

	constructor(options: GitHubOptions = {}) {
		this.token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
		const perMinute = options.perMinute ?? (this.token ? 4000 : 50);
		this.minInterval = 60_000 / perMinute;
		this.doFetch = options.fetchImpl ?? fetch;
	}

	get authenticated(): boolean {
		return Boolean(this.token);
	}

	private async throttle() {
		const wait = this.lastRequest + this.minInterval - Date.now();
		if (wait > 0) await sleep(wait);
		this.lastRequest = Date.now();
	}

	private async get<T>(path: string): Promise<T> {
		await this.throttle();
		const url = path.startsWith("http") ? path : `${API}${path}`;
		this.calls.push(url);
		const res = await this.doFetch(url, {
			headers: {
				accept: "application/vnd.github+json",
				"x-github-api-version": "2022-11-28",
				"user-agent": "asset-hunter-engine",
				...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
			},
		});
		if (res.status === 403 || res.status === 429) {
			const remaining = res.headers.get("x-ratelimit-remaining");
			this.rateLimited = true;
			throw new GitHubError(
				`rate limited (${res.status}, remaining=${remaining ?? "?"}). The hunt read less than it reports.`,
				res.status,
				url,
			);
		}
		if (res.status === 404) throw new GitHubError("not found", 404, url);
		if (!res.ok) throw new GitHubError(`${res.status} ${res.statusText}`, res.status, url);
		return (await res.json()) as T;
	}

	/** One search wave. Pagination is explicit so a brief can bound the crawl. */
	async search(query: string, perPage: number, page = 1): Promise<SearchHit[]> {
		const params = new URLSearchParams({
			q: query,
			per_page: String(Math.min(perPage, 100)),
			page: String(page),
			sort: "stars",
			order: "desc",
		});
		const body = await this.get<{ items?: unknown[] }>(`/search/repositories?${params}`);
		return (body.items ?? []).map((item) => {
			const r = item as Record<string, never>;
			return {
				fullName: String(r.full_name),
				description: (r.description as string) ?? null,
				stars: Number(r.stargazers_count ?? 0),
				license: r.license
					? {
							spdxId: (r.license as Record<string, unknown>).spdx_id
								? String((r.license as Record<string, unknown>).spdx_id)
								: null,
							name: (r.license as Record<string, unknown>).name
								? String((r.license as Record<string, unknown>).name)
								: null,
						}
					: null,
				topics: Array.isArray(r.topics) ? (r.topics as string[]) : [],
				defaultBranch: String(r.default_branch ?? "main"),
				htmlUrl: String(r.html_url),
				updatedAt: String(r.updated_at ?? ""),
				pushedAt: String(r.pushed_at ?? ""),
				archived: Boolean(r.archived),
				fork: Boolean(r.fork),
			};
		});
	}

	/**
	 * Resolves a repository to a commit SHA. Every later read is pinned to it,
	 * so the evidence for one hunt is internally consistent even if the default
	 * branch moves mid-crawl.
	 */
	async resolve(fullName: string): Promise<RepoRef> {
		const [owner, repo] = fullName.split("/");
		if (!owner || !repo) throw new GitHubError(`"${fullName}" is not owner/repo`, 400, fullName);
		const body = await this.get<{ default_branch?: string; pushed_at?: string }>(
			`/repos/${owner}/${repo}`,
		);
		const branch = body.default_branch ?? "main";
		// `/commits/{ref}` returns `sha` at the top level; `/git/ref/{ref}` returns
		// it under `object`. Reading the wrong one made every candidate record a
		// branch name as its "commit", which is provenance that proves nothing.
		const ref = await this.get<{ sha?: string; object?: { sha?: string } }>(
			`/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
		);
		const sha = ref.sha ?? ref.object?.sha;
		if (!sha) throw new GitHubError(`could not resolve ${fullName}@${branch} to a commit`, 502, fullName);
		return { owner, repo, ref: sha };
	}

	/** The file tree at a commit, flattened and truncated to what a hunt can use. */
	async tree(ref: RepoRef, maxEntries = 4000): Promise<{ path: string; size: number; sha: string }[]> {
		const body = await this.get<{ tree?: { path?: string; size?: number; sha?: string; type?: string }[] }>(
			`/repos/${ref.owner}/${ref.repo}/git/trees/${ref.ref}?recursive=1`,
		);
		return (body.tree ?? [])
			.filter((n) => n.type === "blob" && n.path && n.sha)
			.map((n) => ({ path: String(n.path), size: Number(n.size ?? 0), sha: String(n.sha) }))
			.slice(0, maxEntries);
	}

	/**
	 * File bytes at a commit. Returns null rather than throwing for a path that
	 * is not there: a hunt asking for every candidate licence should find out
	 * that one is missing, not that the crawl died.
	 */
	async file(ref: RepoRef, path: string): Promise<RepoFile | null> {
		try {
			const body = await this.get<{ content?: string; sha?: string; size?: number; url?: string }>(
				`/repos/${ref.owner}/${ref.repo}/contents/${path
					.split("/")
					.map(encodeURIComponent)
					.join("/")}?ref=${ref.ref}`,
			);
			if (!body.content) return null;
			const content = body.content.replace(/\n/g, "");
			return {
				path,
				content,
				sha: String(body.sha ?? ""),
				size: Number(body.size ?? 0),
				url: String(body.url ?? ""),
				lfsPointer: isLfsPointer(decodeBase64(content)),
			};
		} catch (err) {
			if (err instanceof GitHubError && err.status === 404) return null;
			throw err;
		}
	}
}

export const decodeBase64 = (value: string): string =>
	Buffer.from(value, "base64").toString("utf8");
