// Provider fallback chain + offline cache behaviour, exercised through the real
// methods in extension.js (network and gsettings are stubbed).
import {
  loadBody,
  loadModule,
  makeChecker,
  DAY_SECONDS,
  nowSeconds,
} from "./helpers.mjs";

const providers = loadModule("lib/providers.js", "let _gettext", [
  "WEATHER_PROVIDERS",
  "getWeatherConditions",
]);

let ONLINE = true;
const Gio = {
  IOErrorEnum: { CANCELLED: 19, TIMED_OUT: 34 },
  NetworkMonitor: {
    get_default: () => ({ get_network_available: () => ONLINE }),
  },
};
const Soup = {
  Message: {
    new: (_method, url) => ({ url, request_headers: { append() {} } }),
  },
  ClientError: { TIMEOUT: 5 },
};
// clockOffsetMs lets the clock-jump scenarios move the wall clock the
// extension sees, without touching the process clock the test helpers use.
let clockOffsetMs = 0;
const GLib = {
  PRIORITY_DEFAULT: 0,
  get_real_time: () => (Date.now() + clockOffsetMs) * 1000, // microseconds, as GLib reports them
};

let attempts = [];
let planFor = () => ({ status: 500, reason: "Server Error" });

const session = {
  timeout: 15,
  async send_and_read_async(msg) {
    const host = new URL(msg.url).hostname;
    attempts.push(host);
    const plan = planFor(host);
    // A pending promise models a request that never completes.
    if (plan instanceof Promise) return plan;
    msg.status_code = plan.status;
    msg.reason_phrase = plan.reason ?? "";
    const payload = plan.status === 200 ? JSON.stringify(plan.json) : "{}";
    return { get_data: () => new TextEncoder().encode(payload) };
  },
};

const WeatherExtension = loadBody("extension.js", {
  marker: "let DEBUG = false;",
  name: "WeatherExtension",
  params: [
    "Gio",
    "Soup",
    "GLib",
    "Main",
    "MessageTray",
    "Extension",
    "WEATHER_PROVIDERS",
    "setGettext",
    "getWeatherConditions",
    "LocationManager",
    "WeatherPanelButton",
    "evaluateAlerts",
    "setAlertsGettext",
    "NOTIFIABLE_SEVERITIES",
  ],
  args: [
    Gio,
    Soup,
    GLib,
    {},
    {},
    class {
      gettext(s) {
        return s;
      }
    },
    providers.WEATHER_PROVIDERS,
    () => {},
    providers.getWeatherConditions,
    class {},
    class {},
    () => [],
    () => {},
    new Set(),
  ],
});

// A payload in the shape the panel consumes: current + hourly + daily.
function forecast(daysFromNow = 0) {
  const day = (n) => new Date(Date.now() + n * DAY_SECONDS * 1000).toISOString().slice(0, 10);
  return {
    current: { temperature_2m: 20, weather_code: 2 },
    hourly: { time: ["x"], temperature_2m: [1] },
    daily: { time: [day(daysFromNow), day(daysFromNow + 1)] },
  };
}

function settingsFor({
  provider = "openmeteo",
  apiKey = "",
  customUrl = "",
  fallback = true,
  cache = "{}",
  cachedAt = 0,
  maxAgeDays = 7,
} = {}) {
  const store = {
    "weather-provider": provider,
    "weather-api-key": apiKey,
    "custom-weather-url": customUrl,
    "enable-provider-fallback": fallback,
    "fallback-provider-order": ["openmeteo", "meteosource", "wttr"],
    "cached-weather-data": cache,
    "weather-cached-at": cachedAt,
    "weather-cache-max-age-days": maxAgeDays,
    "enable-weather-alerts": false,
    "show-alerts-in-panel": true,
    "use-fahrenheit": false,
    "debug-logging": false,
  };
  return {
    store,
    get_string: (k) => store[k],
    get_boolean: (k) => store[k],
    get_int: (k) => store[k],
    get_int64: (k) => store[k],
    get_strv: (k) => store[k],
    set_string: (k, v) => (store[k] = v),
    set_int64: (k, v) => (store[k] = v),
  };
}

function panelStub() {
  const rec = { weather: [], status: [], label: null, icon: null };
  return {
    _destroyed: false,
    rec,
    _weatherLabel: { set_text: (t) => (rec.label = t) },
    _weatherIcon: { set_icon_name: (i) => (rec.icon = i) },
    updateWeather: (d) => rec.weather.push(d),
    updateProviderStatus: (p, s, e) => rec.status.push([p, s, e]),
    updateAlerts: () => {},
  };
}

