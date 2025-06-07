import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import GObject from "gi://GObject";
import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

export default class WeatherPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings(
      "org.gnome.shell.extensions.advanced-weather",
    );
    
    // Create header with logo
    const headerBox = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      margin_top: 24,
      margin_bottom: 24,
      halign: Gtk.Align.CENTER,
    });
    
    // Create image using Gtk.Picture (for GTK4)
    const logo = new Gtk.Picture({
      file: Gio.File.new_for_path(`${this.path}/icons/weather-logo.png`),
      content_fit: Gtk.ContentFit.CONTAIN,
      height_request: 100,
    });
    
    const title = new Gtk.Label({
      label: '<span size="large" weight="bold">Advanced Weather</span>',
      use_markup: true,
      margin_top: 12,
    });
    
    headerBox.append(logo);
    headerBox.append(title);
    
    // Main content container to hold both header and preferences
    const mainBox = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
    });
    
    // Add the header to the main container
    mainBox.append(headerBox);
    
    // Create the preferences page
    const page = new Adw.PreferencesPage();

    const locationGroup = new Adw.PreferencesGroup({
      title: _("Location Settings"),
      description: _("Configure location settings and units"),
    });

    const locationModeRow = new Adw.ActionRow({
      title: _("Location Mode"),
      subtitle: _("Choose how location is determined"),
    });
    const locationModeCombo = new Gtk.ComboBoxText();
    locationModeCombo.append("auto", _("Auto Detect"));
    locationModeCombo.append("manual", _("Manual Setup"));

    const currentMode = settings.get_string("location-mode") || "auto";
    locationModeCombo.set_active_id(currentMode);

    locationModeRow.add_suffix(locationModeCombo);
    locationGroup.add(locationModeRow);

    const locationRow = new Adw.ActionRow({
      title: _("Manual Location"),
      subtitle: _(
        "Enter coordinates as 'latitude,longitude' (e.g., 40.7128,-74.0060)",
      ),
      sensitive: currentMode === "manual",
    });

    const locationBox = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 8,
    });

    const locationEntry = new Gtk.Entry({
      text: settings.get_string("location") || "",
      placeholder_text: _("40.7128,-74.0060"),
      width_request: 200,
      max_length: 50,
      secondary_icon_name: "weather-few-clouds-symbolic",
      secondary_icon_tooltip_text: _("Clear"),
    });

    const validationLabel = new Gtk.Label({
      css_classes: ["caption", "error"],
      visible: false,
    });

    locationBox.append(locationEntry);
    locationBox.append(validationLabel);
    locationRow.add_suffix(locationBox);
    locationGroup.add(locationRow);

    const unitsGroup = new Adw.PreferencesGroup({
      title: _("Units Settings"),
      description: _("Configure temperature and wind speed units"),
    });

    const tempUnitRow = new Adw.ActionRow({
      title: _("Temperature Unit"),
      subtitle: _("Toggle between Celsius (°C) and Fahrenheit (°F)"),
    });

    const tempUnitSwitch = new Gtk.Switch({
      active: settings.get_boolean("use-fahrenheit") || false,
      valign: Gtk.Align.CENTER,
    });

    tempUnitRow.add_suffix(tempUnitSwitch);
    unitsGroup.add(tempUnitRow);

    const windUnitRow = new Adw.ActionRow({
      title: _("Wind Speed Unit"),
      subtitle: _("Choose your preferred wind speed unit"),
    });

    const windUnitCombo = new Gtk.ComboBoxText();
    windUnitCombo.append("kmh", _("Kilometers per hour (km/h)"));
    windUnitCombo.append("mph", _("Miles per hour (mph)"));
    windUnitCombo.append("ms", _("Meters per second (m/s)"));
    windUnitCombo.append("knots", _("Knots (kts)"));

    const currentWindUnit = settings.get_string("wind-speed-unit") || "kmh";
    windUnitCombo.set_active_id(currentWindUnit);

    windUnitRow.add_suffix(windUnitCombo);
    unitsGroup.add(windUnitRow);

    const positionGroup = new Adw.PreferencesGroup({
      title: _("Panel Position"),
      description: _("Configure where the weather indicator appears"),
    });

    const positionRow = new Adw.ActionRow({
      title: _("Panel Position"),
      subtitle: _("Choose where to show the weather indicator"),
    });

    const positionCombo = new Gtk.ComboBoxText();
    positionCombo.append("right", _("Right"));
    positionCombo.append("center", _("Center"));
    positionCombo.append("left", _("Left"));

    const currentPosition = settings.get_string("panel-position") || "right";
    positionCombo.set_active_id(currentPosition);

    positionCombo.connect("changed", (widget) => {
      const newPosition = widget.get_active_id();
      settings.set_string("panel-position", newPosition);
      if (global.weatherExtensionInstance) {
        global.weatherExtensionInstance._updatePanelPosition();
      }
    });

    positionRow.add_suffix(positionCombo);
    positionGroup.add(positionRow);
    page.add(positionGroup);
    window.add(page);

    const validateCoordinates = (text) => {
      if (!text) {
        validationLabel.set_text(_("Coordinates required"));
        validationLabel.show();
        return false;
      }

      const coordMatch = text.match(/^([-+]?\d+\.?\d*),\s*([-+]?\d+\.?\d*)$/);
      if (!coordMatch) {
        validationLabel.set_text(_("Invalid format"));
        validationLabel.show();
        return false;
      }

      const lat = parseFloat(coordMatch[1]);
      const lon = parseFloat(coordMatch[2]);

      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        validationLabel.set_text(_("Coordinates out of range"));
        validationLabel.show();
        return false;
      }

      validationLabel.hide();
      return true;
    };

    locationModeCombo.connect("changed", (widget) => {
      const newMode = widget.get_active_id();
      settings.set_string("location-mode", newMode);
      locationRow.set_sensitive(newMode === "manual");

      if (newMode === "auto") {
        locationEntry.set_text("");
        validationLabel.hide();
      }
    });

    locationEntry.connect("changed", () => {
        const text = locationEntry.get_text().trim();
        if (validateCoordinates(text)) {
            settings.set_string("location", text);
        }
    });

    locationEntry.connect("icon-release", (entry, pos) => {
      if (pos === Gtk.EntryIconPosition.SECONDARY) {
        entry.set_text("");
        validationLabel.hide();
        settings.set_string("location", "");
      }
    });

    tempUnitSwitch.connect("state-set", (widget, state) => {
      settings.set_boolean("use-fahrenheit", state);
      return false;
    });

    windUnitCombo.connect("changed", (widget) => {
      settings.set_string("wind-speed-unit", widget.get_active_id());
    });

    positionCombo.connect("changed", (widget) => {
      settings.set_string("panel-position", widget.get_active_id());
    });

    const styleGroup = new Adw.PreferencesGroup({
      title: _("Style Settings"),
      description: _("Configure the appearance of the weather indicator"),
    });

    const backgroundRow = new Adw.ActionRow({
      title: _("Fill Background"),
      subtitle: _("Choose whether fill the background in the panel or not"),
    });

    const backgroundSwitch = new Gtk.Switch({
        active: settings.get_boolean("fill-button-background") || true,
        valign: Gtk.Align.CENTER,
    });

    backgroundSwitch.connect("state-set", (widget, state) => {
        settings.set_boolean("fill-button-background", state);
    });
    backgroundRow.add_suffix(backgroundSwitch);
    styleGroup.add(backgroundRow);

    // Add Show Location Label option
    const locationLabelRow = new Adw.ActionRow({
      title: _("Show Location Mode Label"),
      subtitle: _("Show or hide the AUTO/MANUAL indicator in the panel"),
    });

    const locationLabelSwitch = new Gtk.Switch({
      active: settings.get_boolean("show-location-label") || false,
      valign: Gtk.Align.CENTER,
    });

    locationLabelSwitch.connect("state-set", (widget, state) => {
      settings.set_boolean("show-location-label", state);
      return false;
    });

    locationLabelRow.add_suffix(locationLabelSwitch);
    styleGroup.add(locationLabelRow);

    page.add(locationGroup);
    page.add(unitsGroup);
    page.add(positionGroup);
    page.add(styleGroup);
    window.add(page);

    // Add Weather Display Preview group
    const previewGroup = new Adw.PreferencesGroup({
      title: _("Weather Display Preview"),
      description: _("Sample appearance in different conditions"),
    });

    const previewBox = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 24,
      margin_top: 12,
      margin_bottom: 12,
      homogeneous: true,
      halign: Gtk.Align.CENTER,
    });

    // Create weather preview samples
    const weatherTypes = [
      { icon: "weather-clear-symbolic", label: "Clear" },
      { icon: "weather-showers-symbolic", label: "Rain" },
      { icon: "weather-snow-symbolic", label: "Snow" },
      { icon: "weather-storm-symbolic", label: "Storm" }
    ];

    weatherTypes.forEach(type => {
      const sampleBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        halign: Gtk.Align.CENTER,
      });
      
      const icon = new Gtk.Image({
        icon_name: type.icon,
        pixel_size: 48,
      });
      
      const label = new Gtk.Label({
        label: type.label,
      });
      
      sampleBox.append(icon);
      sampleBox.append(label);
      previewBox.append(sampleBox);
    });

    previewGroup.add(previewBox);
    page.add(previewGroup);
    window.add(page);

    // Add the page to the main container (ONCE, at the end)
    mainBox.append(page);
    
    // Set the main container as the window content
    window.set_content(mainBox);
  }
}