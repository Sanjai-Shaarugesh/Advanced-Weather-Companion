import St from "gi://St";
import GObject from "gi://GObject";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import {
  WEATHER_PROVIDERS,
  getWeatherConditions,
  WIND_SPEED_UNITS,
  convertWindSpeed,
  canonicalTime,
} from "./providers.js";

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";

//  Calendar-day helpers
//
// Forecast payloads carry canonical "YYYY-MM-DD" day keys (see canonicalTime in
// lib/providers.js). Comparing those keys as calendar dates keeps "Today" and
// the day labels correct for the forecast location, instead of letting UTC
// offsets or DST shift a day by one the way ms arithmetic would.

function _dayKey(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function _dayOffset(fromKey, toKey) {
  const from = new Date(`${fromKey}T00:00`);
  const to = new Date(`${toKey}T00:00`);
  if (isNaN(from) || isNaN(to)) return null;
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

export const WeatherPanelButton = GObject.registerClass(
  class WeatherPanelButton extends PanelMenu.Button {
    _init(ext) {
      super._init(0.0, "Weather Extension", false);
      this._ext = ext;
      this._settings = ext._settings;
      this._updateTimeoutId = null;
      this._retryCount = 0;
      this._lastGoodUpdate = null;
      this._showingCachedData = false;
      this._providerStatus = new Map();
      this._destroyed = false;
      this._activeAlerts = []; // last evaluated alert list

      this._buildPanelWidget();
      this._buildMenu();
      this._connectSettings();
      this._updateLocationIndicator();
      this._startUpdateTimer();
    }

    _(s) {
      return this._ext._(s);
    }

    _buildPanelWidget() {
      this._container = new St.BoxLayout({
        vertical: false,
        style_class: "weather-button-box",
      });

      this._weatherIcon = new St.Icon({
        icon_name: "weather-clear-symbolic",
        icon_size: this._settings.get_int("panel-icon-size") || 16,
        style_class: "weather-icon",
      });

      this._weatherLabel = new St.Label({
        text: "…",
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "weather-label",
        style:
          "font-size: " +
          (this._settings.get_int("panel-text-size") || 13) +
          "px;",
      });

      this._alertBadge = new St.Label({
        text: "⚠",
        y_align: Clutter.ActorAlign.START,
        style_class: "weather-alert-badge",
        style:
          "color: #ff4444; font-size: 9px; font-weight: bold; padding: 0 1px;",
        visible: false,
      });

      this._locationIcon = new St.Icon({
        icon_name: "find-location-symbolic",
        icon_size: 12,
        style_class: "location-icon",
      });

      this._locationDot = new St.Label({
        text: this._locationModeText(),
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "location-mode-label",
      });

      this._rebuildPanelChildren();
      this.add_child(this._container);
    }

    _rebuildPanelChildren() {
      this._container.remove_all_children();
      this._container.add_child(this._weatherIcon);
      this._container.add_child(this._alertBadge);
      if (this._settings.get_boolean("show-text-in-panel"))
        this._container.add_child(this._weatherLabel);
      if (this._settings.get_boolean("show-location-label")) {
        this._container.add_child(this._locationIcon);
        this._container.add_child(this._locationDot);
      }
    }

    _locationModeText() {
      return (this._settings.get_string("location-mode") ?? "auto") === "auto"
        ? this._("AUTO")
        : this._("MANUAL");
    }

    // Menu

    _buildMenu() {
      // Current conditions
      this._currentSection = new PopupMenu.PopupMenuSection();
      this._currentWeatherItem = new PopupMenu.PopupMenuItem(
        this._("Loading weather…"),
        { reactive: false, style_class: "current-weather" },
      );
      this._currentSection.addMenuItem(this._currentWeatherItem);

      //  Alerts section
      this._alertsSection = new PopupMenu.PopupMenuSection();
      this._alertsSeparator = new PopupMenu.PopupSeparatorMenuItem(
        "⚠️ " + this._("Weather Alerts"),
      );

      this._alertsSeparator.actor.visible = false;

      // Location info sub-menu
      this._locationInfoSection = new PopupMenu.PopupSubMenuMenuItem(
        "📍 " + this._("Location Information"),
        true,
      );
      this._buildLocationInfo();

      // Provider status sub-menu
      this._providerSection = new PopupMenu.PopupSubMenuMenuItem(
        "🌐 " + this._("Weather Provider Status"),
        true,
      );
      this._buildProviderInfo();

      // Forecasts
      this._hourlySection = new PopupMenu.PopupSubMenuMenuItem(
        "⏰ " + this._("Hourly Forecast"),
        true,
      );
      this._dailySection = new PopupMenu.PopupSubMenuMenuItem(
        "📅 " + this._("7-Day Forecast"),
        true,
      );
      this._insightsSection = new PopupMenu.PopupSubMenuMenuItem(
        "🔍 " + this._("Weather Insights"),
        true,
      );

      // Actions
      this._refreshItem = new PopupMenu.PopupMenuItem(
        "🔄 " + this._("Refresh Weather"),
      );
      this._refreshItem.style_class = "refresh-button";
      this._refreshItem.connect("activate", () => {
        if (!this._destroyed) this._ext._detectLocationAndLoadWeather();
      });

      this._settingsItem = new PopupMenu.PopupMenuItem(
        "⚙️ " + this._("Extension Settings"),
      );
      this._settingsItem.connect("activate", () => {
        if (!this._destroyed) this._ext.openPreferences();
      });

      this.menu.addMenuItem(this._currentSection);
      this.menu.addMenuItem(this._alertsSeparator);
      this.menu.addMenuItem(this._alertsSection);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this.menu.addMenuItem(this._locationInfoSection);
      this.menu.addMenuItem(this._providerSection);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this.menu.addMenuItem(this._hourlySection);
      this.menu.addMenuItem(this._dailySection);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this.menu.addMenuItem(this._insightsSection);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this.menu.addMenuItem(this._refreshItem);
      this.menu.addMenuItem(this._settingsItem);
    }

    // ── Alert section ─────────────────────────────────────────────────────────

    /**
     * Called by extension.js after every weather fetch with the evaluated alert list.
     * Rebuilds the panel alert section and toggles the badge.
     *
     * @param {import('./alerts.js').Alert[]} alerts
     */
    updateAlerts(alerts) {
      if (this._destroyed) return;
      this._activeAlerts = alerts;
      this.refreshAlerts();
    }

    refreshAlerts() {
      if (this._destroyed) return;
      this._alertsSection.removeAll();

      const showInPanel = this._settings.get_boolean("show-alerts-in-panel");
      const alerts = this._activeAlerts ?? [];
      const hasAlerts = alerts.length > 0;

      // Always keep the badge in sync regardless of the setting
      if (this._alertBadge) this._alertBadge.visible = hasAlerts;

      if (!showInPanel || !hasAlerts) {
        this._alertsSeparator.actor.visible = false;
        return;
      }

      this._alertsSeparator.actor.visible = true;

      for (const alert of alerts) {
        const isSevere = alert.severity === "severe";

        const headerItem = new PopupMenu.PopupBaseMenuItem({
          reactive: false,
          style_class: isSevere
            ? "weather-alert-severe"
            : "weather-alert-warning",
        });
        const headerBox = new St.BoxLayout({
          vertical: false,
          style: "spacing: 8px; padding: 4px 8px;",
        });

        headerBox.add_child(
          new St.Icon({
            icon_name: alert.icon || "dialog-warning-symbolic",
            icon_size: 18,
            style_class: "popup-menu-icon",
          }),
        );
        const titleBox = new St.BoxLayout({ vertical: true, x_expand: true });
        titleBox.add_child(
          new St.Label({
            text: alert.title,
            style:
              "font-weight: bold; " +
              (isSevere ? "color: #ff4444;" : "color: #ffaa00;"),
          }),
        );
        titleBox.add_child(
          new St.Label({
            text: alert.body,
            style: "font-size: 11px; opacity: 0.85;",
          }),
        );
        headerBox.add_child(titleBox);
        headerItem.add_child(headerBox);
        this._alertsSection.addMenuItem(headerItem);

        if (Array.isArray(alert.advice) && alert.advice.length > 0) {
          const adviceMenu = new PopupMenu.PopupSubMenuMenuItem(
            "   📋 " + this._("What to do"),
            true,
          );
          adviceMenu.label.style = "font-size: 11px; opacity: 0.8;";

          for (const tip of alert.advice) {
            const tipItem = new PopupMenu.PopupBaseMenuItem({
              reactive: false,
              style_class: "weather-alert-advice",
            });
            const tipBox = new St.BoxLayout({
              vertical: false,
              style: "spacing: 6px; padding: 2px 8px 2px 20px;",
            });
            tipBox.add_child(
              new St.Label({
                text: "•",
                style: "color: #aaaaaa; min-width: 10px;",
              }),
            );
            tipBox.add_child(
              new St.Label({
                text: tip,
                style: "font-size: 11px; opacity: 0.9;",
                x_expand: true,
              }),
            );
            tipItem.add_child(tipBox);
            adviceMenu.menu.addMenuItem(tipItem);
          }

          this._alertsSection.addMenuItem(adviceMenu);
        }
      }
    }

    _buildProviderInfo() {
      this._currentProviderItem = new PopupMenu.PopupMenuItem(
        this._("Active") + ": " + this._("Loading…"),
        { reactive: false, style_class: "provider-info-item" },
      );
      this._providerStatusItem = new PopupMenu.PopupMenuItem(
        this._("Status") + ": " + this._("Checking…"),
        { reactive: false, style_class: "provider-info-item" },
      );
      this._lastUpdateItem = new PopupMenu.PopupMenuItem(
        this._("Last Update") + ": " + this._("Never"),
        { reactive: false, style_class: "provider-info-item" },
      );
      this._providersStatusSection = new PopupMenu.PopupMenuSection();
      this._refreshProvidersList();

      this._providerSection.menu.addMenuItem(this._currentProviderItem);
      this._providerSection.menu.addMenuItem(this._providerStatusItem);
      this._providerSection.menu.addMenuItem(this._lastUpdateItem);
      this._providerSection.menu.addMenuItem(
        new PopupMenu.PopupSeparatorMenuItem(),
      );
      this._providerSection.menu.addMenuItem(this._providersStatusSection);
    }

    _refreshProvidersList() {
      if (this._destroyed) return;
      this._providersStatusSection.removeAll();

      const titleItem = new PopupMenu.PopupMenuItem(
        this._("Available Providers") + ":",
        { reactive: false, style_class: "provider-info-item" },
      );
      titleItem.label.style = "font-weight: bold; opacity: 0.8;";
      this._providersStatusSection.addMenuItem(titleItem);

      for (const [key, cfg] of Object.entries(WEATHER_PROVIDERS)) {
        if (key === "custom") continue;
        const status = this._effectiveStatus(key, cfg);
        const icon = this._statusIcon(status);
        const free = cfg.isFree ? "🆓" : "💰";

        const item = new PopupMenu.PopupMenuItem(
          icon + " " + free + " " + cfg.name,
          { reactive: status === "working", style_class: "provider-info-item" },
        );
        if (status === "working") {
          item.connect("activate", () => {
            if (!this._destroyed)
              this._settings.set_string("weather-provider", key);
          });
        }
        this._providersStatusSection.addMenuItem(item);
      }

      const customStatus = this._effectiveStatus("custom", WEATHER_PROVIDERS.custom);
      this._providersStatusSection.addMenuItem(
        new PopupMenu.PopupMenuItem(
          this._statusIcon(customStatus) + " ⚙️ " + this._("Custom Provider"),
          { reactive: false, style_class: "provider-info-item" },
        ),
      );
    }

    /**
     * Status to show for a provider right now. A provider we cannot call (no
     * API key, or the custom endpoint without a URL) is reported as inactive
     * even when an older round left a green check behind.
     */
    _effectiveStatus(key, cfg) {
      if (!cfg) return "unknown";
      if (key === "custom" && !(this._settings.get_string("custom-weather-url") || "").trim())
        return "inactive";
      if (cfg.requiresApiKey && !(this._settings.get_string("weather-api-key") || "").trim())
        return "inactive";
      return this._providerStatus.get(key) ?? "unknown";
    }

    _statusIcon(status) {
      return (
        {
          working: "✅",
          error: "❌",
          timeout: "⏱️",
          inactive: "💤",
          testing: "🔄",
          cached: "♻️",
        }[status] ?? "❓"
      );
    }

    updateProviderStatus(provider, status, error = null) {
      if (this._destroyed) return;
      this._providerStatus.set(provider, status);
      this._refreshProvidersList();
      const current =
        this._settings.get_string("weather-provider") ?? "openmeteo";
      if (provider === current) this._refreshCurrentProviderInfo(status, error);
    }

    _refreshCurrentProviderInfo(status = null, error = null) {
      if (this._destroyed) return;
      const key = this._settings.get_string("weather-provider") ?? "openmeteo";
      const cfg = WEATHER_PROVIDERS[key];
      if (!cfg) return;

      if (this._currentProviderItem)
        this._currentProviderItem.label.set_text(
          this._("Active") +
            ": " +
            cfg.name +
            (cfg.isFree ? " (" + this._("Free") + ")" : ""),
        );

      if (this._providerStatusItem) {
        const s = status ?? this._effectiveStatus(key, cfg);
        const texts = {
          working: this._("Working"),
          error: this._("Error") + (error ? ": " + error : ""),
          timeout: this._("Connection Timeout"),
          inactive: this._("Not Configured"),
          testing: this._("Testing Connection…"),
          cached: this._("Showing cached data"),
        };
        this._providerStatusItem.label.set_text(
          this._("Status") +
            ": " +
            this._statusIcon(s) +
            " " +
            (texts[s] ?? this._("Unknown")),
        );
      }

      if (this._lastUpdateItem) {
        // Only a successful fetch counts as an update, so a failed round must
        // not stamp the previous data as if it were brand new.
        if (this._lastGoodUpdate)
          this._lastUpdateItem.label.set_text(
            this._("Last Update") +
              ": " +
              this._formatDateTime(this._lastGoodUpdate) +
              (this._showingCachedData ? " ♻️" : ""),
          );
        else
          this._lastUpdateItem.label.set_text(
            this._("Last Update") + ": " + this._("Never"),
          );
      }
    }

    _buildLocationInfo() {
      this._currentLocationItem = new PopupMenu.PopupMenuItem(
        this._("Current") + ": " + this._("Loading…"),
        { reactive: false, style_class: "location-info-item" },
      );
      this._coordinatesItem = new PopupMenu.PopupMenuItem(
        this._("Coordinates") + ": " + this._("Loading…"),
        { reactive: false, style_class: "location-info-item" },
      );
      this._detectionMethodItem = new PopupMenu.PopupMenuItem(
        this._("Method") + ": " + this._("Loading…"),
        { reactive: false, style_class: "location-info-item" },
      );

      const autoItem = new PopupMenu.PopupMenuItem(
        "🌍 " + this._("Switch to Auto Detection"),
      );
      autoItem.style_class = "location-mode-button";
      autoItem.connect("activate", () => {
        if (!this._destroyed)
          this._settings.set_string("location-mode", "auto");
      });

      const manualItem = new PopupMenu.PopupMenuItem(
        "📍 " + this._("Switch to Manual Location"),
      );
      manualItem.style_class = "location-mode-button";
      manualItem.connect("activate", () => {
        if (!this._destroyed)
          this._settings.set_string("location-mode", "manual");
      });

      // Inline location search
      const searchItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
      const searchBox = new St.BoxLayout({
        vertical: true,
        style_class: "location-search-minimal",
      });
      const inputBox = new St.BoxLayout({ style: "spacing: 6px;" });

      this._searchEntry = new St.Entry({
        hint_text: this._("Enter city name…"),
        style_class: "search-entry-minimal",
        x_expand: true,
      });
      this._searchButton = new St.Button({
        label: this._("Search"),
        style_class: "search-button-panel",
      });
      this._clearButton = new St.Button({
        label: this._("Clear"),
        style_class: "clear-button-panel",
      });

      inputBox.add_child(this._searchEntry);
      inputBox.add_child(this._searchButton);
      inputBox.add_child(this._clearButton);
      searchBox.add_child(inputBox);
      searchItem.add_child(searchBox);

      this._searchResults = new PopupMenu.PopupMenuSection();

      this._searchButton.connect("clicked", () => {
        if (!this._destroyed) this._doSearch();
      });
      this._searchEntry.clutter_text.connect("activate", () => {
        if (!this._destroyed) this._doSearch();
      });
      this._clearButton.connect("clicked", () => {
        if (!this._destroyed) {
          this._searchEntry.set_text("");
          this._searchResults.removeAll();
        }
      });

      this._locationInfoSection.menu.addMenuItem(this._currentLocationItem);
      this._locationInfoSection.menu.addMenuItem(this._coordinatesItem);
      this._locationInfoSection.menu.addMenuItem(this._detectionMethodItem);
      this._locationInfoSection.menu.addMenuItem(autoItem);
      this._locationInfoSection.menu.addMenuItem(manualItem);
      this._locationInfoSection.menu.addMenuItem(searchItem);
      this._locationInfoSection.menu.addMenuItem(this._searchResults);
    }

    async _doSearch() {
      const query = this._searchEntry.get_text().trim();
      this._searchResults.removeAll();
      if (query.length < 2) return;

      this._searchButton.set_label(this._("Searching…"));
      try {
        const session = this._ext._session;
        const url =
          GEOCODING_URL +
          "?name=" +
          encodeURIComponent(query) +
          "&count=5&language=en&format=json";
        const msg = Soup.Message.new("GET", url);
        msg.request_headers.append("User-Agent", "GNOME-Weather-Extension/1.0");

        const bytes = await session.send_and_read_async(
          msg,
          GLib.PRIORITY_DEFAULT,
          this._ext._cancellable ?? null,
        );
        const resp = JSON.parse(new TextDecoder().decode(bytes.get_data()));

        if (resp.results?.length) {
          for (const r of resp.results) {
            if (this._destroyed) break;
            const name = r.admin1
              ? r.name + ", " + r.admin1 + ", " + r.country
              : r.name + ", " + r.country;
            const item = new PopupMenu.PopupMenuItem("📍 " + name, {
              style_class: "location-result-minimal",
            });
            item.connect("activate", () => {
              if (this._destroyed) return;
              this._settings.set_string("location-mode", "manual");
              this._settings.set_string(
                "location",
                r.latitude + "," + r.longitude,
              );
              this._settings.set_string("location-name", name);
              this._searchEntry.set_text("");
              this._searchResults.removeAll();
              this._updateLocationInfo();
              this._ext._detectLocationAndLoadWeather();
            });
            this._searchResults.addMenuItem(item);
          }
        } else {
          this._showSearchError(this._("No locations found"));
        }
      } catch (e) {
        if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
        console.error("[Weather] Location search:", e);
        this._showSearchError(this._("Search failed. Please try again."));
      } finally {
        if (!this._destroyed) this._searchButton.set_label(this._("Search"));
      }
    }

    _showSearchError(msg) {
      if (this._destroyed) return;
      this._searchResults.removeAll();
      this._searchResults.addMenuItem(
        new PopupMenu.PopupMenuItem("⚠️ " + msg, {
          reactive: false,
          style_class: "search-error-item",
        }),
      );
    }

    //  Weather data display

    updateWeather(data) {
      if (this._destroyed) return;
      try {
        const conditions = getWeatherConditions();
        const current = data.current;
        const condition = conditions[current.weather_code] ?? conditions[0];
        const useFahr = this._settings.get_boolean("use-fahrenheit");
        const temp = useFahr
          ? Math.round((current.temperature_2m * 9) / 5 + 32)
          : Math.round(current.temperature_2m);
        const unit = useFahr ? "°F" : "°C";

        this._weatherIcon.set_icon_name(condition.icon);
        this._weatherLabel.set_text(temp + unit);
        this._retryCount = 0;

        // The provider that actually answered, not necessarily the configured
        // one: a fallback or a cached payload must not mark the configured
        // provider as working.
        const providerKey = data.providerKey ?? null;
        if (providerKey)
          this.updateProviderStatus(
            providerKey,
            data.stale ? "cached" : "working",
          );
        this._showingCachedData = !!data.stale;

        if (data.fetchedAt)
          this._lastGoodUpdate = new Date(data.fetchedAt * 1000);
        else if (!data.stale) this._lastGoodUpdate = new Date();

        this._updateCurrentWeather(data, condition, temp, unit);
        this._updateLocationInfo();
        this._refreshCurrentProviderInfo(data.stale ? "cached" : "working");
        this._updateHourly(data);
        this._updateDaily(data);
        this._updateInsights(data);
      } catch (e) {
        console.error("[Weather] updateWeather:", e);
        if (!this._destroyed) {
          this._weatherLabel.set_text(this._("Error"));
          this._weatherIcon.set_icon_name("dialog-error-symbolic");
          const p =
            data?.providerKey ??
            this._settings.get_string("weather-provider") ??
            "openmeteo";
          this.updateProviderStatus(p, "error", e.message);
        }
      }
    }

    _updateCurrentWeather(data, condition, temp, unit) {
      if (this._destroyed) return;
      const c = data.current;
      const windUnit = this._settings.get_string("wind-speed-unit") ?? "kmh";
      const wind = convertWindSpeed(c.wind_speed_10m, windUnit);

      let text = "🌡️ " + temp + unit + " • " + condition.name + "\n";
      text += "💨 " + wind.value + " " + wind.unit;
      if (this._settings.get_boolean("show-humidity"))
        text += " • 💧 " + c.relative_humidity_2m + "%";
      text += "\n📊 " + Math.round(c.surface_pressure) + " hPa";
      text += "\n📍 " + (data.location ?? this._("Unknown Location"));
      text += "\n🌐 " + (data.provider ?? this._("Unknown Provider"));
      if (data.stale && this._lastGoodUpdate)
        text +=
          "\n♻️ " +
          this._("Cached data from") +
          " " +
          this._formatDateTime(this._lastGoodUpdate);
      this._currentWeatherItem.label.set_text(text);
    }

    // Hourly forecast

    _updateHourly(data) {
      if (this._destroyed) return;
      this._hourlySection.menu.removeAll();
      if (!data.hourly?.time) return;

      const conditions = getWeatherConditions();
      const now = new Date();
      const useFahr = this._settings.get_boolean("use-fahrenheit");
      const unit = useFahr ? "°F" : "°C";

      // One normalized copy of the time axis: providers store canonical local
      // keys, but a cache written by an older build may still carry raw epoch
      // values, and `new Date("1792659490")` is Invalid Date.
      const times = data.hourly.time.map(canonicalTime);

      // Cached payloads can already be partly in the past: start at the first
      // hour that is still ahead of us.
      let start = -1;
      for (let i = 0; i < times.length; i++) {
        if (times[i] === null) continue;
        const t = new Date(times[i]);
        if (!isNaN(t) && t > now) {
          start = i;
          break;
        }
      }
      if (start < 0) {
        this._hourlySection.menu.addMenuItem(
          new PopupMenu.PopupMenuItem(
            "🕒 " + this._("This forecast has no upcoming hours left"),
            { reactive: false, style_class: "insight-item-minimal" },
          ),
        );
        return;
      }

      for (let i = 0; i < 12 && start + i < times.length; i++) {
        const idx = start + i;
        // Custom endpoints do not always deliver every hourly series: a missing
        // weather code falls back to "Clear Sky", a missing temperature skips
        // the row instead of taking the whole menu down.
        const rawTemp = data.hourly.temperature_2m?.[idx];
        if (typeof rawTemp !== "number" || !isFinite(rawTemp)) continue;
        const cond = conditions[data.hourly.weather_code?.[idx]] ?? conditions[0];
        const temp = useFahr
          ? Math.round((rawTemp * 9) / 5 + 32)
          : Math.round(rawTemp);
        const precip = data.hourly.precipitation_probability?.[idx] ?? 0;

        const item = new PopupMenu.PopupBaseMenuItem({
          reactive: false,
          style_class: "forecast-item-minimal",
        });
        const box = new St.BoxLayout({
          vertical: false,
          style: "spacing: 8px; padding: 4px;",
        });

        box.add_child(
          new St.Label({
            text: this._formatTime(times[idx]),
            style: "min-width:60px; font-weight:500;",
          }),
        );
        box.add_child(
          new St.Icon({
            icon_name: cond.icon,
            icon_size: 16,
            style_class: "popup-menu-icon",
          }),
        );
        box.add_child(
          new St.Label({
            text: temp + unit,
            style: "min-width:40px; font-weight:500;",
          }),
        );
        box.add_child(
          new St.Label({ text: cond.name, style: "min-width:100px;" }),
        );
        if (precip > 0)
          box.add_child(
            new St.Label({
              text: "💧" + precip + "%",
              style: "color:#4FC3F7; font-size:11px;",
            }),
          );

        item.add_child(box);
        this._hourlySection.menu.addMenuItem(item);
      }
    }

    // Daily forecast

    _updateDaily(data) {
      if (this._destroyed) return;
      this._dailySection.menu.removeAll();
      if (!data.daily?.time) return;

      const conditions = getWeatherConditions();
      const useFahr = this._settings.get_boolean("use-fahrenheit");
      const unit = useFahr ? "°F" : "°C";

      const todayKey = _dayKey(new Date());
      let rendered = 0;

      for (let i = 0; i < data.daily.time.length && rendered < 7; i++) {
        // canonicalTime re-reads any legacy cache entry (raw epoch seconds) so
        // a cache written by an older build still lands on the right calendar day.
        const dayKey = canonicalTime(data.daily.time[i])?.slice(0, 10) ?? String(data.daily.time[i] ?? "").slice(0, 10);
        const dayOffset = _dayOffset(todayKey, dayKey);
        // Days that already elapsed are dropped: cached data can start in the
        // past, and "Today" must mean today, not the day it was fetched.
        if (dayOffset === null || dayOffset < 0) continue;
        const dayDate = new Date(`${dayKey}T00:00`);
        const dayName =
          dayOffset === 0
            ? this._("Today")
            : dayOffset === 1
              ? this._("Tomorrow")
              : dayDate.toLocaleDateString(undefined, { weekday: "long" });
        const cond =
          conditions[data.daily.weather_code?.[i]] ?? conditions[0];
        // Same as above: partial daily payloads must not break the menu.
        const rawMax = data.daily.temperature_2m_max?.[i];
        const rawMin = data.daily.temperature_2m_min?.[i];
        if (typeof rawMax !== "number" || typeof rawMin !== "number") continue;
        const tMax = useFahr
          ? Math.round((rawMax * 9) / 5 + 32)
          : Math.round(rawMax);
        const tMin = useFahr
          ? Math.round((rawMin * 9) / 5 + 32)
          : Math.round(rawMin);

        const item = new PopupMenu.PopupBaseMenuItem({
          reactive: false,
          style_class: "forecast-item-minimal",
        });
        const box = new St.BoxLayout({
          vertical: false,
          style: "spacing: 8px; padding: 6px;",
        });

        box.add_child(
          new St.Label({
            text: dayName,
            style: "min-width:80px; font-weight:500;",
          }),
        );
        box.add_child(
          new St.Icon({
            icon_name: cond.icon,
            icon_size: 18,
            style_class: "popup-menu-icon",
          }),
        );
        box.add_child(
          new St.Label({
            text: tMax + "°/" + tMin + unit,
            style: "min-width:70px; font-weight:500;",
          }),
        );
        box.add_child(new St.Label({ text: cond.name, style: "opacity:0.8;" }));

        item.add_child(box);
        this._dailySection.menu.addMenuItem(item);
        rendered++;
      }
    }

    //  Weather insights

    _updateInsights(data) {
      if (this._destroyed) return;
      this._insightsSection.menu.removeAll();
      try {
        if (data.hourly?.temperature_2m) {
          const trend = this._analyzeTrend(
            data.hourly.temperature_2m.slice(0, 12),
          );
          this._insightsSection.menu.addMenuItem(
            new PopupMenu.PopupMenuItem(
              "🌡️ " + this._("Temperature Trend") + ": " + trend,
              { reactive: false, style_class: "insight-item-minimal" },
            ),
          );
        }

        if (data.hourly?.weather_code) {
          const precipCodes = [51, 53, 55, 61, 63, 65, 80, 81, 82, 85, 86];
          const precipHours = data.hourly.weather_code
            .slice(0, 24)
            .filter((c) => precipCodes.includes(c));
          const pct = ((precipHours.length / 24) * 100).toFixed(1);
          this._insightsSection.menu.addMenuItem(
            new PopupMenu.PopupMenuItem(
              "💧 " + this._("Precipitation (24h)") + ": " + pct + "%",
              { reactive: false, style_class: "insight-item-minimal" },
            ),
          );
        }

        if (data.current?.wind_speed_10m !== undefined) {
          const windUnit =
            this._settings.get_string("wind-speed-unit") ?? "kmh";
          const wind = convertWindSpeed(data.current.wind_speed_10m, windUnit);
          const label =
            wind.value > 50
              ? this._("Strong")
              : wind.value > 25
                ? this._("Moderate")
                : this._("Light");
          this._insightsSection.menu.addMenuItem(
            new PopupMenu.PopupMenuItem(
              "💨 " +
                this._("Wind") +
                ": " +
                wind.value +
                " " +
                wind.unit +
                " (" +
                label +
                ")",
              { reactive: false, style_class: "insight-item-minimal" },
            ),
          );
        }

        const hr = new Date().getHours();
        let uv = 0;
        if (hr >= 10 && hr <= 16) {
          const conditions = getWeatherConditions();
          const cond =
            conditions[data.current?.weather_code ?? 0] ?? conditions[0];
          if (cond.name.includes("Clear")) uv = 8;
          else if (cond.name.includes("Cloudy")) uv = 4;
          else uv = 2;
        }
        const uvLabel =
          uv > 6 ? this._("High") : uv > 3 ? this._("Moderate") : this._("Low");
        this._insightsSection.menu.addMenuItem(
          new PopupMenu.PopupMenuItem(
            "☀️ " + this._("UV Index") + ": " + uv + " (" + uvLabel + ")",
            { reactive: false, style_class: "insight-item-minimal" },
          ),
        );
      } catch (e) {
        console.error("[Weather] insights:", e);
      }
    }

    _analyzeTrend(temps) {
      if (temps.length < 2) return this._("Insufficient data");
      let up = 0,
        dn = 0;
      for (let i = 1; i < temps.length; i++) {
        const d = temps[i] - temps[i - 1];
        if (d > 0.5) up++;
        else if (d < -0.5) dn++;
      }
      if (up > dn + 1) return this._("Warming") + " 🔥";
      if (dn > up + 1) return this._("Cooling") + " 🧊";
      return this._("Stable") + " 🟰";
    }

    //  Location display

    _updateLocationIndicator() {
      if (this._destroyed) return;
      this._locationDot.set_text(this._locationModeText());
      this._updateLocationInfo();
      this._refreshCurrentProviderInfo();
    }

    _updateLocationInfo() {
      if (this._destroyed) return;
      const mode = this._settings.get_string("location-mode") ?? "auto";
      const name = this._settings.get_string("location-name") ?? "";
      const lat = this._ext._latitude;
      const lon = this._ext._longitude;

      if (this._currentLocationItem)
        this._currentLocationItem.label.set_text(
          mode === "auto"
            ? this._("Current") + ": 🌍 " + this._("Auto-detected")
            : this._("Current") + ": " + (name || this._("Not set")),
        );
      if (this._coordinatesItem)
        this._coordinatesItem.label.set_text(
          lat && lon
            ? this._("Coordinates") +
                ": " +
                lat.toFixed(4) +
                ", " +
                lon.toFixed(4)
            : this._("Coordinates") + ": " + this._("Not available"),
        );
      if (this._detectionMethodItem)
        this._detectionMethodItem.label.set_text(
          mode === "auto"
            ? this._("Method") + ": 🌐 " + this._("IP-based geolocation")
            : this._("Method") + ": 📍 " + this._("Manually configured"),
        );
    }

    _startUpdateTimer() {
      if (this._destroyed) return;
      if (this._updateTimeoutId) {
        GLib.source_remove(this._updateTimeoutId);
        this._updateTimeoutId = null;
      }
      const interval = (this._settings.get_int("update-interval") || 10) * 60;
      this._updateTimeoutId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        interval,
        () => {
          if (!this._destroyed) {
            this._ext._detectLocationAndLoadWeather();
            return GLib.SOURCE_CONTINUE;
          }
          return GLib.SOURCE_REMOVE;
        },
      );
    }

    _connectSettings() {
      if (this._destroyed) return;
      const reload = () => {
        if (!this._destroyed) this._ext._detectLocationAndLoadWeather();
      };
      const keys = [
        "location-mode",
        "weather-provider",
        "weather-api-key",
        "custom-weather-url",
        "show-humidity",
        "use-fahrenheit",
        "use-12hour-format",
        "wind-speed-unit",
      ];
      this._settingsConns = keys.map((k) =>
        this._settings.connect("changed::" + k, reload),
      );

      this._settingsConns.push(
        this._settings.connect("changed::show-location-label", () => {
          if (!this._destroyed) this._rebuildPanelChildren();
        }),
        this._settings.connect("changed::show-text-in-panel", () => {
          if (!this._destroyed) this._rebuildPanelChildren();
        }),
        this._settings.connect("changed::panel-icon-size", () => {
          if (!this._destroyed)
            this._weatherIcon.icon_size =
              this._settings.get_int("panel-icon-size");
        }),
        this._settings.connect("changed::panel-text-size", () => {
          if (!this._destroyed)
            this._weatherLabel.set_style(
              "font-size: " + this._settings.get_int("panel-text-size") + "px;",
            );
        }),

        this._settings.connect("changed::show-alerts-in-panel", () => {
          if (!this._destroyed) this.refreshAlerts();
        }),
      );
    }

    _formatDateTime(date) {
      const use12 = this._settings.get_boolean("use-12hour-format");
      return (
        date.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }) +
        " " +
        date.toLocaleTimeString(use12 ? "en-US" : "en-GB", {
          hour: use12 ? "numeric" : "2-digit",
          minute: "2-digit",
          hour12: use12,
        })
      );
    }

    _formatTime(iso) {
      const d = new Date(iso);
      const use12 = this._settings.get_boolean("use-12hour-format");
      return d.toLocaleTimeString(use12 ? "en-US" : "en-GB", {
        hour: use12 ? "numeric" : "2-digit",
        minute: "2-digit",
        hour12: use12,
      });
    }

    destroy() {
      this._destroyed = true;

      if (this._updateTimeoutId) {
        GLib.source_remove(this._updateTimeoutId);
        this._updateTimeoutId = null;
      }

      if (this._settingsConns) {
        for (const id of this._settingsConns) {
          try {
            this._settings.disconnect(id);
          } catch (_) {}
        }
        this._settingsConns = null;
      }

      super.destroy();
    }
  },
);
