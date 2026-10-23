// Preferences wiring: the fallback priority list (order, persistence, which
// providers may join) and the cached-forecast status line.
import { loadBody, loadModule, makeChecker, nowSeconds, DAY_SECONDS } from "./helpers.mjs";

// prefs.js no longer keeps its own provider table: it imports the one in
// lib/providers.js, so the test injects that same real table.
const providers = loadModule("lib/providers.js", "let _gettext", ["WEATHER_PROVIDERS"]);

const sentMessages = [];
const SoupStub = {
  Message: {
    new: (method, url) => {
      const msg = {
        method,
        url,
        request_headers: { append() {} },
        status_code: 0,
        reason_phrase: "Internal Error",
      };
      sentMessages.push(msg);
      return msg;
    },
  },
};

const WeatherPreferences = loadBody("prefs.js", {
  marker: "const GEOCODING_URL",
  name: "WeatherPreferences",
  params: [
    "Adw",
    "Gtk",
    "Gio",
    "GLib",
    "Soup",
    "Gdk",
    "ExtensionPreferences",
    "WEATHER_PROVIDERS",
    "_",
  ],
  args: [
    {},
    {},
    {},
    { get_real_time: () => Date.now() * 1000, PRIORITY_DEFAULT: 0 },
    SoupStub,
    {},
    class {},
    providers.WEATHER_PROVIDERS,
    (s) => s,
  ],
});

/** A preferences object wired to a fake settings store and a fake Soup session. */
function tester(
  key,
  { apiKey = "", url = "", location = "", cache = "{}", status = 200, body = "{}" } = {},
) {
  const store = {
    "weather-provider": key,
    "weather-api-key": apiKey,
    "custom-weather-url": url,
    location,
    "cached-weather-data": cache,
  };
  const toasts = [];
  const before = sentMessages.length;

  const p = new WeatherPreferences();
  p._settings = { get_string: (k) => store[k] ?? "" };
  p._testButton = { set_label() {}, set_sensitive() {} };
  p._cancellable = {};
  p._showToast = (t) => toasts.push(t);
  p._session = {
    send_and_read_async: async (msg) => {
      msg.status_code = status;
      msg.reason_phrase = status === 200 ? "OK" : "Error";
      return { get_data: () => new TextEncoder().encode(body) };
    },
  };
  return { p, toasts, urls: () => sentMessages.slice(before).map((m) => m.url) };
}

const OPEN_METEO_BODY = JSON.stringify({
  current: { temperature_2m: 21.4, weather_code: 1 },
  hourly: { time: [nowSeconds()], temperature_2m: [21] },
  daily: { time: [nowSeconds()], temperature_2m_max: [24], temperature_2m_min: [12] },
});

function settingsFor({ stored = ["openmeteo", "meteosource", "wttr"], customUrl = "", cache = "{}", cachedAt = 0 } = {}) {
  const store = {
    "fallback-provider-order": stored,
    "custom-weather-url": customUrl,
    "cached-weather-data": cache,
    "weather-cached-at": cachedAt,
  };
  return {
    store,
    get_strv: (k) => store[k],
    set_strv: (k, v) => (store[k] = v),
    get_string: (k) => store[k],
    set_string: (k, v) => (store[k] = v),
    get_int64: (k) => store[k],
    set_int64: (k, v) => (store[k] = v),
  };
}

function prefs(settings) {
  const p = new WeatherPreferences();
  p._fallbackOrderGroup = {};
  p._fallbackRowRefs = [];
  p._cacheStatusRow = { _text: null, set_subtitle(t) { this._text = t; } };
  return p;
}

const { check, report } = makeChecker("prefs-ui");

{
  const s = settingsFor();
  const p = prefs(s);
  check(
    "stored order first, remaining providers appended, custom excluded without a URL",
    p._getFallbackKeys(s).join(",") === "openmeteo,meteosource,wttr,openweathermap,weatherapi",
    p._getFallbackKeys(s).join(","),
  );
}
{
  const s = settingsFor({ customUrl: "https://example.invalid/{lat},{lon}" });
  const p = prefs(s);
  check("custom endpoint joins once a URL is configured", p._getFallbackKeys(s).includes("custom"), p._getFallbackKeys(s).join(","));
}
{
  const s = settingsFor({ stored: ["wttr", "ghost-provider", "openmeteo"] });
  const p = prefs(s);
  check(
    "unknown entries are dropped and gaps filled in",
    p._getFallbackKeys(s).join(",") === "wttr,openmeteo,meteosource,openweathermap,weatherapi",
    p._getFallbackKeys(s).join(","),
  );
}
{
  const s = settingsFor();
  const p = prefs(s);
  p._moveFallbackProvider(s, 0, 1);
  check(
    "moving a row down persists the new priority order",
    s.store["fallback-provider-order"].join(",") === "meteosource,openmeteo,wttr,openweathermap,weatherapi",
    s.store["fallback-provider-order"].join(","),
  );
  p._moveFallbackProvider(s, 0, -1);
  check("moving past the top is a no-op", s.store["fallback-provider-order"][0] === "meteosource");
  p._moveFallbackProvider(s, 4, 1);
  check("moving past the bottom is a no-op", s.store["fallback-provider-order"][4] === "weatherapi");
}
{
  const s = settingsFor();
  const p = prefs(s);
  p._updateCacheStatusRow(s);
  check("empty cache reports no data", p._cacheStatusRow._text === "No cached data yet", String(p._cacheStatusRow._text));
}
{
  const payload = {
    providerKey: "wttr",
    provider: "Wttr.in (fallback)",
    current: { temperature_2m: 21.4 },
    hourly: { time: Array(168).fill("x") },
    daily: { time: Array(7).fill("y") },
    fetchedAt: nowSeconds() - 35 * 60,
  };
  const s = settingsFor({ cache: JSON.stringify(payload), cachedAt: payload.fetchedAt });
  const p = prefs(s);
  p._updateCacheStatusRow(s);
  const line = p._cacheStatusRow._text;
  check("status line names the source", /Wttr\.in/.test(line), line);
  check("status line shows the age", /35 min ago/.test(line), line);
  check("status line counts the stored hourly and daily points", /⏰ 168/.test(line) && /📅 7/.test(line), line);
}
{
  const old = {
    providerKey: "openmeteo",
    current: { temperature_2m: 3 },
    daily: { time: ["y"] },
    fetchedAt: nowSeconds() - 3 * DAY_SECONDS,
  };
  const s = settingsFor({ cache: JSON.stringify(old) });
  const p = prefs(s);
  p._updateCacheStatusRow(s);
  check("older caches are reported in days", /3 days ago/.test(p._cacheStatusRow._text), p._cacheStatusRow._text);
}
{
  const s = settingsFor({ cache: "{not json" });
  const p = prefs(s);
  p._updateCacheStatusRow(s);
  check("a corrupt cache is reported, not thrown", /unreadable/.test(p._cacheStatusRow._text), String(p._cacheStatusRow._text));
}

