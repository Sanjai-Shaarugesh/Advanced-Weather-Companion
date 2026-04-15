import Gio from "gi://Gio";
import Soup from "gi://Soup";
import GLib from "gi://GLib";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as MessageTray from "resource:///org/gnome/shell/ui/messageTray.js";
import {
  Extension,
  gettext as getText,
} from "resource:///org/gnome/shell/extensions/extension.js";

import {
  WEATHER_PROVIDERS,
  setGettext,
  getWeatherConditions,
} from "./lib/providers.js";
import { LocationManager } from "./lib/location.js";
import { WeatherPanelButton } from "./lib/panelMenu.js";
import {
  evaluateAlerts,
  setGettext as setAlertsGettext,
  NOTIFIABLE_SEVERITIES,
} from "./lib/alerts.js";


const DEBUG = false;
function _log(...args) { if (DEBUG) console.log(...args); }
function _warn(...args) { if (DEBUG) console.error(...args); }

// Fallback location used when all location services fail
const FALLBACK = {
  lat: 40.7128,
  lon: -74.006,
  name: "New York, NY (Fallback)",
};

export default class WeatherExtension extends Extension {
  enable() {
    this._enabled = true;
    this._settings = this.getSettings(
      "org.gnome.shell.extensions.advanced-weather",
    );
    this._session = new Soup.Session();
    this._session.timeout =
      this._settings.get_int("weather-request-timeout") || 15;

    this._cancellable = new Gio.Cancellable();

    this._debounceTimeoutId = null;
    this._networkReloadId = null;

    this._latitude = null;
    this._longitude = null;
    this._locationName = null;

    // Wire gettext into provider and alert modules
    const gt = (s) => this.gettext(s);
    setGettext(gt);
    setAlertsGettext(gt);

    this._locationManager = new LocationManager(this._session);

    this._panelButton = new WeatherPanelButton(this);
    const pos = this._settings.get_string("panel-position") || "right";
    const index = this._settings.get_int("panel-position-index") || 0;
    Main.panel.addToStatusArea(
      "weather-extension",
      this._panelButton,
      index,
      pos,
    );

    // Notification source
    this._notifSource = null;

    this._lastAlertKey = null;

    this._settingsConns = [
      this._settings.connect("changed::panel-position", () => {
        if (this._enabled) this._rebuildPanel();
      }),
      this._settings.connect("changed::panel-position-index", () => {
        if (this._enabled) this._rebuildPanel();
      }),
      this._settings.connect("changed::update-interval", () => {
        if (this._enabled) this._panelButton._startUpdateTimer();
      }),
      this._settings.connect("changed::weather-request-timeout", () => {
        if (this._enabled)
          this._session.timeout =
            this._settings.get_int("weather-request-timeout") || 15;
      }),
      this._settings.connect("changed::weather-provider", () =>
        this._debouncedReload(),
      ),
      this._settings.connect("changed::weather-api-key", () =>
        this._debouncedReload(),
      ),
      this._settings.connect("changed::custom-weather-url", () =>
        this._debouncedReload(),
      ),
      this._settings.connect("changed::location-mode", () => {
        if (this._enabled) this._detectLocationAndLoadWeather();
      }),
      this._settings.connect("changed::location", () => {
        if (this._enabled) this._detectLocationAndLoadWeather();
      }),

      this._settings.connect("changed::enable-weather-alerts", () => {
        this._lastAlertKey = null;
      }),
      this._settings.connect("changed::show-alerts-in-panel", () => {
        if (this._enabled && this._panelButton && !this._panelButton._destroyed)
          this._panelButton.refreshAlerts();
      }),
    ];

    //  Network monitor
    this._networkMonitor = Gio.NetworkMonitor.get_default();
    this._networkConnId = this._networkMonitor.connect(
      "network-changed",
      (_m, available) => {
        if (available && this._enabled) this._scheduleReload(2);
      },
    );

    this._testAllProviders();
    this._detectLocationAndLoadWeather();
  }

