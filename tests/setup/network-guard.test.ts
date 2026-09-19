/**
 * The run-time layer of rules.yaml TEST-001. This file never installs the guard itself: that it is
 * active here is the proof that vitest.config.mts registers tests/setup/network-guard.setup.ts.
 *
 * Every remote address is under `.invalid` (RFC 6761) and assembled at run time: nothing real can
 * be reached even if the guard were gone, and the static check has nothing to object to.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  connectTarget,
  failOnBlockedAttempts,
  isLoopbackHost,
  isNetworkGuardInstalled,
  liveNetworkAllowed,
  refusalFor,
  takeBlockedAttempts,
} from "./network-guard";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REMOTE_HOST = ["guard-probe", "invalid"].join(".");
const remote = (protocol: string, route = "v1") => [protocol, "", REMOTE_HOST, route].join("/");
const OFF = {};
const LIVE = { RUN_LIVE_AI_TESTS: "1" };

interface ChildReport {
  testResults: {
    assertionResults: { title: string; status: string; failureMessages: string[] }[];
  }[];
}

/** The error of `action`, whether it is thrown, rejected or emitted. */
async function errorOf(action: () => unknown): Promise<unknown> {
  try {
    const result = action();
    if (result instanceof Promise) await result;
    if (result instanceof http.ClientRequest || result instanceof net.Socket) {
      return await new Promise((resolve) => {
        result.once("error", resolve);
        result.once("close", () => resolve(undefined));
      });
    }
    return undefined;
  } catch (error) {
    return error;
  }
}

const expectBlocked = (error: unknown, through: string) => {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe("NetworkGuardError");
  expect((error as Error).message).toMatch(/^TEST-001: a test tried to reach /);
  expect((error as Error).message).toContain(REMOTE_HOST);
  expect((error as Error).message).toContain(through);
};

describe("the guard is wired by vitest.config.mts", () => {
  it("is installed before this file runs, without this file installing it", () => {
    expect(isNetworkGuardInstalled()).toBe(true);
  });
});

describe("what the guard refuses", () => {
  it("blocks fetch to a real host, given as a string, a URL or a Request", async () => {
    const base = remote("https:");
    for (const input of [base, `${base}/messages`, new URL(base), new Request(base)]) {
      expectBlocked(await errorOf(() => fetch(input)), "fetch");
    }
    expect(takeBlockedAttempts()).toHaveLength(4);
  });

  it("blocks node:http, node:https and raw sockets before anything is resolved", async () => {
    const attempts = [
      () => http.request(remote("http:")),
      () => http.get(remote("http:")),
      () => https.request(remote("https:")),
      () => https.request({ host: REMOTE_HOST, port: 443, path: "/v1" }),
      () => net.connect(443, REMOTE_HOST),
      () => net.connect({ host: REMOTE_HOST, port: 6379 }),
      () => new net.Socket().connect(5432, REMOTE_HOST),
    ];
    for (const attempt of attempts) {
      expectBlocked(await errorOf(attempt), "a TCP connection");
    }
    expect(takeBlockedAttempts()).toHaveLength(attempts.length);
  });

  it("blocks a WebSocket to a real host", async () => {
    expect(typeof WebSocket).toBe("function");
    expectBlocked(await errorOf(() => new WebSocket(remote("wss:"))), "new WebSocket");
    expect(takeBlockedAttempts()).toHaveLength(1);
  });

  it("fails the test afterwards, even when the error was swallowed", async () => {
    await fetch(remote("https:")).catch(() => "swallowed");
    expect(() => failOnBlockedAttempts()).toThrow(/TEST-001: a test tried to reach /);
    // The record is cleared: the next test starts clean.
    expect(() => failOnBlockedAttempts()).not.toThrow();
  });

  it("cannot be lifted from inside a test: the live switch was read when the guard was installed", async () => {
    // The name is assembled at run time, like the addresses: the static layer of TEST-001
    // refuses a test file that assigns the switch, and this one proves the run-time layer.
    const name = ["RUN", "LIVE", "AI", "TESTS"].join("_");
    const before = process.env[name];
    try {
      for (const value of ["1", "true"]) {
        process.env[name] = value;
        expectBlocked(await errorOf(() => fetch(remote("https:"))), "fetch");
        expectBlocked(await errorOf(() => net.connect(443, REMOTE_HOST)), "a TCP connection");
        expectBlocked(await errorOf(() => new WebSocket(remote("wss:"))), "new WebSocket");
      }
    } finally {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    }
    expect(takeBlockedAttempts()).toHaveLength(6);
  });

  it("fails a real test that swallowed a blocked call, and passes a loopback test (child run)", () => {
    let report: ChildReport = { testResults: [] };
    const scratch = mkdtempSync(path.join(tmpdir(), "network-guard-"));
    const reportFile = path.join(scratch, "report.json");
    try {
      const result = spawnSync(
        process.execPath,
        [
          "node_modules/vitest/vitest.mjs",
          "run",
          "--config",
          "tests/setup/fixtures/vitest.fixture.config.mts",
          "--reporter=json",
          `--outputFile=${reportFile}`,
        ],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          timeout: 120_000,
          env: { ...process.env, RUN_LIVE_AI_TESTS: "" },
        },
      );
      expect(result.status, result.stderr).toBe(1);
      report = JSON.parse(readFileSync(reportFile, "utf8")) as ChildReport;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    const tests = report.testResults.flatMap((file) => file.assertionResults);
    expect(tests.map((test) => [test.title, test.status])).toEqual([
      ["swallows a blocked call", "failed"],
      ["talks to loopback only", "passed"],
      ["sets the live switch from inside and swallows the blocked call", "failed"],
    ]);
    for (const index of [0, 2]) {
      expect(tests[index]?.failureMessages.join("\n")).toMatch(
        /TEST-001: a test tried to reach https:/,
      );
    }
  }, 130_000);
});

