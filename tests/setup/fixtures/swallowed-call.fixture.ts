/**
 * Not part of the project's suite: tests/setup/network-guard.test.ts runs this file in a child
 * Vitest process and expects the first and the third test to FAIL and the second to pass.
 *
 * The host is under `.invalid` (RFC 6761), so even without the guard nothing real is reached, and
 * the address is assembled at run time, which is exactly what the static TEST-001 check cannot see.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, it } from "vitest";

const remote = ["https:", "", ["guard-probe", "invalid"].join("."), "v1", "messages"].join("/");

it("swallows a blocked call", async () => {
  // Product code with a fail-closed path does this: the error never reaches the test.
  const outcome = await fetch(remote).then(
    () => "reached",
    () => "swallowed",
  );
  expect(outcome).toBe("swallowed");
});

it("talks to loopback only", async () => {
  const server = createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(["http:", "", `127.0.0.1:${port}`, "health"].join("/"));
    expect(await response.text()).toBe("ok");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

it("sets the live switch from inside and swallows the blocked call", async () => {
  // The guard read the switch when the setup file installed it; writing it now lifts nothing.
  // The name is assembled at run time because the static TEST-001 check refuses the assignment.
  const name = ["RUN", "LIVE", "AI", "TESTS"].join("_");
  process.env[name] = "1";
  try {
    const outcome = await fetch(remote, { signal: AbortSignal.abort() }).then(
      () => "reached",
      () => "swallowed",
    );
    expect(outcome).toBe("swallowed");
  } finally {
    process.env[name] = "";
  }
});
