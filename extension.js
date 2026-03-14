/**
 * Advanced Weather Companion – extension.js
 *
 * Responsibilities of THIS file:
 *   • Boot / shutdown lifecycle
 *   • Fetch weather data from the selected provider
 *   • Coordinate location detection ↔ weather load
 *   • Manage periodic refresh and network-change reactions
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
import {Extension} from "resource:///org/gnome/shell/extensions/extension.js";

import {WEATHER_PROVIDERS} from "./lib/providers.js";
import {LocationManager}   from "./lib/location.js";
import {WeatherPanelButton}from "./lib/panelMenu.js";

// Fallback location when everything else fails
const FALLBACK = {lat: 40.7128, lon: -74.006, name: "New York, NY (Fallback)"};

export default class WeatherExtension extends Extension {

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  enable() {
    this._enabled  = true;
    this._settings = this.getSettings("org.gnome.shell.extensions.advanced-weather");
    this._session  = new Soup.Session();
    this._session.timeout = this._settings.get_int("weather-request-timeout") || 15;

    this._latitude  = null;
    this._longitude = null;

    this._locationManager = new LocationManager(this._session);

    this._panelButton = new WeatherPanelButton(this);
    const pos   = this._settings.get_string("panel-position")   || "right";
    const index = this._settings.get_int("panel-position-index")  || 0;
    Main.panel.addToStatusArea("weather-extension", this._panelButton, index, pos);

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

    this._settings        = null;
    this._locationManager = null;
    this._latitude        = null;
    this._longitude       = null;
  }

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
      // Use fallback coords so we still get a weather reading
      this._latitude    = FALLBACK.lat;
      this._longitude   = FALLBACK.lon;
      this._locationName= FALLBACK.name;

      if (this._panelButton && !this._panelButton._destroyed) {
        this._panelButton._weatherLabel.set_text("Offline");
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
      // buildUrl throws when a required API key is missing
      console.error(`[Weather] ${cfg.name} URL build error:`, e.message);
      if (this._panelButton && !this._panelButton._destroyed) {
        this._panelButton._weatherLabel.set_text("No Key");
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
    } catch (e) {
      console.error(`[Weather] ${cfg.name} fetch failed:`, e.message);

      if (this._panelButton && !this._panelButton._destroyed) {
        const offline = !Gio.NetworkMonitor.get_default().get_network_available();
        this._panelButton._weatherLabel.set_text(offline ? "Offline" : "Error");
        this._panelButton._weatherIcon.set_icon_name(
          offline ? "network-offline-symbolic" : "dialog-error-symbolic"
        );
        this._panelButton.updateProviderStatus(
          providerKey,
          e.message.includes("timeout") ? "timeout" : "error",
          e.message.substring(0, 60)
        );
      }

      // Attempt a free fallback when provider key is wrong or provider is down
      if (providerKey !== "openmeteo" && Gio.NetworkMonitor.get_default().get_network_available()) {
        this._tryFallback(providerKey);
      }
    }
  }

  async _tryFallback(failedKey) {
    if (!this._enabled) return;
    // Try the free providers in order; skip the one that just failed
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
            provider: `${cfg.name} (fallback)`,
          });
        }
        console.log(`[Weather] Fell back to ${cfg.name}`);
        return;
      } catch (_) { /* try next */ }
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
        // Don't test paid providers without a key – just mark inactive
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

    // Test custom if URL is configured
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

  // ── Debounced reload (avoids double-fetch while user edits settings) ───────

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