describe("what the guard lets through", () => {
  it("reaches a server on loopback through fetch and node:http", async () => {
    const server = http.createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const origin = ["http:", "", `127.0.0.1:${port}`].join("/");
      expect(await (await fetch(`${origin}/health`)).text()).toBe("ok");
      const viaLocalhost = await new Promise<number | undefined>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: "/" }, (response) => {
            response.resume();
            resolve(response.statusCode);
          })
          .on("error", reject);
      });
      expect(viaLocalhost).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(takeBlockedAttempts()).toEqual([]);
  });

  it("does not judge data: and blob: URLs", async () => {
    const response = await fetch("data:text/plain,hello");
    expect(await response.text()).toBe("hello");
    expect(takeBlockedAttempts()).toEqual([]);
  });
});

describe("the decisions, as pure functions", () => {
  it.each([
    ["localhost", true],
    ["LOCALHOST", true],
    ["app.localhost", true],
    ["127.0.0.1", true],
    ["127.8.9.10", true],
    ["0.0.0.0", true],
    ["::1", true],
    ["[::1]", true],
    ["::ffff:127.0.0.1", true],
    ["localhost.example.com", false],
    ["128.0.0.1", false],
    ["10.0.0.5", false],
    ["192.168.1.10", false],
    ["api.anthropic.com", false],
    ["", false],
  ])("isLoopbackHost(%j) is %j", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });

  it("lifts the guard only for RUN_LIVE_AI_TESTS=1 or true", () => {
    expect(liveNetworkAllowed({})).toBe(false);
    expect(liveNetworkAllowed({ RUN_LIVE_AI_TESTS: "" })).toBe(false);
    expect(liveNetworkAllowed({ RUN_LIVE_AI_TESTS: "0" })).toBe(false);
    expect(liveNetworkAllowed({ RUN_LIVE_AI_TESTS: "yes" })).toBe(false);
    expect(liveNetworkAllowed({ RUN_LIVE_AI_TESTS: "1" })).toBe(true);
    expect(liveNetworkAllowed({ RUN_LIVE_AI_TESTS: " TRUE " })).toBe(true);
  });

  it("refuses network protocols to real hosts and nothing else", () => {
    for (const protocol of ["http:", "https:", "ws:", "wss:"]) {
      expect(refusalFor(remote(protocol), OFF)).toBe(`${protocol}//${REMOTE_HOST}`);
      expect(refusalFor(new URL(remote(protocol)), OFF)).toBe(`${protocol}//${REMOTE_HOST}`);
      expect(refusalFor(remote(protocol), LIVE)).toBeNull();
    }
    expect(refusalFor(["http:", "", "localhost:3100", "api"].join("/"), OFF)).toBeNull();
    expect(refusalFor(["http:", "", "[::1]:3100", "api"].join("/"), OFF)).toBeNull();
    expect(refusalFor("/api/health", OFF)).toBeNull();
    expect(refusalFor("/api/health", OFF, remote("https:"))).toBe(`https://${REMOTE_HOST}`);
    expect(refusalFor("data:text/plain,hello", OFF)).toBeNull();
    expect(refusalFor("file:///tmp/x", OFF)).toBeNull();
    expect(refusalFor("http://", OFF)).toBeNull();
  });

  it("reads the target of every socket.connect() form", () => {
    expect(connectTarget([{ host: REMOTE_HOST, port: 443 }])).toEqual({
      host: REMOTE_HOST,
      port: "443",
    });
    expect(connectTarget([[{ host: REMOTE_HOST, port: 443 }, null]])).toEqual({
      host: REMOTE_HOST,
      port: "443",
    });
    expect(connectTarget([{ port: 6379 }])).toEqual({ host: "localhost", port: "6379" });
    expect(connectTarget([{ host: "", port: 6379 }])).toEqual({ host: "localhost", port: "6379" });
    expect(connectTarget([443, REMOTE_HOST])).toEqual({ host: REMOTE_HOST, port: "443" });
    expect(connectTarget(["443", REMOTE_HOST])).toEqual({ host: REMOTE_HOST, port: "443" });
    expect(connectTarget([443])).toEqual({ host: "localhost", port: "443" });
    expect(connectTarget([443, () => undefined])).toEqual({ host: "localhost", port: "443" });
    expect(connectTarget([{ path: "/tmp/app.sock" }])).toBeNull();
    expect(connectTarget(["/tmp/app.sock"])).toBeNull();
    expect(connectTarget([])).toBeNull();
  });
});
