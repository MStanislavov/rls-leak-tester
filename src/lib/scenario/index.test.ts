import { describe, expect, it } from "vitest";

import * as scenario from "./index";

describe("@/lib/scenario public API", () => {
  it("exports exactly the agreed names", () => {
    expect(Object.keys(scenario).sort()).toEqual(
      [
        "DEFAULT_EXPOSED_SCHEMAS",
        "DEFAULT_SUPABASE_GRANTS",
        "ID_PATTERN",
        "MAX_CLAIMS_DEPTH",
        "MAX_CLAIMS_JSON_LENGTH",
        "MAX_CLAIM_PATH_LENGTH",
        "MAX_DESCRIPTION_LENGTH",
        "MAX_EXPECTATIONS",
        "MAX_EXPECTED_ROWS_SQL_LENGTH",
        "MAX_EXPOSED_SCHEMAS",
        "MAX_IDENTIFIER_BYTES",
        "MAX_ID_LENGTH",
        "MAX_LABEL_LENGTH",
        "MAX_PERSONAS",
        "MAX_SCENARIO_JSON_LENGTH",
        "MAX_SQL_LENGTH",
        "MAX_TABLES",
        "MAX_TITLE_LENGTH",
        "MODES",
        "OPERATIONS",
        "OWNER_COLUMN_NAMES",
        "SCENARIO_MIGRATIONS",
        "SCENARIO_VERSION",
        "SCOPES",
        "SUPABASE_GRANT_REGIMES",
        "SUPABASE_ROLES",
        "TENANT_COLUMN_NAMES",
        "canonicalScenario",
        "compareText",
        "createScenarioId",
        "defaultScope",
        "expectationSchema",
        "findOrphanExpectations",
        "formatIssuePath",
        "getClaimPath",
        "isUuid",
        "isValidId",
        "migrateScenario",
        "modeSchema",
        "newScenarioId",
        "offsetToPosition",
        "operationSchema",
        "parseScenario",
        "parseScenarioJson",
        "personaSchema",
        "personaSub",
        "personaTenant",
        "qualifiedName",
        "quoteIdent",
        "quoteLiteral",
        "randomIdSuffix",
        "resolveExpectations",
        "resolveOptions",
        "resolveTableConfigs",
        "scenarioOptionsSchema",
        "scenarioSchema",
        "scopeSchema",
        "serializeScenario",
        "slugify",
        "splitSqlStatements",
        "stableStringify",
        "suggestTableConfig",
        "tableConfigSchema",
      ].sort(),
    );
  });

  it("pins the contract constants", () => {
    expect(scenario.SCENARIO_VERSION).toBe(1);
    expect(scenario.MODES).toEqual(["supabase", "postgres"]);
    expect(scenario.OPERATIONS).toEqual(["select", "insert", "update", "delete"]);
    expect(scenario.SCOPES).toEqual(["none", "own", "tenant", "all", "custom"]);
    expect(scenario.SUPABASE_GRANT_REGIMES).toEqual(["legacy", "explicit"]);
    expect(scenario.SUPABASE_ROLES).toEqual(["anon", "authenticated", "service_role"]);
    expect(scenario.DEFAULT_EXPOSED_SCHEMAS).toEqual(["public"]);
    expect(scenario.DEFAULT_SUPABASE_GRANTS).toBe("legacy");
    expect(scenario.MAX_EXPECTATIONS).toBe(scenario.MAX_PERSONAS * scenario.MAX_TABLES * 4);
  });
});