function ext(options = {}) {
  const e = new WeatherExtension();
  e._enabled = true;
  e._settings = settingsFor(options);
  e._session = session;
  e._cancellable = null;
  e._latitude = 52.52;
  e._longitude = 13.405;
  e._locationName = "Berlin, DE";
  e._panelButton = panelStub();
  e._lastAlertKey = null;
  e._weatherLoadInFlight = false;
  e._weatherLoadQueued = false;
  return e;
}

const allFail = () => (planFor = () => ({ status: 500, reason: "Server Error" }));
const cachedPayload = ({ ageSeconds, dayOffset = 0, providerKey = "openmeteo", lat = 52.52, lon = 13.405 }) => {
  const data = {
    ...forecast(dayOffset),
    providerKey,
    provider: providers.WEATHER_PROVIDERS[providerKey]?.name ?? providerKey,
    location: "Berlin, DE",
    lat,
    lon,
    fetchedAt: nowSeconds() - ageSeconds,
  };
  return { cache: JSON.stringify(data), cachedAt: data.fetchedAt };
};

const { check, report } = makeChecker("provider-chain");

// ── the chain ───────────────────────────────────────────────────────────────
{
  attempts = [];
  allFail();
  const e = ext();
  await e._loadWeatherData();
  const r = e._panelButton.rec;
  check("every free provider is tried, including the default one", attempts.length === 3, attempts.join(","));
  check("no cache means an error is shown", r.weather.length === 0 && r.label === "Error", String(r.label));
  const lastStatus = new Map(r.status.map(([p, s]) => [p, s]));
  const errors = [...lastStatus.entries()].filter(([, s]) => s === "error").map(([p]) => p);
  check(
    "every provider we did try ends up reported as error",
    errors.length === 3,
    JSON.stringify(errors),
  );
  check(
    "providers we cannot call are marked inactive instead of keeping an old status",
    ["openweathermap", "weatherapi", "custom"].every((k) => lastStatus.get(k) === "inactive"),
    JSON.stringify([...lastStatus]),
  );
}
{
  attempts = [];
  allFail();
  const e = ext({ apiKey: "secret", customUrl: "https://pws.example/v1" });
  await e._loadWeatherData();
  const st = new Map(e._panelButton.rec.status.map(([p, s]) => [p, s]));
  check(
    "with a key and a custom URL no provider is written off",
    ![...st.values()].includes("inactive"),
    JSON.stringify([...st]),
  );
}
{
  attempts = [];
  allFail();
  const e = ext({ apiKey: "secret" });
  await e._loadWeatherData();
  check(
    "with an API key every provider is tried exactly once",
    attempts.length === 5 && new Set(attempts).size === 5,
    attempts.join(","),
  );
  check(
    "key-required providers join the chain",
    attempts.some((h) => h.includes("openweathermap")) && attempts.some((h) => h.includes("weatherapi")),
    attempts.join(","),
  );
}
{
  attempts = [];
  allFail();
  const e = ext({ fallback: false });
  await e._loadWeatherData();
  check("fallback disabled → only the configured provider", attempts.length === 1, attempts.join(","));
}
{
  attempts = [];
  allFail();
  const e = ext({ provider: "openweathermap", apiKey: "" });
  await e._loadWeatherData();
  check("missing key does not stop the chain", attempts.length >= 3, attempts.join(","));
  check("missing key is surfaced as No Key", e._panelButton.rec.label === "No Key", String(e._panelButton.rec.label));
}
{
  attempts = [];
  planFor = (host) =>
    host === "wttr.in"
      ? { status: 503, reason: "Unavailable" }
      : { status: 200, reason: "OK", json: forecast(0) };
  const e = ext({ provider: "wttr" });
  await e._loadWeatherData();
  const r = e._panelButton.rec;
  check("configured provider is attempted first", attempts[0] === "wttr.in", attempts.join(","));
  check("falls back to a working provider", r.weather.length === 1 && r.weather[0].providerKey !== "wttr");
  check("fallback is labelled in the payload", /\(fallback\)/.test(r.weather[0]?.provider ?? ""), r.weather[0]?.provider);
  check("each provider is tried at most once", new Set(attempts).size === attempts.length, attempts.join(","));
  check("the failing provider is marked error", r.status.some(([p, s]) => p === "wttr" && s === "error"));
  check("the answering provider is not marked error", !r.status.some(([p, s]) => p === r.weather[0].providerKey && s === "error"));
  const written = JSON.parse(e._settings.store["cached-weather-data"]);
  check(
    "success writes the full payload (hourly + daily + timestamp) to the cache",
    !!written.hourly?.time && !!written.daily?.time && written.fetchedAt > 0,
  );
}

