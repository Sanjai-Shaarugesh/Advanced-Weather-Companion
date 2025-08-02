import St from "gi://St";
import GObject from "gi://GObject";
import Gio from "gi://Gio";
import Soup from "gi://Soup";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

const BASE_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const GEOIP_URL = "https://ipapi.co/json/";

// Fallback GEOIP services
const FALLBACK_GEOIP_URLS = [
  "https://ipapi.co/json/",
  "http://ip-api.com/json/",
  "https://freegeoip.app/json/"
];

// Weather conditions with native GNOME icons
const WEATHER_CONDITIONS = {
  0: { name: "Clear Sky", icon: "weather-clear-symbolic", severity: "normal" },
  1: { name: "Mainly Clear", icon: "weather-few-clouds-symbolic", severity: "normal" },
  2: { name: "Partly Cloudy", icon: "weather-few-clouds-symbolic", severity: "normal" },
  3: { name: "Overcast", icon: "weather-overcast-symbolic", severity: "normal" },
  45: { name: "Fog", icon: "weather-fog-symbolic", severity: "caution" },
  48: { name: "Rime Fog", icon: "weather-fog-symbolic", severity: "caution" },
  51: { name: "Light Drizzle", icon: "weather-showers-scattered-symbolic", severity: "normal" },
  53: { name: "Drizzle", icon: "weather-showers-symbolic", severity: "normal" },
  55: { name: "Heavy Drizzle", icon: "weather-showers-symbolic", severity: "caution" },
  61: { name: "Light Rain", icon: "weather-showers-scattered-symbolic", severity: "normal" },
  63: { name: "Rain", icon: "weather-showers-symbolic", severity: "normal" },
  65: { name: "Heavy Rain", icon: "weather-storm-symbolic", severity: "warning" },
  71: { name: "Light Snow", icon: "weather-snow-symbolic", severity: "normal" },
  73: { name: "Snow", icon: "weather-snow-symbolic", severity: "caution" },
  75: { name: "Heavy Snow", icon: "weather-snow-symbolic", severity: "warning" },
  77: { name: "Snow Grains", icon: "weather-snow-symbolic", severity: "caution" },
  80: { name: "Rain Showers", icon: "weather-showers-scattered-symbolic", severity: "normal" },
  81: { name: "Rain Showers", icon: "weather-showers-symbolic", severity: "caution" },
  82: { name: "Heavy Showers", icon: "weather-storm-symbolic", severity: "warning" },
  85: { name: "Snow Showers", icon: "weather-snow-symbolic", severity: "caution" },
  86: { name: "Heavy Snow", icon: "weather-snow-symbolic", severity: "warning" },
  95: { name: "Thunderstorm", icon: "weather-storm-symbolic", severity: "severe" },
  96: { name: "Hail Storm", icon: "weather-storm-symbolic", severity: "severe" },
  99: { name: "Heavy Hail", icon: "weather-storm-symbolic", severity: "severe" },
};

