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
      "org.gnome.shell.extensions.advanced-weather"
    );

    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({ 
      title: _("Weather Settings"),
      description: _("Configure location settings and temperature units")
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
    group.add(locationModeRow);

    
    const locationRow = new Adw.ActionRow({
      title: _("Manual Location"),
      subtitle: _("Enter coordinates as 'latitude,longitude' (e.g., 40.7128,-74.0060)"),
      sensitive: currentMode === "manual"
    });

    const locationBox = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 8
    });

    const locationEntry = new Gtk.Entry({
      text: settings.get_string("location") || "",
      placeholder_text: _("40.7128,-74.0060"),
      width_request: 200,
      max_length: 50,
      secondary_icon_name: "edit-clear-symbolic",
      secondary_icon_tooltip_text: _("Clear")
    });

    const validationLabel = new Gtk.Label({
      css_classes: ["caption", "error"],
      visible: false
    });

    locationBox.append(locationEntry);
    locationBox.append(validationLabel);
    locationRow.add_suffix(locationBox);
    group.add(locationRow);

    
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

    
    const unitRow = new Adw.ActionRow({
      title: _("Temperature Unit"),
      subtitle: _("Toggle between Celsius (°C) and Fahrenheit (°F)")
    });
    
    const unitSwitch = new Gtk.Switch({
      active: settings.get_boolean("use-fahrenheit") || false,
      valign: Gtk.Align.CENTER
    });
    
    unitRow.add_suffix(unitSwitch);
    group.add(unitRow);

    unitSwitch.connect("state-set", (widget, state) => {
      settings.set_boolean("use-fahrenheit", state);
      return false;
    });

    page.add(group);
    window.add(page);
  }
}
