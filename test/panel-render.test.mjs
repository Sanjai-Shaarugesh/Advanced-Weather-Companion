// Panel rendering behaviour: fallback provider status, cached-data badge, and
// the hourly / 7-day sections when the payload comes from the offline cache.
// The real WeatherPanelButton methods are used; only the widgets are stubbed.
import { loadBody, loadModule, makeChecker, dateStr, hourStr, DAY_SECONDS, nowSeconds } from "./helpers.mjs";

const providers = loadModule("lib/providers.js", "let _gettext", [
  "WEATHER_PROVIDERS",
  "getWeatherConditions",
  "WIND_SPEED_UNITS",
  "convertWindSpeed",
  "canonicalTime",
]);

class StLabel {
  constructor(o) {
    this._text = o?.text ?? "";
  }
  set_text(t) {
    this._text = t;
  }
}
class StBox {
  constructor(o) {
    this.opts = o;
    this.children = [];
  }
  add_child(c) {
    this.children.push(c);
  }
  remove_all_children() {
    this.children = [];
  }
}
class StIcon {
  constructor(o) {
    this.icon_name = o?.icon_name;
  }
  set_icon_name(n) {
    this.icon_name = n;
  }
}

class MenuSection {
  constructor() {
    this.items = [];
  }
  addMenuItem(i) {
    this.items.push(i);
  }
  removeAll() {
    this.items = [];
  }
}
class PopItem {
  constructor(text) {
    this.text = text;
    this.label = new StLabel({ text });
    this.actor = { visible: true };
  }
  connect() {
    return 1;
  }
}
class BaseItem {
  constructor() {
    this.children = [];
    this.actor = { visible: true };
  }
  add_child(c) {
    this.children.push(c);
  }
  connect() {
    return 1;
  }
}

const WeatherPanelButton = loadBody("lib/panelMenu.js", {
  marker: "const GEOCODING_URL",
  name: "WeatherPanelButton",
  params: [
    "St",
    "GObject",
    "Gio",
    "GLib",
    "Clutter",
    "PanelMenu",
    "PopupMenu",
    "WEATHER_PROVIDERS",
    "getWeatherConditions",
    "WIND_SPEED_UNITS",
    "convertWindSpeed",
    "canonicalTime",
  ],
  args: [
    { BoxLayout: StBox, Label: StLabel, Icon: StIcon },
    { registerClass: (c) => c },
    { NetworkMonitor: { get_default: () => ({ get_network_available: () => true }) } },
    { PRIORITY_DEFAULT: 0 },
    { ActorAlign: { CENTER: 1, START: 0 } },
    { Button: class {} },
    {
      PopupMenuItem: PopItem,
      PopupBaseMenuItem: BaseItem,
      PopupSeparatorMenuItem: class {
        constructor() {
          this.actor = { visible: true };
        }
      },
      PopupMenuSection: MenuSection,
      PopupSubMenuMenuItem: class {
        constructor(label) {
          this.label = new StLabel({ text: label });
          this.menu = new MenuSection();
        }
      },
    },
    providers.WEATHER_PROVIDERS,
    providers.getWeatherConditions,
    providers.WIND_SPEED_UNITS,
    providers.convertWindSpeed,
    providers.canonicalTime,
  ],
});

function button(configuredProvider, { values = {} } = {}) {
  const strings = { "custom-weather-url": "", "weather-api-key": "", ...values };
  const b = Object.create(WeatherPanelButton.prototype);
  b._destroyed = false;
  b._settings = {
    get_boolean: (k) => k !== "use-fahrenheit",
    get_string: (k) =>
      k === "weather-provider"
        ? configuredProvider
        : k === "wind-speed-unit"
          ? "kmh"
          : k in strings
            ? strings[k]
            : "auto",
    get_int: () => 16,
    connect: () => 1,
    disconnect: () => {},
  };
  b._ext = { _(s) { return s; }, gettext: (s) => s, _latitude: 52.52, _longitude: 13.405 };
  b._weatherIcon = new StIcon({ icon_name: "x" });
  b._weatherLabel = new StLabel({ text: "…" });
  b._alertBadge = { visible: false };
  b._providerStatus = new Map();
  b._lastGoodUpdate = null;
  b._showingCachedData = false;
  b._retryCount = 0;
  b._activeAlerts = [];
  for (const field of [
    "_currentWeatherItem",
    "_currentLocationItem",
    "_coordinatesItem",
    "_detectionMethodItem",
    "_currentProviderItem",
    "_providerStatusItem",
    "_lastUpdateItem",
  ])
    b[field] = new PopItem("");
  for (const field of ["_hourlySection", "_dailySection", "_insightsSection"])
    b[field] = { menu: new MenuSection() };
  b._providersStatusSection = new MenuSection();
  return b;
}

