import { describe, expect, it } from "vitest";
import { TEMPLATES } from "@/lib/scenario/templates";
import { defaultLabEntry, labEntryQuery, parseLabSearchParams } from "./search-params";

const FIRST = TEMPLATES[0]?.id ?? "";

describe("parseLabSearchParams", () => {
  it("opens the first template, leaky, without parameters", () => {
    expect(parseLabSearchParams({})).toEqual({
      kind: "template",
      templateId: FIRST,
      variant: "leaky",
    });
    expect(parseLabSearchParams(undefined)).toEqual(defaultLabEntry());
    expect(parseLabSearchParams(null)).toEqual(defaultLabEntry());
  });

  it("reads a template and its variant", () => {
    expect(parseLabSearchParams({ template: "team-workspace", variant: "fixed" })).toEqual({
      kind: "template",
      templateId: "team-workspace",
      variant: "fixed",
    });
  });

  it("falls back to leaky for an unknown or missing variant", () => {
    expect(parseLabSearchParams({ template: "todos-sharing", variant: "broken" })).toEqual({
      kind: "template",
      templateId: "todos-sharing",
      variant: "leaky",
    });
    expect(parseLabSearchParams({ template: "todos-sharing" })).toMatchObject({
      variant: "leaky",
    });
  });

  it("takes the first value of a repeated parameter", () => {
    expect(
      parseLabSearchParams({ template: ["team-workspace", "todos-sharing"], variant: ["fixed"] }),
    ).toEqual({ kind: "template", templateId: "team-workspace", variant: "fixed" });
  });

  it("opens a blank scenario", () => {
    expect(parseLabSearchParams({ template: "blank" })).toEqual({ kind: "blank" });
  });

  it("opens a saved scenario by a well-formed id only", () => {
    expect(parseLabSearchParams({ saved: "abc-123_x" })).toEqual({
      kind: "saved",
      storeId: "abc-123_x",
    });
    expect(parseLabSearchParams({ saved: "../etc/passwd" })).toEqual(defaultLabEntry());
    expect(parseLabSearchParams({ saved: "" })).toEqual(defaultLabEntry());
  });

  it("never throws on hostile input", () => {
    expect(parseLabSearchParams({ template: "<script>alert(1)</script>" })).toEqual(
      defaultLabEntry(),
    );
    expect(parseLabSearchParams({ template: "x".repeat(10_000) })).toEqual(defaultLabEntry());
    expect(parseLabSearchParams("template=blank")).toEqual(defaultLabEntry());
    expect(parseLabSearchParams({ template: 42 })).toEqual(defaultLabEntry());
  });

  it("prefers the template over a saved id", () => {
    expect(parseLabSearchParams({ template: "team-workspace", saved: "abc" })).toMatchObject({
      kind: "template",
    });
  });
});

describe("labEntryQuery", () => {
  it("round-trips every entry", () => {
    const entries = [
      { kind: "template", templateId: "team-workspace", variant: "fixed" },
      { kind: "blank" },
      { kind: "saved", storeId: "abc-1" },
    ] as const;
    for (const entry of entries) {
      const query = Object.fromEntries(new URLSearchParams(labEntryQuery(entry)));
      expect(parseLabSearchParams(query)).toEqual(entry);
    }
  });
});