const WeatherPanelButton = GObject.registerClass(
  class WeatherPanelButton extends PanelMenu.Button {
    _init(ext) {
      super._init(0.0, "Weather Extension", false);
      this._ext = ext;
      this._updateTimeoutId = null;
      this._searchResults = null;
      this._retryCount = 0;
      this._maxRetries = 3;

      // Create main container with native styling
      this._container = new St.BoxLayout({
        vertical: false,
        style_class: "weather-button-box"
      });

      // Weather icon
      this._weatherIcon = new St.Icon({
        icon_name: "weather-clear-symbolic",
        icon_size: this._ext._settings.get_int("panel-icon-size") || 16,
        style_class: "weather-icon"
      });

      // Weather text with dynamic sizing
      this._weatherLabel = new St.Label({
        text: "…",
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "weather-label",
        style: this._getTextStyle()
      });

      this._locationContainer = new St.BoxLayout({
              vertical: false,
              style_class: "location-container",
              visible: this._ext._settings.get_boolean("show-location-label")
            });

      // Location indicator
      this._locationIcon = new St.Icon({
        icon_name: "find-location-symbolic",
        icon_size: 12,
        style_class: "location-icon",
        visible: this._ext._settings.get_boolean("show-location-label")
      });

      this._locationDot = new St.Label({
        text: this._getLocationModeText(),
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "location-mode-label",
        visible: this._ext._settings.get_boolean("show-location-label")
      });

      // Add children to container
      this._container.add_child(this._weatherIcon);
      if (this._ext._settings.get_boolean("show-text-in-panel")) {
        this._container.add_child(this._weatherLabel);
      }
      if (this._ext._settings.get_boolean("show-location-label")) {
        this._container.add_child(this._locationIcon);
        this._container.add_child(this._locationDot);
      }

      this.add_child(this._container);

      this._setupMenu();
      this._connectSettings();
      this._updateLocationIndicator();
      this._startUpdateTimer();
    }

    _getTextStyle() {
      const textSize = this._ext._settings.get_int("panel-text-size") || 13;
      return `font-size: ${textSize}px;`;
    }

    _getLocationModeText() {
      const mode = this._ext._settings.get_string("location-mode") || "auto";
      return mode === "auto" ? "AUTO" : "MANUAL";
    }

    _connectSettings() {
      this._settingsConnections = [
        this._ext._settings.connect("changed::location-mode", () => {
          this._updateLocationIndicator();
          this._ext._detectLocationAndLoadWeather();
        }),
        this._ext._settings.connect("changed::show-location-label", () => {
          this._updateLocationVisibility();
        }),
        this._ext._settings.connect("changed::show-text-in-panel", () => {
          this._updatePanelLayout();
        }),
        this._ext._settings.connect("changed::panel-icon-size", () => {
          this._weatherIcon.icon_size = this._ext._settings.get_int("panel-icon-size");
        }),
        this._ext._settings.connect("changed::panel-text-size", () => {
          this._updateTextSize();
        }),
        this._ext._settings.connect("changed::show-humidity", () => {
          this._ext._detectLocationAndLoadWeather();
        }),
        this._ext._settings.connect("changed::use-fahrenheit", () => {
          this._ext._detectLocationAndLoadWeather();
        }),
        this._ext._settings.connect("changed::use-12hour-format", () => {
          this._ext._detectLocationAndLoadWeather();
        })
      ];
    }

    _updateTextSize() {
      if (this._weatherLabel) {
        this._weatherLabel.set_style(this._getTextStyle());
      }
    }

    _updateLocationVisibility() {
      const show = this._ext._settings.get_boolean("show-location-label");
      this._locationIcon.visible = show;
      this._locationDot.visible = show;

      if (!show) {
        if (this._container.contains(this._locationIcon)) {
          this._container.remove_child(this._locationIcon);
        }
        if (this._container.contains(this._locationDot)) {
          this._container.remove_child(this._locationDot);
        }
      } else {
        if (!this._container.contains(this._locationIcon)) {
          this._container.add_child(this._locationIcon);
        }
        if (!this._container.contains(this._locationDot)) {
          this._container.add_child(this._locationDot);
        }
      }
    }

    _updatePanelLayout() {
      this._container.remove_all_children();
      this._container.add_child(this._weatherIcon);

      if (this._ext._settings.get_boolean("show-text-in-panel")) {
        this._container.add_child(this._weatherLabel);
      }

      if (this._ext._settings.get_boolean("show-location-label")) {
        this._container.add_child(this._locationIcon);
        this._container.add_child(this._locationDot);
      }
    }

    _setupMenu() {
      // Current weather section
      this._currentSection = new PopupMenu.PopupMenuSection();
      this._currentWeatherItem = new PopupMenu.PopupMenuItem("Loading weather...", {
        reactive: false,
        style_class: "current-weather"
      });
      this._currentSection.addMenuItem(this._currentWeatherItem);

      // Weather alerts section
      this._alertsSection = new PopupMenu.PopupMenuSection();

      // Location info section
      this._locationInfoSection = new PopupMenu.PopupSubMenuMenuItem("📍 Location Information", true);
      this._setupLocationInfo();

      // Hourly forecast
      this._hourlySection = new PopupMenu.PopupSubMenuMenuItem("⏰ Hourly Forecast", true);

      // Daily forecast
      this._dailySection = new PopupMenu.PopupSubMenuMenuItem("📅 7-Day Forecast", true);

      // Weather insights
      this._insightsSection = new PopupMenu.PopupSubMenuMenuItem("🔍 Weather Insights", true);

      // Actions
      this._refreshItem = new PopupMenu.PopupMenuItem("🔄 Refresh Weather");
      this._refreshItem.style_class = "refresh-button";
      this._refreshItem.connect("activate", () => {
        this._ext._detectLocationAndLoadWeather();
      });

      this._settingsItem = new PopupMenu.PopupMenuItem("⚙️ Extension Settings");
      this._settingsItem.connect("activate", () => this._ext.openPreferences());

      // Build menu
      this.menu.addMenuItem(this._currentSection);
      this.menu.addMenuItem(this._alertsSection);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this.menu.addMenuItem(this._locationInfoSection);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this.menu.addMenuItem(this._hourlySection);
      this.menu.addMenuItem(this._dailySection);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this.menu.addMenuItem(this._insightsSection);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this.menu.addMenuItem(this._refreshItem);
      this.menu.addMenuItem(this._settingsItem);
    }

    // In the _setupLocationInfo() method, update the search section:

    _setupLocationInfo() {
      // Current location display
      this._currentLocationItem = new PopupMenu.PopupMenuItem("Current: Loading...", {
        reactive: false,
        style_class: "location-info-item"
      });

      // Location coordinates
      this._coordinatesItem = new PopupMenu.PopupMenuItem("Coordinates: Loading...", {
        reactive: false,
        style_class: "location-info-item"
      });

      // Detection method
      this._detectionMethodItem = new PopupMenu.PopupMenuItem("Method: Loading...", {
        reactive: false,
        style_class: "location-info-item"
      });

      // Mode switching buttons
      const autoItem = new PopupMenu.PopupMenuItem("🌍 Switch to Auto Detection");
      autoItem.style_class = "location-mode-button";
      autoItem.connect("activate", () => {
        this._ext._settings.set_string("location-mode", "auto");
      });

      const manualItem = new PopupMenu.PopupMenuItem("📍 Switch to Manual Location");
      manualItem.style_class = "location-mode-button";
      manualItem.connect("activate", () => {
        this._ext._settings.set_string("location-mode", "manual");
      });

      // Location search for manual mode
      const searchItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
      const searchBox = new St.BoxLayout({
        vertical: true,
        style_class: "location-search-minimal"
      });

      const inputBox = new St.BoxLayout({
        style: "spacing: 6px;"
      });

      this._searchEntry = new St.Entry({
        hint_text: "Enter city name...",
        style_class: "search-entry-minimal",
        x_expand: true
      });

      this._searchButton = new St.Button({
        label: "Search",
        style_class: "search-button-panel"
      });

      this._clearButton = new St.Button({
        label: "Clear",
        style_class: "clear-button-panel"
      });

      inputBox.add_child(this._searchEntry);
      inputBox.add_child(this._searchButton);
      inputBox.add_child(this._clearButton);
      searchBox.add_child(inputBox);
      searchItem.add_child(searchBox);

      // Search results container
      this._searchResults = new PopupMenu.PopupMenuSection();

      // Connect search functionality
      this._searchButton.connect("clicked", () => this._searchLocation());
      this._searchEntry.clutter_text.connect("activate", () => this._searchLocation());

      // Connect clear functionality
      this._clearButton.connect("clicked", () => this._clearSearch());

      // Add items to location info menu
      this._locationInfoSection.menu.addMenuItem(this._currentLocationItem);
      this._locationInfoSection.menu.addMenuItem(this._coordinatesItem);
      this._locationInfoSection.menu.addMenuItem(this._detectionMethodItem);
      this._locationInfoSection.menu.addMenuItem(autoItem);
      this._locationInfoSection.menu.addMenuItem(manualItem);
      this._locationInfoSection.menu.addMenuItem(searchItem);
      this._locationInfoSection.menu.addMenuItem(this._searchResults);
    }

    // Add this new method to handle clearing the search:

    _clearSearch() {
      this._searchEntry.set_text("");
      this._searchResults.removeAll();
    }

    async _searchLocation() {
      const query = this._searchEntry.get_text().trim();
      if (!query || query.length < 2) {
        this._showSearchError("Please enter at least 2 characters");
        return;
      }

      this._searchButton.set_label("Searching...");
      this._searchResults.removeAll();

      try {
        const url = `${GEOCODING_URL}?name=${encodeURIComponent(query)}&count=5&language=en&format=json`;
        const session = new Soup.Session();
        session.timeout = 10;

        const message = Soup.Message.new("GET", url);
        message.request_headers.append('User-Agent', 'GNOME-Weather-Extension/1.0');

        const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);

        if (message.status_code !== 200) {
          throw new Error(`HTTP ${message.status_code}`);
        }

        const responseText = new TextDecoder().decode(bytes.get_data());
        const response = JSON.parse(responseText);

        if (response.results && response.results.length > 0) {
          response.results.forEach(result => {
            const resultItem = new PopupMenu.PopupMenuItem(
              `📍 ${result.name}, ${result.country}${result.admin1 ? ', ' + result.admin1 : ''}`,
              { style_class: "location-result-minimal" }
            );

            resultItem.connect("activate", () => {
              this._ext._settings.set_string("location-mode", "manual");
              this._ext._settings.set_string("location", `${result.latitude},${result.longitude}`);
              this._ext._settings.set_string("location-name", `${result.name}, ${result.country}`);
              this._searchEntry.set_text("");
              this._searchResults.removeAll();
              this._updateLocationInfo();
              this._ext._detectLocationAndLoadWeather();
            });

            this._searchResults.addMenuItem(resultItem);
          });
        } else {
          this._showSearchError("No locations found");
        }
      } catch (error) {
        console.error("Location search failed:", error);
        this._showSearchError("Search failed. Please try again.");
      }

      this._searchButton.set_label("Search");
    }

    _showSearchError(message) {
      this._searchResults.removeAll();
      const errorItem = new PopupMenu.PopupMenuItem(`⚠️ ${message}`, {
        reactive: false,
        style_class: "search-error-item"
      });
      this._searchResults.addMenuItem(errorItem);
    }

    _updateLocationIndicator() {
      const mode = this._ext._settings.get_string("location-mode") || "auto";

      this._locationDot.text = this._getLocationModeText();
      this._updateLocationInfo();
    }

    _updateLocationInfo() {
      const mode = this._ext._settings.get_string("location-mode") || "auto";
      const locationName = this._ext._settings.get_string("location-name") || "";

      // Update current location
      if (this._currentLocationItem) {
        if (mode === "auto") {
          this._currentLocationItem.label.set_text("Current: 🌍 Auto-detected location");
        } else {
          this._currentLocationItem.label.set_text(`Current: ${locationName || "Not set"}`);
        }
      }

      // Update coordinates
      if (this._coordinatesItem) {
        if (this._ext._latitude && this._ext._longitude) {
          this._coordinatesItem.label.set_text(
            `Coordinates: ${this._ext._latitude.toFixed(4)}, ${this._ext._longitude.toFixed(4)}`
          );
        } else {
          this._coordinatesItem.label.set_text("Coordinates: Not available");
        }
      }

      // Update detection method
      if (this._detectionMethodItem) {
        const methodText = mode === "auto" ?
          "Method: 🌐 IP-based geolocation" :
          "Method: 📍 Manually configured";
        this._detectionMethodItem.label.set_text(methodText);
      }
    }

    _startUpdateTimer() {
      if (this._updateTimeoutId) {
        GLib.source_remove(this._updateTimeoutId);
      }

      const interval = (this._ext._settings.get_int("update-interval") || 10) * 60;
      this._updateTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
        this._ext._detectLocationAndLoadWeather();
        return GLib.SOURCE_CONTINUE;
      });
    }

    _formatTime(dateString) {
      const date = new Date(dateString);
      const use12Hour = this._ext._settings.get_boolean("use-12hour-format");

      if (use12Hour) {
        return date.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
      } else {
        return date.toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });
      }
    }

    _generateWeatherAlerts(data) {
      this._alertsSection.removeAll();
      let hasAlerts = false;

      const current = data.current;
      const condition = WEATHER_CONDITIONS[current.weather_code] || WEATHER_CONDITIONS[0];

      // Severe weather alerts
      if (condition.severity === "severe") {
        const alertItem = new PopupMenu.PopupMenuItem(
          `⚠️ SEVERE WEATHER: ${condition.name}`,
          { reactive: false, style_class: "weather-alert-severe" }
        );
        this._alertsSection.addMenuItem(alertItem);
        hasAlerts = true;
      }

      // Temperature extremes
      const temp = this._ext._settings.get_boolean("use-fahrenheit")
        ? current.temperature_2m * 9/5 + 32
        : current.temperature_2m;

      const extremeTemp = this._ext._settings.get_boolean("use-fahrenheit") ? 95 : 35;
      if (temp > extremeTemp) {
        const heatAlert = new PopupMenu.PopupMenuItem(
          "🌡️ HEAT WARNING: Extreme temperatures",
          { reactive: false, style_class: "weather-alert-warning" }
        );
        this._alertsSection.addMenuItem(heatAlert);
        hasAlerts = true;
      }

      // Wind alerts
      if (current.wind_speed_10m > 50) {
        const windAlert = new PopupMenu.PopupMenuItem(
          "💨 WIND WARNING: Strong winds detected",
          { reactive: false, style_class: "weather-alert-warning" }
        );
        this._alertsSection.addMenuItem(windAlert);
        hasAlerts = true;
      }
    }

    updateWeather(data) {
      try {
        const current = data.current;
        const condition = WEATHER_CONDITIONS[current.weather_code] || WEATHER_CONDITIONS[0];
        const useFahrenheit = this._ext._settings.get_boolean("use-fahrenheit");

        const temp = useFahrenheit
          ? Math.round(current.temperature_2m * 9/5 + 32)
          : Math.round(current.temperature_2m);
        const unit = useFahrenheit ? "°F" : "°C";

        // Update panel
        this._weatherIcon.set_icon_name(condition.icon);
        this._weatherLabel.set_text(`${temp}${unit}`);

        // Reset retry count on successful update
        this._retryCount = 0;

        // Generate weather alerts
        this._generateWeatherAlerts(data);

        // Update sections
        this._updateCurrentWeather(data, condition, temp, unit);
        this._updateLocationInfo();
        this._updateHourlyForecast(data);
        this._updateDailyForecast(data);
        this._updateWeatherInsights(data);

      } catch (error) {
        console.error("Weather Extension: Error updating weather", error);
        this._weatherLabel.set_text("Error");
        this._weatherIcon.set_icon_name("dialog-error-symbolic");
      }
    }

    _updateCurrentWeather(data, condition, temp, unit) {
      const current = data.current;
      const windSpeed = Math.round(current.wind_speed_10m);

      let currentText = `🌡️ ${temp}${unit} • ${condition.name}\n`;
      currentText += `💨 ${windSpeed} km/h`;

      // Check if humidity should be shown
      if (this._ext._settings.get_boolean("show-humidity")) {
        currentText += ` • 💧 ${current.relative_humidity_2m}%`;
      }

      currentText += `\n📊 ${Math.round(current.surface_pressure)} hPa`;
      currentText += `\n📍 ${data.location || "Unknown Location"}`;

      this._currentWeatherItem.label.set_text(currentText);
    }

    _updateHourlyForecast(data) {
      this._hourlySection.menu.removeAll();

      if (data.hourly && data.hourly.time) {
        const now = new Date();
        let startIndex = 0;

        // Find the next hour
        for (let i = 0; i < data.hourly.time.length; i++) {
          const hourTime = new Date(data.hourly.time[i]);
          if (hourTime > now) {
            startIndex = i;
            break;
          }
        }

        // Show next 12 hours
        for (let i = 0; i < 12 && (startIndex + i) < data.hourly.time.length; i++) {
          const hourIndex = startIndex + i;
          const timeStr = this._formatTime(data.hourly.time[hourIndex]);
          const condition = WEATHER_CONDITIONS[data.hourly.weather_code[hourIndex]] || WEATHER_CONDITIONS[0];
          const temp = this._ext._settings.get_boolean("use-fahrenheit")
            ? Math.round(data.hourly.temperature_2m[hourIndex] * 9/5 + 32)
            : Math.round(data.hourly.temperature_2m[hourIndex]);
          const unit = this._ext._settings.get_boolean("use-fahrenheit") ? "°F" : "°C";

          const precipProb = data.hourly.precipitation_probability
            ? data.hourly.precipitation_probability[hourIndex] : 0;

          const hourlyItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: "forecast-item-minimal"
          });

          const hourlyBox = new St.BoxLayout({
            vertical: false,
            style: "spacing: 8px; padding: 4px;"
          });

          const timeLabel = new St.Label({
            text: timeStr,
            style: "min-width: 60px; font-weight: 500;"
          });

          const iconWidget = new St.Icon({
            icon_name: condition.icon,
            icon_size: 16,
            style_class: "popup-menu-icon"
          });

          const tempLabel = new St.Label({
            text: `${temp}${unit}`,
            style: "min-width: 40px; font-weight: 500;"
          });

          const conditionLabel = new St.Label({
            text: condition.name,
            style: "min-width: 100px;"
          });

          hourlyBox.add_child(timeLabel);
          hourlyBox.add_child(iconWidget);
          hourlyBox.add_child(tempLabel);
          hourlyBox.add_child(conditionLabel);

          if (precipProb > 0) {
            const precipLabel = new St.Label({
              text: `💧${precipProb}%`,
              style: "color: #4FC3F7; font-size: 11px;"
            });
            hourlyBox.add_child(precipLabel);
          }

          hourlyItem.add_child(hourlyBox);
          this._hourlySection.menu.addMenuItem(hourlyItem);
        }
      }
    }

    _updateDailyForecast(data) {
      this._dailySection.menu.removeAll();

      if (data.daily && data.daily.time) {
        for (let i = 0; i < Math.min(7, data.daily.time.length); i++) {
          const date = new Date(data.daily.time[i]);
          const dayName = i === 0 ? "Today" :
                        i === 1 ? "Tomorrow" :
                        date.toLocaleDateString('en', { weekday: 'long' });

          const condition = WEATHER_CONDITIONS[data.daily.weather_code[i]] || WEATHER_CONDITIONS[0];

          const maxTemp = this._ext._settings.get_boolean("use-fahrenheit")
            ? Math.round(data.daily.temperature_2m_max[i] * 9/5 + 32)
            : Math.round(data.daily.temperature_2m_max[i]);
          const minTemp = this._ext._settings.get_boolean("use-fahrenheit")
            ? Math.round(data.daily.temperature_2m_min[i] * 9/5 + 32)
            : Math.round(data.daily.temperature_2m_min[i]);
          const unit = this._ext._settings.get_boolean("use-fahrenheit") ? "°F" : "°C";

          const dailyItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: "forecast-item-minimal"
          });

          const dailyBox = new St.BoxLayout({
            vertical: false,
            style: "spacing: 8px; padding: 6px;"
          });

          const dayLabel = new St.Label({
            text: dayName,
            style: "min-width: 80px; font-weight: 500;"
          });

          const iconWidget = new St.Icon({
            icon_name: condition.icon,
            icon_size: 18,
            style_class: "popup-menu-icon"
          });

          const tempLabel = new St.Label({
            text: `${maxTemp}°/${minTemp}${unit}`,
            style: "min-width: 70px; font-weight: 500;"
          });

          const conditionLabel = new St.Label({
            text: condition.name,
            style: "opacity: 0.8;"
          });

          dailyBox.add_child(dayLabel);
          dailyBox.add_child(iconWidget);
          dailyBox.add_child(tempLabel);
          dailyBox.add_child(conditionLabel);

          dailyItem.add_child(dailyBox);
          this._dailySection.menu.addMenuItem(dailyItem);
        }
      }
    }

    _updateWeatherInsights(data) {
      this._insightsSection.menu.removeAll();

      try {
        // Temperature trend analysis
        if (data.hourly && data.hourly.temperature_2m) {
          const hourlyTemps = data.hourly.temperature_2m.slice(0, 12);
          const tempTrend = this._analyzeTrend(hourlyTemps);

          const trendItem = new PopupMenu.PopupMenuItem(
            `📈 Temperature Trend: ${tempTrend}`,
            { reactive: false, style_class: "insight-item-minimal" }
          );
          this._insightsSection.menu.addMenuItem(trendItem);
        }

        // Precipitation analysis
        const precipCodes = [51, 53, 55, 61, 63, 65, 80, 81, 82, 85, 86];
        if (data.hourly && data.hourly.weather_code) {
          const precipHours = data.hourly.weather_code.slice(0, 24).filter(code =>
            precipCodes.includes(code)
          );
          const precipChance = (precipHours.length / 24 * 100).toFixed(1);

          const precipItem = new PopupMenu.PopupMenuItem(
            `💧 Precipitation (24h): ${precipChance}%`,
            { reactive: false, style_class: "insight-item-minimal" }
          );
          this._insightsSection.menu.addMenuItem(precipItem);
        }

        // UV Index estimation
        const now = new Date();
        const hour = now.getHours();
        let uvIndex = 0;

        if (hour >= 10 && hour <= 16) {
          const current = data.current;
          const condition = WEATHER_CONDITIONS[current.weather_code];

          if (condition && condition.name.includes("Clear")) {
            uvIndex = 8;
          } else if (condition && condition.name.includes("Cloudy")) {
            uvIndex = 4;
          } else {
            uvIndex = 2;
          }
        }

        const uvItem = new PopupMenu.PopupMenuItem(
          `☀️ UV Index: ${uvIndex} ${uvIndex > 6 ? "(High)" : uvIndex > 3 ? "(Moderate)" : "(Low)"}`,
          { reactive: false, style_class: "insight-item-minimal" }
        );
        this._insightsSection.menu.addMenuItem(uvItem);

        // Air quality estimate
        const aqiItem = new PopupMenu.PopupMenuItem(
          `🌬️ Air Quality: Good (Estimated)`,
          { reactive: false, style_class: "insight-item-minimal" }
        );
        this._insightsSection.menu.addMenuItem(aqiItem);

      } catch (error) {
        console.error("Error updating weather insights:", error);
      }
    }

    _analyzeTrend(temperatures) {
      if (temperatures.length < 2) return "Insufficient data";

      let increasingCount = 0;
      let decreasingCount = 0;

      for (let i = 1; i < temperatures.length; i++) {
        const diff = temperatures[i] - temperatures[i - 1];
        if (diff > 0.5) {
          increasingCount++;
        } else if (diff < -0.5) {
          decreasingCount++;
        }
      }

      if (increasingCount > decreasingCount + 1) return "Warming 🔥";
      if (decreasingCount > increasingCount + 1) return "Cooling 🧊";
      return "Stable 🟰";
    }

    destroy() {
      if (this._updateTimeoutId) {
        GLib.source_remove(this._updateTimeoutId);
        this._updateTimeoutId = null;
      }

      if (this._settingsConnections) {
        this._settingsConnections.forEach(id => {
          this._ext._settings.disconnect(id);
        });
        this._settingsConnections = null;
      }

      super.destroy();
    }
  }
);

