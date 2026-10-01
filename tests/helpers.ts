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
