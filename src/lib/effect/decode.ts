/**
 * Decoding untrusted data at a boundary (#62).
 *
 * Two small helpers, because both boundaries need the same two steps and both
 * used to skip the second:
 *
 * 1. get the bytes (an EmDash row, a JSON response body);
 * 2. prove they are the shape this application promised, and fail *by name* if
 *    they are not.
 *
 * Step 2 is the part that matters. A `SchemaError` says which field and what it
 * found, which is what makes a decode failure debuggable; wrapping it in a
 * generic "invalid response" throws that information away. So the wrapper keeps
 * the schema's own message and adds only the subject — which row, which slug —
 * so a log line identifies the record without opening the source.
 */
import { Effect, Schema } from "effect";
import { CatalogueDecodeError, EmDashWriteError } from "./errors.ts";

/** The first line of a `SchemaError`, which is the part that names the field. */
const firstLine = (error: unknown): string =>
	(error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "unknown";

/**
 * Decodes one value against a schema.
 *
 * `Schema.decodeUnknownEffect` rather than `decodeUnknownSync` because a decode
 * that fails here is an ordinary outcome on an untrusted boundary, not a
 * programming error, and it belongs in the error channel where a caller can
 * decide what one bad record means for the page.
 */
export const decodeOr = <S extends Schema.Constraint>(schema: S, subject: string) =>
	Effect.fnUntraced(function* (input: unknown) {
		return yield* Schema.decodeUnknownEffect(schema)(input).pipe(
			Effect.mapError((error) => new CatalogueDecodeError({ subject, detail: firstLine(error) })),
		);
	});

/**
 * Reads a `Response` body as JSON and decodes it.
 *
 * A body that is not JSON at all is the common case when something in front of
 * EmDash answers with an HTML error page, so the failure says which operation
 * was attempted rather than surfacing a `SyntaxError` from `JSON.parse`.
 */
export const decodeResponse = <S extends Schema.Constraint>(schema: S, operation: string) =>
	Effect.fnUntraced(function* (response: Response) {
		const raw = yield* Effect.tryPromise({
			async try() {
				return (await response.json()) as unknown;
			},
			catch: (cause) =>
				new EmDashWriteError({
					operation,
					status: response.status,
					detail: `response body is not JSON: ${
						cause instanceof Error ? cause.message : String(cause)
					}`,
				}),
		});
		return yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
			Effect.mapError(
				(error) =>
					new EmDashWriteError({
						operation,
						status: response.status,
						detail: `unexpected body shape: ${firstLine(error)}`,
					}),
			),
		);
	});
