import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class WeatherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.advanced-weather');

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({ title: _('Weather Settings') });

        
        const locationModeRow = new Adw.ActionRow({ 
            title: _('Location Mode'), 
            subtitle: _('Choose how location is determined') 
        });
        const locationModeCombo = new Gtk.ComboBoxText();
        locationModeCombo.append('auto', _('Auto Detect'));
        locationModeCombo.append('manual', _('Manual Setup'));

        const currentMode = settings.get_string('location-mode') || 'auto';
        locationModeCombo.set_active_id(currentMode);

        locationModeRow.add_suffix(locationModeCombo);
        group.add(locationModeRow);

        locationModeCombo.connect('changed', (widget) => {
            settings.set_string('location-mode', widget.get_active_id());
        });

        
        const locationRow = new Adw.ActionRow({ 
            title: _('Manual Location'), 
            subtitle: _('City name or coordinates') 
        });
        const locationEntry = new Gtk.Entry({
            text: settings.get_string('location') || '',
            placeholder_text: _('New York or 40.7128,-74.0060')
        });
        locationRow.add_suffix(locationEntry);
        group.add(locationRow);

        locationEntry.connect('changed', () => {
            settings.set_string('location', locationEntry.get_text());
        });

        
        const unitRow = new Adw.ActionRow({ 
            title: _('Temperature Unit'), 
            subtitle: _('Choose between Celsius and Fahrenheit') 
        });
        const unitSwitch = new Gtk.Switch({
            active: settings.get_boolean('use-fahrenheit') || false
        });
        unitRow.add_suffix(unitSwitch);
        group.add(unitRow);

        unitSwitch.connect('state-set', (widget, state) => {
            settings.set_boolean('use-fahrenheit', state);
        });

        page.add(group);
        window.add(page);
    }
}