{
  // The provider combo reports its selection while the page is still being
  // built, before the API key / custom URL rows exist; that must not throw.
  const p = prefs(settingsFor());
  let threw = null;
  try {
    p._updateProviderSettings("openweathermap");
    p._updateProviderSettings("no-such-provider");
  } catch (e) {
    threw = e.message;
  }
  check("the provider detail rows may not exist yet", threw === null, String(threw));

  p._apiKeyRow = { visible: null };
  p._customUrlRow = { visible: null };
  p._providerInfoRow = { _text: null, set_subtitle(t) { this._text = t; } };
  p._updateProviderSettings("openweathermap");
  check("a keyed provider shows the API key row", p._apiKeyRow.visible === true, String(p._apiKeyRow.visible));
  check("the custom URL row stays hidden for other providers", p._customUrlRow.visible === false, String(p._customUrlRow.visible));
  p._updateProviderSettings("custom");
  check("the custom provider reveals its URL row", p._customUrlRow.visible === true, String(p._customUrlRow.visible));
  p._updateProviderSettings("openmeteo");
  check("a free provider hides the API key row again", p._apiKeyRow.visible === false, String(p._apiKeyRow.visible));
  check("the provider info row is filled in", /Base URL/.test(p._providerInfoRow._text), String(p._providerInfoRow._text));
}

{
  const t = tester("openmeteo", {
    location: "30.66,104.06",
    body: OPEN_METEO_BODY,
  });
  await t.p._testWeatherConnection();
  check(
    "the test asks for the configured location through the shared adapter",
    /latitude=30\.66/.test(t.urls()[0] ?? "") && /longitude=104\.06/.test(t.urls()[0] ?? ""),
    t.urls()[0],
  );
  check(
    "a valid payload reports the parsed temperature",
    /Connection successful/.test(t.toasts[0] ?? "") && /21°C/.test(t.toasts[0] ?? ""),
    t.toasts[0],
  );
}
{
  const t = tester("openmeteo", { cache: JSON.stringify({ lat: 29.56, lon: 106.55 }), body: OPEN_METEO_BODY });
  await t.p._testWeatherConnection();
  check(
    "an auto-detected location is reused from the cache",
    /latitude=29\.56/.test(t.urls()[0] ?? ""),
    t.urls()[0],
  );
}
{
  const t = tester("meteosource");
  await t.p._testWeatherConnection();
  check(
    "the prefs test uses the same local-time request as the panel",
    /[?&]timezone=local(&|$)/.test(t.urls()[0] ?? ""),
    t.urls()[0],
  );
}
{
  const t = tester("custom", { url: "" });
  await t.p._testWeatherConnection();
  check(
    "a custom provider without a URL is refused before any request",
    t.urls().length === 0 && /Custom URL is required/.test(t.toasts[0] ?? ""),
    JSON.stringify({ urls: t.urls(), toast: t.toasts[0] }),
  );
}
{
  const t = tester("openweathermap", { apiKey: "" });
  await t.p._testWeatherConnection();
  check(
    "a keyed provider without a key is refused before any request",
    t.urls().length === 0 && /API key is required for/.test(t.toasts[0] ?? ""),
    JSON.stringify({ urls: t.urls(), toast: t.toasts[0] }),
  );
}
{
  const t = tester("openmeteo", { body: JSON.stringify({ not: "weather" }) });
  await t.p._testWeatherConnection();
  check(
    "a response with no weather data is reported as such",
    /no weather data found/.test(t.toasts[0] ?? ""),
    t.toasts[0],
  );
}
{
  const t = tester("openmeteo", { status: 503, body: "{}" });
  await t.p._testWeatherConnection();
  check(
    "a non-200 answer surfaces its status",
    /HTTP 503/.test(t.toasts[0] ?? ""),
    t.toasts[0],
  );
}
check(
  "prefs no longer carries a second provider table",
  !/const WEATHER_PROVIDERS = \{/.test(
    await import("node:fs").then((fs) => fs.readFileSync(new URL("../prefs.js", import.meta.url), "utf8")),
  ),
);

process.exit(report() ? 0 : 1);
