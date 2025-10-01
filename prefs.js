import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import GObject from "gi://GObject";
import GLib from "gi://GLib";
import Soup from "gi://Soup";
import GdkPixbuf from "gi://GdkPixbuf";
import Gdk from "gi://Gdk";

import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const REVERSE_GEOCODING_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client";


const WEATHER_PROVIDERS = {
  openmeteo: {
    name: "Open-Meteo (Free)",
    description: "Free weather API - No API key required",
    baseUrl: "https://api.open-meteo.com/v1/forecast",
    requiresApiKey: false,
    supportedParams: ["temperature_2m", "relative_humidity_2m", "weather_code", "wind_speed_10m", "surface_pressure"],
    rateLimit: "10,000 requests/day"
  },
  meteosource: {
    name: "Meteosource (Free)",
    description: "Free tier - 400 calls/day without API key",
    baseUrl: "https://www.meteosource.com/api/v1/free/point",
    requiresApiKey: false,
    supportedParams: ["temperature", "humidity", "weather_icon", "wind_speed", "pressure"],
    rateLimit: "400 requests/day (free tier)"
  },
  wttr: {
    name: "Wttr.in (Free)",
    description: "Free console weather service - No registration, unlimited requests",
    baseUrl: "https://wttr.in",
    requiresApiKey: false,
    supportedParams: ["temp_C", "humidity", "weatherCode", "windspeedKmph", "pressure"],
    rateLimit: "No limits"
  },
  openweathermap: {
    name: "OpenWeatherMap",
    description: "Comprehensive weather data - API key required",
    baseUrl: "https://api.openweathermap.org/data/2.5/weather",
    requiresApiKey: true,
    supportedParams: ["temp", "humidity", "weather", "wind_speed", "pressure"],
    rateLimit: "1,000 requests/day (free tier)"
  },
  weatherapi: {
    name: "WeatherAPI",
    description: "Real-time weather API - API key required",
    baseUrl: "https://api.weatherapi.com/v1/forecast.json",
    requiresApiKey: true,
    supportedParams: ["temp_c", "humidity", "condition", "wind_kph", "pressure_mb"],
    rateLimit: "1 million requests/month (free tier)"
  },
  custom: {
    name: "Custom Provider",
    description: "Configure your own weather API endpoint",
    baseUrl: "",
    requiresApiKey: true,
    supportedParams: [],
    rateLimit: "Depends on provider"
  }
};

