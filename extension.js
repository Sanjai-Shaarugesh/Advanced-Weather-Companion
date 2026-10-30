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


// Driven by the debug-logging gsetting (see enable()) so provider chain
// failures can be diagnosed in a running shell without rebuilding the pack.
let DEBUG = false;
// _log is the verbose per-round chatter and stays behind debug-logging.
// _warn is never gated: a provider-chain, cache or location failure has to be
// visible in the journal of a session where nobody enabled debugging.
function _log(...args) { if (DEBUG) console.log(...args); }
function _warn(...args) { console.error(...args); }

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
    DEBUG = this._settings.get_boolean("debug-logging");

    this._session = new Soup.Session();
    this._session.timeout =
      this._settings.get_int("weather-request-timeout") || 15;

    this._cancellable = new Gio.Cancellable();

    this._debounceTimeoutId = null;
    this._networkReloadId = null;
    this._weatherLoadInFlight = false;
    this._weatherLoadQueued = false;
    this._panelLiveData = false;
    this._cacheShownAt = null;

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
      this._settings.connect("changed::debug-logging", () => {
        DEBUG = this._settings.get_boolean("debug-logging");
      }),
      this._settings.connect("changed::enable-provider-fallback", () => {
        if (this._enabled) this._debouncedReload();
      }),
      this._settings.connect("changed::fallback-provider-order", () => {
        if (this._enabled) this._debouncedReload();
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
  //
  // One round tries every usable provider exactly once, in priority order.
  // If all of them fail we serve the last successful payload from the local
  // cache (which includes the hourly and daily forecasts) instead of showing
  // an error, as long as the cache still falls inside its forecast horizon.

  _setProviderStatus(provider, status, error = null) {
    if (this._panelButton && !this._panelButton._destroyed)
      this._panelButton.updateProviderStatus(provider, status, error);
  }

  /**
   * Providers to try this round: configured one first, then the configured
   * fallback order, then every remaining provider as a last resort.
   * Each key appears at most once, so a round always terminates.
   */
  _getProviderQueue() {
    const configured =
      this._settings.get_string("weather-provider") || "openmeteo";
    const apiKey = (this._settings.get_string("weather-api-key") || "").trim();
    const customUrl = (this._settings.get_string("custom-weather-url") || "").trim();
    const fallbackEnabled = this._settings.get_boolean("enable-provider-fallback");

    const candidates = [configured];
    if (fallbackEnabled) {
      candidates.push(...this._settings.get_strv("fallback-provider-order"));
      candidates.push(...Object.keys(WEATHER_PROVIDERS));
    }

    const queue = [];
    for (const key of candidates) {
      const cfg = WEATHER_PROVIDERS[key];
      if (!cfg || queue.includes(key)) continue;
      if (key === "custom" && !customUrl) continue;
      // Providers that need a key are only worth trying when we actually have
      // one, except the configured one, whose error message is informative.
      if (cfg.requiresApiKey && !apiKey && key !== configured) continue;
      queue.push(key);
    }
    return queue;
  }

  async _fetchFromProvider(providerKey, apiKey, customUrl) {
    const cfg = WEATHER_PROVIDERS[providerKey];

    const url =
      providerKey === "custom"
        ? cfg.buildUrl(this._latitude, this._longitude, apiKey, customUrl)
        : cfg.buildUrl(this._latitude, this._longitude, apiKey);

    _log("[Weather] Trying", cfg.name, url.replace(apiKey || "NOKEY", "***"));

    const msg = Soup.Message.new("GET", url);
    msg.request_headers.append("User-Agent", "GNOME-Weather-Extension/1.0");

    const bytes = await this._session.send_and_read_async(
      msg,
      GLib.PRIORITY_DEFAULT,
      this._cancellable,
    );

    if (msg.status_code !== 200)
      throw new Error(
        "HTTP " + msg.status_code + ": " + (msg.reason_phrase ?? "no response"),
      );

    return cfg.parseResponse(
      JSON.parse(new TextDecoder().decode(bytes.get_data())),
    );
  }

  async _loadWeatherData() {
    if (!this._enabled) return;

    // Guard against overlapping rounds (timer + settings change + refresh).
    if (this._weatherLoadInFlight) {
      this._weatherLoadQueued = true;
      return;
    }
    this._weatherLoadInFlight = true;

    try {
      const configured =
        this._settings.get_string("weather-provider") || "openmeteo";
      const apiKey = this._settings.get_string("weather-api-key") || "";
      const customUrl = this._settings.get_string("custom-weather-url") || "";

      const queue = this._getProviderQueue();

      // Providers we are not going to call this round must not keep a green
      // check from an older round: the custom endpoint without a URL and the
      // paid ones without a key are inactive, whatever was recorded before.
      for (const key of Object.keys(WEATHER_PROVIDERS))
        if (!queue.includes(key)) this._setProviderStatus(key, "inactive");

      // Paint what we already know before touching the network. A geolocation
      // lookup that never resolves or a provider that hangs until the request
      // timeout must not leave the panel blank or stuck on an error label.
      if (!this._panelLiveData) this._renderCachedWeather();

      if (queue.length === 0) {
        _warn("[Weather] No usable provider configured (current:", configured, ")");
        this._showWeatherFailure(configured, "no-provider");
        return;
      }

      let usedKey = null;
      let parsed = null;
      let lastError = null;

      for (const key of queue) {
        if (!this._enabled) return;
        this._setProviderStatus(key, "testing");
        try {
          parsed = await this._fetchFromProvider(key, apiKey, customUrl);
          usedKey = key;
          break;
        } catch (e) {
          if (this._isCancelled(e)) return;
          if (!this._enabled) return;
          lastError = e;
          const status = this._isTimeout(e) ? "timeout" : "error";
          _warn("[Weather]", WEATHER_PROVIDERS[key].name, "failed:", e.message);
          this._setProviderStatus(key, status, e.message.substring(0, 60));
        }
      }

      if (!this._enabled) return;

      if (usedKey) {
        const data = {
          location: this._locationName,
          current: parsed.current,
          hourly: parsed.hourly ?? null,
          daily: parsed.daily ?? null,
          providerKey: usedKey,
          provider:
            WEATHER_PROVIDERS[usedKey].name +
            (usedKey === configured ? "" : " (" + this._("fallback") + ")"),
          lat: this._latitude,
          lon: this._longitude,
          fetchedAt: Math.floor(GLib.get_real_time() / 1000000),
          stale: false,
        };

        this._saveWeatherCache(data);

        if (this._panelButton && !this._panelButton._destroyed) {
          this._panelButton.updateWeather(data);
          this._panelLiveData = true;
          this._cacheShownAt = null;
        }

        this._processAlerts(parsed.current, this._locationName);
        if (usedKey !== configured) _log("[Weather] Fell back to", data.provider);
        return;
      }

      _warn("[Weather] All providers failed this round:", queue.join(", "));
      this._showWeatherFailure(configured, lastError?.message ?? "error");
    } finally {
      this._weatherLoadInFlight = false;
      if (this._weatherLoadQueued) {
        this._weatherLoadQueued = false;
        this._loadWeatherData();
      }
    }
  }

  //  Offline cache

  _saveWeatherCache(data) {
    try {
      this._settings.set_string("cached-weather-data", JSON.stringify(data));
      this._settings.set_int64("weather-cached-at", data.fetchedAt);
    } catch (e) {
      _warn("[Weather] Could not write weather cache:", e.message);
    }
  }

  _loadWeatherCache() {
    try {
      const raw = this._settings.get_string("cached-weather-data");
      if (!raw || raw === "{}" || raw.length < 3) return null;
      const data = JSON.parse(raw);
      const temp = data?.current?.temperature_2m;
      if (typeof temp !== "number" || !isFinite(temp)) return null;

      // A cache written for other coordinates must not be reused.
      if (
        this._latitude !== null &&
        this._longitude !== null &&
        typeof data.lat === "number" &&
        (Math.abs(data.lat - this._latitude) > 0.01 ||
          Math.abs(data.lon - this._longitude) > 0.01)
      ) {
        _warn("[Weather] Cached data is for another location, ignoring it");
        return null;
      }
      return data;
    } catch (e) {
      _warn("[Weather] Bad weather cache payload:", e.message);
      return null;
    }
  }

  /**
   * Cached data is usable while it is younger than weather-cache-max-age-days
   * (7 by default) and its daily forecast still reaches today. Providers that
   * deliver no forecast at all (OpenWeatherMap, WeatherAPI, custom endpoints)
   * have no horizon to validate, so they stay usable for a single day.
   */
  _isCacheUsable(data) {
    if (!data) return false;

    const maxDays =
      Math.max(1, this._settings.get_int("weather-cache-max-age-days") || 7);
    const nowSec = GLib.get_real_time() / 1000000;
    // fetchedAt travels inside the payload; weather-cached-at is the mirror we
    // keep in gsettings so the cache stays inspectable with dconf/gsettings.
    const stamp =
      Number(data.fetchedAt) || Number(this._settings.get_int64?.("weather-cached-at") ?? 0) || 0;
    const rawAge = nowSec - stamp;
    if (!isFinite(rawAge)) return false;
    // NTP steps and manual corrections can put the wall clock behind the stamp
    // of a perfectly recent fetch, so up to a day of negative age counts as
    // fresh. A stamp further ahead than that means the clock (or the stamp)
    // cannot be trusted, and the cache is refused rather than served as new.
    if (rawAge < -86400) return false;
    const ageSec = Math.max(0, rawAge);
    if (ageSec > maxDays * 86400) return false;

    const days = data.daily?.time;
    const horizon = this._lastForecastDate(days);
    if (horizon) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return horizon >= today;
    }

    // No forecast horizon to validate (providers without daily data, custom
    // endpoints, an unparseable day list): usable for a single day.
    return ageSec <= 86400;
  }

  /**
   * Last day a cached daily forecast covers. Providers publish ISO dates
   * ("2026-10-22"), but custom endpoints often use epoch seconds or
   * milliseconds, so those are normalised as well. Returns null when the list
   * is missing or the value cannot be read as a sane date.
   */
  _lastForecastDate(days) {
    const raw = days?.[days.length - 1];
    if (raw === undefined || raw === null || raw === "") return null;

    const text = String(raw).trim();
    let date = null;

    if (/^\d+$/.test(text)) {
      // Epoch seconds or milliseconds; anything shorter is not a timestamp we
      // can trust (providers that emit "0", "1", "2" as placeholders).
      if (text.length < 9 || text.length > 13) return null;
      const num = Number(text);
      const millis = text.length >= 12 ? num : num * 1000;
      date = new Date(millis);
    } else if (/[-:]/.test(text)) {
      date = new Date(text);
    } else {
      return null;
    }

    if (!date || isNaN(date)) return null;
    const year = date.getFullYear();
    return year >= 1970 && year <= 2100 ? date : null;
  }

  /**
   * Render the last known good payload on the panel, flagged as stale. Used
   * both when a round fails and when a round starts with an empty panel, so
   * usable cached data is never hidden behind an error label. Returns true
   * when the cache was good enough to display.
   */
  _renderCachedWeather() {
    const cached = this._loadWeatherCache();
    if (!this._isCacheUsable(cached)) return false;

    // The round-start serve already painted this exact payload; painting it
    // again would make the panel flicker at the end of a failing round.
    if (this._panelLiveData && this._cacheShownAt === cached.fetchedAt) return true;

    cached.stale = true;
    cached.provider =
      (WEATHER_PROVIDERS[cached.providerKey]?.name ?? cached.provider ?? "") +
      " (" +
      this._("cached data") +
      ")";
    _log("[Weather] Serving cached data from", cached.fetchedAt);

    if (this._panelButton && !this._panelButton._destroyed) {
      this._panelButton.updateWeather(cached);
      this._panelLiveData = true;
      this._cacheShownAt = cached.fetchedAt;
    } else {
      return false;
    }

    this._processAlerts(cached.current, cached.location ?? this._locationName);
    return true;
  }

  _showWeatherFailure(configured, lastError) {
    if (!this._enabled) return;

    if (this._renderCachedWeather()) return;

    if (this._panelButton && !this._panelButton._destroyed) {
      this._panelLiveData = false;
      const offline =
        !Gio.NetworkMonitor.get_default().get_network_available();
      const needsKey =
        WEATHER_PROVIDERS[configured]?.requiresApiKey &&
        !(this._settings.get_string("weather-api-key") || "").trim();
      const missingUrl =
        configured === "custom" &&
        !(this._settings.get_string("custom-weather-url") || "").trim();

      this._panelButton._weatherLabel.set_text(
        needsKey || missingUrl
          ? this._("No Key")
          : offline
            ? this._("Offline")
            : this._("Error"),
      );
      this._panelButton._weatherIcon.set_icon_name(
        needsKey || missingUrl
          ? "dialog-warning-symbolic"
          : offline
            ? "network-offline-symbolic"
            : "dialog-error-symbolic",
      );
    }

    this._setProviderStatus(
      configured,
      this._isTimeout(lastError) ? "timeout" : "error",
      String(lastError).substring(0, 60),
    );
  }

  _isTimeout(error) {
    if (!error) return false;
    try {
      if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT)) return true;
      if (error.matches?.(Soup.ClientError, Soup.ClientError.TIMEOUT)) return true;
    } catch (_) {}
    return /timed?\s*out|timeout/i.test(error.message ?? "");
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
    this._panelLiveData = false;
    this._cacheShownAt = null;
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