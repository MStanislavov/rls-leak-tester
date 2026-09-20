import { describe, expect, it } from "vitest";
import { buildHealthReport } from "@/lib/ai/health";
import { HEALTH_ENDPOINT, explainAvailabilityOf, fetchExplainAvailability } from "./explain-health";

function report(explain: boolean): unknown {
  // The body the route really sends, so the two sides cannot drift apart unnoticed.
  return buildHealthReport({
    buildId: "test",
    features: { explainEnabled: explain, redisEnabled: false, supabaseEnabled: false },
  });
}

describe("explainAvailabilityOf", () => {
  it("reads the boolean of the health report", () => {
    expect(explainAvailabilityOf(report(true))).toBe("on");
    expect(explainAvailabilityOf(report(false))).toBe("off");
  });

  it("anything else is unknown, never on", () => {
    for (const body of [
      undefined,
      null,
      "ok",
      {},
      { status: "ok" },
      { status: "ok", features: { explain: "true" } },
      { status: "down", features: { explain: true } },
    ]) {
      expect(explainAvailabilityOf(body)).toBe("unknown");
    }
  });
});

describe("fetchExplainAvailability", () => {
  it("asks the health endpoint without a cache and reads the answer", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const availability = await fetchExplainAvailability({
      fetch: (input, init) => {
        calls.push({ url: String(input), init });
        return Promise.resolve(Response.json(report(true)));
      },
    });

    expect(availability).toBe("on");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(HEALTH_ENDPOINT);
    expect(calls[0]?.init?.cache).toBe("no-store");
  });

  it("never throws: an error status, a body that is no JSON and a lost network are unknown", async () => {
    const answers: (() => Promise<Response>)[] = [
      () => Promise.resolve(Response.json(report(true), { status: 500 })),
      () => Promise.resolve(new Response("<html>")),
      () => Promise.reject(new TypeError("Failed to fetch")),
    ];
    for (const answer of answers) {
      expect(await fetchExplainAvailability({ fetch: answer })).toBe("unknown");
    }
  });

  it("passes the abort signal on", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null | undefined;
    await fetchExplainAvailability({
      signal: controller.signal,
      fetch: (_input, init) => {
        seen = init?.signal;
        return Promise.resolve(Response.json(report(false)));
      },
    });

    expect(seen).toBe(controller.signal);
  });
});