export default class WeatherPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings("org.gnome.shell.extensions.advanced-weather");
    this._session = new Soup.Session();
    this._session.timeout = 15;

    window.set_title(_("Advanced Weather Companion"));
    window.set_default_size(700, 650);
    window.set_resizable(true);

    window.add(this._createGeneralPage(settings));
    window.add(this._createLocationPage(settings));
    window.add(this._createWeatherProviderPage(settings));
    window.add(this._createAppearancePage(settings));
    window.add(this._createAboutPage(settings));
  }

  _createGeneralPage(settings) {
    const page = new Adw.PreferencesPage({
      title: _("General"),
      icon_name: "preferences-other-symbolic"
    });

    const unitsGroup = new Adw.PreferencesGroup({
      title: _("Units & Format"),
      description: _("Configure measurement units and display format")
    });

    const tempUnitRow = new Adw.SwitchRow({
      title: _("Use Fahrenheit"),
      subtitle: _("Switch between Celsius and Fahrenheit")
    });
    tempUnitRow.set_active(settings.get_boolean("use-fahrenheit"));
    tempUnitRow.connect("notify::active", () => {
      settings.set_boolean("use-fahrenheit", tempUnitRow.get_active());
    });

    const windSpeedUnitRow = new Adw.ComboRow({
      title: _("Wind Speed Unit"),
      subtitle: _("Choose unit for wind speed display"),
      model: new Gtk.StringList()
    });

    const windUnits = [
      { label: _("km/h (Kilometers per hour)"), value: "kmh" },
      { label: _("mph (Miles per hour)"), value: "mph" },
      { label: _("m/s (Meters per second)"), value: "ms" },
      { label: _("knots (Nautical miles per hour)"), value: "knots" }
    ];

    windUnits.forEach(unit => windSpeedUnitRow.model.append(unit.label));
    const currentWindUnit = settings.get_string("wind-speed-unit") || "kmh";
    const windUnitIndex = windUnits.findIndex(u => u.value === currentWindUnit);
    windSpeedUnitRow.set_selected(windUnitIndex >= 0 ? windUnitIndex : 0);
    windSpeedUnitRow.connect("notify::selected", () => {
      const selectedUnit = windUnits[windSpeedUnitRow.get_selected()];
      if (selectedUnit) {
        settings.set_string("wind-speed-unit", selectedUnit.value);
      }
    });

    const timeFormatRow = new Adw.SwitchRow({
      title: _("Use 12-hour Format"),
      subtitle: _("Display time in 12-hour format with AM/PM")
    });
    timeFormatRow.set_active(settings.get_boolean("use-12hour-format"));
    timeFormatRow.connect("notify::active", () => {
      settings.set_boolean("use-12hour-format", timeFormatRow.get_active());
    });

    unitsGroup.add(tempUnitRow);
    unitsGroup.add(windSpeedUnitRow);
    unitsGroup.add(timeFormatRow);

    const updateGroup = new Adw.PreferencesGroup({
      title: _("Updates"),
      description: _("Configure weather data refresh settings")
    });

    const intervalRow = new Adw.ComboRow({
      title: _("Update Interval"),
      subtitle: _("How often to refresh weather data"),
      model: new Gtk.StringList()
    });

    const intervals = [
      { label: _("5 minutes"), value: 5 },
      { label: _("10 minutes"), value: 10 },
      { label: _("15 minutes"), value: 15 },
      { label: _("30 minutes"), value: 30 },
      { label: _("1 hour"), value: 60 }
    ];

    intervals.forEach(interval => intervalRow.model.append(interval.label));
    const currentInterval = settings.get_int("update-interval") || 10;
    const intervalIndex = intervals.findIndex(i => i.value === currentInterval);
    intervalRow.set_selected(intervalIndex >= 0 ? intervalIndex : 1);
    intervalRow.connect("notify::selected", () => {
      const selectedInterval = intervals[intervalRow.get_selected()];
      if (selectedInterval) {
        settings.set_int("update-interval", selectedInterval.value);
      }
    });

    updateGroup.add(intervalRow);

    const featuresGroup = new Adw.PreferencesGroup({
      title: _("Features"),
      description: _("Enable or disable weather features")
    });

    const humidityRow = new Adw.SwitchRow({
      title: _("Show Humidity"),
      subtitle: _("Display relative humidity in weather details")
    });
    humidityRow.set_active(settings.get_boolean("show-humidity"));
    humidityRow.connect("notify::active", () => {
      settings.set_boolean("show-humidity", humidityRow.get_active());
    });

    featuresGroup.add(humidityRow);

    page.add(unitsGroup);
    page.add(updateGroup);
    page.add(featuresGroup);

    return page;
  }


  _copyToClipboard(text, label = null) {
      // Use proper GJS clipboard access as per GNOME guidelines
      try {
          const display = Gdk.Display.get_default();
          if (!display) {
              throw new Error("No display available");
          }

          const clipboard = display.get_clipboard();
          if (!clipboard) {
              throw new Error("No clipboard available");
          }

          // Use the proper GJS async clipboard API
          clipboard.set_text_async(text, -1, null, (clipboard, result) => {
              try {
                  clipboard.set_text_finish(result);
                  this._showToast(`✅ ${label || 'Text'} copied to clipboard!`);
              } catch (error) {
                  console.log("Async clipboard set failed:", error.message);
                  // Try synchronous fallback
                  this._trySync(clipboard, text, label);
              }
          });
          return;

      } catch (error) {
          console.log("Async clipboard method failed:", error.message);
      }

      // Fallback to synchronous method
      try {
          const display = Gdk.Display.get_default();
          const clipboard = display?.get_clipboard();
          if (clipboard) {
              this._trySync(clipboard, text, label);
              return;
          }
      } catch (error) {
          console.log("Sync clipboard method failed:", error.message);
      }

      // If all automatic methods fail, show manual copy dialog
      console.log("All clipboard methods failed, showing manual copy dialog");
      this._showCopyDialog(text, label);
  }

  _trySync(clipboard, text, label) {
      try {
          // Try the synchronous set_text method
          clipboard.set_text(text);
          this._showToast(`✅ ${label || 'Text'} copied to clipboard!`);
          return true;
      } catch (error) {
          console.log("Synchronous clipboard failed:", error.message);

          // Try with content provider approach
          try {
              const contentProvider = Gdk.ContentProvider.new_for_value(text);
              if (contentProvider) {
                  clipboard.set_content(contentProvider);
                  this._showToast(`✅ ${label || 'Text'} copied to clipboard!`);
                  return true;
              }
          } catch (providerError) {
              console.log("Content provider approach failed:", providerError.message);
          }

          return false;
      }
  }

  _showCopyDialog(text, label = null) {
      const dialog = new Adw.MessageDialog({
          heading: _("Copy to Clipboard"),
          body: _(`Unable to automatically copy to clipboard. Please manually copy the ${label || 'text'} below:`),
          modal: true,
          transient_for: this._getParentWindow()
      });

      dialog.add_response("close", _("Close"));
      dialog.add_response("select", _("Select Text"));
      dialog.set_response_appearance("select", Adw.ResponseAppearance.SUGGESTED);
      dialog.set_default_response("select");


      const contentBox = new Gtk.Box({
          orientation: Gtk.Orientation.VERTICAL,
          spacing: 12,
          margin_top: 12,
          margin_bottom: 12,
          margin_start: 12,
          margin_end: 12
      });


      const textView = new Gtk.TextView({
          editable: false,
          cursor_visible: true,
          wrap_mode: Gtk.WrapMode.CHAR,
          css_classes: ["monospace", "card"],
          margin_top: 8,
          margin_bottom: 8,
          margin_start: 8,
          margin_end: 8
      });


      const scrolledWindow = new Gtk.ScrolledWindow({
          child: textView,
          height_request: Math.min(120, Math.max(40, text.length / 3)),
          hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
          vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
          css_classes: ["view"]
      });

      const buffer = textView.get_buffer();
      buffer.set_text(text, -1);

      contentBox.append(scrolledWindow);

      // Add copy instruction
      const instructionLabel = new Gtk.Label({
          label: _("💡 Select the text above and press Ctrl+C to copy"),
          css_classes: ["caption", "dim-label"],
          halign: Gtk.Align.CENTER,
          margin_top: 8
      });
      contentBox.append(instructionLabel);

      dialog.set_extra_child(contentBox);

      dialog.connect("response", (dialog, response) => {
          if (response === "select") {

              const startIter = buffer.get_start_iter();
              const endIter = buffer.get_end_iter();
              buffer.select_range(startIter, endIter);


              textView.grab_focus();


              try {
                  const display = Gdk.Display.get_default();
                  if (display) {
                      const clipboard = display.get_clipboard();
                      if (clipboard) {
                          clipboard.set_text(text);
                          this._showToast(`✅ ${label || 'Text'} copied to clipboard!`);
                          dialog.close();
                          return;
                      }
                  }
              } catch (e) {
                  // If clipboard access still fails, just show the selection
                  this._showToast(_("💡 Text selected! Press Ctrl+C to copy"));
              }
              return;
          }
          dialog.close();
      });

      dialog.present();
  }

  // Helper method to get parent window for dialogs
  _getParentWindow() {
      let widget = this._searchResultsGroup || this._providerDetailsGroup;
      while (widget) {
          if (widget.get_root && widget.get_root()) {
              return widget.get_root();
          }
          if (widget.get_toplevel && widget.get_toplevel()) {
              return widget.get_toplevel();
          }
          widget = widget.get_parent();
      }
      return null;
  }

  _createLocationPage(settings) {
    const page = new Adw.PreferencesPage({
      title: _("Location"),
      icon_name: "find-location-symbolic"
    });

    const locationGroup = new Adw.PreferencesGroup({
      title: _("Location Detection"),
      description: _("Configure how your location is determined")
    });

    const locationModeRow = new Adw.ComboRow({
      title: _("Location Mode"),
      subtitle: _("Choose detection method"),
      model: new Gtk.StringList()
    });

    locationModeRow.model.append(_("🌍 Auto Detection"));
    locationModeRow.model.append(_("📍 Manual Location"));
    const currentMode = settings.get_string("location-mode") || "auto";
    locationModeRow.set_selected(currentMode === "auto" ? 0 : 1);

    const currentLocationRow = new Adw.ActionRow({
      title: _("Current Location"),
      subtitle: this._getLocationSubtitle(settings),
      activatable: false
    });

    const gpsIcon = new Gtk.Image({
      icon_name: currentMode === "auto" ? "location-services-active-symbolic" : "location-services-disabled-symbolic",
      pixel_size: 16
    });
    currentLocationRow.add_prefix(gpsIcon);

    const refreshButton = new Gtk.Button({
      icon_name: "view-refresh-symbolic",
      valign: Gtk.Align.CENTER,
      tooltip_text: _("Refresh location"),
      css_classes: ["flat"]
    });
    refreshButton.connect("clicked", () => {
      this._updateCurrentLocationDisplay();
    });
    currentLocationRow.add_suffix(refreshButton);

    locationGroup.add(locationModeRow);
    locationGroup.add(currentLocationRow);

    const searchGroup = new Adw.PreferencesGroup({
      title: _("Manual Location Search"),
      description: _("Search by city name or coordinates (latitude, longitude)"),
      sensitive: currentMode === "manual"
    });

    const searchEntryRow = new Adw.EntryRow({
      title: _("Search Location"),
      text: "",
      show_apply_button: true
    });
    searchEntryRow.set_input_hints(Gtk.InputHints.NONE);

    const searchButton = new Gtk.Button({
      icon_name: "edit-find-symbolic",
      valign: Gtk.Align.CENTER,
      tooltip_text: _("Search for location"),
      css_classes: ["suggested-action"]
    });

    const clearButton = new Gtk.Button({
      icon_name: "edit-clear-symbolic",
      valign: Gtk.Align.CENTER,
      tooltip_text: _("Clear search"),
      css_classes: ["flat"]
    });

    searchEntryRow.add_suffix(searchButton);
    searchEntryRow.add_suffix(clearButton);

    const helpRow = new Adw.ActionRow({
      title: _("Search Examples"),
      subtitle: _("City names: 'London', 'New York', 'Tokyo'\nCoordinates: '40.7128, -74.0060' or '40.7128 -74.0060'"),
      activatable: false,
      sensitive: false
    });
    const helpIcon = new Gtk.Image({
      icon_name: "dialog-information-symbolic",
      pixel_size: 16
    });
    helpRow.add_prefix(helpIcon);

    this._searchResultsGroup = new Adw.PreferencesGroup({
      title: _("Search Results"),
      visible: false
    });

    this._currentLocationRow = currentLocationRow;
    this._searchGroup = searchGroup;
    this._searchEntryRow = searchEntryRow;
    this._searchButton = searchButton;
    this._settings = settings;
    this._locationModeRow = locationModeRow;
    this._gpsIcon = gpsIcon;

    locationModeRow.connect("notify::selected", () => {
      const mode = locationModeRow.get_selected() === 0 ? "auto" : "manual";
      settings.set_string("location-mode", mode);
      this._updateLocationSensitivity(mode);
      this._updateCurrentLocationDisplay();
      this._gpsIcon.set_from_icon_name(mode === "auto" ? "location-services-active-symbolic" : "location-services-disabled-symbolic");
    });

    searchButton.connect("clicked", () => {
      this._clearSearchResults();
      this._performLocationSearch();
    });
    searchEntryRow.connect("entry-activated", () => {
      this._clearSearchResults();
      this._performLocationSearch();
    });
    searchEntryRow.connect("apply", () => {
      this._clearSearchResults();
      this._performLocationSearch();
    });
    clearButton.connect("clicked", () => {
      searchEntryRow.set_text("");
      this._clearSearchResults();
    });

    searchEntryRow.connect("notify::text", () => {
      const query = searchEntryRow.get_text().trim();
      const coordPattern = /^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/;
      const isCoordinates = coordPattern.test(query);
      searchButton.set_sensitive(isCoordinates || query.length >= 2);
    });

    searchGroup.add(searchEntryRow);
    searchGroup.add(helpRow);
    page.add(locationGroup);
    page.add(searchGroup);
    page.add(this._searchResultsGroup);

    return page;
  }

  _createWeatherProviderPage(settings) {
    const page = new Adw.PreferencesPage({
      title: _("Weather Provider"),
      icon_name: "network-server-symbolic"
    });

    const providerGroup = new Adw.PreferencesGroup({
      title: _("Weather Data Source"),
      description: _("Choose your weather data provider")
    });

    const providerRow = new Adw.ComboRow({
      title: _("Weather Provider"),
      subtitle: _("Select weather API service"),
      model: new Gtk.StringList()
    });
    
    
    providerRow.connect("notify::selected", () => {
      const selectedKey = providerKeys[providerRow.get_selected()];
      settings.set_string("weather-provider", selectedKey);
      this._updateProviderSettings(selectedKey);
      
      // Force settings sync
      settings.sync();
    });

    
    


    const providerKeys = Object.keys(WEATHER_PROVIDERS);
    providerKeys.forEach(key => {
      const provider = WEATHER_PROVIDERS[key];
      const freeIndicator = provider.requiresApiKey ? "💰" : "🆓";
      providerRow.model.append(`${freeIndicator} ${provider.name} - ${provider.description}`);
    });

    const currentProvider = settings.get_string("weather-provider") || "openmeteo";
    const providerIndex = providerKeys.indexOf(currentProvider);
    providerRow.set_selected(providerIndex >= 0 ? providerIndex : 0);


    this._providerDetailsGroup = new Adw.PreferencesGroup({
      title: _("Provider Configuration"),
      description: _("Configure your selected weather provider")
    });


    this._apiKeyRow = new Adw.PasswordEntryRow({
      title: _("API Key"),
      text: settings.get_string("weather-api-key") || ""
    });

    const getApiKeyButton = new Gtk.Button({
      label: _("Get API Key"),
      valign: Gtk.Align.CENTER,
      css_classes: ["suggested-action"]
    });
    this._apiKeyRow.add_suffix(getApiKeyButton);


    this._customUrlRow = new Adw.EntryRow({
      title: _("Custom API URL"),
      text: settings.get_string("custom-weather-url") || ""
    });


    this._providerInfoRow = new Adw.ActionRow({
      title: _("Provider Information"),
      activatable: false
    });


    const testConnectionRow = new Adw.ActionRow({
      title: _("Test Connection"),
      subtitle: _("Verify your provider settings work correctly"),
      activatable: true
    });

    const testButton = new Gtk.Button({
      label: _("Test"),
      valign: Gtk.Align.CENTER,
      css_classes: ["suggested-action"]
    });
    testConnectionRow.add_suffix(testButton);


    providerRow.connect("notify::selected", () => {
      const selectedKey = providerKeys[providerRow.get_selected()];
      settings.set_string("weather-provider", selectedKey);
      this._updateProviderSettings(selectedKey);
    });

    this._apiKeyRow.connect("notify::text", () => {
      settings.set_string("weather-api-key", this._apiKeyRow.get_text());
    });

    this._customUrlRow.connect("notify::text", () => {
      settings.set_string("custom-weather-url", this._customUrlRow.get_text());
    });

    getApiKeyButton.connect("clicked", () => {
      this._openProviderWebsite(providerKeys[providerRow.get_selected()]);
    });

    testButton.connect("clicked", () => {
      this._testWeatherConnection(settings);
    });

    testConnectionRow.connect("activated", () => {
      this._testWeatherConnection(settings);
    });

    providerGroup.add(providerRow);

    this._providerDetailsGroup.add(this._apiKeyRow);
    this._providerDetailsGroup.add(this._customUrlRow);
    this._providerDetailsGroup.add(this._providerInfoRow);
    this._providerDetailsGroup.add(testConnectionRow);

    page.add(providerGroup);
    page.add(this._providerDetailsGroup);


    this._updateProviderSettings(currentProvider);

    return page;
  }

  _updateProviderSettings(providerKey) {
    const provider = WEATHER_PROVIDERS[providerKey];


    this._apiKeyRow.visible = provider.requiresApiKey;


    this._customUrlRow.visible = (providerKey === "custom");


    let infoText = `📡 Base URL: ${provider.baseUrl || "Not specified"}\n`;
    infoText += `📊 Rate Limit: ${provider.rateLimit}\n`;
    infoText += `🔑 API Key: ${provider.requiresApiKey ? "Required" : "Not Required"}`;

    if (provider.supportedParams && provider.supportedParams.length > 0) {
      infoText += `\n🎯 Parameters: ${provider.supportedParams.join(", ")}`;
    }

    this._providerInfoRow.set_subtitle(infoText);
  }

  _openProviderWebsite(providerKey) {
    const urls = {
      openmeteo: "https://open-meteo.com/",
      meteosource: "https://www.meteosource.com/",
      wttr: "https://wttr.in/",
      openweathermap: "https://openweathermap.org/api",
      weatherapi: "https://www.weatherapi.com/",
      custom: "https://github.com/Sanjai-Shaarugesh/Advanced-Weather-Companion/wiki/Custom-Weather-Providers"
    };

    const url = urls[providerKey];
    if (url) {
      try {
        Gio.AppInfo.launch_default_for_uri(url, null);
      } catch (error) {
        console.error("Could not open provider website:", error);
        this._showToast(_("Could not open website. Please visit manually."));
      }
    }
  }

  async _testWeatherConnection(settings) {
    const testButton = this._providerDetailsGroup.get_last_child().get_last_child();
    testButton.set_label(_("Testing..."));
    testButton.set_sensitive(false);

    try {
      const provider = settings.get_string("weather-provider") || "openmeteo";
      const apiKey = settings.get_string("weather-api-key") || "";
      const customUrl = settings.get_string("custom-weather-url") || "";


      const testLat = 40.7128;
      const testLon = -74.0060;

      let testUrl;
      const providerConfig = WEATHER_PROVIDERS[provider];

      if (provider === "custom") {
        if (!customUrl.trim()) {
          throw new Error("Custom URL is required");
        }
        testUrl = customUrl.replace("{lat}", testLat).replace("{lon}", testLon);
        testUrl = testUrl.replace("{latitude}", testLat).replace("{longitude}", testLon);
        if (apiKey) {
          testUrl += testUrl.includes("?") ? "&" : "?";
          testUrl += `key=${apiKey}`;
        }
      } else if (provider === "openmeteo") {
        testUrl = `${providerConfig.baseUrl}?latitude=${testLat}&longitude=${testLon}&current=temperature_2m,weather_code`;
      } else if (provider === "meteosource") {
        testUrl = `${providerConfig.baseUrl}?lat=${testLat}&lon=${testLon}&sections=current&timezone=UTC&language=en&units=metric`;
      } else if (provider === "wttr") {
        testUrl = `${providerConfig.baseUrl}/${testLat},${testLon}?format=j1`;
      }
      else if (provider === "openweathermap") {
        if (!apiKey.trim()) {
          throw new Error("API key is required for OpenWeatherMap");
        }
         testUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${testLat}&lon=${testLon}&appid=${apiKey}&units=metric`;
      } else if (provider === "weatherapi") {
        if (!apiKey.trim()) {
          throw new Error("API key is required for WeatherAPI");
        }
        testUrl = `${providerConfig.baseUrl}?key=${apiKey}&q=${testLat},${testLon}&days=1`;
      }

      const message = Soup.Message.new("GET", testUrl);
      message.request_headers.append('User-Agent', 'GNOME-Weather-Extension/1.0');

      const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);

      if (message.status_code === 200) {
        const responseText = new TextDecoder().decode(bytes.get_data());
        const response = JSON.parse(responseText);


        let hasValidData = false;
        let temperature = null;

        if (provider === "openmeteo" && response.current && response.current.temperature_2m !== undefined) {
          hasValidData = true;
          temperature = response.current.temperature_2m;
        } else if (provider === "meteosource" && response.current && response.current.temperature !== undefined) {
          hasValidData = true;
          temperature = response.current.temperature;
        } else if (provider === "wttr" && response.current_condition && response.current_condition[0] && response.current_condition[0].temp_C) {
          hasValidData = true;
          temperature = response.current_condition[0].temp_C;
        } else if (provider === "openweathermap" && response.current && response.current.temp !== undefined) {
          hasValidData = true;
          temperature = response.current.temp;
        } else if (provider === "weatherapi" && response.current && response.current.temp_c !== undefined) {
          hasValidData = true;
          temperature = response.current.temp_c;
        } else if (provider === "custom" && response) {
          hasValidData = true;
        }

        if (hasValidData) {
          let successMessage = "✅ Connection successful! Weather data received.";
          if (temperature !== null) {
            successMessage += ` Current temperature: ${temperature}°C`;
          }
          this._showToast(successMessage);
        } else {
          throw new Error("Invalid response format - no temperature data found");
        }
      } else {
        throw new Error(`HTTP ${message.status_code}: ${message.reason_phrase}`);
      }

    } catch (error) {
      console.error("Weather provider test failed:", error);
      this._showToast(_("❌ Connection failed: ") + error.message);
    } finally {
      testButton.set_label(_("Test"));
      testButton.set_sensitive(true);
    }
  }

  _createAppearancePage(settings) {
    const page = new Adw.PreferencesPage({
      title: _("Appearance"),
      icon_name: "applications-graphics-symbolic"
    });

    const panelGroup = new Adw.PreferencesGroup({
      title: _("Panel Display"),
      description: _("Configure how the weather appears in the panel")
    });

    const panelPositionRow = new Adw.ComboRow({
      title: _("Panel Position"),
      subtitle: _("Where to show the weather widget"),
      model: new Gtk.StringList()
    });

    const positions = [
      { id: "left", label: _("Left") },
      { id: "center", label: _("Center") },
      { id: "right", label: _("Right") }
    ];

    positions.forEach(pos => panelPositionRow.model.append(pos.label));
    const currentPosition = settings.get_string("panel-position") || "right";
    const positionIndex = positions.findIndex(p => p.id === currentPosition);
    panelPositionRow.set_selected(positionIndex >= 0 ? positionIndex : 2);
    panelPositionRow.connect("notify::selected", () => {
      const selectedPosition = positions[panelPositionRow.get_selected()];
      if (selectedPosition) {
        settings.set_string("panel-position", selectedPosition.id);
      }
    });

    const panelPositionIndexRow = new Adw.SpinRow({
      title: _("Panel Position Index"),
      subtitle: _("Position index in the selected panel area"),
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 10,
        step_increment: 1,
        value: settings.get_int("panel-position-index") || 0
      })
    });
    panelPositionIndexRow.connect("notify::value", () => {
      settings.set_int("panel-position-index", panelPositionIndexRow.get_value());
    });

    const showTextRow = new Adw.SwitchRow({
      title: _("Show Temperature Text"),
      subtitle: _("Display temperature alongside the weather icon")
    });
    showTextRow.set_active(settings.get_boolean("show-text-in-panel"));
    showTextRow.connect("notify::active", () => {
      settings.set_boolean("show-text-in-panel", showTextRow.get_active());
    });

    const showLocationRow = new Adw.SwitchRow({
      title: _("Show Location Indicator"),
      subtitle: _("Display location mode indicator in panel")
    });
    const locationModeIcon = new Gtk.Image({
      icon_name: "find-location-symbolic",
      pixel_size: 16
    });
    showLocationRow.add_prefix(locationModeIcon);
    showLocationRow.set_active(settings.get_boolean("show-location-label"));
    showLocationRow.connect("notify::active", () => {
      settings.set_boolean("show-location-label", showLocationRow.get_active());
    });

    const iconSizeRow = new Adw.SpinRow({
      title: _("Icon Size"),
      subtitle: _("Size of the weather icon in pixels"),
      adjustment: new Gtk.Adjustment({
        lower: 12,
        upper: 24,
        step_increment: 1,
        value: settings.get_int("panel-icon-size") || 16
      })
    });
    iconSizeRow.connect("notify::value", () => {
      settings.set_int("panel-icon-size", iconSizeRow.get_value());
    });

    const textSizeRow = new Adw.SpinRow({
      title: _("Text Size"),
      subtitle: _("Size of the temperature text in pixels"),
      adjustment: new Gtk.Adjustment({
        lower: 10,
        upper: 16,
        step_increment: 1,
        value: settings.get_int("panel-text-size") || 13
      })
    });
    textSizeRow.connect("notify::value", () => {
      settings.set_int("panel-text-size", textSizeRow.get_value());
    });

    panelGroup.add(panelPositionRow);
    panelGroup.add(panelPositionIndexRow);
    panelGroup.add(showTextRow);
    panelGroup.add(showLocationRow);
    panelGroup.add(iconSizeRow);
    panelGroup.add(textSizeRow);

    page.add(panelGroup);
    return page;
  }

  _createAboutPage(settings) {
      const page = new Adw.PreferencesPage({
        title: _("About"),
        icon_name: "help-about-symbolic"
      });

      const infoGroup = new Adw.PreferencesGroup({
        title: _("Advanced Weather Companion"),
        description: _("A beautiful, modern weather companion for GNOME Shell")
      });

      const headerBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 20,
        margin_top: 20,
        margin_bottom: 20,
        halign: Gtk.Align.CENTER
      });

      const logoPath = `${this.dir.get_path()}/icons/weather-logo.png`;
      let logoImage;
      try {
        logoImage = Gtk.Image.new_from_file(logoPath);
        logoImage.set_pixel_size(72);
      } catch (e) {
        logoImage = new Gtk.Image({
          icon_name: "weather-clear-symbolic",
          pixel_size: 72
        });
      }

      const infoBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        valign: Gtk.Align.CENTER
      });

      const titleLabel = new Gtk.Label({
        label: _("Advanced Weather Companion"),
        halign: Gtk.Align.START,
        css_classes: ["title-2"]
      });

      const versionLabel = new Gtk.Label({
        label: _("Version 2.0"),
        halign: Gtk.Align.START,
        css_classes: ["caption"]
      });

      const descLabel = new Gtk.Label({
        label: _("Modern weather extension with native GNOME design"),
        halign: Gtk.Align.START,
        wrap: true,
        max_width_chars: 40,
        css_classes: ["body"]
      });

      infoBox.append(titleLabel);
      infoBox.append(versionLabel);
      infoBox.append(descLabel);
      headerBox.append(logoImage);
      headerBox.append(infoBox);

      const headerRow = new Adw.ActionRow({ title: "", activatable: false });
      headerRow.add_suffix(headerBox);

      const linksGroup = new Adw.PreferencesGroup({
        title: _("Extension Links"),
        description: _("Source code, issues, and contributions")
      });

      const githubRow = new Adw.ActionRow({
        title: _("View on GitHub"),
        subtitle: _("Source code, issues, and contributions"),
        activatable: true
      });

      const githubIcon = this._createGitHubIcon();
      githubRow.add_prefix(githubIcon);

      const externalIcon = new Gtk.Image({
        icon_name: "adw-external-link-symbolic",
        pixel_size: 16
      });
      githubRow.add_suffix(externalIcon);
      githubRow.connect("activated", () => {
        try {
          Gio.AppInfo.launch_default_for_uri("https://github.com/Sanjai-Shaarugesh/Advanced-Weather-Companion", null);
        } catch (error) {
          console.error("Could not open GitHub link:", error);
        }
      });

      const qrGroup = new Adw.PreferencesGroup({
        title: _("☕ Support by buying me a coffee — just scan the QR code!"),
        description: _("Preferred Method - Scan QR code to support development")
      });

      const qrContainer = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        halign: Gtk.Align.CENTER,
        margin_top: 24,
        margin_bottom: 24,
        margin_start: 24,
        margin_end: 24,
        css_classes: ["qr-container"]
      });

      const qrImageBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        halign: Gtk.Align.CENTER,
        css_classes: ["qr-image-container"]
      });

      const qrPath = `${this.dir.get_path()}/icons/qr.png`;
      let qrImage;
      try {
        qrImage = Gtk.Image.new_from_file(qrPath);
        qrImage.set_pixel_size(200);
        qrImage.set_css_classes(["qr-code-image"]);
      } catch (e) {
        qrImage = new Gtk.Image({
          icon_name: "camera-web-symbolic",
          pixel_size: 200
        });
        qrImage.set_css_classes(["qr-code-placeholder"]);
      }

      qrImageBox.append(qrImage);
      qrContainer.append(qrImageBox);

      const qrRow = new Adw.ActionRow({
        title: "",
        activatable: false
      });
      qrRow.set_child(qrContainer);


      const addressGroup = new Adw.PreferencesGroup({
        title: _("Donation Address"),
        css_classes: ["address-group"]
      });

      const addressRow = new Adw.ActionRow({
        title: "https://buymeacoffee.com/sanjai",
        activatable: true,
        css_classes: ["address-row"]
      });


      const donationIcon = new Gtk.Image({
        icon_name: "emote-love-symbolic",
        pixel_size: 16
      });
      addressRow.add_prefix(donationIcon);


      const copyIcon = new Gtk.Image({
        icon_name: "edit-copy-symbolic",
        pixel_size: 16,
        css_classes: ["copy-icon"]
      });
      addressRow.add_suffix(copyIcon);

      // Make the address copyable when clicked
      addressRow.connect("activated", () => {
        const address = "https://buymeacoffee.com/sanjai";
        this._copyToClipboard(address, "Donation address");
      });

      const sponsorRow = new Adw.ActionRow({
        title: _("☕ Buy Me a Coffee"),
        subtitle: _("Support development with a small donation"),
        activatable: true
      });
      const heartIcon = new Gtk.Image({
        icon_name: "emblem-favorite-symbolic",
        pixel_size: 20
      });
      sponsorRow.add_prefix(heartIcon);
      const sponsorIcon = new Gtk.Image({
        icon_name: "adw-external-link-symbolic",
        pixel_size: 16
      });
      sponsorRow.add_suffix(sponsorIcon);
      sponsorRow.connect("activated", () => {
        try {
          Gio.AppInfo.launch_default_for_uri("https://buymeacoffee.com/sanjai", null);
        } catch (error) {
          console.error("Could not open sponsor link:", error);
        }
      });

      const licenseGroup = new Adw.PreferencesGroup({
        title: _("License & Credits"),
        description: _("Open source software information")
      });

      const licenseRow = new Adw.ActionRow({
        title: _("Open Source License"),
        subtitle: _("MIT License - Free and open source software"),
        activatable: false
      });
      const licenseIcon = new Gtk.Image({
        icon_name: "security-high-symbolic",
        pixel_size: 16
      });
      licenseRow.add_prefix(licenseIcon);

      const creditsRow = new Adw.ActionRow({
        title: _("Weather Data Sources"),
        subtitle: _("Open-Meteo, Meteosource, Wttr.in - Free weather APIs"),
        activatable: false
      });
      const apiIcon = new Gtk.Image({
        icon_name: "network-server-symbolic",
        pixel_size: 16
      });
      creditsRow.add_prefix(apiIcon);

      // Add all rows to their respective groups
      infoGroup.add(headerRow);
      linksGroup.add(githubRow);
      linksGroup.add(sponsorRow);
      qrGroup.add(qrRow);
      addressGroup.add(addressRow);
      licenseGroup.add(licenseRow);
      licenseGroup.add(creditsRow);

      // Add all groups to the page
      page.add(infoGroup);
      page.add(linksGroup);
      page.add(qrGroup);
      page.add(addressGroup);
      page.add(licenseGroup);

      return page;
    }

  _createGitHubIcon() {
    try {
      const githubIconPath = `${this.dir.get_path()}/icons/github.svg`;
      const file = Gio.File.new_for_path(githubIconPath);

      if (file.query_exists(null)) {
        return new Gtk.Image({
          file: githubIconPath,
          pixel_size: 20
        });
      }
    } catch (error) {
      console.log("GitHub icon file not found, creating from SVG data");
    }

    try {
      const githubSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
</svg>`;

      const tempDir = GLib.get_tmp_dir();
      const tempPath = `${tempDir}/github-icon-${Date.now()}.svg`;
      const tempFile = Gio.File.new_for_path(tempPath);

      tempFile.replace_contents(githubSvg, null, false, Gio.FileCreateFlags.NONE, null);

      const githubIcon = new Gtk.Image({
        file: tempPath,
        pixel_size: 20
      });

      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        try {
          tempFile.delete(null);
        } catch (e) {

        }
        return GLib.SOURCE_REMOVE;
      });

      return githubIcon;
    } catch (error) {
      console.error("Failed to create GitHub icon:", error);
      return new Gtk.Image({
        icon_name: "software-properties-symbolic",
        pixel_size: 20
      });
    }
  }

  async _performLocationSearch() {
    const query = this._searchEntryRow.get_text().trim();

    this._clearSearchResults();

    if (!query || query.length < 2) {
      return;
    }

    if (this._searchInProgress) {
      return;
    }
    this._searchInProgress = true;

    this._searchButton.set_icon_name("content-loading-symbolic");
    this._searchButton.set_sensitive(false);

    try {
      const coordPattern = /^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/;
      const coordMatch = query.match(coordPattern);

      if (coordMatch) {
        const lat = parseFloat(coordMatch[1]);
        const lon = parseFloat(coordMatch[2]);

        if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
          await this._searchByCoordinates(lat, lon);
        } else {
          this._showSearchError(_("Invalid coordinates. Latitude must be between -90 and 90, longitude between -180 and 180."));
        }
      } else {
        await this._searchByName(query);
      }

    } catch (error) {
      console.error("Location search failed:", error);

      if (this._searchInProgress) {
        let errorMessage = _("Search failed. Please try again.");

        if (error.message.includes('HTTP')) {
          errorMessage = _("Unable to connect to location service. Check your internet connection.");
        } else if (error.message.includes('JSON')) {
          errorMessage = _("Invalid response from location service. Please try again.");
        } else if (error.message.includes('timeout')) {
          errorMessage = _("Search timed out. Please try again.");
        }

        this._showSearchError(errorMessage);
      }
    } finally {
      this._searchInProgress = false;
      this._searchButton.set_icon_name("edit-find-symbolic");
      this._searchButton.set_sensitive(true);
    }
  }

  async _searchByCoordinates(lat, lon) {
    const coordinateResult = {
      name: "Custom Location",
      latitude: lat,
      longitude: lon,
      country: "",
      admin1: ""
    };

    try {
      const reverseUrl = `${REVERSE_GEOCODING_URL}?latitude=${lat}&longitude=${lon}&localityLanguage=en`;

      const reverseMessage = Soup.Message.new("GET", reverseUrl);
      reverseMessage.request_headers.append('User-Agent', 'GNOME-Weather-Extension/1.0');

      const reverseBytes = await new Promise((resolve, reject) => {
        this._session.send_and_read_async(reverseMessage, GLib.PRIORITY_DEFAULT, null, (session, result) => {
          try {
            const bytes = session.send_and_read_finish(result);
            resolve(bytes);
          } catch (error) {
            reject(error);
          }
        });
      });

      if (reverseMessage.status_code === 200) {
        const reverseResponseText = new TextDecoder().decode(reverseBytes.get_data());
        const reverseResponse = JSON.parse(reverseResponseText);

        if (reverseResponse.locality || reverseResponse.city || reverseResponse.countryName) {
          const locationParts = [];

          if (reverseResponse.locality) locationParts.push(reverseResponse.locality);
          else if (reverseResponse.city) locationParts.push(reverseResponse.city);

          if (reverseResponse.principalSubdivision) locationParts.push(reverseResponse.principalSubdivision);
          if (reverseResponse.countryName) locationParts.push(reverseResponse.countryName);

          coordinateResult.name = locationParts.join(", ") || "Custom Location";
          coordinateResult.country = reverseResponse.countryName || "";
          coordinateResult.admin1 = reverseResponse.principalSubdivision || "";
        }
      }
    } catch (error) {

    }

    this._showCoordinateResults([coordinateResult]);
  }

  async _searchByName(query) {
    const url = `${GEOCODING_URL}?name=${encodeURIComponent(query)}&count=10&language=en&format=json`;

    const message = Soup.Message.new("GET", url);
    message.request_headers.append('User-Agent', 'GNOME-Weather-Extension/1.0');

    const bytes = await new Promise((resolve, reject) => {
      this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
        try {
          const bytes = session.send_and_read_finish(result);
          resolve(bytes);
        } catch (error) {
          reject(error);
        }
      });
    });

    if (message.status_code !== 200) {
      throw new Error(`HTTP ${message.status_code}: ${message.reason_phrase}`);
    }

    const responseText = new TextDecoder().decode(bytes.get_data());
    const response = JSON.parse(responseText);

    if (response.results && response.results.length > 0) {
      this._showSearchResults(response.results);
    } else {
      this._showNoResults();
    }
  }

  _showCoordinateResults(results) {
    this._clearSearchResults();
    this._searchResultsGroup.set_visible(true);

    results.forEach((result) => {
      const locationName = result.name;
      const coordinates = `${result.latitude.toFixed(4)}, ${result.longitude.toFixed(4)}`;

      const resultRow = new Adw.ActionRow({
        title: `🎯 ${locationName}`,
        subtitle: `Coordinates: ${coordinates}`,
        activatable: true
      });

      const locationIcon = new Gtk.Image({
        icon_name: "view-pin-symbolic",
        pixel_size: 16
      });
      resultRow.add_prefix(locationIcon);

      const selectButton = new Gtk.Button({
        icon_name: "object-select-symbolic",
        valign: Gtk.Align.CENTER,
        tooltip_text: _("Select this location"),
        css_classes: ["suggested-action"]
      });

      selectButton.connect("clicked", () => this._selectLocation(result, locationName));
      resultRow.connect("activated", () => this._selectLocation(result, locationName));
      resultRow.add_suffix(selectButton);

      this._searchResultsGroup.add(resultRow);
    });
  }

  _showSearchResults(results) {
    this._clearSearchResults();
    this._searchResultsGroup.set_visible(true);

    results.forEach((result, index) => {
      const locationName = result.admin1
        ? `${result.name}, ${result.admin1}, ${result.country}`
        : `${result.name}, ${result.country}`;

      const coordinates = `${result.latitude.toFixed(4)}, ${result.longitude.toFixed(4)}`;

      const resultRow = new Adw.ActionRow({
        title: `📍 ${locationName}`,
        subtitle: `${coordinates}`,
        activatable: true
      });

      const locationIcon = new Gtk.Image({
        icon_name: "find-location-symbolic",
        pixel_size: 16
      });
      resultRow.add_prefix(locationIcon);

      const selectButton = new Gtk.Button({
        icon_name: "object-select-symbolic",
        valign: Gtk.Align.CENTER,
        tooltip_text: _("Select this location"),
        css_classes: ["suggested-action"]
      });

      selectButton.connect("clicked", () => this._selectLocation(result, locationName));
      resultRow.connect("activated", () => this._selectLocation(result, locationName));
      resultRow.add_suffix(selectButton);

      this._searchResultsGroup.add(resultRow);
    });
  }

  _selectLocation(result, locationName) {
    try {
      this._settings.set_string("location", `${result.latitude},${result.longitude}`);
      this._settings.set_string("location-name", locationName);
      this._updateCurrentLocationDisplay();
      this._searchEntryRow.set_text("");
      this._clearSearchResults();
      this._showToast(_("Location updated successfully"));
    } catch (error) {
      console.error("Failed to save location:", error);
      this._showSearchError(_("Failed to save location. Please try again."));
    }
  }

  _showNoResults() {
    this._clearSearchResults();
    const noResultsRow = new Adw.ActionRow({
      title: _("No Results Found"),
      subtitle: _("Try a different search term or check your spelling"),
      sensitive: false
    });
    const warningIcon = new Gtk.Image({
      icon_name: "dialog-warning-symbolic",
      pixel_size: 16
    });
    noResultsRow.add_prefix(warningIcon);
    this._searchResultsGroup.add(noResultsRow);
    this._searchResultsGroup.set_visible(true);
  }

  _clearSearchResults() {
    if (!this._searchResultsGroup) {
      return;
    }

    if (this._searchInProgress) {
      return;
    }

    let child = this._searchResultsGroup.get_first_child();
    while (child) {
      const next = child.get_next_sibling();
      this._searchResultsGroup.remove(child);
      child = next;
    }

    this._searchResultsGroup.set_visible(false);
  }

  _showSearchError(message) {
    this._clearSearchResults();
    const errorRow = new Adw.ActionRow({
      title: _("Search Error"),
      subtitle: message,
      sensitive: false
    });
    const errorIcon = new Gtk.Image({
      icon_name: "dialog-error-symbolic",
      pixel_size: 16
    });
    errorRow.add_prefix(errorIcon);
    this._searchResultsGroup.add(errorRow);
    this._searchResultsGroup.set_visible(true);
  }

  _updateLocationSensitivity(mode) {
    const isManual = mode === "manual";
    this._searchGroup.set_sensitive(isManual);
    if (!isManual) this._clearSearchResults();
  }

  _updateCurrentLocationDisplay() {
    const mode = this._settings.get_string("location-mode") || "auto";
    const locationName = this._settings.get_string("location-name") || "";
    const location = this._settings.get_string("location") || "";

    let subtitle;
    if (mode === "auto") {
      subtitle = _("🌍 Auto Detection Enabled");
    } else {
      if (locationName && location) {
        subtitle = `📍 ${locationName}`;
      } else {
        subtitle = _("📍 Manual - Please set location");
      }
    }

    this._currentLocationRow.set_subtitle(subtitle);
  }

  _getLocationSubtitle(settings) {
    const mode = settings.get_string("location-mode") || "auto";
    const locationName = settings.get_string("location-name") || "";
    const location = settings.get_string("location") || "";

    if (mode === "auto") {
      return _("🌍 Auto Detection Enabled");
    } else {
      if (locationName && location) {
        return `📍 ${locationName}`;
      } else {
        return _("📍 Manual - Please set location");
      }
    }
  }

  _showToast(message) {

    let widget = this._searchResultsGroup || this._providerDetailsGroup;
    while (widget && !widget.add_toast) {
      widget = widget.get_parent();
    }

    if (widget && widget.add_toast) {
      const toast = new Adw.Toast({
        title: message,
        timeout: 3
      });
      widget.add_toast(toast);
    } else {
      console.log(message);
    }
  }
}