/**
 * Shared helpers for the test suite.
 */
import { MEDIA_LABEL } from "../src/lib/vocabulary.ts";

export {
	ORIGIN_MEANING,
	ORIGIN_LABEL,
	RIGHTS_LABEL,
	RIGHTS_MEANING,
} from "../src/lib/vocabulary.ts";

/**
 * Returns the display label for a media kind, or null when there is nothing to
 * show. An empty string would render an empty pill on a tile.
 */
export function mediaLabelGuard(kind: string | null | undefined): string | null {
	if (!kind) return null;
	return MEDIA_LABEL[kind] ?? kind;
}

/**
 * Headers a browser puts on a same-origin form post (#53).
 *
 * `/api/board` and `/api/signal` now make their own `sameOrigin` check, and it
 * refuses a request that carries **no** browser provenance at all — which a Node
 * `fetch()` does not. That refusal is the control, so these tests cannot reach the
 * behaviour they are about without it.
 *
 * So every POST test sends what a browser sends. The assertions are unchanged: a
 * test that was about an open redirect is still about an open redirect, and the
 * refusal itself is asserted separately in `tests/security.test.ts` (`a request
 * with no browser provenance at all is refused`), so nothing is traded away —
 * it is asserted on the other side of the same change, against the same rule.
 */
export const SAME_ORIGIN_POST: Readonly<Record<string, string>> = {
	"sec-fetch-site": "same-origin",
	origin: "http://localhost:4321",
};