// ── the cache ───────────────────────────────────────────────────────────────
{
  attempts = [];
  allFail();
  const e = ext(cachedPayload({ ageSeconds: 7200, providerKey: "wttr" }));
  await e._loadWeatherData();
  const r = e._panelButton.rec;
  check("all providers down → cached forecast is served", r.weather.length === 1);
  check("cached payload is flagged stale", r.weather[0]?.stale === true);
  check("hourly and daily survive the round trip", !!r.weather[0]?.hourly?.time && !!r.weather[0]?.daily?.time);
  check("cached source is labelled", /cached data/.test(r.weather[0]?.provider ?? ""), r.weather[0]?.provider);
  check("no error text in the panel", r.label !== "Error" && r.label !== "Offline", String(r.label));
  const last = new Map(r.status.map(([p, s]) => [p, s]));
  check("no provider left stuck in testing", r.status.length > 0 && [...last.values()].every((v) => v !== "testing"));
}
{
  attempts = [];
  allFail();
  const e = ext(cachedPayload({ ageSeconds: 8 * DAY_SECONDS }));
  await e._loadWeatherData();
  check("cache older than the 7 day window is refused", e._panelButton.rec.weather.length === 0 && e._panelButton.rec.label === "Error");
}
{
  attempts = [];
  allFail();
  const e = ext({ ...cachedPayload({ ageSeconds: 2 * DAY_SECONDS, dayOffset: -3 }) });
  await e._loadWeatherData();
  check("cache whose forecast horizon already ended is refused", e._panelButton.rec.weather.length === 0);
}
{
  attempts = [];
  allFail();
  const e = ext(cachedPayload({ ageSeconds: 3600, lat: 40.7128, lon: -74.006 }));
  await e._loadWeatherData();
  check("cache from other coordinates is not reused", e._panelButton.rec.weather.length === 0);
}
{
  attempts = [];
  allFail();
  const e = ext({ ...cachedPayload({ ageSeconds: 2 * DAY_SECONDS }), maxAgeDays: 3 });
  await e._loadWeatherData();
  check("cache window follows weather-cache-max-age-days", e._panelButton.rec.weather.length === 1);
}
{
  attempts = [];
  allFail();
  const payload = (ageSeconds) =>
    JSON.stringify({
      current: { temperature_2m: 11 },
      hourly: null,
      daily: null,
      providerKey: "openweathermap",
      lat: 52.52,
      lon: 13.405,
      fetchedAt: nowSeconds() - ageSeconds,
    });
  const fresh = ext({ provider: "openweathermap", apiKey: "k", cache: payload(3 * 3600) });
  await fresh._loadWeatherData();
  check("forecast-less cache is reusable for a day", fresh._panelButton.rec.weather.length === 1);
  const old = ext({ provider: "openweathermap", apiKey: "k", cache: payload(2 * DAY_SECONDS) });
  await old._loadWeatherData();
  check("forecast-less cache older than a day is refused", old._panelButton.rec.weather.length === 0);
}
{
  attempts = [];
  ONLINE = false;
  planFor = () => ({ status: 0, reason: "" });
  const e = ext(cachedPayload({ ageSeconds: 3600 }));
  await e._loadWeatherData();
  check("offline → cached forecast instead of the Offline label", e._panelButton.rec.weather.length === 1 && e._panelButton.rec.label !== "Offline", String(e._panelButton.rec.label));
  ONLINE = true;
}
{
  attempts = [];
  allFail();
  const e = ext();
  const first = e._loadWeatherData();
  const second = e._loadWeatherData(); // arrives while the first round is in flight
  await Promise.all([first, second]);
  await new Promise((r) => setTimeout(r, 20)); // the queued round is fire-and-forget
  const roundsAreClean =
    attempts.length === 6 && attempts.slice(3).join(",") === attempts.slice(0, 3).join(",");
  check("a second request during a round is queued, not interleaved", roundsAreClean, attempts.join(","));
}