  disable() {
    this._enabled = false;

    // Cancel all in-flight async requests immediately
    if (this._cancellable) {
      this._cancellable.cancel();
      this._cancellable = null;
    }

    if (this._networkConnId) {
      this._networkMonitor.disconnect(this._networkConnId);
      this._networkConnId = null;
    }

    if (this._debounceTimeoutId) {
      GLib.source_remove(this._debounceTimeoutId);
      this._debounceTimeoutId = null;
    }

    if (this._networkReloadId) {
      GLib.source_remove(this._networkReloadId);
      this._networkReloadId = null;
    }

    if (this._panelButton) {
      this._panelButton.destroy();
      this._panelButton = null;
    }

    for (const id of this._settingsConns ?? []) {
      try {
        this._settings.disconnect(id);
      } catch (_) {}
    }
    this._settingsConns = null;

    if (this._session) {
      this._session.abort();
      this._session = null;
    }

    this._notifSource = null;
    this._lastAlertKey = null;
    this._settings = null;
    this._locationManager = null;
    this._latitude = null;
    this._longitude = null;
  }

  _(s) {
    return this.gettext(s);
  }

  //  Location resolution

  async _detectLocationAndLoadWeather() {
    if (!this._enabled) return;
    try {
      const loc = await this._locationManager.resolveLocation(
        this._settings,
        this._cancellable,
      );
      this._latitude = loc.lat;
      this._longitude = loc.lon;
      this._locationName = loc.name;
    } catch (e) {
      if (this._isCancelled(e)) return;
      _warn("[Weather] Location detection failed:", e.message);
      this._latitude = FALLBACK.lat;
      this._longitude = FALLBACK.lon;
      this._locationName = FALLBACK.name;
      if (this._panelButton && !this._panelButton._destroyed) {
        this._panelButton._weatherLabel.set_text(this._("Offline"));
        this._panelButton._weatherIcon.set_icon_name(
          "network-offline-symbolic",
        );
      }
    }
    await this._loadWeatherData();
  }

  // Weather fetch

  async _loadWeatherData() {
    if (!this._enabled) return;

    const providerKey =
      this._settings.get_string("weather-provider") || "openmeteo";
    const apiKey = this._settings.get_string("weather-api-key") || "";
    const customUrl = this._settings.get_string("custom-weather-url") || "";
    const cfg = WEATHER_PROVIDERS[providerKey];

    if (!cfg) {
      _warn("[Weather] Unknown provider:", providerKey);
      return;
    }

    if (this._panelButton && !this._panelButton._destroyed)
      this._panelButton.updateProviderStatus(providerKey, "testing");

    let url;
    try {
      url =
        providerKey === "custom"
          ? cfg.buildUrl(this._latitude, this._longitude, apiKey, customUrl)
          : cfg.buildUrl(this._latitude, this._longitude, apiKey);
    } catch (e) {
      _warn("[Weather] URL build error:", e.message);
      if (this._panelButton && !this._panelButton._destroyed) {
        this._panelButton._weatherLabel.set_text(this._("No Key"));
        this._panelButton._weatherIcon.set_icon_name("dialog-warning-symbolic");
        this._panelButton.updateProviderStatus(
          providerKey,
          "error",
          e.message.substring(0, 60),
        );
      }
      return;
    }

    _log(
      "[Weather] Fetching from",
      cfg.name,
      url.replace(apiKey || "NOKEY", "***"),
    );

    try {
      const msg = Soup.Message.new("GET", url);
      msg.request_headers.append("User-Agent", "GNOME-Weather-Extension/1.0");

      const bytes = await this._session.send_and_read_async(
        msg,
        GLib.PRIORITY_DEFAULT,
        this._cancellable,
      );

      if (msg.status_code !== 200)
        throw new Error("HTTP " + msg.status_code + ": " + msg.reason_phrase);

      const parsed = cfg.parseResponse(
        JSON.parse(new TextDecoder().decode(bytes.get_data())),
      );

      if (this._panelButton && !this._panelButton._destroyed) {
        this._panelButton.updateWeather({
          location: this._locationName,
          current: parsed.current,
          hourly: parsed.hourly ?? null,
          daily: parsed.daily ?? null,
          provider: cfg.name,
        });
      }

      this._processAlerts(parsed.current, this._locationName);
    } catch (e) {
      if (this._isCancelled(e)) return;
      _warn("[Weather]", cfg.name, "fetch failed:", e.message);

      if (this._panelButton && !this._panelButton._destroyed) {
        const offline =
          !Gio.NetworkMonitor.get_default().get_network_available();
        this._panelButton._weatherLabel.set_text(
          offline ? this._("Offline") : this._("Error"),
        );
        this._panelButton._weatherIcon.set_icon_name(
          offline ? "network-offline-symbolic" : "dialog-error-symbolic",
        );
        this._panelButton.updateProviderStatus(
          providerKey,
          e.message.includes("timeout") ? "timeout" : "error",
          e.message.substring(0, 60),
        );
      }

      if (
        providerKey !== "openmeteo" &&
        Gio.NetworkMonitor.get_default().get_network_available()
      )
        this._tryFallback(providerKey);
    }
  }

