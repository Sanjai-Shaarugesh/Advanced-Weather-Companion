/**
 * Advanced Weather Companion – extension.js
 *
 * Responsibilities of THIS file:
 *   • Boot / shutdown lifecycle
 *   • Fetch weather data from the selected provider
 *   • Coordinate location detection ↔ weather load
 *   • Manage periodic refresh and network-change reactions
 *   • Send system desktop notifications for severe weather alerts
 *
 * All provider logic  → lib/providers.js
 * All location logic  → lib/location.js
 * All UI logic        → lib/panelMenu.js
 * All prefs UI        → prefs.js
 */

import Gio from "gi://Gio";
import Soup from "gi://Soup";
import GLib from "gi://GLib";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import {Extension, gettext as getText} from "resource:///org/gnome/shell/extensions/extension.js";
import * as MessageTray from "resource:///org/gnome/shell/ui/messageTray.js";

import {WEATHER_PROVIDERS, setGettext, getWeatherConditions} from "./lib/providers.js";
import {LocationManager}   from "./lib/location.js";
import {WeatherPanelButton}from "./lib/panelMenu.js";

// Fallback location when everything else fails
const FALLBACK = {lat: 40.7128, lon: -74.006, name: "New York, NY (Fallback)"};

// Severity levels that trigger a desktop notification
const ALERT_SEVERITIES = new Set(["warning", "severe"]);

export default class WeatherExtension extends Extension {

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  enable() {
    this._enabled  = true;
    this._settings = this.getSettings("org.gnome.shell.extensions.advanced-weather");
    this._session  = new Soup.Session();
    this._session.timeout = this._settings.get_int("weather-request-timeout") || 15;

    this._latitude  = null;
    this._longitude = null;

    // Wire gettext into providers so condition names translate
    setGettext(s => this.gettext(s));

    this._locationManager = new LocationManager(this._session);

    this._panelButton = new WeatherPanelButton(this);
    const pos   = this._settings.get_string("panel-position")   || "right";
    const index = this._settings.get_int("panel-position-index")  || 0;
    Main.panel.addToStatusArea("weather-extension", this._panelButton, index, pos);

    // Notification source (created once, re-used for all alerts)
    this._notifSource = null;
    // Track last-notified alert key to avoid spam on every refresh
    this._lastAlertKey = null;

    // React to settings that require a UI rebuild
    this._settingsConns = [
      this._settings.connect("changed::panel-position",       () => { if (this._enabled) this._rebuildPanel(); }),
      this._settings.connect("changed::panel-position-index", () => { if (this._enabled) this._rebuildPanel(); }),
      this._settings.connect("changed::update-interval",      () => { if (this._enabled) this._panelButton._startUpdateTimer(); }),
      this._settings.connect("changed::weather-request-timeout", () => {
        if (this._enabled) this._session.timeout = this._settings.get_int("weather-request-timeout") || 15;
      }),
      // Provider / key changes: debounce by 1 s to avoid double fetches while user types
      this._settings.connect("changed::weather-provider",  () => this._debouncedReload()),
      this._settings.connect("changed::weather-api-key",   () => this._debouncedReload()),
      this._settings.connect("changed::custom-weather-url",() => this._debouncedReload()),
      this._settings.connect("changed::location-mode",     () => { if (this._enabled) this._detectLocationAndLoadWeather(); }),
      this._settings.connect("changed::location",          () => { if (this._enabled) this._detectLocationAndLoadWeather(); }),
      // Reset alert dedupe key when notifications are re-enabled
      this._settings.connect("changed::enable-weather-alerts", () => {
        this._lastAlertKey = null;
      }),
    ];

    // React to network reconnection
    this._networkMonitor = Gio.NetworkMonitor.get_default();
    this._networkConnId  = this._networkMonitor.connect("network-changed", (_m, available) => {
      if (available && this._enabled) this._scheduleReload(2);
    });

    this._testAllProviders();
    this._detectLocationAndLoadWeather();
  }

  disable() {
    this._enabled = false;

    if (this._networkConnId) {
      this._networkMonitor.disconnect(this._networkConnId);
      this._networkConnId = null;
    }
    this._cancelPendingTimers();

    if (this._panelButton) {
      this._panelButton.destroy();
      this._panelButton = null;
    }

    for (const id of (this._settingsConns ?? [])) {
      try { this._settings.disconnect(id); } catch (_) {}
    }
    this._settingsConns = null;

    if (this._session) {
      this._session.abort();
      this._session = null;
    }

    this._notifSource  = null;
    this._lastAlertKey = null;
    this._settings        = null;
    this._locationManager = null;
    this._latitude        = null;
    this._longitude       = null;
  }

