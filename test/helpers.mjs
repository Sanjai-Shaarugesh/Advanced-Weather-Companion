// Shared plumbing for the repo test suite.
//
// The extension sources import from resource:///org/gnome/shell/..., which only
// resolves inside a running GNOME Shell. The tests therefore load the source
// text, drop the import block, and evaluate the remainder with stubbed GI
// modules, so the REAL methods under test are exercised.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * @param {string} file path relative to the repository root
 * @param {object} opts
 *   marker:     first line of the body to keep (everything above is imports)
 *   name:       exported class / const to return
 *   params:     names injected into the evaluated scope
 *   args:       values for those names
 */
export function loadBody(file, { marker, name, params = [], args = [] }) {
  const src = readFileSync(path.join(ROOT, file), "utf8");
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`${file}: marker "${marker}" not found`);

  let body = src.slice(at);
  const exportPatterns = [
    [`export default class ${name}`, `class ${name}`],
    [`export const ${name}`, `const ${name}`],
  ];
  const hit = exportPatterns.find(([from]) => body.includes(from));
  if (!hit) throw new Error(`${file}: export of "${name}" not found`);
  body = body.replace(hit[0], hit[1]);

  const factory = new Function(...params, `${body}\nreturn ${name};`);
  return factory(...args);
}

/**
 * Load a dependency-free module such as lib/providers.js and return the named
 * exports. There is no package.json in this repo, so plain .js files cannot be
 * imported as ESM by Node; rewriting the export keywords keeps the real code.
 */
export function loadModule(file, marker, names) {
  const src = readFileSync(path.join(ROOT, file), "utf8");
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`${file}: marker "${marker}" not found`);
  const body = src.slice(at).replace(/^export (const|function)/gm, "$1");
  const factory = new Function(`${body}\nreturn { ${names.join(", ")} };`);
  return factory();
}

export function makeChecker(label) {
  let passed = 0;
  const failures = [];
  return {
    check(name, condition, extra = "") {
      if (condition) {
        passed++;
        console.log(`  ok   ${name}`);
      } else {
        failures.push(name);
        console.log(`  FAIL ${name}${extra ? `  -> ${extra}` : ""}`);
      }
    },
    report() {
      console.log(`${label}: ${passed} passed, ${failures.length} failed`);
      if (failures.length) console.log("  failed: " + failures.join(", "));
      return failures.length === 0;
    },
  };
}

export const pad = (n) => String(n).padStart(2, "0");

/** Local YYYY-MM-DD, n days from today. */
export const dateStr = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Local YYYY-MM-DDTHH:00, n hours from now, minutes zeroed. */
export const hourStr = (n) => {
  const d = new Date(Date.now() + n * 3600000);
  d.setMinutes(0, 0, 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
};

export const DAY_SECONDS = 86400;
export const nowSeconds = () => Math.floor(Date.now() / 1000);
