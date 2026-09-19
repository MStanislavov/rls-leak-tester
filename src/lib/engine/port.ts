/**
 * The `SqlEngine` port, re-exported where brief 4.2 expects it. The definition lives in
 * `src/lib/runner/types.ts` because the runner must value-import the error classes and SEC-004
 * forbids it every value import from `src/lib/engine`.
 */
export * from "@/lib/runner/types";
