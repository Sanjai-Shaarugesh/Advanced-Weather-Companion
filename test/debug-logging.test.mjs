// Source-level guard: the debug-logging gsetting must drive the log helpers.
// enable()/fillPreferencesWindow() need a live shell session, so the wiring is
// asserted on the source text; a flip back to `const DEBUG = false` fails here.
import { readFileSync } from "node:fs";
import { makeChecker, ROOT } from "./helpers.mjs";

const extension = readFileSync(`${ROOT}/extension.js`, "utf8");
const prefs = readFileSync(`${ROOT}/prefs.js`, "utf8");
const { check, report } = makeChecker("debug-logging");

for (const [name, src, assignment] of [
  ["extension.js", extension, 'DEBUG = this._settings.get_boolean("debug-logging")'],
  ["prefs.js", prefs, 'DEBUG = settings.get_boolean("debug-logging")'],
]) {
  check(`${name}: DEBUG is mutable`, /(^|\n)let DEBUG = false;/.test(src));
  check(`${name}: DEBUG is read from the gsetting`, src.includes(assignment));
  check(`${name}: _log honours DEBUG`, /function _log\([^)]*\)\s*\{\s*if \(DEBUG\)/.test(src));
}

// In the shell the verbose chatter is opt-in, but a provider-chain, cache or
// location failure has to reach the journal of a session where nobody enabled
// debug-logging — that is the only way a user can report a broken chain. The
// prefs process is a window the user opens themselves, so it may stay quiet.
check(
  "extension.js: _warn always logs, never behind DEBUG",
  /function _warn\([^)]*\)\s*\{\s*console\.error/.test(extension) &&
    !/function _warn\([^)]*\)\s*\{\s*if \(DEBUG\)/.test(extension),
);
check(
  "prefs.js: _warn stays behind DEBUG",
  /function _warn\([^)]*\)\s*\{\s*if \(DEBUG\)/.test(prefs),
);

check(
  "extension.js reacts to changes of debug-logging",
  extension.includes('changed::debug-logging'),
);
check(
  "the provider chain logs each provider failure",
  /_warn\("\[Weather\]", WEATHER_PROVIDERS\[key\]\.name, "failed:"/.test(extension),
);
check(
  "a round in which every provider failed is logged",
  extension.includes("All providers failed this round"),
);

process.exit(report() ? 0 : 1);
