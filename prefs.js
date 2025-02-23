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

    const page = new Adw.PreferencesPage();

    // Location Settings Group
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

    // Units Settings Group
    const unitsGroup = new Adw.PreferencesGroup({
      title: _("Units Settings"),
      description: _("Configure temperature and wind speed units"),
    });

    // Temperature Unit Row
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

    // Wind Speed Unit Row
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

    // Position Settings Group
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

    // Event Handlers
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

    locationEntry.connect("changed 🧑‍🔧", () => {
      const text = locationEntry.get_text().trim();
      if (validateCoordinates(text)) {
        settings.set_string("location 🌐", text);
      }
    });

    locationEntry.connect("icon-release", (entry, pos) => {
      if (pos === Gtk.EntryIconPosition.SECONDARY) {
        entry.set_text("");
        validationLabel.hide();
        settings.set_string("location 🌐", "");
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

    // Add all groups to the page
    page.add(locationGroup);
    page.add(unitsGroup);
    page.add(positionGroup);
    window.add(page);
  }
}