  // ── i18n helper ───────────────────────────────────────────────────────────

  // Expose gettext to UI modules that receive the extension object
  _(s) { return this.gettext(s); }

  // ── Location resolution ───────────────────────────────────────────────────

  async _detectLocationAndLoadWeather() {
    if (!this._enabled) return;

    try {
      const loc = await this._locationManager.resolveLocation(this._settings);
      this._latitude    = loc.lat;
      this._longitude   = loc.lon;
      this._locationName= loc.name;
    } catch (e) {
      console.error("[Weather] Location detection failed:", e.message);
      this._latitude    = FALLBACK.lat;
      this._longitude   = FALLBACK.lon;
      this._locationName= FALLBACK.name;

      if (this._panelButton && !this._panelButton._destroyed) {
        this._panelButton._weatherLabel.set_text(this._("Offline"));
        this._panelButton._weatherIcon.set_icon_name("network-offline-symbolic");
      }
    }

    await this._loadWeatherData();
  }

  // ── Weather fetch ─────────────────────────────────────────────────────────

  async _loadWeatherData() {
    if (!this._enabled) return;

    const providerKey = this._settings.get_string("weather-provider") || "openmeteo";
    const apiKey      = this._settings.get_string("weather-api-key")   || "";
    const customUrl   = this._settings.get_string("custom-weather-url")|| "";

    const cfg = WEATHER_PROVIDERS[providerKey];
    if (!cfg) {
      console.error(`[Weather] Unknown provider: ${providerKey}`);
      return;
    }

    if (this._panelButton && !this._panelButton._destroyed)
      this._panelButton.updateProviderStatus(providerKey, "testing");

    let url;
    try {
      url = providerKey === "custom"
        ? cfg.buildUrl(this._latitude, this._longitude, apiKey, customUrl)
        : cfg.buildUrl(this._latitude, this._longitude, apiKey);
    } catch (e) {
      console.error(`[Weather] ${cfg.name} URL build error:`, e.message);
      if (this._panelButton && !this._panelButton._destroyed) {
        this._panelButton._weatherLabel.set_text(this._("No Key"));
        this._panelButton._weatherIcon.set_icon_name("dialog-warning-symbolic");
        this._panelButton.updateProviderStatus(providerKey, "error", e.message.substring(0, 60));
      }
      return;
    }

    console.log(`[Weather] Fetching from ${cfg.name}: ${url.replace(apiKey || "NOKEY", "***")}`);

    try {
      const msg = Soup.Message.new("GET", url);
      msg.request_headers.append("User-Agent", "GNOME-Weather-Extension/1.0");

      const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);

      if (msg.status_code !== 200) {
        throw new Error(`HTTP ${msg.status_code}: ${msg.reason_phrase}`);
      }

      const parsed = cfg.parseResponse(JSON.parse(new TextDecoder().decode(bytes.get_data())));

      if (this._panelButton && !this._panelButton._destroyed) {
        this._panelButton.updateWeather({
          location: this._locationName,
          current:  parsed.current,
          hourly:   parsed.hourly  ?? null,
          daily:    parsed.daily   ?? null,
          provider: cfg.name,
        });
      }

      // Check for dangerous conditions and notify if enabled
      this._maybeNotifyAlerts(parsed.current, this._locationName);

    } catch (e) {
      console.error(`[Weather] ${cfg.name} fetch failed:`, e.message);

      if (this._panelButton && !this._panelButton._destroyed) {
        const offline = !Gio.NetworkMonitor.get_default().get_network_available();
        this._panelButton._weatherLabel.set_text(offline ? this._("Offline") : this._("Error"));
        this._panelButton._weatherIcon.set_icon_name(
          offline ? "network-offline-symbolic" : "dialog-error-symbolic"
        );
        this._panelButton.updateProviderStatus(
          providerKey,
          e.message.includes("timeout") ? "timeout" : "error",
          e.message.substring(0, 60)
        );
      }

      if (providerKey !== "openmeteo" && Gio.NetworkMonitor.get_default().get_network_available()) {
        this._tryFallback(providerKey);
      }
    }
  }

  async _tryFallback(failedKey) {
    if (!this._enabled) return;
    const order = ["openmeteo", "wttr", "meteosource"];
    for (const key of order) {
      if (key === failedKey) continue;
      const cfg = WEATHER_PROVIDERS[key];
      try {
        const url = cfg.buildUrl(this._latitude, this._longitude, "");
        const msg = Soup.Message.new("GET", url);
        msg.request_headers.append("User-Agent", "GNOME-Weather-Extension/1.0");
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
        if (msg.status_code !== 200) continue;
        const parsed = cfg.parseResponse(JSON.parse(new TextDecoder().decode(bytes.get_data())));
        if (this._panelButton && !this._panelButton._destroyed) {
          this._panelButton.updateWeather({
            location: this._locationName,
            current:  parsed.current,
            hourly:   parsed.hourly ?? null,
            daily:    parsed.daily  ?? null,
            provider: `${cfg.name} (${this._("fallback")})`,
          });
        }
        this._maybeNotifyAlerts(parsed.current, this._locationName);
        console.log(`[Weather] Fell back to ${cfg.name}`);
        return;
      } catch (_) { /* try next */ }
    }
  }

  // ── Desktop alert notifications ───────────────────────────────────────────

  /**
   * Evaluate current weather data and send a desktop notification when the
   * conditions are dangerous, but only if the user has enabled alerts in
   * settings and the alert hasn't already been shown this cycle.
   */
  _maybeNotifyAlerts(current, location) {
    if (!this._enabled) return;
    if (!this._settings.get_boolean("enable-weather-alerts")) return;

    const conditions = getWeatherConditions();
    const cond = conditions[current.weather_code] ?? conditions[0];

    const useFahr = this._settings.get_boolean("use-fahrenheit");
    const tempVal = useFahr ? current.temperature_2m * 9/5 + 32 : current.temperature_2m;
    const heatLim = useFahr ? 95 : 35;
    const coldLim = useFahr ? 14 : -10;

    // Build a sorted list of active alert descriptors
    const alerts = [];

    if (ALERT_SEVERITIES.has(cond.severity))
      alerts.push({key: `cond:${current.weather_code}`, title: this._("⚠️ Severe Weather Alert"), body: `${cond.name} — ${location}`});

    if (tempVal > heatLim)
      alerts.push({key: `heat:${Math.round(tempVal)}`, title: this._("🌡️ Heat Warning"), body: this._("Extreme high temperature detected") + ` (${Math.round(tempVal)}${useFahr ? "°F" : "°C"}) — ${location}`});

    if (tempVal < coldLim)
      alerts.push({key: `cold:${Math.round(tempVal)}`, title: this._("🥶 Cold Warning"), body: this._("Extreme low temperature detected") + ` (${Math.round(tempVal)}${useFahr ? "°F" : "°C"}) — ${location}`});

    if (current.wind_speed_10m > 80)
      alerts.push({key: `wind:severe:${Math.round(current.wind_speed_10m)}`, title: this._("🌀 Storm Warning"), body: this._("Dangerous wind speed") + ` (${Math.round(current.wind_speed_10m)} km/h) — ${location}`});
    else if (current.wind_speed_10m > 50)
      alerts.push({key: `wind:strong:${Math.round(current.wind_speed_10m)}`, title: this._("💨 Wind Warning"), body: this._("Strong winds detected") + ` (${Math.round(current.wind_speed_10m)} km/h) — ${location}`});

    if (alerts.length === 0) {
      // Conditions are safe – reset dedupe so a future alert shows
      this._lastAlertKey = null;
      return;
    }

    // Deduplicate: build a compound key from all active alerts
    const alertKey = alerts.map(a => a.key).join("|");
    if (alertKey === this._lastAlertKey) return;
    this._lastAlertKey = alertKey;

    // Send one notification per alert type
    for (const alert of alerts)
      this._sendNotification(alert.title, alert.body);
  }

  _sendNotification(title, body) {
    if (!this._enabled) return;

    try {
      // Lazily create and register the notification source
      if (!this._notifSource) {
        this._notifSource = new MessageTray.Source({
          title: this._("Advanced Weather"),
          iconName: "weather-storm-symbolic",
        });
        Main.messageTray.add(this._notifSource);
      }

      const notification = new MessageTray.Notification({
        source:  this._notifSource,
        title,
        body,
        iconName: "weather-storm-symbolic",
        urgency:  MessageTray.Urgency.HIGH,
        isTransient: false,
      });

      this._notifSource.addNotification(notification);
    } catch (e) {
      console.error("[Weather] Failed to send notification:", e.message);
    }
  }

  // ── Provider self-test (non-blocking, background) ─────────────────────────

  async _testAllProviders() {
    if (!this._enabled) return;
    const testLat = 40.7128, testLon = -74.006;

    for (const [key, cfg] of Object.entries(WEATHER_PROVIDERS)) {
      if (!this._enabled) return;
      if (key === "custom") continue;
      if (cfg.requiresApiKey) {
        if (this._panelButton && !this._panelButton._destroyed)
          this._panelButton.updateProviderStatus(key, "inactive");
        continue;
      }

      try {
        if (this._panelButton && !this._panelButton._destroyed)
          this._panelButton.updateProviderStatus(key, "testing");

        const url = cfg.buildUrl(testLat, testLon, "");
        const msg = Soup.Message.new("GET", url);
        msg.request_headers.append("User-Agent", "GNOME-Weather-Extension/1.0");
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);

        if (msg.status_code === 200) {
          cfg.parseResponse(JSON.parse(new TextDecoder().decode(bytes.get_data())));
          if (this._panelButton && !this._panelButton._destroyed)
            this._panelButton.updateProviderStatus(key, "working");
        } else {
          if (this._panelButton && !this._panelButton._destroyed)
            this._panelButton.updateProviderStatus(key, "error", `HTTP ${msg.status_code}`);
        }
      } catch (e) {
        if (this._panelButton && !this._panelButton._destroyed)
          this._panelButton.updateProviderStatus(
            key,
            e.message.includes("timeout") ? "timeout" : "error",
            e.message.substring(0, 50)
          );
      }
    }

    if (!this._enabled) return;
    const customUrl = this._settings.get_string("custom-weather-url") || "";
    const customKey = this._settings.get_string("weather-api-key")    || "";
    if (customUrl.trim()) {
      try {
        if (this._panelButton && !this._panelButton._destroyed)
          this._panelButton.updateProviderStatus("custom", "testing");
        const url = WEATHER_PROVIDERS.custom.buildUrl(testLat, testLon, customKey, customUrl);
        const msg = Soup.Message.new("GET", url);
        msg.request_headers.append("User-Agent", "GNOME-Weather-Extension/1.0");
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
        if (msg.status_code === 200) {
          WEATHER_PROVIDERS.custom.parseResponse(JSON.parse(new TextDecoder().decode(bytes.get_data())));
          if (this._panelButton && !this._panelButton._destroyed)
            this._panelButton.updateProviderStatus("custom", "working");
        } else {
          if (this._panelButton && !this._panelButton._destroyed)
            this._panelButton.updateProviderStatus("custom", "error", `HTTP ${msg.status_code}`);
        }
      } catch (e) {
        if (this._panelButton && !this._panelButton._destroyed)
          this._panelButton.updateProviderStatus("custom", "error", e.message.substring(0, 50));
      }
    } else {
      if (this._panelButton && !this._panelButton._destroyed)
        this._panelButton.updateProviderStatus("custom", "inactive");
    }
  }

  // ── Panel rebuild ─────────────────────────────────────────────────────────

  _rebuildPanel() {
    if (!this._enabled || !this._panelButton) return;
    this._panelButton.destroy();
    this._panelButton = new WeatherPanelButton(this);
    const pos   = this._settings.get_string("panel-position")    || "right";
    const index = this._settings.get_int("panel-position-index") || 0;
    Main.panel.addToStatusArea("weather-extension", this._panelButton, index, pos);
    this._detectLocationAndLoadWeather();
  }

  // ── Debounced reload ───────────────────────────────────────────────────────

  _debouncedReload() {
    if (!this._enabled) return;
    if (this._debounceTimeoutId) {
      GLib.source_remove(this._debounceTimeoutId);
      this._debounceTimeoutId = null;
    }
    this._debounceTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
      this._debounceTimeoutId = null;
      if (this._enabled) this._detectLocationAndLoadWeather();
      return GLib.SOURCE_REMOVE;
    });
  }

  _scheduleReload(delaySec) {
    if (!this._enabled) return;
    if (this._networkReloadId) {
      GLib.source_remove(this._networkReloadId);
      this._networkReloadId = null;
    }
    this._networkReloadId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delaySec, () => {
      this._networkReloadId = null;
      if (this._enabled) this._detectLocationAndLoadWeather();
      return GLib.SOURCE_REMOVE;
    });
  }

  _cancelPendingTimers() {
    for (const prop of ["_debounceTimeoutId", "_networkReloadId"]) {
      if (this[prop]) { GLib.source_remove(this[prop]); this[prop] = null; }
    }
  }
}