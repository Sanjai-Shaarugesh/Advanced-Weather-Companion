import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import GObject from "gi://GObject";
import GLib from "gi://GLib";
import Soup from "gi://Soup";
import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";

export default class WeatherPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings("org.gnome.shell.extensions.advanced-weather");
    this._session = new Soup.Session();

    // Enhanced session settings for better API compatibility
    this._session.timeout = 15;
    this._session.max_conns = 10;
    this._session.max_conns_per_host = 5;

    window.set_title(_("Advanced Weather Extension"));
    window.set_default_size(700, 650);
    window.set_resizable(true);

    window.add(this._createGeneralPage(settings));
    window.add(this._createLocationPage(settings));
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

    const timeFormatRow = new Adw.SwitchRow({
      title: _("Use 12-hour Format"),
      subtitle: _("Display time in 12-hour format with AM/PM")
    });
    timeFormatRow.set_active(settings.get_boolean("use-12hour-format"));
    timeFormatRow.connect("notify::active", () => {
      settings.set_boolean("use-12hour-format", timeFormatRow.get_active());
    });

    unitsGroup.add(tempUnitRow);
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

    // Enhanced current location display with better formatting
    const currentLocationRow = new Adw.ActionRow({
      title: _("Current Location"),
      subtitle: this._getLocationSubtitle(settings),
      activatable: false
    });

    const gpsIcon = new Gtk.Image({
      icon_name: currentMode === "auto" ? "find-location-symbolic" : "mark-location-symbolic",
      pixel_size: 16
    });
    currentLocationRow.add_prefix(gpsIcon);

    // Add a refresh button for current location
    const refreshButton = new Gtk.Button({
      icon_name: "view-refresh-symbolic",
      valign: Gtk.Align.CENTER,
      tooltip_text: _("Refresh location"),
      css_classes: ["flat"]
    });
    refreshButton.connect("clicked", () => {
      this._updateCurrentLocationDisplay();
      // Don't show toast for location refresh as it's just updating display
      console.log("Location display refreshed");
    });
    currentLocationRow.add_suffix(refreshButton);

    locationGroup.add(locationModeRow);
    locationGroup.add(currentLocationRow);

    const searchGroup = new Adw.PreferencesGroup({
      title: _("Manual Location Search"),
      description: _("Search and select your location manually"),
      sensitive: currentMode === "manual"
    });

    const searchEntryRow = new Adw.EntryRow({
      title: _("Search Location"),
      text: "",
      show_apply_button: true
    });
    searchEntryRow.set_input_hints(Gtk.InputHints.LOWERCASE);

    const searchButton = new Gtk.Button({
      icon_name: "system-search-symbolic",
      valign: Gtk.Align.CENTER,
      tooltip_text: _("Search for location"),
      css_classes: ["suggested-action"]
    });

    const clearButton = new Gtk.Button({
      icon_name: "edit-clear-symbolic",
      valign: Gtk.Align.CENTER,
      tooltip_text: _("Clear search")
    });

    searchEntryRow.add_suffix(searchButton);
    searchEntryRow.add_suffix(clearButton);

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
      // Update icon based on mode
      this._gpsIcon.set_from_icon_name(mode === "auto" ? "find-location-symbolic" : "mark-location-symbolic");
    });

    searchButton.connect("clicked", () => {
      // Clear any existing results before starting new search
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

    // Add real-time search validation
    searchEntryRow.connect("notify::text", () => {
      const query = searchEntryRow.get_text().trim();
      searchButton.set_sensitive(query.length >= 2);
    });

    searchGroup.add(searchEntryRow);
    page.add(locationGroup);
    page.add(searchGroup);
    page.add(this._searchResultsGroup);

    return page;
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
      title: _("Advanced Weather Extension"),
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
      // Fallback if logo doesn't exist
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
      label: _("Advanced Weather"),
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

    const qrGroup = new Adw.PreferencesGroup({
      title: _("Extension Links"),
      description: _("Scan QR code or click links to access extension resources")
    });

    const githubRow = new Adw.ActionRow({
      title: _("View on GitHub"),
      subtitle: _("Source code, issues, and contributions"),
      activatable: true
    });
    const githubIcon = new Gtk.Image({
      icon_name: "computer-symbolic",
      pixel_size: 20
    });
    githubRow.add_prefix(githubIcon);
    const externalIcon = new Gtk.Image({
      icon_name: "adw-external-link-symbolic",
      pixel_size: 16
    });
    githubRow.add_suffix(externalIcon);
    githubRow.connect("activated", () => {
      try {
        Gio.AppInfo.launch_default_for_uri("https://github.com/yourusername/advanced-weather-extension", null);
      } catch (error) {
        console.error("Could not open GitHub link:", error);
      }
    });

    const sponsorRow = new Adw.ActionRow({
      title: _("Support Development"),
      subtitle: _("Help keep this extension free and updated"),
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
        Gio.AppInfo.launch_default_for_uri("https://github.com/sponsors/yourusername", null);
      } catch (error) {
        console.error("Could not open sponsor link:", error);
      }
    });

    // Enhanced QR Code - Medium size, centered, rounded corners
    const qrBox = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 12,
      halign: Gtk.Align.CENTER,
      margin_top: 20,
      margin_bottom: 20
    });

    const qrPath = `${this.dir.get_path()}/icons/qr.png`;
    let qrImage;
    try {
      qrImage = Gtk.Image.new_from_file(qrPath);
      qrImage.set_pixel_size(180); // Medium size
      qrImage.set_css_classes(["qr-code-image"]); // For rounded corners
    } catch (e) {
      // Create a placeholder if QR doesn't exist
      qrImage = new Gtk.Image({
        icon_name: "camera-web-symbolic",
        pixel_size: 180
      });
      qrImage.set_css_classes(["qr-code-image"]);
    }

    const qrLabel = new Gtk.Label({
      label: _("Scan to visit GitHub repository"),
      css_classes: ["caption"],
      halign: Gtk.Align.CENTER
    });

    qrBox.append(qrImage);
    qrBox.append(qrLabel);

    const qrRow = new Adw.ActionRow({
      title: _("QR Code"),
      subtitle: _("Quick access to extension repository"),
      activatable: false
    });
    qrRow.add_suffix(qrBox);

    const licenseGroup = new Adw.PreferencesGroup({
      title: _("License & Credits"),
      description: _("Open source software information")
    });

    const licenseRow = new Adw.ActionRow({
      title: _("Open Source License"),
      subtitle: _("GPL-3.0 - Free and open source software"),
      activatable: false
    });
    const licenseIcon = new Gtk.Image({
      icon_name: "security-high-symbolic",
      pixel_size: 16
    });
    licenseRow.add_prefix(licenseIcon);

    const creditsRow = new Adw.ActionRow({
      title: _("Weather Data by Open-Meteo"),
      subtitle: _("Free weather API for non-commercial use"),
      activatable: false
    });
    const apiIcon = new Gtk.Image({
      icon_name: "network-server-symbolic",
      pixel_size: 16
    });
    creditsRow.add_prefix(apiIcon);

    infoGroup.add(headerRow);
    qrGroup.add(githubRow);
    qrGroup.add(sponsorRow);
    qrGroup.add(qrRow);
    licenseGroup.add(licenseRow);
    licenseGroup.add(creditsRow);

    page.add(infoGroup);
    page.add(qrGroup);
    page.add(licenseGroup);

    return page;
  }

  async _performLocationSearch() {
    const query = this._searchEntryRow.get_text().trim();

    // Clear previous results first
    this._clearSearchResults();

    // Don't show error for empty search, just return silently
    if (!query || query.length < 2) {
      return;
    }

    // Prevent multiple concurrent searches
    if (this._searchInProgress) {
      return;
    }
    this._searchInProgress = true;

    this._searchButton.set_icon_name("content-loading-symbolic");
    this._searchButton.set_sensitive(false);

    try {
      const encodedQuery = encodeURIComponent(query);
      const url = `${GEOCODING_URL}?name=${encodedQuery}&count=10&language=en&format=json`;

      console.log(`Searching for location: ${query}`);
      console.log(`API URL: ${url}`);

      const message = Soup.Message.new("GET", url);

      // Set proper headers for better compatibility
      message.request_headers.replace('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0');
      message.request_headers.replace('Accept', 'application/json, text/plain, */*');
      message.request_headers.replace('Accept-Language', 'en-US,en;q=0.5');
      message.request_headers.replace('Accept-Encoding', 'gzip, deflate, br');
      message.request_headers.replace('Connection', 'keep-alive');
      message.request_headers.replace('Upgrade-Insecure-Requests', '1');

      // Use the simpler send_and_read_async method
      const cancellable = new Gio.Cancellable();
      const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
        console.log("Search request timeout");
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
      });

      const bytes = await this._session.send_and_read_async(
        message,
        GLib.PRIORITY_DEFAULT,
        cancellable
      );

      GLib.source_remove(timeoutId);

      console.log(`Response status: ${message.status_code}`);

      if (message.status_code !== 200) {
        throw new Error(`HTTP ${message.status_code}: ${message.reason_phrase || 'Request failed'}`);
      }

      const responseText = new TextDecoder().decode(bytes.get_data());
      console.log(`Response received, length: ${responseText.length}`);

      if (!responseText.trim()) {
        throw new Error("Empty response from server");
      }

      let response;
      try {
        response = JSON.parse(responseText);
      } catch (parseError) {
        console.error("JSON Parse Error:", parseError);
        throw new Error("Invalid response format");
      }

      console.log('Parsed response:', response);

      if (response.results && response.results.length > 0) {
        console.log(`Found ${response.results.length} results`);
        this._showSearchResults(response.results);
      } else {
        console.log("No results found");
        this._showNoResults();
      }

    } catch (error) {
      console.error("Location search failed:", error);

      // Only show error if it's not a cancellation and search is still in progress
      if (!error.message.includes('cancelled') && this._searchInProgress) {
        let errorMessage;
        if (error.message.includes('timeout')) {
          errorMessage = _("Search timed out. Please try again.");
        } else if (error.message.includes('network') || error.message.includes('resolve')) {
          errorMessage = _("Network error. Check your internet connection.");
        } else if (error.message.includes('HTTP 4')) {
          errorMessage = _("Search service unavailable. Try again later.");
        } else if (error.message.includes('HTTP 5')) {
          errorMessage = _("Server error. Please try again.");
        } else {
          errorMessage = _("Search failed. Please try again.");
        }

        this._showSearchError(errorMessage);
      }
    } finally {
      this._searchInProgress = false;
      this._searchButton.set_icon_name("system-search-symbolic");
      this._searchButton.set_sensitive(true);
    }
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
        title: locationName,
        subtitle: `📍 ${coordinates}`,
        activatable: true
      });

      const locationIcon = new Gtk.Image({
        icon_name: "mark-location-symbolic",
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
      this._showSuccessToast(_("Location updated successfully"));

      console.log(`Selected location: ${locationName} (${result.latitude}, ${result.longitude})`);
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

  _clearSearchResults() {
    // Prevent clearing during search to avoid UI flicker
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

  _showSuccessToast(message) {
    let widget = this._searchResultsGroup;
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
      console.log(`Success: ${message}`);
    }
  }
}