function payload({ providerKey = "openmeteo", provider = "Open-Meteo", stale = false, fetchedAt = nowSeconds(), hours, days } = {}) {
  const allHours = Array.from({ length: 26 }, (_, i) => hourStr(i - 5));
  const allDays = [-1, 0, 1, 2, 3, 4, 5, 6].map(dateStr);
  return {
    location: "Berlin, DE",
    current: {
      temperature_2m: 21,
      relative_humidity_2m: 60,
      surface_pressure: 1013,
      weather_code: 2,
      wind_speed_10m: 12,
    },
    hourly: {
      time: hours ?? allHours,
      temperature_2m: Array(allHours.length).fill(20),
      weather_code: Array(allHours.length).fill(2),
      precipitation_probability: Array(allHours.length).fill(10),
      wind_speed_10m: Array(allHours.length).fill(10),
    },
    daily: {
      time: days ?? allDays,
      weather_code: Array(allDays.length).fill(2),
      temperature_2m_max: Array(allDays.length).fill(25),
      temperature_2m_min: Array(allDays.length).fill(14),
    },
    providerKey,
    provider,
    fetchedAt,
    stale,
  };
}

const rowTexts = (item) =>
  item.children.flatMap((c) => c.children?.map((l) => l._text) ?? [c._text ?? item.text]);

const { check, report } = makeChecker("panel-render");

{
  const b = button("openmeteo");
  b.updateWeather(payload({ providerKey: "wttr", provider: "Wttr.in (fallback)" }));
  check("the provider that answered is the one marked working", b._providerStatus.get("wttr") === "working", JSON.stringify([...b._providerStatus]));
  check("the configured provider is not falsely marked working", b._providerStatus.get("openmeteo") !== "working");
  check("live data carries no cache badge", b._showingCachedData === false);
}
{
  const b = button("openmeteo");
  const fetchedAt = nowSeconds() - 7200;
  b.updateWeather(payload({ providerKey: "wttr", provider: "Wttr.in (cached data)", stale: true, fetchedAt }));
  check("cached data shows a temperature, not Error", /\d+°C/.test(b._weatherLabel._text), b._weatherLabel._text);
  check("cached source is reported with its own status", b._providerStatus.get("wttr") === "cached", JSON.stringify([...b._providerStatus]));
  check("the current block names the cached time", /Cached data from/.test(b._currentWeatherItem.label._text), b._currentWeatherItem.label._text);
  check("Last Update is the fetch time, not now", b._lastUpdateItem.label._text.includes(b._formatDateTime(new Date(fetchedAt * 1000))), b._lastUpdateItem.label._text);
  check("hourly and 7-day sections are populated", b._hourlySection.menu.items.length > 0 && b._dailySection.menu.items.length > 0);
}
{
  const b = button("openmeteo");
  b.updateWeather(payload({ stale: true, fetchedAt: nowSeconds() - 7200 }));
  const items = b._hourlySection.menu.items;
  check("12 upcoming hours are rendered", items.length === 12, "n=" + items.length);
  check("rendering starts at the first upcoming hour", rowTexts(items[0])[0] === b._formatTime(hourStr(1)), rowTexts(items[0])[0]);
  check("hours that already passed are dropped", ![0, 1, 2, 3, 4, 5].some((n) => rowTexts(items[0]).includes(b._formatTime(hourStr(-n)))));
}
{
  const b = button("openmeteo");
  b.updateWeather(payload({ hours: [hourStr(-5), hourStr(-4), hourStr(-3)], stale: true, fetchedAt: nowSeconds() - 4 * DAY_SECONDS }));
  const items = b._hourlySection.menu.items;
  check("an elapsed hourly window is announced instead of replayed", items.length === 1 && /no upcoming hours/.test(items[0].text), JSON.stringify(items.map((i) => i.text)));
}
{
  const b = button("openmeteo");
  b.updateWeather(payload({ stale: true, fetchedAt: nowSeconds() - DAY_SECONDS }));
  const items = b._dailySection.menu.items;
  check("elapsed days are dropped and 7 days remain", items.length === 7, "n=" + items.length);
  check("first row is Today", rowTexts(items[0])[0] === "Today", rowTexts(items[0])[0]);
  check("second row is Tomorrow", rowTexts(items[1])[0] === "Tomorrow", rowTexts(items[1])[0]);
}
{
  // A green check must not survive for a provider we cannot actually call.
  const b = button("openmeteo");
  b.updateProviderStatus("custom", "working");
  b.updateProviderStatus("openweathermap", "working");
  const rows = b._providersStatusSection.items.map((i) => i.text);
  check(
    "an unconfigured custom endpoint is never shown as working",
    rows.at(-1).startsWith("💤"),
    JSON.stringify(rows.at(-1)),
  );
  check(
    "paid providers without a key are shown as not configured",
    rows.some((t) => t.startsWith("💤") && /OpenWeatherMap/.test(t)),
    JSON.stringify(rows),
  );
}
{
  const b = button("openmeteo", {
    values: { "custom-weather-url": "https://pws.example/v1", "weather-api-key": "key" },
  });
  b.updateProviderStatus("custom", "working");
  b.updateProviderStatus("openweathermap", "working");
  const rows = b._providersStatusSection.items.map((i) => i.text);
  check(
    "a configured custom endpoint keeps its check",
    rows.at(-1).startsWith("✅"),
    JSON.stringify(rows.at(-1)),
  );
  check(
    "a keyed paid provider keeps its check",
    rows.some((t) => t.startsWith("✅") && /OpenWeatherMap/.test(t)),
    JSON.stringify(rows),
  );
}
{
  const b = button("openweathermap");
  b.updateWeather({ providerKey: "wttr", current: null }); // deliberate broken payload
  check("a broken payload marks its own provider", b._providerStatus.get("wttr") === "error" && b._providerStatus.get("openweathermap") === undefined, JSON.stringify([...b._providerStatus]));
}
{
  const b = button("openmeteo");
  b.updateProviderStatus("openmeteo", "error", "HTTP 503");
  check("a failed round does not pretend the data is new", /Never$/.test(b._lastUpdateItem.label._text), b._lastUpdateItem.label._text);
  b.updateWeather(payload());
  b.updateProviderStatus("openmeteo", "error", "HTTP 503");
  check("a later failure keeps the last successful timestamp", b._lastUpdateItem.label._text.includes(b._formatDateTime(b._lastGoodUpdate)), b._lastUpdateItem.label._text);
}

