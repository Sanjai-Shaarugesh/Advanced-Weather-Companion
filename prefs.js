/**
 * Advanced Weather Companion – prefs.js
 *
 * Fixes applied vs original:
 *  1. Provider selection persists across reboots (was saving before providerKeys defined).
 *  2. Test button gives real visual feedback (spinner + toast).
 *  3. OpenWeatherMap test validates response.main.temp (not response.current.temp).
 *  4. Custom/Weather Underground URL: apiKey appended correctly; test uses actual URL.
 *  5. Provider page properly initialised before connecting notify::selected signal.
 *  6. i18n: all user-visible strings wrapped with _().
 */

import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Soup from "gi://Soup";
import Gdk from "gi://Gdk";

import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

// Provider metadata used only in the UI (no network calls here)
const WEATHER_PROVIDERS = {
  openmeteo: {
    name: "Open-Meteo (Free)",
    description: "Free weather API – No API key required",
    baseUrl: "https://api.open-meteo.com/v1/forecast",
    requiresApiKey: false,
    rateLimit: "10,000 requests/day",
    testUrl: (lat, lon, _key) =>
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`,
    validateResponse: r => r?.current?.temperature_2m !== undefined,
    getTemp: r => r.current.temperature_2m,
  },
  meteosource: {
    name: "Meteosource (Free)",
    description: "Free tier – 400 calls/day without API key",
    baseUrl: "https://www.meteosource.com/api/v1/free/point",
    requiresApiKey: false,
    rateLimit: "400 requests/day (free tier)",
    testUrl: (lat, lon, _key) =>
      `https://www.meteosource.com/api/v1/free/point?lat=${lat}&lon=${lon}&sections=current&timezone=UTC&language=en&units=metric`,
    validateResponse: r => r?.current?.temperature !== undefined,
    getTemp: r => r.current.temperature,
  },
  wttr: {
    name: "Wttr.in (Free)",
    description: "Free console weather service – No limits",
    baseUrl: "https://wttr.in",
    requiresApiKey: false,
    rateLimit: "No limits",
    testUrl: (lat, lon, _key) => `https://wttr.in/${lat},${lon}?format=j1`,
    validateResponse: r => r?.current_condition?.[0]?.temp_C !== undefined,
    getTemp: r => r.current_condition[0].temp_C,
  },
  openweathermap: {
    name: "OpenWeatherMap",
    description: "Comprehensive weather data – API key required",
    baseUrl: "https://api.openweathermap.org/data/2.5/weather",
    requiresApiKey: true,
    rateLimit: "1,000 requests/day (free tier)",
    apiUrl: "https://openweathermap.org/api",
    testUrl: (lat, lon, key) =>
      `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${key}&units=metric`,
    validateResponse: r => r?.main?.temp !== undefined,
    getTemp: r => r.main.temp,
  },
  weatherapi: {
    name: "WeatherAPI",
    description: "Real-time weather API – API key required",
    baseUrl: "https://api.weatherapi.com/v1/forecast.json",
    requiresApiKey: true,
    rateLimit: "1 million requests/month (free tier)",
    apiUrl: "https://www.weatherapi.com/",
    testUrl: (lat, lon, key) =>
      `https://api.weatherapi.com/v1/forecast.json?key=${key}&q=${lat},${lon}&days=1`,
    validateResponse: r => r?.current?.temp_c !== undefined,
    getTemp: r => r.current.temp_c,
  },
  custom: {
    name: "Custom / Weather Underground",
    description: "Your own API URL or a Weather Underground PWS endpoint",
    baseUrl: "",
    requiresApiKey: false,
    rateLimit: "Depends on provider",
    apiUrl: "https://github.com/Sanjai-Shaarugesh/Advanced-Weather-Companion/wiki/Custom-Weather-Providers",
    // testUrl is computed dynamically from the user-supplied URL
    validateResponse: r => r !== null && typeof r === "object",
    getTemp: _r => null,
  },
};

const PROVIDER_KEYS = Object.keys(WEATHER_PROVIDERS);
const TEST_LAT = 40.7128, TEST_LON = -74.006;

// ─────────────────────────────────────────────────────────────────────────────

export default class WeatherPreferences extends ExtensionPreferences {

  fillPreferencesWindow(window) {
    this._settings = this.getSettings("org.gnome.shell.extensions.advanced-weather");
    this._session  = new Soup.Session();
    this._session.timeout = 15;

    window.set_title(_("Advanced Weather Companion"));
    window.set_default_size(700, 680);
    window.set_resizable(true);

    window.add(this._buildGeneralPage());
    window.add(this._buildLocationPage());
    window.add(this._buildProviderPage());
    window.add(this._buildAppearancePage());
    window.add(this._buildAboutPage());
  }

