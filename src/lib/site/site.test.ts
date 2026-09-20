import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { STATIC_CHECK_RULES } from "@/lib/checks";
import { CELL_STATUSES, VERDICTS } from "@/lib/runner";
import { TEMPLATES } from "@/lib/scenario/templates";
import { generateNonce } from "@/lib/security/csp";

import {
  DOCS_SECTIONS,
  EXPLAIN_PAYLOAD_MAX_KIB,
  PROBE_TIMEOUT_SECONDS,
  RUN_CEILING_SECONDS,
  docsSectionHref,
  staticCheckAnchor,
  staticCheckDocsHref,
} from "./docs";
import { NAV_ITEMS, REPO_URL, SITE_DESCRIPTION, isActivePath } from "./links";
import { parseNonce } from "./nonce";
import { STATUS_META, VERDICT_META, statusMeta, verdictMeta } from "./status";
import { labTemplateHref, templateCards } from "./templates";

describe("parseNonce", () => {
  it("accepts what generateNonce produces", () => {
    const nonce = generateNonce();
    expect(parseNonce(nonce)).toBe(nonce);
  });

  it.each([
    ["a missing header", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["a short value", "abc"],
    ["an attribute break-out", 'AAAAAAAAAAAAAAAAAAAAAA==" onload="x'],
    ["whitespace", "AAAAAAAAAAAA AAAAAAAAAA=="],
    ["an oversized value", "A".repeat(200)],
  ])("rejects %s", (_name, value) => {
    expect(parseNonce(value)).toBeUndefined();
  });
});

describe("status and verdict words", () => {
  it("covers every cell status of the runner, in the runner's order", () => {
    expect(STATUS_META.map((meta) => meta.status)).toEqual([...CELL_STATUSES]);
  });

  it("gives every status its own word", () => {
    const labels = STATUS_META.map((meta) => meta.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const meta of STATUS_META) {
      expect(meta.label.toLowerCase()).toBe(meta.status);
      expect(meta.meaning.length).toBeGreaterThan(20);
    }
  });

  it("lets only leak and escape fail the verdict, and only measured cells prove it", () => {
    const byEffect = (effect: string) =>
      STATUS_META.filter((meta) => meta.verdictEffect === effect).map((meta) => meta.status);
    expect(byEffect("fails")).toEqual(["leak", "escape"]);
    expect(byEffect("proves")).toEqual(["pass", "overblock"]);
    expect(byEffect("none")).toEqual(["inconclusive", "skipped"]);
  });

  it("looks a status up", () => {
    expect(statusMeta("escape")).toEqual(STATUS_META[2]);
  });

  it("covers every verdict of the runner", () => {
    expect(VERDICT_META.map((meta) => meta.verdict)).toEqual([...VERDICTS]);
    expect(verdictMeta("NOT PROVEN").rule).toContain("Never reported as ISOLATED");
  });
});

describe("template cards", () => {
  it("builds the lab link with the template id and the variant", () => {
    expect(labTemplateHref("multi-tenant-saas", "leaky")).toBe(
      "/lab?template=multi-tenant-saas&variant=leaky",
    );
    expect(labTemplateHref("a b&c", "fixed")).toBe("/lab?template=a+b%26c&variant=fixed");
  });

  it("carries metadata only: no SQL, no personas, no expectations", () => {
    const cards = templateCards(TEMPLATES);
    expect(cards.map((card) => card.id)).toEqual(TEMPLATES.map((template) => template.id));
    for (const card of cards) {
      expect(Object.keys(card).sort()).toEqual(["description", "href", "id", "leak", "title"]);
      expect(card.href).toBe(`/lab?template=${card.id}&variant=leaky`);
      expect(JSON.stringify(card)).not.toMatch(/create (table|policy)/i);
    }
  });
});

describe("links", () => {
  it("uses the one-line description of package.json, word for word", () => {
    const manifest = z
      .object({ description: z.string() })
      .parse(
        JSON.parse(
          readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8"),
        ),
      );
    expect(SITE_DESCRIPTION).toBe(manifest.description);
  });

  it("never prefetches the lab, the one heavy page", () => {
    expect(NAV_ITEMS.find((item) => item.href === "/lab")?.prefetch).toBe(false);
  });

  it("names the lab and the docs", () => {
    expect(NAV_ITEMS.map((item) => item.href)).toEqual(["/lab", "/docs"]);
    expect(REPO_URL).toBe("https://github.com/MStanislavov/rls-leak-tester");
  });

  it.each([
    ["/", "/", true],
    ["/lab", "/", false],
    ["/lab", "/lab", true],
    ["/lab/x", "/lab", true],
    ["/labs", "/lab", false],
    ["/docs", "/lab", false],
  ])("isActivePath(%s, %s) is %s", (pathname, href, expected) => {
    expect(isActivePath(pathname, href)).toBe(expected);
  });
});

describe("docs structure", () => {
  it("has unique, fragment-safe section ids", () => {
    const ids = DOCS_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
    expect(docsSectionHref("limits")).toBe("/docs#limits");
  });

  it("gives every static check an anchor that no section uses", () => {
    const sectionIds = new Set<string>(DOCS_SECTIONS.map((section) => section.id));
    const anchors = STATIC_CHECK_RULES.map((rule) => staticCheckAnchor(rule.id));
    expect(anchors).toHaveLength(9);
    expect(new Set(anchors).size).toBe(anchors.length);
    for (const anchor of anchors) {
      expect(sectionIds.has(anchor)).toBe(false);
    }
    expect(staticCheckDocsHref("RLS004")).toBe("/docs#rls004");
  });

  it("quotes the thresholds of rules.yaml", () => {
    const rulesFile = z.object({
      thresholds: z.object({
        runner: z.object({ probe_timeout_ms: z.number(), run_ceiling_ms: z.number() }),
        ai: z.object({ explain_payload_max_bytes: z.number() }),
      }),
    });
    const { thresholds } = rulesFile.parse(
      parse(readFileSync(fileURLToPath(new URL("../../../rules.yaml", import.meta.url)), "utf8")),
    );
    expect(PROBE_TIMEOUT_SECONDS * 1000).toBe(thresholds.runner.probe_timeout_ms);
    expect(RUN_CEILING_SECONDS * 1000).toBe(thresholds.runner.run_ceiling_ms);
    expect(EXPLAIN_PAYLOAD_MAX_KIB * 1024).toBe(thresholds.ai.explain_payload_max_bytes);
  });
});
