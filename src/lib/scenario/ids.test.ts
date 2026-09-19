import { describe, expect, it } from "vitest";

import {
  ID_PATTERN,
  createScenarioId,
  isValidId,
  newScenarioId,
  randomIdSuffix,
  slugify,
  type FillRandom,
} from "./ids";
import { MAX_ID_LENGTH } from "./limits";

const counting: FillRandom = (bytes) => {
  bytes.forEach((_, index) => {
    bytes[index] = index * 37 + 5;
  });
  return bytes;
};

describe("slugify", () => {
  it.each([
    ["Multi-tenant SaaS", "multi-tenant-saas"],
    ["  Todos   with sharing!  ", "todos-with-sharing"],
    ["Crème brûlée & Ünïcode", "creme-brulee-unicode"],
    ["a__b--c", "a-b-c"],
    ["---", "scenario"],
    ["", "scenario"],
    ["日本語", "scenario"],
    ["RLS001: leak #2", "rls001-leak-2"],
  ])("turns %j into %s", (text, expected) => {
    expect(slugify(text)).toBe(expected);
  });

  it("cuts to the maximum length without leaving a hyphen at the end", () => {
    expect(slugify("hello world again", 6)).toBe("hello");
    expect(slugify("hello world again", 8)).toBe("hello-wo");
    expect(slugify("x".repeat(200))).toHaveLength(MAX_ID_LENGTH);
    expect(slugify("", 3)).toBe("sce");
    expect(slugify("abc", 0)).toBe("a");
  });

  it("always gives a valid id", () => {
    for (const text of ["", "-", "A B", "ü".repeat(300), "a".repeat(300), "_x_"]) {
      expect(isValidId(slugify(text)), text).toBe(true);
    }
  });
});

describe("isValidId", () => {
  it("accepts letters, digits, hyphen and underscore", () => {
    expect(isValidId("saas-leaky_v2")).toBe(true);
    expect(isValidId("A")).toBe(true);
    expect(isValidId("x".repeat(MAX_ID_LENGTH))).toBe(true);
  });

  it.each([
    [""],
    ["-a"],
    ["_a"],
    ["a b"],
    ["a/b"],
    ["a.b"],
    ["ü"],
    ["x".repeat(MAX_ID_LENGTH + 1)],
  ])("refuses %j", (value) => {
    expect(isValidId(value)).toBe(false);
  });

  it("shares its pattern with the schema", () => {
    expect(ID_PATTERN.test("ok-id")).toBe(true);
    expect(ID_PATTERN.flags).toBe("");
  });
});

describe("createScenarioId", () => {
  it("joins the slug of the title and the suffix", () => {
    expect(createScenarioId("Team workspace", "k3x9")).toBe("team-workspace-k3x9");
  });

  it("is a pure function of its inputs", () => {
    expect(createScenarioId("Same", "abc")).toBe(createScenarioId("Same", "abc"));
  });

  it("stays within the id limits for any input", () => {
    const id = createScenarioId("t".repeat(500), "S U F F I X ".repeat(20));
    expect(id.length).toBeLessThanOrEqual(MAX_ID_LENGTH);
    expect(isValidId(id)).toBe(true);
    expect(isValidId(createScenarioId("", ""))).toBe(true);
  });
});

describe("randomIdSuffix and newScenarioId", () => {
  it("maps random bytes to the alphabet, five bits each", () => {
    // Bytes 5, 42, 79, 116: the low five bits are 5, 10, 15, 20.
    expect(randomIdSuffix(4, counting)).toBe("fkpu");
    expect(randomIdSuffix(3, (bytes) => bytes.fill(255))).toBe("777");
    expect(randomIdSuffix(3, (bytes) => bytes.fill(0))).toBe("aaa");
  });

  it("clamps the length", () => {
    expect(randomIdSuffix(0, counting)).toHaveLength(1);
    expect(randomIdSuffix(1000, counting)).toHaveLength(MAX_ID_LENGTH / 2);
  });

  it("uses the platform's crypto by default", () => {
    const first = randomIdSuffix();
    expect(first).toMatch(/^[a-z2-7]{10}$/);
    expect(new Set([first, randomIdSuffix(), randomIdSuffix()]).size).toBeGreaterThan(1);
  });

  it("builds a valid id, deterministic for a given random source", () => {
    const id = newScenarioId("Multi-tenant SaaS", counting);
    expect(id).toBe(newScenarioId("Multi-tenant SaaS", counting));
    expect(id).toMatch(/^multi-tenant-saas-[a-z2-7]{10}$/);
    expect(isValidId(newScenarioId("x".repeat(300)))).toBe(true);
  });
});