// ── backward clock jumps (NTP step, manual correction, dead CMOS) ──────────
{
  // Realistic sequence: a round succeeds, the clock is then corrected three
  // hours backwards, and the next round finds every provider down. The cached
  // fetch is hours old, but the shifted clock makes its stamp look three
  // hours in the future — the panel must keep showing it, not flip to Error.
  attempts = [];
  planFor = () => ({ status: 200, reason: "OK", json: forecast(0) });
  const e = ext();
  await e._loadWeatherData();
  clockOffsetMs = -3 * 3600 * 1000;
  allFail();
  await e._loadWeatherData();
  clockOffsetMs = 0;
  const r = e._panelButton.rec;
  check(
    "a 3 h backward correction keeps the last forecast on the panel",
    r.weather.length === 2 && r.weather[1]?.stale === true,
    `updates=${r.weather.length}, label=${r.label}`,
  );
  check(
    "the backward jump does not push the panel to Error",
    r.label !== "Error",
    String(r.label),
  );
}
{
  attempts = [];
  allFail();
  const e = ext(cachedPayload({ ageSeconds: 3600 })); // fetched 1 h ago
  clockOffsetMs = -10 * 3600 * 1000; // clock corrected 10 h backwards
  await e._loadWeatherData();
  clockOffsetMs = 0;
  check(
    "a cache the corrected clock puts 9 h in the future is still served",
    e._panelButton.rec.weather.length === 1,
    `label=${e._panelButton.rec.label}`,
  );
}
{
  attempts = [];
  allFail();
  const e = ext(cachedPayload({ ageSeconds: 3600 }));
  clockOffsetMs = -40 * DAY_SECONDS * 1000; // e.g. a dead CMOS battery
  await e._loadWeatherData();
  clockOffsetMs = 0;
  check(
    "data the clock claims was fetched 40 days from now is refused",
    e._panelButton.rec.weather.length === 0 && e._panelButton.rec.label === "Error",
    `updates=${e._panelButton.rec.weather.length}, label=${e._panelButton.rec.label}`,
  );
}
{
  // Forecast-less payloads (their one-day rule) must survive small
  // corrections but not an implausible future stamp either.
  attempts = [];
  allFail();
  const owm = {
    provider: "openweathermap",
    apiKey: "k",
    cache: JSON.stringify({
      current: { temperature_2m: 11 },
      hourly: null,
      daily: null,
      providerKey: "openweathermap",
      lat: 52.52,
      lon: 13.405,
      fetchedAt: nowSeconds(),
    }),
  };
  const small = ext(owm);
  clockOffsetMs = -6 * 3600 * 1000;
  await small._loadWeatherData();
  clockOffsetMs = 0;
  check(
    "forecast-less cache survives a 6 h backward jump",
    small._panelButton.rec.weather.length === 1,
    `label=${small._panelButton.rec.label}`,
  );
  const big = ext(owm);
  clockOffsetMs = -3 * DAY_SECONDS * 1000;
  await big._loadWeatherData();
  clockOffsetMs = 0;
  check(
    "forecast-less cache 3 days in the future is refused",
    big._panelButton.rec.weather.length === 0,
  );
}

// ── failures are visible without debug-logging ──────────────────────────────
{
  attempts = [];
  allFail();
  const lines = [];
  const realError = console.error;
  console.error = (...a) => lines.push(a.map(String).join(" "));
  try {
    const e = ext();
    await e._loadWeatherData();
  } finally {
    console.error = realError;
  }
  check(
    "provider failures are logged even with debug-logging off",
    lines.some((l) => /\[Weather\].*failed/.test(l)),
    JSON.stringify(lines.slice(0, 2)),
  );
}

// ── cached data is the baseline for a round, not only its consolation prize ─
{
  attempts = [];
  planFor = () => new Promise(() => {}); // the provider never answers
  const e = ext(cachedPayload({ ageSeconds: 3600 }));
  e._loadWeatherData(); // deliberately not awaited: this round hangs
  await new Promise((r) => setTimeout(r, 20));
  const r = e._panelButton.rec;
  check(
    "a hanging round still shows the cached forecast",
    r.weather.length === 1 && r.weather[0]?.stale === true,
    `updates=${r.weather.length}`,
  );
  check(
    "no error label while providers are still hanging",
    r.label === null,
    String(r.label),
  );
}
{
  attempts = [];
  allFail();
  const e = ext(cachedPayload({ ageSeconds: 3600 }));
  await e._loadWeatherData();
  check(
    "a failing round paints the cache once, not twice",
    e._panelButton.rec.weather.length === 1,
    `updates=${e._panelButton.rec.weather.length}`,
  );
}
{
  attempts = [];
  planFor = () => ({ status: 200, reason: "OK", json: forecast(0) });
  const e = ext(cachedPayload({ ageSeconds: 3600 }));
  await e._loadWeatherData();
  const w = e._panelButton.rec.weather;
  check(
    "live data replaces the cached baseline inside the same round",
    w.length === 2 && w[0].stale === true && w[1].stale === false,
    JSON.stringify(w.map((x) => x.stale)),
  );
}