  async _tryFallback(failedKey) {
    if (!this._enabled) return;
    for (const key of ["openmeteo", "wttr", "meteosource"]) {
      if (key === failedKey) continue;
      const cfg = WEATHER_PROVIDERS[key];
      try {
        const url = cfg.buildUrl(this._latitude, this._longitude, "");
        const msg = Soup.Message.new("GET", url);
        msg.request_headers.append("User-Agent", "GNOME-Weather-Extension/1.0");
        const bytes = await this._session.send_and_read_async(
          msg,
          GLib.PRIORITY_DEFAULT,
          this._cancellable,
        );
        if (msg.status_code !== 200) continue;
        const parsed = cfg.parseResponse(
          JSON.parse(new TextDecoder().decode(bytes.get_data())),
        );
        if (this._panelButton && !this._panelButton._destroyed) {
          this._panelButton.updateWeather({
            location: this._locationName,
            current: parsed.current,
            hourly: parsed.hourly ?? null,
            daily: parsed.daily ?? null,
            provider: cfg.name + " (" + this._("fallback") + ")",
          });
        }
        this._processAlerts(parsed.current, this._locationName);
        _log("[Weather] Fell back to", cfg.name);
        return;
      } catch (e) {
        if (this._isCancelled(e)) return;
      }
    }
  }

  _processAlerts(current, location) {
    if (!this._enabled) return;

    const conditions = getWeatherConditions();
    const useFahr = this._settings.get_boolean("use-fahrenheit");
    const alerts = evaluateAlerts(current, location, useFahr, conditions);

    if (this._panelButton && !this._panelButton._destroyed)
      this._panelButton.updateAlerts(alerts);

    if (!this._settings.get_boolean("enable-weather-alerts")) {
      this._lastAlertKey = null;
      return;
    }

    const notifiable = alerts.filter((a) =>
      NOTIFIABLE_SEVERITIES.has(a.severity),
    );
    if (notifiable.length === 0) {
      this._lastAlertKey = null;
      return;
    }

    const alertKey = notifiable.map((a) => a.key).join("|");
    if (alertKey === this._lastAlertKey) return;
    this._lastAlertKey = alertKey;

    for (const alert of notifiable)
      this._sendNotification(alert.title, alert.body, alert.advice, alert.icon);
  }

  _sendNotification(title, body, advice, iconName) {
    if (!this._enabled) return;
    try {
      if (!this._notifSource) {
        this._notifSource = new MessageTray.Source({
          title: this._("Advanced Weather"),
          iconName: "weather-storm-symbolic",
        });
        Main.messageTray.add(this._notifSource);
      }

      const adviceText =
        Array.isArray(advice) && advice.length
          ? "\n\n" + this._("What to do:") + "\n• " + advice.join("\n• ")
          : "";

      const notification = new MessageTray.Notification({
        source: this._notifSource,
        title,
        body: body + adviceText,
        iconName: iconName || "weather-storm-symbolic",
        urgency: MessageTray.Urgency.HIGH,
        isTransient: false,
      });

      this._notifSource.addNotification(notification);
    } catch (e) {
      _warn("[Weather] Failed to send notification:", e.message);
    }
  }

