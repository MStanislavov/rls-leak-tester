/**
 * The landing page ships no zod. `/` is a Server Component, so what reaches the browser is the
 * STATIC import graph of the "use client" modules under the root layout and the page. zod is
 * about 96 KB gzip, and one schema import in a header component puts it on every route.
 *
 * This walks the source the way the bundler does: value imports and re-exports only (a type
 * import is erased, `import()` is a chunk of its own that loads when it is called). The proof
 * on the built app is `e2e/site.spec.ts`; this one fails in seconds and names the chain.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SERVER_ENTRIES = ["src/app/layout.tsx", "src/app/page.tsx", "src/app/error.tsx"];
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"];

/** `import x from "y"`, `import "y"`, `export ... from "y"`; never `import type` / `export type`. */
const STATIC_IMPORT =
  /(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']/g;

function resolveProjectFile(specifier: string, from: string): string | undefined {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(ROOT, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else return undefined;
  const candidates = [
    base,
    ...EXTENSIONS.map((extension) => `${base}${extension}`),
    ...EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function staticImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(STATIC_IMPORT)].map((match) => match[1] ?? "");
}

const isClientModule = (file: string): boolean =>
  /^\s*(?:\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(readFileSync(file, "utf8"));

/** Every chain `client module > ... > zod` below the server entries. */
function chainsToZod(): string[] {
  const chains: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string, inClientGraph: boolean, trail: readonly string[]): void => {
    const client = inClientGraph || isClientModule(file);
    const key = `${client ? "client" : "server"}:${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    const here = [...trail, path.relative(ROOT, file)];
    for (const specifier of staticImports(file)) {
      if (client && (specifier === "zod" || specifier.startsWith("zod/"))) {
        chains.push([...here, specifier].join(" > "));
        continue;
      }
      const target = resolveProjectFile(specifier, file);
      // The trail starts at the client module: what is above it never reaches the browser.
      if (target !== undefined) walk(target, client, client ? here : []);
    }
  };
  for (const entry of SERVER_ENTRIES) walk(path.join(ROOT, entry), false, []);
  return chains;
}

describe("the client graph of the landing route", () => {
  it("finds the client modules of the layout, so an empty answer means something", () => {
    expect(isClientModule(path.join(ROOT, "src/components/auth/auth-controls.tsx"))).toBe(true);
    expect(isClientModule(path.join(ROOT, "src/app/layout.tsx"))).toBe(false);
    expect(staticImports(path.join(ROOT, "src/components/auth/auth-controls.tsx"))).toContain(
      "@/lib/lab/share-auth",
    );
    // A type import and a dynamic import are not part of the static graph.
    expect(staticImports(path.join(ROOT, "src/components/auth/auth-controls.tsx"))).not.toContain(
      "@/lib/store/auth-client",
    );
  });

  it("does not reach zod through a static import", () => {
    expect(chainsToZod()).toEqual([]);
  });
});
