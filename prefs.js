import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import GObject from "gi://GObject";
import GLib from "gi://GLib";
import Soup from "gi://Soup";
import GdkPixbuf from "gi://GdkPixbuf";

import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const REVERSE_GEOCODING_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client";

export default class WeatherPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings("org.gnome.shell.extensions.advanced-weather");
    this._session = new Soup.Session();

    // Use same session settings as extension.js
    this._session.timeout = 15;

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
      icon_name: currentMode === "auto" ? "location-services-active-symbolic" : "location-services-disabled-symbolic",
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
    // Allow all input types for coordinates
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

    // Add help text for coordinate format
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
      // Update icon based on mode
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

    // Enhanced search validation
    searchEntryRow.connect("notify::text", () => {
      const query = searchEntryRow.get_text().trim();
      const coordPattern = /^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/;
      const isCoordinates = coordPattern.test(query);

      // Enable search for valid coordinates or text queries >= 2 chars
      searchButton.set_sensitive(isCoordinates || query.length >= 2);
    });

    searchGroup.add(searchEntryRow);
    searchGroup.add(helpRow);
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
      icon_name: "location-services-active-symbolic",
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

    const linksGroup = new Adw.PreferencesGroup({
      title: _("Extension Links"),
      description: _("Source code, issues, and contributions")
    });

    // GitHub Row - Fixed and restored
    const githubRow = new Adw.ActionRow({
      title: _("View on GitHub"),
      subtitle: _("Source code, issues, and contributions"),
      activatable: true
    });

    // Create custom GitHub icon
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

    // Enhanced QR Code Support Section
    const qrGroup = new Adw.PreferencesGroup({
      title: _("☕ Support by buying me a coffee — just scan the QR code!"),
      description: _("Preferred Method - Scan QR code to support development")
    });

    // Create a dark container for the QR code
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

    // QR Code with enhanced styling
    const qrImageBox = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      halign: Gtk.Align.CENTER,
      css_classes: ["qr-image-container"]
    });

    const qrPath = `${this.dir.get_path()}/icons/qr.png`;
    let qrImage;
    try {
      qrImage = Gtk.Image.new_from_file(qrPath);
      qrImage.set_pixel_size(200); // Larger size for better visibility
      qrImage.set_css_classes(["qr-code-image"]);
    } catch (e) {
      // Create a placeholder if QR doesn't exist
      qrImage = new Gtk.Image({
        icon_name: "camera-web-symbolic",
        pixel_size: 200
      });
      qrImage.set_css_classes(["qr-code-placeholder"]);
    }

    qrImageBox.append(qrImage);

    // Address label with monospace font
    const addressLabel = new Gtk.Label({
      label: "https://buymeacoffee.com/sanjai", // Replace with your actual Dogecoin address
      css_classes: ["qr-address"],
      halign: Gtk.Align.CENTER,
      selectable: true,
      wrap: true,
      max_width_chars: 40
    });

    // Copy button for the address
    const copyButton = new Gtk.Button({
      label: _("Copy Address"),
      halign: Gtk.Align.CENTER,
      css_classes: ["qr-copy-button"]
    });

    copyButton.connect("clicked", () => {
      const clipboard = Gdk.Display.get_default().get_clipboard();
      clipboard.set_text("https://buymeacoffee.com/sanjai"); // Replace with your actual address
      this._showSuccessToast(_("Address copied to clipboard"));
    });

    // Assemble the QR container
    qrContainer.append(qrImageBox);
    qrContainer.append(addressLabel);
    qrContainer.append(copyButton);

    // Create a row to hold the QR container
    const qrRow = new Adw.ActionRow({
      title: "",
      activatable: false
    });
    qrRow.set_child(qrContainer);

    // Alternative sponsor row (buy me a coffee)
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
      title: _("Weather Data by Open-Meteo"),
      subtitle: _("Free weather API for non-commercial use"),
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

    licenseGroup.add(licenseRow);
    licenseGroup.add(creditsRow);

    // Add all groups to the page
    page.add(infoGroup);
    page.add(linksGroup);
    page.add(qrGroup);
    page.add(licenseGroup);

    return page;
  }

  // Create custom GitHub icon from SVG
  _createGitHubIcon() {
    try {
      // First try to load from file
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

    // If file doesn't exist, create from SVG data
    try {
      const githubSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
</svg>`;

      // Create a temporary file for the SVG
      const tempDir = GLib.get_tmp_dir();
      const tempPath = `${tempDir}/github-icon-${Date.now()}.svg`;
      const tempFile = Gio.File.new_for_path(tempPath);

      tempFile.replace_contents(githubSvg, null, false, Gio.FileCreateFlags.NONE, null);

      const githubIcon = new Gtk.Image({
        file: tempPath,
        pixel_size: 20
      });

      // Clean up temp file after a short delay
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        try {
          tempFile.delete(null);
        } catch (e) {
          // Ignore cleanup errors
        }
        return GLib.SOURCE_REMOVE;
      });

      return githubIcon;
    } catch (error) {
      console.error("Failed to create GitHub icon:", error);
      // Fallback to generic icon
      return new Gtk.Image({
        icon_name: "software-properties-symbolic",
        pixel_size: 20
      });
    }
  }

  // Enhanced location search with coordinate support
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
      // Check if query looks like coordinates (lat,lon or lat lon)
      const coordPattern = /^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/;
      const coordMatch = query.match(coordPattern);

      if (coordMatch) {
        // Handle coordinate search
        const lat = parseFloat(coordMatch[1]);
        const lon = parseFloat(coordMatch[2]);

        // Validate coordinate ranges
        if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {

          await this._searchByCoordinates(lat, lon);
        } else {
          this._showSearchError(_("Invalid coordinates. Latitude must be between -90 and 90, longitude between -180 and 180."));
        }
      } else {
        // Handle regular location name search

        await this._searchByName(query);
      }

    } catch (error) {
      console.error("Location search failed:", error);

      // Only show error if search is still in progress
      if (this._searchInProgress) {
        // Provide more specific error messages
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

  // Search by coordinates with reverse geocoding
  async _searchByCoordinates(lat, lon) {
    // Create a result with the coordinates
    const coordinateResult = {
      name: "Custom Location",
      latitude: lat,
      longitude: lon,
      country: "",
      admin1: ""
    };

    try {
      // Try reverse geocoding to get a readable location name
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

  // Search by location name
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

  // Show coordinate search results
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

  // Show regular search results
  _showSearchResults(results) {
    this._clearSearchResults();
    this._searchResultsGroup.set_visible(true);

    results.forEach((result, index) => {
      // Use the same format as extension.js
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
        icon_name: "location-services-active-symbolic",
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
    // Don't clear if we don't have the results group
    if (!this._searchResultsGroup) {
      return;
    }

    // Prevent clearing during search to avoid UI flicker
    if (this._searchInProgress) {
      return;
    }

    // Remove all child rows
    let child = this._searchResultsGroup.get_first_child();
    while (child) {
      const next = child.get_next_sibling();
      this._searchResultsGroup.remove(child);
      child = next;
    }

    // Hide the results group
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

    }
  }
}