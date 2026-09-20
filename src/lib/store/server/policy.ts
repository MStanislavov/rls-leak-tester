/**
 * The numbers of the Supabase store. They are `thresholds.store` in rules.yaml;
 * `tests/store/policy.test.ts` fails when this file, rules.yaml or the check constraints of
 * `supabase/migrations` drift apart. Changing one means changing rules.yaml and writing an ADR.
 */

/** Bytes of a `POST` or `PATCH` body. Counted while reading; more is never buffered. */
export const SCENARIO_BODY_MAX_BYTES = 1_048_576;

/**
 * Bytes of `payload::text` the database accepts (`scenarios_payload_size`). Larger than the body
 * cap because the text form of jsonb puts a space after every ':' and ','.
 */
export const SCENARIO_PAYLOAD_DB_MAX_BYTES = 1_572_864;

/** Rows `GET /api/scenarios` returns at most, newest first. */
export const LIST_MAX_ROWS = 200;

/** Characters of `[a-z2-7]` at the end of a slug: 5 random bits each, 80 in all. */
export const SLUG_SUFFIX_LENGTH = 16;

/** Inserts tried with a fresh slug before a unique violation is reported. */
export const SLUG_MAX_ATTEMPTS = 5;

/** Seconds a client is asked to wait when Supabase or the limiter is down. */
export const UNAVAILABLE_RETRY_AFTER_SECONDS = 30;
