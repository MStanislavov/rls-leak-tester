/**
 * Limits of a scenario. They protect the browser: a scenario is attacker-controlled the moment it
 * is shared, and everything in it is rendered, parsed or executed in the visitor's tab.
 */

/** Characters in `schemaSql` and in `seedSql`, each. */
export const MAX_SQL_LENGTH = 200_000;
/** Characters in one `expectedRowsSql`. */
export const MAX_EXPECTED_ROWS_SQL_LENGTH = 10_000;
export const MAX_PERSONAS = 12;
export const MAX_TABLES = 50;
/** One cell per persona x table x operation (four operations). */
export const MAX_EXPECTATIONS = MAX_PERSONAS * MAX_TABLES * 4;
export const MAX_EXPOSED_SCHEMAS = 8;
export const MAX_TITLE_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 2_000;
export const MAX_LABEL_LENGTH = 80;
/** Scenario and persona ids: `[A-Za-z0-9_-]`, at most this long. */
export const MAX_ID_LENGTH = 64;
/** Postgres truncates identifiers to NAMEDATALEN - 1 = 63 bytes; longer names would not match. */
export const MAX_IDENTIFIER_BYTES = 63;
/** Characters of the claims object as JSON. */
export const MAX_CLAIMS_JSON_LENGTH = 4_000;
/** Nesting depth of the claims object. */
export const MAX_CLAIMS_DEPTH = 8;
/** Characters of `tenantClaimPath`. */
export const MAX_CLAIM_PATH_LENGTH = 200;
/** Characters of a whole scenario as JSON text, checked before `JSON.parse`. */
export const MAX_SCENARIO_JSON_LENGTH = 1_000_000;
