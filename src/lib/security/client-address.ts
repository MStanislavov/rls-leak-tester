/**
 * The caller's address, which is the bucket of the per-address rate limits (`/api/explain`,
 * scenario writes). A route handler sees headers only, never the socket, so the address comes
 * from `X-Forwarded-For`, and the one thing that matters is which part of it is trusted.
 *
 * Trust assumption (stated in docs/adr, DEPLOY.md and SECURITY.md): exactly ONE trusted proxy
 * stands in front of the app and it sets or appends `X-Forwarded-For`: Vercel (overwrites the
 * header with the one client address), or nginx / a load balancer (appends the address of the
 * connection). Either way the LAST hop is the one the proxy wrote; every hop before it is text
 * the caller sent. So the last hop is the bucket and the first hop is never read.
 *
 * - More than one proxy in front: the last hop is the proxy before the last, so its users share
 *   a bucket. That is strict, never a bypass.
 * - No proxy at all (`next start` open to the internet): Next.js keeps a header the caller sent
 *   (`x-forwarded-for ??= socket address`), so the limit can be dodged. Not a supported setup.
 * - `X-Real-IP` is read only when there is no `X-Forwarded-For` at all, which a proxy that
 *   appends never lets happen. `X-Vercel-Forwarded-For` is not read: outside Vercel it is text
 *   from the caller, on Vercel `X-Forwarded-For` holds the same address.
 *
 * Anything that does not look like an address shares one bucket, which is the strict choice;
 * there is no fallback to an earlier hop. Pure, and SEC-002: the header is parsed with zod.
 */
import { z } from "zod";

export const UNKNOWN_CLIENT = "unknown";

const BRACKETED = /^\[([^\][]*)\](?::\d{1,5})?$/;
const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;

/** `[2001:db8::1]:443` and `203.0.113.7:443` without the port: the caller chooses its port. */
function withoutPort(hop: string): string {
  return BRACKETED.exec(hop)?.[1] ?? IPV4_WITH_PORT.exec(hop)?.[1] ?? hop;
}

const clientAddressSchema = z
  .string()
  .transform((hop) => withoutPort(hop.trim()).toLowerCase())
  .pipe(z.string().regex(/^[0-9a-f:.]{2,45}$/));

export function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const candidate = forwarded === null ? headers.get("x-real-ip") : forwarded.split(",").at(-1);
  const parsed = clientAddressSchema.safeParse(candidate);
  return parsed.success ? parsed.data : UNKNOWN_CLIENT;
}
