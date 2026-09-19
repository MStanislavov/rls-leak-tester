import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseServerEnv, PUBLIC_ENV_KEYS, SERVER_ENV_KEYS } from "./env";

/** Set by Next.js or by Vercel, never by hand, so .env.example does not list them. */
const PLATFORM_KEYS = ["NODE_ENV", "VERCEL_ENV", "VERCEL_GIT_COMMIT_SHA"];

const lines = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8").split("\n");
const assignments = lines.filter((line) => line.trim() !== "" && !line.startsWith("#"));

describe(".env.example", () => {
  it("lists exactly the variables the schema knows, platform variables aside", () => {
    const documented = assignments.map((line) => line.split("=")[0]).sort();
    const known = [...PUBLIC_ENV_KEYS, ...SERVER_ENV_KEYS]
      .filter((key) => !PLATFORM_KEYS.includes(key))
      .sort();
    expect(documented).toEqual(known);
  });

  it("leaves every value empty", () => {
    for (const line of assignments) {
      expect(line).toMatch(/^[A-Z][A-Z0-9_]*=$/);
    }
  });

  it("explains every variable with a one-line comment directly above it", () => {
    for (const line of assignments) {
      const index = lines.indexOf(line);
      expect(lines[index - 1], `comment above ${line}`).toMatch(/^# \S/);
      expect(lines[index - 2] ?? "", `single comment line above ${line}`).not.toMatch(/^#/);
    }
  });

  it("parses to the zero-configuration defaults when copied unchanged", () => {
    const env = Object.fromEntries(assignments.map((line) => [line.split("=")[0], ""]));
    expect(parseServerEnv(env)).toEqual(parseServerEnv({}));
  });
});
