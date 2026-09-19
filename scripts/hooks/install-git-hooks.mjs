#!/usr/bin/env node
/**
 * The `prepare` script of package.json: points git at .husky/ (Husky 9 sets core.hooksPath).
 *
 * It must never break an install, so it skips quietly, with exit code 0, when
 *   - there is no .git here (a tarball, a Docker build context, a deployment),
 *   - husky is not installed (`npm ci --omit=dev`),
 *   - HUSKY=0 is set (Husky's own switch, handled inside husky).
 * A real failure of git itself is printed and still exits 0: git hooks are a convenience for
 * people, CI runs the same checks as jobs.
 */
import { existsSync } from "node:fs";

/** @param {string} message */
const skip = (message) => console.log(`prepare: ${message}, git hooks not installed`);

if (!existsSync(".git")) {
  skip("no .git here");
} else {
  /** @type {((dir?: string) => string) | null} */
  let husky = null;
  try {
    husky = (await import("husky")).default;
  } catch {
    skip("husky is not installed");
  }
  if (husky !== null) {
    const message = husky(".husky");
    if (message === "") console.log("prepare: git hooks installed from .husky/");
    else skip(message.trim());
  }
}