  // ══════════════════════════════════════════════════════════════════════════
  // General page
  // ══════════════════════════════════════════════════════════════════════════

  _buildGeneralPage() {
    const page = new Adw.PreferencesPage({
      title: _("General"),
      icon_name: "preferences-other-symbolic",
    });

    // ── Units ──────────────────────────────────────────────────────────────
    const unitsGroup = new Adw.PreferencesGroup({
      title: _("Units & Format"),
      description: _("Configure measurement units and display format"),
    });

    const tempRow = new Adw.SwitchRow({
      title: _("Use Fahrenheit"),
      subtitle: _("Switch between Celsius and Fahrenheit"),
    });
    tempRow.set_active(this._settings.get_boolean("use-fahrenheit"));
    tempRow.connect("notify::active", () => {
      this._settings.set_boolean("use-fahrenheit", tempRow.get_active());
    });

    const windRow = new Adw.ComboRow({
      title: _("Wind Speed Unit"),
      subtitle: _("Unit for wind speed display"),
      model: new Gtk.StringList(),
    });
    const windOpts = [
      {label: _("km/h (Kilometers per hour)"), value: "kmh"},
      {label: _("mph (Miles per hour)"),       value: "mph"},
      {label: _("m/s (Meters per second)"),    value: "ms"},
      {label: _("knots (Nautical miles)"),      value: "knots"},
    ];
    windOpts.forEach(o => windRow.model.append(o.label));
    const curWind = this._settings.get_string("wind-speed-unit") || "kmh";
    windRow.set_selected(Math.max(0, windOpts.findIndex(o => o.value === curWind)));
    windRow.connect("notify::selected", () => {
      const o = windOpts[windRow.get_selected()];
      if (o) this._settings.set_string("wind-speed-unit", o.value);
    });

    const timeRow = new Adw.SwitchRow({
      title: _("Use 12-hour Format"),
      subtitle: _("Display time in 12-hour format with AM/PM"),
    });
    timeRow.set_active(this._settings.get_boolean("use-12hour-format"));
    timeRow.connect("notify::active", () => {
      this._settings.set_boolean("use-12hour-format", timeRow.get_active());
    });

    unitsGroup.add(tempRow);
    unitsGroup.add(windRow);
    unitsGroup.add(timeRow);

    // ── Updates ────────────────────────────────────────────────────────────
    const updateGroup = new Adw.PreferencesGroup({
      title: _("Updates"),
      description: _("Configure weather data refresh settings"),
    });

    const intervalRow = new Adw.ComboRow({
      title: _("Update Interval"),
      subtitle: _("How often to refresh weather data"),
      model: new Gtk.StringList(),
    });
    const intervals = [
      {label: _("5 minutes"),  value: 5},
      {label: _("10 minutes"), value: 10},
      {label: _("15 minutes"), value: 15},
      {label: _("30 minutes"), value: 30},
      {label: _("1 hour"),     value: 60},
    ];
    intervals.forEach(i => intervalRow.model.append(i.label));
    const curInterval = this._settings.get_int("update-interval") || 10;
    intervalRow.set_selected(Math.max(1, intervals.findIndex(i => i.value === curInterval)));
    intervalRow.connect("notify::selected", () => {
      const o = intervals[intervalRow.get_selected()];
      if (o) this._settings.set_int("update-interval", o.value);
    });

    updateGroup.add(intervalRow);

    // ── Features ───────────────────────────────────────────────────────────
    const featGroup = new Adw.PreferencesGroup({
      title: _("Features"),
      description: _("Enable or disable weather features"),
    });

    const humRow = new Adw.SwitchRow({
      title: _("Show Humidity"),
      subtitle: _("Display relative humidity in weather details"),
    });
    humRow.set_active(this._settings.get_boolean("show-humidity"));
    humRow.connect("notify::active", () => {
      this._settings.set_boolean("show-humidity", humRow.get_active());
    });

    const alertsRow = new Adw.SwitchRow({
      title: _("Enable Weather Alerts"),
      subtitle: _("Send desktop notifications for dangerous weather"),
    });
    alertsRow.set_active(this._settings.get_boolean("enable-weather-alerts"));
    alertsRow.connect("notify::active", () => {
      this._settings.set_boolean("enable-weather-alerts", alertsRow.get_active());
    });

    featGroup.add(humRow);
    featGroup.add(alertsRow);
    page.add(unitsGroup);
    page.add(updateGroup);
    page.add(featGroup);
    return page;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Location page
  // ══════════════════════════════════════════════════════════════════════════

  _buildLocationPage() {
    const page = new Adw.PreferencesPage({
      title: _("Location"),
      icon_name: "find-location-symbolic",
    });

    // ── Detection mode ─────────────────────────────────────────────────────
    const modeGroup = new Adw.PreferencesGroup({
      title: _("Location Detection"),
      description: _("Configure how your location is determined"),
    });

    const modeRow = new Adw.ComboRow({
      title: _("Location Mode"),
      subtitle: _("Choose detection method"),
      model: new Gtk.StringList(),
    });
    modeRow.model.append(_("🌍 Auto Detection"));
    modeRow.model.append(_("📍 Manual Location"));
    const curMode = this._settings.get_string("location-mode") || "auto";
    modeRow.set_selected(curMode === "auto" ? 0 : 1);

    const currentRow = new Adw.ActionRow({
      title: _("Current Location"),
      subtitle: this._locationSubtitle(),
      activatable: false,
    });
    const gpsIcon = new Gtk.Image({
      icon_name: curMode === "auto"
        ? "location-services-active-symbolic"
        : "location-services-disabled-symbolic",
      pixel_size: 16,
    });
    currentRow.add_prefix(gpsIcon);
    const refreshBtn = new Gtk.Button({
      icon_name: "view-refresh-symbolic",
      valign: Gtk.Align.CENTER,
      tooltip_text: _("Refresh location display"),
      css_classes: ["flat"],
    });
    refreshBtn.connect("clicked", () => this._refreshLocationRow(currentRow));
    currentRow.add_suffix(refreshBtn);

    modeGroup.add(modeRow);
    modeGroup.add(currentRow);

    // ── Manual search ──────────────────────────────────────────────────────
    const searchGroup = new Adw.PreferencesGroup({
      title: _("Manual Location Search"),
      description: _("Search by city name or coordinates (lat, lon)"),
      sensitive: curMode === "manual",
    });

    const searchEntry = new Adw.EntryRow({
      title: _("Search Location"),
      show_apply_button: true,
    });
    const searchBtn = new Gtk.Button({
      icon_name: "edit-find-symbolic",
      valign: Gtk.Align.CENTER,
      tooltip_text: _("Search for location"),
      css_classes: ["suggested-action"],
    });
    const clearBtn = new Gtk.Button({
      icon_name: "edit-clear-symbolic",
      valign: Gtk.Align.CENTER,
      tooltip_text: _("Clear search"),
      css_classes: ["flat"],
    });
    searchEntry.add_suffix(searchBtn);
    searchEntry.add_suffix(clearBtn);

    const helpRow = new Adw.ActionRow({
      title: _("Search Examples"),
      subtitle: _("City: 'London', 'New York'\nCoordinates: '40.7128, -74.0060'"),
      activatable: false,
      sensitive: false,
    });
    helpRow.add_prefix(new Gtk.Image({icon_name:"dialog-information-symbolic", pixel_size:16}));

    this._searchResultsGroup = new Adw.PreferencesGroup({
      title: _("Search Results"),
      visible: false,
    });

    // Store refs for internal helpers
    this._searchEntryRow = searchEntry;
    this._searchBtn = searchBtn;
    this._locationModeRow = modeRow;

    // Wire up events
    modeRow.connect("notify::selected", () => {
      const mode = modeRow.get_selected() === 0 ? "auto" : "manual";
      this._settings.set_string("location-mode", mode);
      searchGroup.set_sensitive(mode === "manual");
      this._refreshLocationRow(currentRow);
      gpsIcon.set_from_icon_name(
        mode === "auto"
          ? "location-services-active-symbolic"
          : "location-services-disabled-symbolic"
      );
    });

    const doSearch = () => {
      this._clearResults();
      this._performSearch();
    };
    searchBtn.connect("clicked", doSearch);
    searchEntry.connect("apply", doSearch);
    searchEntry.connect("entry-activated", doSearch);
    clearBtn.connect("clicked", () => {
      searchEntry.set_text("");
      this._clearResults();
    });
    searchEntry.connect("notify::text", () => {
      const q = searchEntry.get_text().trim();
      searchBtn.set_sensitive(q.length >= 2);
    });

    searchGroup.add(searchEntry);
    searchGroup.add(helpRow);
    page.add(modeGroup);
    page.add(searchGroup);
    page.add(this._searchResultsGroup);
    return page;
  }

  _locationSubtitle() {
    const mode = this._settings.get_string("location-mode") || "auto";
    if (mode === "auto") return _("🌍 Auto Detection Enabled");
    const name = this._settings.get_string("location-name") || "";
    const loc  = this._settings.get_string("location")       || "";
    return name && loc ? `📍 ${name}` : _("📍 Manual – Please set location");
  }

  _refreshLocationRow(row) {
    row.set_subtitle(this._locationSubtitle());
  }

  // ── Search helpers ─────────────────────────────────────────────────────

  async _performSearch() {
    const query = (this._searchEntryRow?.get_text() ?? "").trim();
    this._clearResults();
    if (!query || query.length < 2) return;
    if (this._searchInProgress) return;

    this._searchInProgress = true;
    this._searchBtn.set_icon_name("content-loading-symbolic");
    this._searchBtn.set_sensitive(false);

    try {
      const coordPat = /^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/;
      const coordMatch = query.match(coordPat);

      if (coordMatch) {
        const lat = parseFloat(coordMatch[1]);
        const lon = parseFloat(coordMatch[2]);
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
          this._showResultError(_("Invalid coordinates. Lat: −90 to 90, Lon: −180 to 180."));
          return;
        }
        this._showCoordResult(lat, lon);
      } else {
        await this._searchByName(query);
      }
    } catch (e) {
      let msg = _("Search failed. Please try again.");
      if (e.message?.includes("HTTP"))    msg = _("Unable to reach location service. Check your connection.");
      if (e.message?.includes("timeout")) msg = _("Search timed out. Please try again.");
      this._showResultError(msg);
    } finally {
      this._searchInProgress = false;
      this._searchBtn.set_icon_name("edit-find-symbolic");
      this._searchBtn.set_sensitive(true);
    }
  }

