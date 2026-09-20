/**
 * SIDE-EFFECT MODULE: import it FIRST in the lab's client entry, before anything that builds a
 * zod schema.
 *
 * zod 4 compiles object parsers with `new Function` when the environment lets it, and finds out
 * by trying, at the moment an object schema is CONSTRUCTED (so while `@/lib/scenario/schema` is
 * being evaluated, long before the first parse). Under the production Content-Security-Policy
 * (no 'unsafe-eval', SEC-005) the attempt is blocked; zod catches that and falls back, but the
 * browser has already reported a `securitypolicyviolation`. Seen in `next build && next start`
 * only: the development policy allows eval. With `jitless` zod skips the probe and uses its
 * interpreter from the start.
 *
 * The setting is global to zod. That is why this is not part of `@/lib/lab`'s index: the server
 * imports that index too, and the server has no CSP to satisfy.
 */
import { z } from "zod";

z.config({ jitless: true });

export const ZOD_IS_JITLESS = true;
