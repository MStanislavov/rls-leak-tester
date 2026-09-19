/**
 * The single key builder (rules.yaml REDIS-001): `rlsleak:{env}:{purpose}:{id}`.
 *
 * The prefix literal exists here and nowhere else. The ports only accept the branded
 * `RedisKey`, which only this module produces, and the adapters refuse at run time
 * a key that does not start with their builder's prefix.
 *
 * Ids never carry user input verbatim unless it is already harmless: an id made of
 * `[A-Za-z0-9_-]` (a slug, a hex digest) is kept, everything else is replaced by
 * `h.` plus its SHA-256. A plain id cannot contain a dot, so the two forms never
 * collide, and no id can contain `:`, a glob character, a space or a cluster hash
 * tag. Rate-limit subjects (IP addresses, user ids) are always hashed, so that no
 * address is stored in Redis in the clear.
 */
import { createHash } from "node:crypto";

const NAMESPACE = "rlsleak";
const SEPARATOR = ":";

const ENV_SEGMENT = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PLAIN_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** 128 bits of the digest are plenty to keep rate-limit subjects apart. */
const SUBJECT_DIGEST_LENGTH = 32;

declare const redisKeyBrand: unique symbol;

/** A key built by this module. A plain string is not assignable to it. */
export type RedisKey = string & { readonly [redisKeyBrand]: "RedisKey" };

export type KeyPurpose = "ratelimit" | "explain" | "lock" | "scenario";

/** What is being limited; the numbers live in `policy.ts`. */
export type RateLimitScope = "explain" | "scenario-writes";

/** Whose budget it is: the caller's address or the signed-in user. */
export type RateLimitSubjectKind = "ip" | "user";

export interface KeyBuilder {
  /** The `{env}` segment. */
  readonly env: string;
  /** `rlsleak:{env}:`, the prefix of every key of this builder. */
  readonly prefix: string;
  /** A key for any purpose; the id is kept when it is harmless and hashed otherwise. */
  build(purpose: KeyPurpose, id: string): RedisKey;
  /** The sliding-window log of one subject in one scope. The subject is always hashed. */
  rateLimit(scope: RateLimitScope, kind: RateLimitSubjectKind, subject: string): RedisKey;
  /** The cached explanation of one request hash. */
  explanation(requestHash: string): RedisKey;
  /** The single-flight lock of the same request hash. */
  explanationLock(requestHash: string): RedisKey;
  /** The read-through cache entry of one shared scenario. */
  scenario(slug: string): RedisKey;
  /** True for a key of this builder: right namespace, right env. */
  owns(key: string): boolean;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Pure: keeps a harmless id, replaces everything else by `h.` plus its SHA-256. */
export function safeKeyId(id: string): string {
  return PLAIN_ID.test(id) ? id : `h.${sha256Hex(id)}`;
}

/**
 * Builds keys for one environment. `env` is configuration, not user input, so an
 * invalid value is a programming error and throws.
 */
export function createKeyBuilder(env: string): KeyBuilder {
  if (!ENV_SEGMENT.test(env)) {
    throw new RangeError(
      "The Redis key env segment must be 1 to 40 characters of a-z, 0-9 and '-', starting with a letter or digit",
    );
  }
  const prefix = `${NAMESPACE}${SEPARATOR}${env}${SEPARATOR}`;
  const join = (purpose: KeyPurpose, id: string): RedisKey =>
    `${prefix}${purpose}${SEPARATOR}${id}` as RedisKey;

  return {
    env,
    prefix,
    build: (purpose, id) => join(purpose, safeKeyId(id)),
    rateLimit: (scope, kind, subject) =>
      join("ratelimit", `${scope}.${kind}.${sha256Hex(subject).slice(0, SUBJECT_DIGEST_LENGTH)}`),
    explanation: (requestHash) => join("explain", safeKeyId(requestHash)),
    explanationLock: (requestHash) => join("lock", safeKeyId(requestHash)),
    scenario: (slug) => join("scenario", safeKeyId(slug)),
    owns: (key) => key.startsWith(prefix),
  };
}

/** Throws when `key` was not built for `prefix`. The adapters call it before every command. */
export function assertKeyPrefix(prefix: string, key: string): void {
  if (!key.startsWith(prefix)) {
    throw new RangeError("A Redis key must come from the key builder of this environment");
  }
}
