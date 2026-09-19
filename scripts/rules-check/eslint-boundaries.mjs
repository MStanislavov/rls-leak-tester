/**
 * The local ESLint plugin behind the resolved half of ARCH-001 and ARCH-004.
 *
 * `no-restricted-imports` matches the specifier as text, so it only sees a relative import whose
 * banned directory follows the `../` chain directly. `../../lib/redis/keys` from src/lib/runner,
 * `../../../src/components/ui/button` from src/lib/security and `../checks/../redis/keys` all land
 * in a banned directory through an intermediate one and pass it. This rule resolves the specifier
 * against the importing file first, with the same lexical resolver the SEC-004 check of the rules
 * check uses (`resolveImport`: the `@/` alias and relative paths, no file system), and compares the
 * result with the banned directories. Because nothing is read from disk, a target that does not
 * exist yet is judged like any other, which `import/no-restricted-paths` cannot do: it skips an
 * import it cannot resolve on disk.
 *
 * Every form that names a module is covered: static and type-only imports, re-exports, `import()`,
 * `require()`, `import x = require()` and the `import("…")` type, with a string or a template
 * literal without placeholders.
 */
import path from "node:path";

import { isUnder, resolveImport } from "./text.mjs";

/**
 * @typedef {{ dirs: string[], except?: string, message: string }} Zone
 * `dirs` are repo-relative directories no import may resolve into, `except` is the source of a
 * regular expression for resolved paths that stay allowed, `message` starts with the rule id.
 */

/**
 * The text of a node that is a string, or a template literal without placeholders.
 * @param {unknown} node
 * @returns {string | null}
 */
function staticText(node) {
  if (typeof node !== "object" || node === null) return null;
  const candidate =
    /** @type {{ type?: unknown, value?: unknown, expressions?: unknown, quasis?: unknown }} */ (
      node
    );
  if (candidate.type === "Literal") {
    return typeof candidate.value === "string" ? candidate.value : null;
  }
  if (
    candidate.type === "TemplateLiteral" &&
    Array.isArray(candidate.expressions) &&
    candidate.expressions.length === 0 &&
    Array.isArray(candidate.quasis)
  ) {
    const cooked = candidate.quasis[0]?.value?.cooked;
    return typeof cooked === "string" ? cooked : null;
  }
  return null;
}

/** @type {import("eslint").Rule.RuleModule} */
const resolvedImports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "An import must not resolve into a banned directory, however the relative path is spelled (ARCH-001, ARCH-004)",
    },
    schema: [
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            dirs: { type: "array", items: { type: "string" }, minItems: 1 },
            except: { type: "string" },
            message: { type: "string" },
          },
          required: ["dirs", "message"],
          additionalProperties: false,
        },
      },
    ],
    messages: {
      crossed: '{{message}} ("{{specifier}}" resolves to {{target}}.)',
    },
  },
  create(context) {
    /** @type {Zone[]} */
    const zones = context.options[0] ?? [];
    const file = path.relative(context.cwd, context.filename).split(path.sep).join("/");
    if (zones.length === 0 || file.startsWith("../")) return {};
    const exceptions = zones.map((zone) =>
      zone.except === undefined ? null : new RegExp(zone.except),
    );

    /** @param {unknown} node the node that holds the specifier */
    const check = (node) => {
      const specifier = staticText(node);
      if (specifier === null) return;
      const target = resolveImport(file, specifier);
      if (target === null) return;
      const index = zones.findIndex(
        (zone, at) =>
          zone.dirs.some((dir) => isUnder(target, dir)) && exceptions[at]?.test(target) !== true,
      );
      const zone = zones[index];
      if (zone === undefined) return;
      context.report({
        node: /** @type {import("estree").Node} */ (node),
        messageId: "crossed",
        data: { message: zone.message, specifier, target },
      });
    };

    /** @param {{ source?: unknown }} node */
    const checkSource = (node) => check(node.source);

    return {
      ImportDeclaration: checkSource,
      ExportNamedDeclaration: checkSource,
      ExportAllDeclaration: checkSource,
      ImportExpression: checkSource,
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require") {
          check(node.arguments[0]);
        }
      },
      /** @param {{ expression?: unknown }} node `import x = require("…")` */
      TSExternalModuleReference(node) {
        check(node.expression);
      },
      /** @param {{ source?: unknown, argument?: { literal?: unknown } }} node `import("…").Type` */
      TSImportType(node) {
        check(node.source ?? node.argument?.literal);
      },
    };
  },
};

/** Registered in eslint.config.mjs under the namespace `boundaries`. */
const boundariesPlugin = {
  meta: { name: "rls-leak-tester-boundaries" },
  rules: { "resolved-imports": resolvedImports },
};

export default boundariesPlugin;