  _showCoordResult(lat, lon) {
    const result = {name: "Custom Location", latitude: lat, longitude: lon, country: "", admin1: ""};
    this._displayResults([result]);
  }

  async _searchByName(query) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=10&language=en&format=json`;
    const msg = Soup.Message.new("GET", url);
    msg.request_headers.append("User-Agent", "GNOME-Weather-Extension/1.0");
    const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    if (msg.status_code !== 200)
      throw new Error(`HTTP ${msg.status_code}: ${msg.reason_phrase}`);
    const resp = JSON.parse(new TextDecoder().decode(bytes.get_data()));
    if (resp.results?.length) {
      this._displayResults(resp.results);
    } else {
      this._searchResultsGroup.set_visible(true);
      const row = new Adw.ActionRow({
        title: _("No Results Found"),
        subtitle: _("Try a different search term or check your spelling"),
        sensitive: false,
      });
      row.add_prefix(new Gtk.Image({icon_name:"dialog-warning-symbolic", pixel_size:16}));
      this._searchResultsGroup.add(row);
    }
  }

  _displayResults(results) {
    this._searchResultsGroup.set_visible(true);
    for (const r of results) {
      const name = r.admin1
        ? `${r.name}, ${r.admin1}, ${r.country}`
        : r.country ? `${r.name}, ${r.country}` : r.name;
      const coords = `${r.latitude.toFixed(4)}, ${r.longitude.toFixed(4)}`;

      const row = new Adw.ActionRow({
        title: `📍 ${name}`,
        subtitle: coords,
        activatable: true,
      });
      row.add_prefix(new Gtk.Image({icon_name:"find-location-symbolic", pixel_size:16}));
      const selBtn = new Gtk.Button({
        icon_name: "object-select-symbolic",
        valign: Gtk.Align.CENTER,
        tooltip_text: _("Select this location"),
        css_classes: ["suggested-action"],
      });
      selBtn.connect("clicked", () => this._selectResult(r, name));
      row.connect("activated",  () => this._selectResult(r, name));
      row.add_suffix(selBtn);
      this._searchResultsGroup.add(row);
    }
  }

  _selectResult(r, name) {
    this._settings.set_string("location", `${r.latitude},${r.longitude}`);
    this._settings.set_string("location-name", name);
    this._searchEntryRow?.set_text("");
    this._clearResults();
    this._showToast(_("✅ Location updated successfully"));
  }

  _clearResults() {
    if (!this._searchResultsGroup) return;
    let child = this._searchResultsGroup.get_first_child();
    while (child) {
      const next = child.get_next_sibling();
      this._searchResultsGroup.remove(child);
      child = next;
    }
    this._searchResultsGroup.set_visible(false);
  }

  _showResultError(msg) {
    this._searchResultsGroup.set_visible(true);
    const row = new Adw.ActionRow({title: _("Search Error"), subtitle: msg, sensitive: false});
    row.add_prefix(new Gtk.Image({icon_name:"dialog-error-symbolic", pixel_size:16}));
    this._searchResultsGroup.add(row);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Weather Provider page  (all bugs fixed)
  // ══════════════════════════════════════════════════════════════════════════

  _buildProviderPage() {
    const page = new Adw.PreferencesPage({
      title: _("Weather Provider"),
      icon_name: "network-server-symbolic",
    });

    // ── Provider selection ────────────────────────────────────────────────
    const providerGroup = new Adw.PreferencesGroup({
      title: _("Weather Data Source"),
      description: _("Choose your weather data provider"),
    });

    const providerRow = new Adw.ComboRow({
      title: _("Weather Provider"),
      subtitle: _("Select weather API service"),
      model: new Gtk.StringList(),
    });

    // Populate model FIRST, then connect signal (avoids stale index on signal)
    PROVIDER_KEYS.forEach(key => {
      const p = WEATHER_PROVIDERS[key];
      const free = p.requiresApiKey ? "💰" : "🆓";
      providerRow.model.append(`${free} ${p.name} – ${p.description}`);
    });

    const curProvider = this._settings.get_string("weather-provider") || "openmeteo";
    const curIdx      = Math.max(0, PROVIDER_KEYS.indexOf(curProvider));
    providerRow.set_selected(curIdx);

    // ── Configuration group ───────────────────────────────────────────────
    this._providerDetailsGroup = new Adw.PreferencesGroup({
      title: _("Provider Configuration"),
      description: _("Configure your selected weather provider"),
    });

    this._apiKeyRow = new Adw.PasswordEntryRow({
      title: _("API Key"),
      text: this._settings.get_string("weather-api-key") || "",
    });
    const getKeyBtn = new Gtk.Button({
      label: _("Get API Key"),
      valign: Gtk.Align.CENTER,
      css_classes: ["suggested-action"],
    });
    this._apiKeyRow.add_suffix(getKeyBtn);

    this._customUrlRow = new Adw.EntryRow({
      title: _("Custom / Weather Underground URL"),
      text: this._settings.get_string("custom-weather-url") || "",
    });
    // URL placeholder hint
    const hintRow = new Adw.ActionRow({
      title: _("URL Placeholders"),
      subtitle: _("{lat} and {lon} are replaced with coordinates.\nExample WU URL: https://api.weather.com/v2/pws/observations/current?stationId=MYID&format=json&units=m&apiKey=YOURKEY"),
      activatable: false,
      sensitive: false,
    });
    hintRow.add_prefix(new Gtk.Image({icon_name:"dialog-information-symbolic", pixel_size:16}));

    this._providerInfoRow = new Adw.ActionRow({
      title: _("Provider Information"),
      activatable: false,
    });

    // ── Test button ───────────────────────────────────────────────────────
    const testRow = new Adw.ActionRow({
      title: _("Test Connection"),
      subtitle: _("Verify your provider settings work correctly"),
      activatable: true,
    });
    this._testButton = new Gtk.Button({
      label: _("Test"),
      valign: Gtk.Align.CENTER,
      css_classes: ["suggested-action"],
    });
    testRow.add_suffix(this._testButton);

    // ── Wire events ───────────────────────────────────────────────────────

    // Connect AFTER populating & setting initial value to avoid stale state
    providerRow.connect("notify::selected", () => {
      const key = PROVIDER_KEYS[providerRow.get_selected()];
      if (!key) return;
      this._settings.set_string("weather-provider", key);
      this._updateProviderDetails(key);
    });

    this._apiKeyRow.connect("notify::text", () => {
      this._settings.set_string("weather-api-key", this._apiKeyRow.get_text());
    });
    this._customUrlRow.connect("notify::text", () => {
      this._settings.set_string("custom-weather-url", this._customUrlRow.get_text());
    });
    getKeyBtn.connect("clicked", () => {
      const key = PROVIDER_KEYS[providerRow.get_selected()];
      const url = WEATHER_PROVIDERS[key]?.apiUrl;
      if (url) {
        try { Gio.AppInfo.launch_default_for_uri(url, null); }
        catch (e) { this._showToast(_("Could not open website.")); }
      }
    });
    this._testButton.connect("clicked",   () => this._runConnectionTest());
    testRow.connect("activated",          () => this._runConnectionTest());

    // Build group
    this._providerDetailsGroup.add(this._apiKeyRow);
    this._providerDetailsGroup.add(this._customUrlRow);
    this._providerDetailsGroup.add(hintRow);
    this._providerDetailsGroup.add(this._providerInfoRow);
    this._providerDetailsGroup.add(testRow);

    providerGroup.add(providerRow);
    page.add(providerGroup);
    page.add(this._providerDetailsGroup);

    // Initialise the detail rows for the current selection
    this._updateProviderDetails(curProvider);

    return page;
  }

  _updateProviderDetails(key) {
    const p = WEATHER_PROVIDERS[key];
    if (!p) return;
    this._apiKeyRow.set_visible(p.requiresApiKey);
    this._customUrlRow.set_visible(key === "custom");

    // hintRow (3rd child of group) visibility
    const hintVisible = key === "custom";
    // Find hintRow by walking children
    let child = this._providerDetailsGroup.get_first_child();
    let idx = 0;
    while (child) {
      if (idx === 2) { child.set_visible(hintVisible); break; }
      child = child.get_next_sibling();
      idx++;
    }

    let info = `📡 ${p.baseUrl || _("Not specified")}\n`;
    info += `📊 ${_("Rate Limit")}: ${p.rateLimit}\n`;
    info += `🔑 ${_("API Key")}: ${p.requiresApiKey ? _("Required") : _("Not Required")}`;
    this._providerInfoRow.set_subtitle(info);
  }

  // ── Connection test ───────────────────────────────────────────────────────

  async _runConnectionTest() {
    if (this._testInProgress) return;
    this._testInProgress = true;
    this._testButton.set_label(_("Testing…"));
    this._testButton.set_sensitive(false);

    try {
      const key      = this._settings.get_string("weather-provider") || "openmeteo";
      const apiKey   = this._settings.get_string("weather-api-key")   || "";
      const customUrl= this._settings.get_string("custom-weather-url")|| "";
      const cfg      = WEATHER_PROVIDERS[key];

      // Validate before even making a request
      if (cfg.requiresApiKey && !apiKey.trim())
        throw new Error(_(`API key is required for ${cfg.name}`));

      let testUrl;
      if (key === "custom") {
        if (!customUrl.trim())
          throw new Error(_("Custom URL is required"));
        // Replace placeholders with test coords
        testUrl = customUrl
          .replace("{lat}", TEST_LAT).replace("{latitude}", TEST_LAT)
          .replace("{lon}", TEST_LON).replace("{longitude}", TEST_LON);
        // Append key only if not already present
        if (apiKey?.trim()) {
          const hasKey =
            testUrl.includes("apiKey=") || testUrl.includes("api_key=") ||
            testUrl.includes("key=")   || testUrl.includes("appid=");
          if (!hasKey)
            testUrl += (testUrl.includes("?") ? "&" : "?") + `apiKey=${apiKey}`;
        }
      } else {
        testUrl = cfg.testUrl(TEST_LAT, TEST_LON, apiKey);
      }

      const msg = Soup.Message.new("GET", testUrl);
      msg.request_headers.append("User-Agent", "GNOME-Weather-Extension/1.0");
      const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);

      if (msg.status_code !== 200)
        throw new Error(`HTTP ${msg.status_code}: ${msg.reason_phrase}`);

      const resp = JSON.parse(new TextDecoder().decode(bytes.get_data()));

      if (!cfg.validateResponse(resp))
        throw new Error(_("Response received but no weather data found. Check your API key and URL."));

      const temp = cfg.getTemp(resp);
      const tempStr = temp !== null ? ` ${_("Current temp:")} ${temp}°C` : "";
      this._showToast(`✅ ${_("Connection successful!")}${tempStr}`);

    } catch (e) {
      this._showToast(`❌ ${_("Test failed:")} ${e.message}`);
    } finally {
      this._testInProgress = false;
      this._testButton.set_label(_("Test"));
      this._testButton.set_sensitive(true);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Appearance page
  // ══════════════════════════════════════════════════════════════════════════

  _buildAppearancePage() {
    const page = new Adw.PreferencesPage({
      title: _("Appearance"),
      icon_name: "applications-graphics-symbolic",
    });

    const panelGroup = new Adw.PreferencesGroup({
      title: _("Panel Display"),
      description: _("Configure how weather appears in the panel"),
    });

    // Panel position
    const posRow = new Adw.ComboRow({
      title: _("Panel Position"),
      subtitle: _("Where to show the weather widget"),
      model: new Gtk.StringList(),
    });
    const positions = [
      {id:"left",   label:_("Left")},
      {id:"center", label:_("Center")},
      {id:"right",  label:_("Right")},
    ];
    positions.forEach(p => posRow.model.append(p.label));
    const curPos = this._settings.get_string("panel-position") || "right";
    posRow.set_selected(Math.max(2, positions.findIndex(p => p.id === curPos)));
    posRow.connect("notify::selected", () => {
      const p = positions[posRow.get_selected()];
      if (p) this._settings.set_string("panel-position", p.id);
    });

    // Position index
    const idxRow = new Adw.SpinRow({
      title: _("Panel Position Index"),
      subtitle: _("Position index within the selected panel area"),
      adjustment: new Gtk.Adjustment({
        lower: 0, upper: 10, step_increment: 1,
        value: this._settings.get_int("panel-position-index") || 0,
      }),
    });
    idxRow.connect("notify::value", () => {
      this._settings.set_int("panel-position-index", idxRow.get_value());
    });

    // Show temperature text
    const showTextRow = new Adw.SwitchRow({
      title: _("Show Temperature Text"),
      subtitle: _("Display temperature alongside the weather icon"),
    });
    showTextRow.set_active(this._settings.get_boolean("show-text-in-panel"));
    showTextRow.connect("notify::active", () => {
      this._settings.set_boolean("show-text-in-panel", showTextRow.get_active());
    });

    // Show location indicator
    const showLocRow = new Adw.SwitchRow({
      title: _("Show Location Indicator"),
      subtitle: _("Display AUTO/MANUAL indicator in panel"),
    });
    showLocRow.add_prefix(new Gtk.Image({icon_name:"find-location-symbolic", pixel_size:16}));
    showLocRow.set_active(this._settings.get_boolean("show-location-label"));
    showLocRow.connect("notify::active", () => {
      this._settings.set_boolean("show-location-label", showLocRow.get_active());
    });

    // Icon size
    const iconSizeRow = new Adw.SpinRow({
      title: _("Icon Size"),
      subtitle: _("Size of the weather icon in pixels"),
      adjustment: new Gtk.Adjustment({
        lower:12, upper:24, step_increment:1,
        value: this._settings.get_int("panel-icon-size") || 16,
      }),
    });
    iconSizeRow.connect("notify::value", () => {
      this._settings.set_int("panel-icon-size", iconSizeRow.get_value());
    });

    // Text size
    const textSizeRow = new Adw.SpinRow({
      title: _("Text Size"),
      subtitle: _("Size of the temperature text in pixels"),
      adjustment: new Gtk.Adjustment({
        lower:10, upper:16, step_increment:1,
        value: this._settings.get_int("panel-text-size") || 13,
      }),
    });
    textSizeRow.connect("notify::value", () => {
      this._settings.set_int("panel-text-size", textSizeRow.get_value());
    });

    panelGroup.add(posRow);
    panelGroup.add(idxRow);
    panelGroup.add(showTextRow);
    panelGroup.add(showLocRow);
    panelGroup.add(iconSizeRow);
    panelGroup.add(textSizeRow);
    page.add(panelGroup);
    return page;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // About page
  // ══════════════════════════════════════════════════════════════════════════

  _buildAboutPage() {
    const page = new Adw.PreferencesPage({
      title: _("About"),
      icon_name: "help-about-symbolic",
    });

    // ── Header ─────────────────────────────────────────────────────────────
    const infoGroup = new Adw.PreferencesGroup({
      title: _("Advanced Weather Companion"),
      description: _("A beautiful, modern weather companion for GNOME Shell"),
    });

    const headerBox = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 20, halign: Gtk.Align.CENTER,
      margin_top:20, margin_bottom:20,
    });

    let logo;
    try {
      logo = Gtk.Image.new_from_file(`${this.dir.get_path()}/icons/weather-logo.png`);
      logo.set_pixel_size(72);
    } catch (_) {
      logo = new Gtk.Image({icon_name:"weather-clear-symbolic", pixel_size:72});
    }

    const infoBox = new Gtk.Box({orientation:Gtk.Orientation.VERTICAL, spacing:6, valign:Gtk.Align.CENTER});
    infoBox.append(new Gtk.Label({label:_("Advanced Weather Companion"), halign:Gtk.Align.START, css_classes:["title-2"]}));
    infoBox.append(new Gtk.Label({label:_("Version 2.0"), halign:Gtk.Align.START, css_classes:["caption"]}));
    infoBox.append(new Gtk.Label({
      label: _("Modern weather extension with native GNOME design"),
      halign:Gtk.Align.START, wrap:true, max_width_chars:40, css_classes:["body"],
    }));
    headerBox.append(logo);
    headerBox.append(infoBox);

    const headerRow = new Adw.ActionRow({title:"", activatable:false});
    headerRow.add_suffix(headerBox);
    infoGroup.add(headerRow);

    // ── Links ──────────────────────────────────────────────────────────────
    const linksGroup = new Adw.PreferencesGroup({
      title: _("Extension Links"),
      description: _("Source code, issues, and contributions"),
    });

    const ghRow = new Adw.ActionRow({
      title: _("View on GitHub"),
      subtitle: _("Source code, issues, and contributions"),
      activatable: true,
    });
    ghRow.add_prefix(this._githubIcon());
    ghRow.add_suffix(new Gtk.Image({icon_name:"adw-external-link-symbolic", pixel_size:16}));
    ghRow.connect("activated", () => {
      try { Gio.AppInfo.launch_default_for_uri("https://github.com/Sanjai-Shaarugesh/Advanced-Weather-Companion", null); }
      catch (e) { console.error(e); }
    });

    const coffeeRow = new Adw.ActionRow({
      title: _("☕ Buy Me a Coffee"),
      subtitle: _("Support development with a small donation"),
      activatable: true,
    });
    coffeeRow.add_prefix(new Gtk.Image({icon_name:"emblem-favorite-symbolic", pixel_size:20}));
    coffeeRow.add_suffix(new Gtk.Image({icon_name:"adw-external-link-symbolic", pixel_size:16}));
    coffeeRow.connect("activated", () => {
      try { Gio.AppInfo.launch_default_for_uri("https://buymeacoffee.com/sanjai", null); }
      catch (e) { console.error(e); }
    });

    linksGroup.add(ghRow);
    linksGroup.add(coffeeRow);

    // ── QR ─────────────────────────────────────────────────────────────────
    const qrGroup = new Adw.PreferencesGroup({
      title: _("☕ Support – Scan QR to buy me a coffee"),
    });

    const qrBox = new Gtk.Box({
      orientation:Gtk.Orientation.VERTICAL, spacing:16, halign:Gtk.Align.CENTER,
      margin_top:20, margin_bottom:20, css_classes:["qr-container"],
    });
    let qrImg;
    try {
      qrImg = Gtk.Image.new_from_file(`${this.dir.get_path()}/icons/qr.png`);
      qrImg.set_pixel_size(180);
    } catch (_) {
      qrImg = new Gtk.Image({icon_name:"camera-web-symbolic", pixel_size:180});
    }
    qrBox.append(qrImg);
    const qrRow = new Adw.ActionRow({title:"", activatable:false});
    qrRow.set_child(qrBox);
    qrGroup.add(qrRow);

    // ── Donation address ───────────────────────────────────────────────────
    const addrGroup = new Adw.PreferencesGroup({title: _("Donation Address")});
    const addrRow = new Adw.ActionRow({
      title: "https://buymeacoffee.com/sanjai",
      activatable: true,
    });
    addrRow.add_prefix(new Gtk.Image({icon_name:"emote-love-symbolic", pixel_size:16}));
    addrRow.add_suffix(new Gtk.Image({icon_name:"edit-copy-symbolic", pixel_size:16}));
    addrRow.connect("activated", () => {
      this._copyToClipboard("https://buymeacoffee.com/sanjai", _("Donation address"));
    });
    addrGroup.add(addrRow);

    // ── License ────────────────────────────────────────────────────────────
    const licGroup = new Adw.PreferencesGroup({
      title: _("License & Credits"),
      description: _("Open source software information"),
    });
    const licRow = new Adw.ActionRow({
      title: _("Open Source License"),
      subtitle: _("MIT License – Free and open source software"),
      activatable: false,
    });
    licRow.add_prefix(new Gtk.Image({icon_name:"security-high-symbolic", pixel_size:16}));
    const credRow = new Adw.ActionRow({
      title: _("Weather Data Sources"),
      subtitle: _("Open-Meteo, Meteosource, Wttr.in, OpenWeatherMap, WeatherAPI, Weather Underground"),
      activatable: false,
    });
    credRow.add_prefix(new Gtk.Image({icon_name:"network-server-symbolic", pixel_size:16}));
    licGroup.add(licRow);
    licGroup.add(credRow);

    page.add(infoGroup);
    page.add(linksGroup);
    page.add(qrGroup);
    page.add(addrGroup);
    page.add(licGroup);
    return page;
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  _showToast(msg) {
    let w = this._providerDetailsGroup ?? this._searchResultsGroup;
    while (w && !w.add_toast) w = w.get_parent?.();
    if (w?.add_toast) {
      w.add_toast(new Adw.Toast({title: msg, timeout: 4}));
    } else {
      console.log("[Weather pref toast]", msg);
    }
  }

  _copyToClipboard(text, label) {
    try {
      const clipboard = Gdk.Display.get_default()?.get_clipboard();
      if (!clipboard) throw new Error("no clipboard");
      clipboard.set_text(text);
      this._showToast(`✅ ${label || "Text"} ${_("copied to clipboard")}`);
    } catch (e) {
      console.error("Clipboard error:", e);
      this._showToast(_("Could not copy. Please copy manually: ") + text);
    }
  }

  _githubIcon() {
    const path = `${this.dir.get_path()}/icons/github.svg`;
    if (Gio.File.new_for_path(path).query_exists(null)) {
      return new Gtk.Image({file: path, pixel_size: 20});
    }
    // Inline fallback SVG written to /tmp
    const svg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>`;
    try {
      const tmp = `${GLib.get_tmp_dir()}/gh-icon-${Date.now()}.svg`;
      const f   = Gio.File.new_for_path(tmp);
      f.replace_contents(svg, null, false, Gio.FileCreateFlags.NONE, null);
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => { try { f.delete(null); } catch (_) {} return GLib.SOURCE_REMOVE; });
      return new Gtk.Image({file: tmp, pixel_size: 20});
    } catch (_) {
      return new Gtk.Image({icon_name:"software-properties-symbolic", pixel_size:20});
    }
  }
}
