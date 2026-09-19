/**
 * The run-time layer of rules.yaml TEST-001: a test makes no real network call.
 *
 * The rules check reads test files as text and sees a URL literal that is handed to a network
 * call. It cannot see an address that is assembled while the test runs. This module closes that
 * gap from the other side: once installed, every way out of the process is checked against the
 * host it is about to reach, and only loopback passes.
 *
 * - `fetch`, `WebSocket`, `EventSource` and `XMLHttpRequest` (when the environment has them) are
 *   checked by URL, which gives a precise message.
 * - `net.Socket.prototype.connect` is the catch-all underneath: `node:http`, `node:https`,
 *   `node:http2`, `node:tls`, the built-in `fetch`, `ioredis` and any database driver all end
 *   there. Unix sockets and pipes are not the network and pass.
 *
 * A blocked attempt throws a `NetworkGuardError` and is recorded as well, because product code may
 * catch the error (a fail-closed path does exactly that). The setup file fails the test that made
 * the attempt even when the error was swallowed.
 *
 * Live tests opt out with RUN_LIVE_AI_TESTS=1 (or "true"), the switch section 5.1 of the brief
 * names; nothing else lifts the guard. The switch is read once, when the guard is installed, so
 * it has to be set by whoever starts the run: a test that writes it to `process.env` changes
 * nothing. Known limit: UDP (`node:dgram`) and the resolver calls of `node:dns` are not
 * intercepted.
 *
 * This module has no side effect on import. `network-guard.setup.ts` installs it.
 */
import net from "node:net";

const INSTALLED = Symbol.for("rls-leak-tester.network-guard.installed");
const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const LOOPBACK_HOST =
  /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|::ffff:127(?:\.\d{1,3}){3})$/i;

export type EnvRecord = Record<string, string | undefined>;

export class NetworkGuardError extends Error {
  override readonly name = "NetworkGuardError";
}

const ATTEMPTS = Symbol.for("rls-leak-tester.network-guard.attempts");

/**
 * Attempts the guard blocked since the last call of {@link takeBlockedAttempts}. The list hangs on
 * the global object, so the setup file and a test see the same one however the module was loaded.
 */
function blockedAttempts(): string[] {
  const existing: unknown = Reflect.get(globalThis, ATTEMPTS);
  if (Array.isArray(existing)) return existing as string[];
  const created: string[] = [];
  Reflect.set(globalThis, ATTEMPTS, created);
  return created;
}

/** True for localhost, `*.localhost`, 127.0.0.0/8, 0.0.0.0 and ::1, with or without brackets. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return LOOPBACK_HOST.test(bare);
}

/** RUN_LIVE_AI_TESTS=1 (or "true") is the one switch that lets a test reach a real host. */
export function liveNetworkAllowed(env: EnvRecord): boolean {
  const flag = env.RUN_LIVE_AI_TESTS?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/**
 * The reason a URL is refused, or null when it may be used: not a network protocol (`data:`,
 * `blob:`, `file:`), a loopback host, or live tests switched on. A relative URL resolves against
 * `base`, which is the page address under jsdom and loopback otherwise.
 */
export function refusalFor(target: string | URL, env: EnvRecord, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(target, base ?? "http://localhost/");
  } catch {
    return null; // not a URL: the real API rejects it, nothing leaves the process
  }
  if (!NETWORK_PROTOCOLS.has(url.protocol)) return null;
  if (isLoopbackHost(url.hostname) || liveNetworkAllowed(env)) return null;
  return `${url.protocol}//${url.host}`;
}

/** The host a `socket.connect(...)` call is about to reach, or null for a pipe or Unix socket. */
export function connectTarget(args: readonly unknown[]): { host: string; port: string } | null {
  // net.connect() hands over its arguments already normalised, as one array: [options, callback].
  const first: unknown = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof first === "object" && first !== null) {
    const options = first as { host?: unknown; port?: unknown; path?: unknown };
    if (typeof options.path === "string") return null;
    return {
      host: typeof options.host === "string" && options.host !== "" ? options.host : "localhost",
      port: String(options.port ?? ""),
    };
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    const host = Array.isArray(args[0]) ? undefined : args[1];
    return { host: typeof host === "string" && host !== "" ? host : "localhost", port: `${first}` };
  }
  return null; // a path: a pipe or a Unix socket
}