export default class WeatherExtension extends Extension {
  enable() {
    this._settings = this.getSettings("org.gnome.shell.extensions.advanced-weather");
    this._session = new Soup.Session();
    this._session.timeout = 15;

    this._panelButton = new WeatherPanelButton(this);

    const position = this._settings.get_string("panel-position") || "right";
    const index = this._settings.get_int("panel-position-index") || 0;
    Main.panel.addToStatusArea("weather-extension", this._panelButton, index, position);

    this._settingsConnections = [
      this._settings.connect("changed::panel-position", () => this._updatePanelPosition()),
      this._settings.connect("changed::panel-position-index", () => this._updatePanelPosition()),
      this._settings.connect("changed::location-mode", () => this._detectLocationAndLoadWeather()),
      this._settings.connect("changed::location", () => this._detectLocationAndLoadWeather()),
      this._settings.connect("changed::update-interval", () => this._restartUpdateTimer())
    ];

    this._detectLocationAndLoadWeather();
  }

  disable() {
    if (this._panelButton) {
      this._panelButton.destroy();
      this._panelButton = null;
    }

    if (this._settingsConnections) {
      this._settingsConnections.forEach(id => {
        this._settings.disconnect(id);
      });
      this._settingsConnections = null;
    }

    this._settings = null;
    this._session = null;
  }

