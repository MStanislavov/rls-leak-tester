import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ZOD_IS_JITLESS } from "./zod-csp";

describe("zod-csp", () => {
  it("switches zod to its interpreter on import, and parsing still works", () => {
    expect(ZOD_IS_JITLESS).toBe(true);
    expect(z.config().jitless).toBe(true);
    const schema = z.strictObject({ id: z.string(), count: z.number().int() });
    expect(schema.parse({ id: "a", count: 1 })).toEqual({ id: "a", count: 1 });
    expect(schema.safeParse({ id: "a", count: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ id: "a", count: 1, extra: true }).success).toBe(false);
  });
});
