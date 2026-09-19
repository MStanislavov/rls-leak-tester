/**
 * Scenario ids and slugs. An id is an INPUT of a run, never a result: the runner's output does
 * not depend on how an id was made, so a random suffix cannot break determinism (P6). The pure
 * builders take the suffix as a value; only `newScenarioId` reaches for randomness, and its
 * source can be replaced.
 */
import { MAX_ID_LENGTH } from "./limits";

/** Scenario and persona ids: safe in a URL path, a storage key and a file name. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidId(value: string): boolean {
  return value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
}

const FALLBACK_SLUG = "scenario";
const COMBINING_MARKS = /[̀-ͯ]/g;

function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") {
    start += 1;
  }
  while (end > start && value[end - 1] === "-") {
    end -= 1;
  }
  return value.slice(start, end);
}

/**
 * A lower-case ASCII slug: accents folded, every other run of characters becomes one hyphen, no
 * hyphen at either end, at most `maxLength` characters. Text without any letter or digit gives
 * `scenario`. The same text always gives the same slug.
 */
export function slugify(text: string, maxLength: number = MAX_ID_LENGTH): string {
  const folded = text.normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase();
  const hyphenated = folded.replace(/[^a-z0-9]+/g, "-");
  const slug = trimHyphens(trimHyphens(hyphenated).slice(0, Math.max(1, maxLength)));
  return slug === "" ? FALLBACK_SLUG.slice(0, Math.max(1, maxLength)) : slug;
}

/**
 * `<slug of the title>-<suffix>`, at most `MAX_ID_LENGTH` characters and valid as a scenario id.
 * Pure: the caller supplies the suffix (a counter, a hash, `randomIdSuffix()`).
 */
export function createScenarioId(title: string, suffix: string): string {
  const cleanSuffix = slugify(suffix, MAX_ID_LENGTH / 2);
  const room = MAX_ID_LENGTH - cleanSuffix.length - 1;
  return `${slugify(title, room)}-${cleanSuffix}`;
}

/** Fills the array with random bytes, like `crypto.getRandomValues`. */
export type FillRandom = (bytes: Uint8Array) => Uint8Array;

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const DEFAULT_SUFFIX_LENGTH = 10;

function cryptoFillRandom(bytes: Uint8Array): Uint8Array {
  return globalThis.crypto.getRandomValues(bytes);
}

/** `length` characters of `[a-z2-7]`, five random bits each (no modulo bias). */
export function randomIdSuffix(
  length: number = DEFAULT_SUFFIX_LENGTH,
  fillRandom: FillRandom = cryptoFillRandom,
): string {
  const bytes = fillRandom(new Uint8Array(Math.max(1, Math.min(length, MAX_ID_LENGTH / 2))));
  let suffix = "";
  for (const byte of bytes) {
    suffix += SUFFIX_ALPHABET.charAt(byte & 31);
  }
  return suffix;
}

/** A fresh id for a new or forked scenario: the title's slug and a random suffix. */
export function newScenarioId(title: string, fillRandom: FillRandom = cryptoFillRandom): string {
  return createScenarioId(title, randomIdSuffix(DEFAULT_SUFFIX_LENGTH, fillRandom));
}