  _updatePanelPosition() {
    if (this._panelButton) {
      this._panelButton.destroy();
      this._panelButton = new WeatherPanelButton(this);

      const position = this._settings.get_string("panel-position") || "right";
      const index = this._settings.get_int("panel-position-index") || 0;
      Main.panel.addToStatusArea("weather-extension", this._panelButton, index, position);

      this._detectLocationAndLoadWeather();
    }
  }

  _restartUpdateTimer() {
    if (this._panelButton) {
      this._panelButton._startUpdateTimer();
    }
  }

  async _detectLocationAndLoadWeather() {
    try {
      const mode = this._settings.get_string("location-mode");

      if (mode === "manual") {
        await this._useManualLocation();
      } else {
        await this._autoDetectLocation();
      }

      await this._loadWeatherData();
    } catch (error) {
      console.error("Weather Extension: Location detection failed", error);
      if (this._panelButton) {
        this._panelButton._weatherLabel.set_text("Offline");
        this._panelButton._weatherIcon.set_icon_name("network-offline-symbolic");
      }
      this._useFallbackLocation();
    }
  }

  async _useManualLocation() {
    const location = this._settings.get_string("location").trim();

    if (!location) {
      throw new Error("No manual location set");
    }

    const coordMatch = location.match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
    if (coordMatch) {
      this._latitude = parseFloat(coordMatch[1]);
      this._longitude = parseFloat(coordMatch[2]);
      this._locationName = this._settings.get_string("location-name") ||
                          `${this._latitude.toFixed(2)}, ${this._longitude.toFixed(2)}`;
      return;
    }

    await this._searchLocationCoordinates(location);
  }