function block(what: string, where: string): never {
  const message =
    `TEST-001: a test tried to reach ${where} through ${what}. Tests make no real network or ` +
    "model calls: mock the call or use a loopback URL. Live tests run with RUN_LIVE_AI_TESTS=1.";
  blockedAttempts().push(message);
  throw new NetworkGuardError(message);
}

function pageAddress(): string | undefined {
  const location: unknown = Reflect.get(globalThis, "location");
  if (typeof location !== "object" || location === null) return undefined;
  const href: unknown = Reflect.get(location, "href");
  return typeof href === "string" && /^https?:/.test(href) ? href : undefined;
}

function checkUrl(what: string, target: unknown, env: EnvRecord): void {
  const text =
    typeof target === "string" || target instanceof URL
      ? target
      : typeof Request === "function" && target instanceof Request
        ? target.url
        : String(target);
  const refused = refusalFor(text, env, pageAddress());
  if (refused !== null) block(what, refused);
}

function guardFetch(env: EnvRecord): void {
  const original: unknown = Reflect.get(globalThis, "fetch");
  if (typeof original !== "function") return;
  const guarded = (...args: unknown[]): Promise<unknown> => {
    try {
      checkUrl("fetch", args[0], env);
    } catch (error) {
      return Promise.reject(error); // fetch reports every failure as a rejection
    }
    return Reflect.apply(original, globalThis, args) as Promise<unknown>;
  };
  Reflect.set(globalThis, "fetch", guarded);
}

function guardConstructor(name: "WebSocket" | "EventSource", env: EnvRecord): void {
  const original: unknown = Reflect.get(globalThis, name);
  if (typeof original !== "function") return;
  const guarded = new Proxy(original, {
    construct(target, args: unknown[], newTarget) {
      checkUrl(`new ${name}`, args[0], env);
      return Reflect.construct(target, args, newTarget) as object;
    },
  });
  Reflect.set(globalThis, name, guarded);
}

function guardXmlHttpRequest(env: EnvRecord): void {
  const constructor: unknown = Reflect.get(globalThis, "XMLHttpRequest");
  if (typeof constructor !== "function") return;
  const prototype = constructor.prototype as { open?: (...args: unknown[]) => unknown };
  const original = prototype.open;
  if (typeof original !== "function") return;
  prototype.open = function guardedOpen(this: unknown, ...args: unknown[]): unknown {
    checkUrl("XMLHttpRequest", args[1], env);
    return Reflect.apply(original, this, args);
  };
}

function guardSockets(env: EnvRecord): void {
  const prototype = net.Socket.prototype as { connect: (...args: unknown[]) => unknown };
  const original = prototype.connect;
  prototype.connect = function guardedConnect(this: unknown, ...args: unknown[]): unknown {
    const target = connectTarget(args);
    if (target !== null && !isLoopbackHost(target.host) && !liveNetworkAllowed(env)) {
      block("a TCP connection", `${target.host}:${target.port}`);
    }
    return Reflect.apply(original, this, args);
  };
}

/** True once {@link installNetworkGuard} ran in this process. */
export function isNetworkGuardInstalled(): boolean {
  return Reflect.get(globalThis, INSTALLED) === true;
}

/**
 * Installs the guard once per process. The live switch is decided here, once, from a frozen copy
 * of the one variable: the setup file hands over `process.env`, which every test can write to,
 * and a test that sets RUN_LIVE_AI_TESTS after this point must not lift the guard from inside.
 * The switch belongs to whoever starts the run, not to the code under test.
 */
export function installNetworkGuard(env: EnvRecord): void {
  if (isNetworkGuardInstalled()) return;
  const decided: EnvRecord = Object.freeze({ RUN_LIVE_AI_TESTS: env.RUN_LIVE_AI_TESTS });
  guardFetch(decided);
  guardConstructor("WebSocket", decided);
  guardConstructor("EventSource", decided);
  guardXmlHttpRequest(decided);
  guardSockets(decided);
  Reflect.set(globalThis, INSTALLED, true);
}

/** Returns the recorded attempts and forgets them. */
export function takeBlockedAttempts(): string[] {
  const attempts = blockedAttempts();
  return attempts.splice(0, attempts.length);
}

/** Throws when an attempt was blocked since the last check, even if the test swallowed the error. */
export function failOnBlockedAttempts(): void {
  const attempts = takeBlockedAttempts();
  if (attempts.length > 0) throw new NetworkGuardError([...new Set(attempts)].join("\n"));
}