  async _testAllProviders() {
    if (!this._enabled) return;
    const testLat = 40.7128,
      testLon = -74.006;

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
        const bytes = await this._session.send_and_read_async(
          msg,
          GLib.PRIORITY_DEFAULT,
          this._cancellable,
        );
        if (msg.status_code === 200) {
          cfg.parseResponse(
            JSON.parse(new TextDecoder().decode(bytes.get_data())),
          );
          if (this._panelButton && !this._panelButton._destroyed)
            this._panelButton.updateProviderStatus(key, "working");
        } else {
          if (this._panelButton && !this._panelButton._destroyed)
            this._panelButton.updateProviderStatus(
              key,
              "error",
              "HTTP " + msg.status_code,
            );
        }
      } catch (e) {
        if (this._isCancelled(e)) return;
        if (this._panelButton && !this._panelButton._destroyed)
          this._panelButton.updateProviderStatus(
            key,
            e.message.includes("timeout") ? "timeout" : "error",
            e.message.substring(0, 50),
          );
      }
    }

    if (!this._enabled) return;
    const customUrl = this._settings.get_string("custom-weather-url") || "";
    const customKey = this._settings.get_string("weather-api-key") || "";
    if (customUrl.trim()) {
      try {
        if (this._panelButton && !this._panelButton._destroyed)
          this._panelButton.updateProviderStatus("custom", "testing");
        const url = WEATHER_PROVIDERS.custom.buildUrl(
          testLat,
          testLon,
          customKey,
          customUrl,
        );
        const msg = Soup.Message.new("GET", url);
        msg.request_headers.append("User-Agent", "GNOME-Weather-Extension/1.0");
        const bytes = await this._session.send_and_read_async(
          msg,
          GLib.PRIORITY_DEFAULT,
          this._cancellable,
        );
        if (msg.status_code === 200) {
          WEATHER_PROVIDERS.custom.parseResponse(
            JSON.parse(new TextDecoder().decode(bytes.get_data())),
          );
          if (this._panelButton && !this._panelButton._destroyed)
            this._panelButton.updateProviderStatus("custom", "working");
        } else {
          if (this._panelButton && !this._panelButton._destroyed)
            this._panelButton.updateProviderStatus(
              "custom",
              "error",
              "HTTP " + msg.status_code,
            );
        }
      } catch (e) {
        if (this._isCancelled(e)) return;
        if (this._panelButton && !this._panelButton._destroyed)
          this._panelButton.updateProviderStatus(
            "custom",
            "error",
            e.message.substring(0, 50),
          );
      }
    } else {
      if (this._panelButton && !this._panelButton._destroyed)
        this._panelButton.updateProviderStatus("custom", "inactive");
    }
  }

  _rebuildPanel() {
    if (!this._enabled || !this._panelButton) return;
    this._panelButton.destroy();
    this._panelButton = new WeatherPanelButton(this);
    const pos = this._settings.get_string("panel-position") || "right";
    const index = this._settings.get_int("panel-position-index") || 0;
    Main.panel.addToStatusArea(
      "weather-extension",
      this._panelButton,
      index,
      pos,
    );
    this._detectLocationAndLoadWeather();
  }

  

  _debouncedReload() {
    if (!this._enabled) return;
    if (this._debounceTimeoutId) {
      GLib.source_remove(this._debounceTimeoutId);
      this._debounceTimeoutId = null;
    }
    this._debounceTimeoutId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      1,
      () => {
        this._debounceTimeoutId = null;
        if (this._enabled) this._detectLocationAndLoadWeather();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _scheduleReload(delaySec) {
    if (!this._enabled) return;
    if (this._networkReloadId) {
      GLib.source_remove(this._networkReloadId);
      this._networkReloadId = null;
    }
    this._networkReloadId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      delaySec,
      () => {
        this._networkReloadId = null;
        if (this._enabled) this._detectLocationAndLoadWeather();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _isCancelled(e) {
    return e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;
  }
}