{
  // A custom endpoint can deliver hourly.time + temperatures but no weather
  // codes: the menu has to degrade, not take the whole panel down.
  const b = button("custom");
  const p = payload();
  delete p.hourly.weather_code;
  delete p.daily.weather_code;
  b.updateWeather(p);
  check(
    "hourly rows survive a payload without weather codes",
    b._hourlySection.menu.items.length === 12,
    "n=" + b._hourlySection.menu.items.length,
  );
  check(
    "a missing hourly code renders as the neutral condition",
    rowTexts(b._hourlySection.menu.items[0]).includes("Clear Sky"),
    JSON.stringify(rowTexts(b._hourlySection.menu.items[0])),
  );
  check(
    "daily rows survive a payload without weather codes",
    b._dailySection.menu.items.length === 7,
    "n=" + b._dailySection.menu.items.length,
  );
  check(
    "the panel keeps the live temperature for a partial payload",
    /\d+°C/.test(b._weatherLabel._text),
    b._weatherLabel._text,
  );
}
{
  const b = button("custom");
  const p = payload();
  delete p.hourly.temperature_2m;
  delete p.daily.temperature_2m_min;
  b.updateWeather(p);
  check(
    "hourly rows without temperatures are skipped instead of fatal",
    b._hourlySection.menu.items.length === 0,
    "n=" + b._hourlySection.menu.items.length,
  );
  check(
    "daily rows without a minimum are skipped instead of NaN",
    b._dailySection.menu.items.length === 0,
    "n=" + b._dailySection.menu.items.length,
  );
  check(
    "a partial payload never turns the panel into Error",
    b._weatherLabel._text !== "Error" && /\d+°C/.test(b._weatherLabel._text),
    b._weatherLabel._text,
  );
}

{
  // After a backward clock correction, a served cache carries a fetchedAt that
  // is ahead of the wall clock. The panel must still render it normally and
  // keep the payload's own (future-looking) stamp, never Error.
  const b = button("openmeteo");
  const fetchedAt = nowSeconds() + 3 * 3600;
  b.updateWeather(payload({ stale: true, fetchedAt }));
  check(
    "a future-dated fetch still renders the cached temperature",
    /\d+°C/.test(b._weatherLabel._text),
    b._weatherLabel._text,
  );
  check(
    "Last Update keeps the payload's own stamp, badged as cached",
    b._lastUpdateItem.label._text.includes(b._formatDateTime(new Date(fetchedAt * 1000))) &&
      /♻️/.test(b._lastUpdateItem.label._text),
    b._lastUpdateItem.label._text,
  );
  check(
    "the current block still names the cached time",
    /Cached data from/.test(b._currentWeatherItem.label._text),
    b._currentWeatherItem.label._text,
  );
}

{
  // A cache written before times were normalized stored raw epoch values in the
  // very same fields; the panel must still place them on the right day/hour.
  const b = button("openmeteo");
  const p = payload();
  const epochOf = (s) =>
    String(Math.floor(new Date(s.length === 10 ? `${s}T00:00` : s).getTime() / 1000));
  p.hourly.time = p.hourly.time.map(epochOf);
  p.daily.time = p.daily.time.map(epochOf);
  b.updateWeather(p);

  const daily = b._dailySection.menu.items;
  check(
    "a legacy epoch cache still fills the hourly section",
    b._hourlySection.menu.items.length === 12,
    "n=" + b._hourlySection.menu.items.length,
  );
  check("a legacy epoch cache still fills the 7-day section", daily.length === 7, "n=" + daily.length);
  check(
    "the legacy day list is anchored on Today",
    daily.length > 0 && rowTexts(daily[0]).includes("Today"),
    daily.length ? JSON.stringify(rowTexts(daily[0])) : "no rows",
  );
  check(
    "the legacy hourly labels are the payload hours",
    rowTexts(b._hourlySection.menu.items[0] ?? {})[0] === b._formatTime(hourStr(1)),
    JSON.stringify(rowTexts(b._hourlySection.menu.items[0] ?? {})),
  );
}

process.exit(report() ? 0 : 1);
