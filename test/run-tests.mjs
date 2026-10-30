// Test runner: node test/run-tests.mjs
//
// 1. syntax-checks every source file
// 2. checks the compiled gschema is not older than the schema source
// 3. checks the translation template and the compiled .mo files are up to date
// 4. runs each *.test.mjs in this directory and aggregates the result
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tmp = mkdtempSync(path.join(tmpdir(), "awc-syntax-"));

let failures = 0;
const step = (name, fn) => {
  const ok = fn();
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}`);
  if (!ok) failures++;
};

console.log("syntax");
for (const file of ["extension.js", "prefs.js", "lib/providers.js", "lib/panelMenu.js", "lib/location.js", "lib/alerts.js"]) {
  const copy = path.join(tmp, path.basename(file) + ".mjs");
  copyFileSync(path.join(root, file), copy);
  step(file, () => spawnSync(process.execPath, ["--check", copy], { encoding: "utf8" }).status === 0);
}

console.log("\ngschema");
const haveSchemaCompiler = spawnSync("glib-compile-schemas", ["--help"], { encoding: "utf8" }).status === 0;
const schemaXml = path.join(root, "schemas", "org.gnome.shell.extensions.advanced-weather.gschema.xml");
const schemaOut = path.join(root, "schemas", "gschemas.compiled");
if (haveSchemaCompiler) {
  // Content comparison rather than mtimes: git checkout order makes mtimes unreliable.
  step("gschemas.compiled matches the schema source", () => {
    const out = mkdtempSync(path.join(tmpdir(), "awc-schema-"));
    copyFileSync(schemaXml, path.join(out, "x.gschema.xml"));
    const res = spawnSync("glib-compile-schemas", [out], { encoding: "utf8" });
    if (res.status !== 0) {
      console.log("  " + res.stderr.trim().split("\n")[0]);
      return false;
    }
    const fresh = path.join(out, "gschemas.compiled");
    if (!existsSync(schemaOut) || !existsSync(fresh) || !readFileSync(schemaOut).equals(readFileSync(fresh))) {
      console.log("  run: glib-compile-schemas schemas");
      return false;
    }
    return true;
  });
} else {
  step("gschemas.compiled is not older than the schema source", () => {
    const stale = statSync(schemaOut).mtimeMs < statSync(schemaXml).mtimeMs;
    if (stale) console.log("  run: glib-compile-schemas schemas");
    return !stale;
  });
  console.log("  skip  glib-compile-schemas not installed, cannot verify contents");
}

console.log("\nlocale");
const localeDir = path.join(root, "locale");
const langOf = (po) => path.relative(localeDir, po).split(path.sep)[0];
const poFiles = readdirSync(localeDir)
  .map((lang) => path.join(localeDir, lang, "LC_MESSAGES", "advanced-weather.po"))
  .filter((f) => existsSync(f));
const haveMsgfmt = spawnSync("msgfmt", ["--version"], { encoding: "utf8" }).status === 0;
step(haveMsgfmt ? "every .mo matches its .po" : "every .mo is present", () => {
  const bad = [];
  for (const po of poFiles) {
    const mo = po.replace(/\.po$/, ".mo");
    if (!existsSync(mo)) {
      bad.push(langOf(po) + " (missing .mo)");
      continue;
    }
    if (!haveMsgfmt) continue;
    const out = path.join(tmp, "check.mo");
    const res = spawnSync("msgfmt", ["--check-format", "-o", out, po], { encoding: "utf8" });
    if (res.status !== 0) {
      bad.push(langOf(po) + " (invalid .po: " + res.stderr.trim().split("\n")[0] + ")");
    } else if (!readFileSync(mo).equals(readFileSync(out))) {
      bad.push(langOf(po) + " (stale .mo)");
    }
  }
  if (bad.length) {
    console.log("  " + bad.join(", "));
    console.log("  run: ./translations.sh --compile");
    return false;
  }
  return poFiles.length > 0;
});

const haveGettext =
  spawnSync("xgettext", ["--version"], { encoding: "utf8" }).status === 0 &&
  spawnSync("msgcat", ["--version"], { encoding: "utf8" }).status === 0;
if (haveGettext) {
  step("advanced-weather.pot matches the sources", () => {
    const sources = ["extension.js", "prefs.js"]
      .concat(readdirSync(path.join(root, "lib")).map((f) => "lib/" + f))
      .filter((f) => f.endsWith(".js"));
    const gen = path.join(tmp, "regen.pot");
    const genPot = spawnSync(
      "xgettext",
      ["--from-code=UTF-8", "--language=JavaScript", "--keyword=_", "--keyword=gettext", "--no-wrap", "--output", gen, ...sources],
      { encoding: "utf8", cwd: root },
    );
    if (genPot.status !== 0) {
      console.log("  " + genPot.stderr.trim().split("\n")[0]);
      return false;
    }
    const ids = (file) =>
      new Set(
        spawnSync("msgcat", ["--no-location", "--no-wrap", file], { encoding: "utf8" })
          .stdout.split("\n")
          .filter((l) => l.startsWith("msgid ") && l !== 'msgid ""')
          .map((l) => l.slice(6)),
      );
    const inSources = ids(gen);
    const inPot = ids(path.join(root, "locale", "advanced-weather.pot"));
    const missing = [...inSources].filter((x) => !inPot.has(x));
    const obsolete = [...inPot].filter((x) => !inSources.has(x));
    if (missing.length || obsolete.length) {
      for (const m of missing.slice(0, 8)) console.log("  not in template: " + m);
      for (const o of obsolete.slice(0, 8)) console.log("  obsolete in template: " + o);
      console.log(`  ${missing.length} missing, ${obsolete.length} obsolete — run: ./translations.sh --extract && ./translations.sh --all`);
      return false;
    }
    return true;
  });
} else {
  console.log("  skip  gettext tools not installed");
}

console.log("\ntests");
for (const entry of readdirSync(here).filter((f) => f.endsWith(".test.mjs")).sort()) {
  const res = spawnSync(process.execPath, [path.join(here, entry)], { encoding: "utf8", stdio: "inherit" });
  if (res.status !== 0) failures++;
}

console.log(`\n${failures === 0 ? "all green" : failures + " step(s) failed"}`);
process.exit(failures === 0 ? 0 : 1);