// ── forecast horizon normalisation across provider date formats ─────────────
{
  attempts = [];
  allFail();
  const epochDay = (n) => Math.floor((Date.now() + n * DAY_SECONDS * 1000) / 1000);
  const withDays = (days, ageSeconds) =>
    JSON.stringify({
      current: { temperature_2m: 5 },
      hourly: null,
      daily: { time: days, temperature_2m_max: [1, 2] },
      providerKey: "custom",
      lat: 52.52,
      lon: 13.405,
      fetchedAt: nowSeconds() - ageSeconds,
    });
  const custom = { provider: "custom", customUrl: "https://pws.example/v1" };

  const seconds = ext({ ...custom, cache: withDays([String(epochDay(0)), String(epochDay(6))], DAY_SECONDS) });
  await seconds._loadWeatherData();
  check("epoch-seconds forecast dates are understood", seconds._panelButton.rec.weather.length === 1);

  const millis = ext({ ...custom, cache: withDays([epochDay(0) * 1000, epochDay(6) * 1000], DAY_SECONDS) });
  await millis._loadWeatherData();
  check("epoch-milliseconds forecast dates are understood", millis._panelButton.rec.weather.length === 1);

  const bogus = ext({ ...custom, cache: withDays(["0", "1", "2"], 6 * 3600) });
  await bogus._loadWeatherData();
  check("an unparseable day list falls back to the age rule", bogus._panelButton.rec.weather.length === 1);

  const staleBogus = ext({ ...custom, cache: withDays(["0", "1", "2"], 2 * DAY_SECONDS) });
  await staleBogus._loadWeatherData();
  check("an unparseable day list older than a day is refused", staleBogus._panelButton.rec.weather.length === 0);
}

// ── a 200 answer that is not weather data ──────────────────────────────────
{
  attempts = [];
  planFor = () => ({ status: 200, reason: "OK", json: { error: true, reason: "No matching location found." } });
  const e = ext({ fallback: false });
  await e._loadWeatherData();
  const r = e._panelButton.rec;
  check(
    "a response body the adapter rejects marks the provider as error",
    r.status.some(([p, s]) => p === "openmeteo" && s === "error"),
    JSON.stringify(r.status),
  );
  check(
    "a rejected body is not written to the cache",
    (e._settings.store["cached-weather-data"] ?? "{}") === "{}",
    String(e._settings.store["cached-weather-data"]).slice(0, 40),
  );
  check("a rejected body still ends on the error label", r.label === "Error", String(r.label));
}
{
  // The same round, with a second provider that answers properly: a bad body
  // must move the chain along, and the real wttr adapter must normalize what
  // it gets (its own day/hour format becomes the canonical keys on the way in).
  attempts = [];
  const today = new Date().toISOString().slice(0, 10);
  planFor = (host) => {
    if (host === "api.open-meteo.com")
      return { status: 200, reason: "OK", json: { error: true, reason: "No matching location found." } };
    if (host === "wttr.in")
      return {
        status: 200,
        reason: "OK",
        json: {
          current_condition: [
            { temp_C: "20", humidity: "60", pressure: "1013", weatherCode: "113", windspeedKmph: "5", winddir16Point: "N" },
          ],
          weather: [
            {
              date: today,
              maxtempC: "24",
              mintempC: "12",
              hourly: [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400].map((t) => ({
                time: String(t),
                tempC: "20",
                weatherCode: "113",
                chanceofrain: "0",
                windspeedKmph: "5",
              })),
            },
          ],
        },
      };
    return { status: 500, reason: "Server Error" };
  };
  const e = ext();
  await e._loadWeatherData();
  const r = e._panelButton.rec;
  check(
    "a rejected body moves the chain to the next provider",
    r.weather.length === 1 && r.weather[0].providerKey === "wttr",
    JSON.stringify(r.weather.map((w) => w.providerKey)),
  );
  const got = r.weather[0];
  check(
    "the fallback payload carries canonical time keys",
    (got?.hourly?.time ?? []).every((t) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t)) &&
      (got?.daily?.time ?? []).every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t)),
    JSON.stringify({ hourly: got?.hourly?.time?.slice(0, 2), daily: got?.daily?.time }),
  );
  const cached = JSON.parse(e._settings.store["cached-weather-data"] ?? "{}");
  check(
    "the cached copy keeps the same canonical keys",
    (cached.hourly?.time ?? []).length === 8 &&
      cached.hourly.time.every((t) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t)) &&
      cached.daily?.time?.[0] === today,
    JSON.stringify({ hourly: cached.hourly?.time?.slice(0, 2), daily: cached.daily?.time }),
  );
}

process.exit(report() ? 0 : 1);
