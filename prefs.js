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

    const headerGroup = new Adw.PreferencesGroup();

    
    const headerBox = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      margin_top: 8,
      margin_bottom: 12,
      halign: Gtk.Align.FILL,
      hexpand: true,
      spacing: 8,
    });

    
    const logoTitleBox = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      halign: Gtk.Align.START,
      spacing: 8,
    });

    
    const logo = new Gtk.Picture({
      file: Gio.File.new_for_path(`${this.path}/icons/weather-logo.png`),
      content_fit: Gtk.ContentFit.CONTAIN,
      height_request: 32,
      width_request: 32,
    });

    const title = new Gtk.Label({
      label: '<span weight="bold">Advanced Weather Companion</span>',
      use_markup: true,
    });

    logoTitleBox.append(logo);
    logoTitleBox.append(title);

    
    const windowControlsBox = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      halign: Gtk.Align.END,
      hexpand: true,
      spacing: 4,
    });

    
    const minimizeButton = new Gtk.Button({
      icon_name: "window-minimize-symbolic",
      has_frame: false,
      valign: Gtk.Align.CENTER,
    });

    
    const closeButton = new Gtk.Button({
      icon_name: "window-close-symbolic",
      has_frame: false,
      valign: Gtk.Align.CENTER,
    });

    
    minimizeButton.connect("clicked", () => {
      window.minimize();
    });

    closeButton.connect("clicked", () => {
      window.close();
    });

    
    windowControlsBox.append(minimizeButton);
    windowControlsBox.append(closeButton);

    
    headerBox.append(logoTitleBox);
    headerBox.append(windowControlsBox);

    
    headerGroup.add(headerBox);

    page.add(headerGroup);

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

    const timeFormatRow = new Adw.ActionRow({
      title: _("Time Format"),
      subtitle: _("Choose between 12-hour (1:00 PM) or 24-hour (13:00) format"),
    });

    const timeFormatSwitch = new Gtk.Switch({
      active: settings.get_boolean("use-12hour-format") || false,
      valign: Gtk.Align.CENTER,
    });

    
    const timeFormatBox = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 8,
    });

    const hourFormatLabel = new Gtk.Label({
      label: timeFormatSwitch.active ? "12h" : "24h",
      css_classes: ["caption"],
    });

    timeFormatSwitch.connect("state-set", (widget, state) => {
      settings.set_boolean("use-12hour-format", state);
      hourFormatLabel.set_label(state ? "12h" : "24h");
      return false;
    });

    timeFormatBox.append(hourFormatLabel);
    timeFormatBox.append(timeFormatSwitch);
    timeFormatRow.add_suffix(timeFormatBox);
    unitsGroup.add(timeFormatRow);

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

    const previewGroup = new Adw.PreferencesGroup({
      title: _("Weather Display Preview"),
      description: _(
        "Sample appearance in different conditions according to your GTK theme",
      ),
    });

    const previewBox = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 24,
      margin_top: 12,
      margin_bottom: 12,
      homogeneous: true,
      halign: Gtk.Align.CENTER,
    });

    const weatherTypes = [
      { icon: "weather-clear-symbolic", label: "Clear" },
      { icon: "weather-showers-symbolic", label: "Rain" },
      { icon: "weather-snow-symbolic", label: "Snow" },
      { icon: "weather-storm-symbolic", label: "Storm" },
    ];

    weatherTypes.forEach((type) => {
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

    page.add(locationGroup);
    page.add(unitsGroup);
    page.add(positionGroup);
    page.add(styleGroup);
    page.add(previewGroup);

    window.set_content(page);
  }
}