  async _searchLocationCoordinates(query) {
    const url = `${GEOCODING_URL}?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;

    try {
      const message = Soup.Message.new("GET", url);
      message.request_headers.append('User-Agent', 'GNOME-Weather-Extension/1.0');

      const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);

      if (message.status_code !== 200) {
        throw new Error(`HTTP ${message.status_code}`);
      }

      const response = JSON.parse(bytes.get_data().toString());

      if (response.results && response.results.length > 0) {
        const result = response.results[0];
        this._latitude = result.latitude;
        this._longitude = result.longitude;
        this._locationName = `${result.name}, ${result.country}`;
      } else {
        throw new Error("Location not found");
      }
    } catch (error) {
      console.error("Weather Extension: Location search failed", error);
      throw error;
    }
  }

  async _autoDetectLocation() {
    // Try multiple GEOIP services for better reliability
    for (const url of FALLBACK_GEOIP_URLS) {
      try {
        console.log(`Trying GeoIP service: ${url}`);
        const message = Soup.Message.new("GET", url);
        message.request_headers.append('User-Agent', 'GNOME-Weather-Extension/1.0');

        const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);

        if (message.status_code !== 200) {
          console.log(`GeoIP service ${url} returned status ${message.status_code}`);
          continue;
        }

        const response = JSON.parse(bytes.get_data().toString());

        // Handle different API response formats
        let lat, lon, city, country;

        if (url.includes('ipapi.co')) {
          if (response.latitude && response.longitude) {
            lat = response.latitude;
            lon = response.longitude;
            city = response.city;
            country = response.country_name;
          }
        } else if (url.includes('ip-api.com')) {
          if (response.status === "success" && response.lat && response.lon) {
            lat = response.lat;
            lon = response.lon;
            city = response.city;
            country = response.country;
          }
        } else if (url.includes('freegeoip.app')) {
          if (response.latitude && response.longitude) {
            lat = response.latitude;
            lon = response.longitude;
            city = response.city;
            country = response.country_name;
          }
        }

        if (lat && lon) {
          this._latitude = lat;
          this._longitude = lon;
          this._locationName = `${city}, ${country}`;
          console.log(`Successfully detected location: ${this._locationName}`);
          return;
        }
      } catch (error) {
        console.error(`GeoIP service ${url} failed:`, error);
        continue;
      }
    }

    throw new Error("All GeoIP services failed");
  }

  _useFallbackLocation() {
    console.log("Using fallback location: New York, NY");
    this._latitude = 40.7128;
    this._longitude = -74.0060;
    this._locationName = "New York, NY (Fallback)";
    this._loadWeatherData();
  }

  async _loadWeatherData() {
    try {
      const params = [
        `latitude=${this._latitude}`,
        `longitude=${this._longitude}`,
        "current=temperature_2m,relative_humidity_2m,apparent_temperature,surface_pressure,weather_code,wind_speed_10m,wind_direction_10m",
        "hourly=temperature_2m,weather_code,precipitation_probability,wind_speed_10m",
        "daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset",
        "timezone=auto",
        "forecast_days=7"
      ];

      const url = `${BASE_URL}?${params.join("&")}`;

      const message = Soup.Message.new("GET", url);
      message.request_headers.append('User-Agent', 'GNOME-Weather-Extension/1.0');

      const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);

      if (message.status_code !== 200) {
        throw new Error(`Weather API returned status ${message.status_code}`);
      }

      const response = JSON.parse(bytes.get_data().toString());

      if (!response.current) {
        throw new Error("Invalid weather data received");
      }

      const data = {
        location: this._locationName,
        current: response.current,
        hourly: response.hourly,
        daily: response.daily
      };

      this._panelButton.updateWeather(data);
    } catch (error) {
      console.error("Weather Extension: Failed to load weather data", error);
      if (this._panelButton) {
        this._panelButton._weatherLabel.set_text("Error");
        this._panelButton._weatherIcon.set_icon_name("dialog-error-symbolic");
      }
    }
  }
}