import St from 'gi://St';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const BASE_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';


const WEATHER_CONDITIONS = {
    0: { name: 'Clear Sky', icon: 'weather-clear-symbolic', description: 'Completely clear, sunny day' },
    1: { name: 'Mainly Clear', icon: 'weather-few-clouds-symbolic', description: 'Mostly clear with some clouds' },
    2: { name: 'Partly Cloudy', icon: 'weather-overcast-symbolic', description: 'Partial cloud cover' },
    3: { name: 'Overcast', icon: 'weather-overcast-symbolic', description: 'Fully covered by clouds' },
    45: { name: 'Foggy', icon: 'weather-fog-symbolic', description: 'Foggy conditions' },
    48: { name: 'Depositing Rime Fog', icon: 'weather-fog-symbolic', description: 'Freezing fog' },
    51: { name: 'Light Drizzle', icon: 'weather-showers-scattered-symbolic', description: 'Slight drizzle' },
    53: { name: 'Moderate Drizzle', icon: 'weather-showers-symbolic', description: 'Moderate drizzle' },
    55: { name: 'Dense Drizzle', icon: 'weather-showers-symbolic', description: 'Heavy drizzle' },
    61: { name: 'Slight Rain', icon: 'weather-showers-scattered-symbolic', description: 'Light rain' },
    63: { name: 'Moderate Rain', icon: 'weather-showers-symbolic', description: 'Moderate rain' },
    65: { name: 'Heavy Rain', icon: 'weather-storm-symbolic', description: 'Heavy rainfall' },
    71: { name: 'Slight Snow', icon: 'weather-snow-symbolic', description: 'Light snowfall' },
    73: { name: 'Moderate Snow', icon: 'weather-snow-symbolic', description: 'Moderate snow' },
    75: { name: 'Heavy Snow', icon: 'weather-snow-symbolic', description: 'Heavy snowfall' },
    77: { name: 'Snow Grains', icon: 'weather-snow-symbolic', description: 'Snow grains' },
    80: { name: 'Slight Rain Showers', icon: 'weather-showers-scattered-symbolic', description: 'Light rain showers' },
    81: { name: 'Moderate Rain Showers', icon: 'weather-showers-symbolic', description: 'Moderate rain showers' },
    82: { name: 'Violent Rain Showers', icon: 'weather-storm-symbolic', description: 'Intense rain showers' },
    85: { name: 'Slight Snow Showers', icon: 'weather-snow-symbolic', description: 'Light snow showers' },
    86: { name: 'Heavy Snow Showers', icon: 'weather-snow-symbolic', description: 'Heavy snow showers' },
    95: { name: 'Thunderstorm', icon: 'weather-storm-symbolic', description: 'Thunderstorm' },
    96: { name: 'Thunderstorm with Light Hail', icon: 'weather-storm-symbolic', description: 'Thunderstorm with light hail' },
    99: { name: 'Thunderstorm with Heavy Hail', icon: 'weather-storm-symbolic', description: 'Thunderstorm with heavy hail' }
};

const WeatherPanelButton = GObject.registerClass(
class WeatherPanelButton extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Weather Extension');
        this._ext = ext;

        
        this._weatherIcon = new St.Icon({
            icon_name: 'weather-clear-day-symbolic',
            icon_size: 24,
            style: 'margin-right: 10px;'
        });
        
        this._weatherLabel = new St.Label({
            text: 'Loading...',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-weight: bold; font-size: 0.9em;'
        });

        const buttonBox = new St.BoxLayout();
        buttonBox.add_child(this._weatherIcon);
        buttonBox.add_child(this._weatherLabel);
        this.add_child(buttonBox);

        
        this.currentWeatherSection = new PopupMenu.PopupSubMenuMenuItem('📍 Current Weather');
        this.hourlyWeatherSection = new PopupMenu.PopupSubMenuMenuItem('⏰ Hourly Forecast');
        this.dailyWeatherSection = new PopupMenu.PopupSubMenuMenuItem('📅 Daily Forecast');

        this.menu.addMenuItem(this.currentWeatherSection);
        this.menu.addMenuItem(this.hourlyWeatherSection);
        this.menu.addMenuItem(this.dailyWeatherSection);

        
        const locationMenu = new PopupMenu.PopupSubMenuMenuItem('🗺️ Location Settings');
        const manualSetItem = new PopupMenu.PopupMenuItem('📍 Auto Manual Location detect');

        manualSetItem.connect('activate', () => this._ext._openManualLocationDialog());

        locationMenu.menu.addMenuItem(manualSetItem);
        this.menu.addMenuItem(locationMenu);

        
        const refreshButton = new PopupMenu.PopupMenuItem('🔄 Refresh Weather');
        refreshButton.connect('activate', () => this._ext._loadWeatherData());
        this.menu.addMenuItem(refreshButton);
    }

    _openManualLocationDialog() {
        const dialog = new St.Dialog({
            modal: true,
            style_class: 'manual-location-dialog',
            width: 400,
            height: 250
        });

        const titleLabel = new St.Label({
            text: 'Set Manual Location',
            style_class: 'dialog-title'
        });

        const instructionLabel = new St.Label({
            text: 'Enter city, country or precise coordinates (lat,lon)',
            style_class: 'dialog-instruction'
        });

        const locationEntry = new St.Entry({
            hint_text: 'New York, USA or 40.7128,-74.0060',
            style_class: 'manual-location-entry',
            can_focus: true
        });

        const buttonBox = new St.BoxLayout({
            style_class: 'dialog-button-box',
            vertical: false
        });

        const saveButton = new St.Button({
            label: 'Save',
            style_class: 'dialog-save-button'
        });

        const cancelButton = new St.Button({
            label: 'Cancel',
            style_class: 'dialog-cancel-button'
        });

        saveButton.connect('clicked', () => {
            const input = locationEntry.get_text().trim();
            if (input) {
                this._ext._resolveLocation(input);
                dialog.close();
            }
        });

        cancelButton.connect('clicked', () => {
            dialog.close();
        });

        buttonBox.add_child(saveButton);
        buttonBox.add_child(cancelButton);

        const contentBox = new St.BoxLayout({
            vertical: true,
            style_class: 'dialog-content-box'
        });
        contentBox.add_child(titleLabel);
        contentBox.add_child(instructionLabel);
        contentBox.add_child(locationEntry);
        contentBox.add_child(buttonBox);

        dialog.add_child(contentBox);
        dialog.open();
    }

    updateWeather(data) {
        const current = data.current_weather;
        const weatherCondition = WEATHER_CONDITIONS[current.weathercode] || 
            { name: 'Unknown', icon: 'weather-severe-alert-symbolic', description: 'Unable to determine' };

        
        this._weatherIcon.set_icon_name(weatherCondition.icon);
        this._weatherLabel.set_text(`${current.temperature}°C | ${weatherCondition.name}`);

        
        this.currentWeatherSection.menu.removeAll();
        const temperatureItem = new PopupMenu.PopupMenuItem(`🌡️ Temperature: ${current.temperature}°C`);
        const conditionItem = new PopupMenu.PopupMenuItem(`☁️ Condition: ${weatherCondition.name}`);
        const descriptionItem = new PopupMenu.PopupMenuItem(`📝 Description: ${weatherCondition.description}`);
        const windItem = new PopupMenu.PopupMenuItem(`💨 Wind: ${current.windspeed} km/h`);

        this.currentWeatherSection.menu.addMenuItem(temperatureItem);
        this.currentWeatherSection.menu.addMenuItem(conditionItem);
        this.currentWeatherSection.menu.addMenuItem(descriptionItem);
        this.currentWeatherSection.menu.addMenuItem(windItem);

        
        this.hourlyWeatherSection.menu.removeAll();
        data.hourly.slice(0, 12).forEach(hour => {
            const hourCondition = WEATHER_CONDITIONS[hour.weathercode] || 
                { name: 'Unknown', icon: 'weather-severe-alert-symbolic' };
            
            const hourItem = new PopupMenu.PopupMenuItem(
                `⏰ ${hour.time}: ${hour.temperature}°C | ${hourCondition.name}`, 
                { reactive: false }
            );
            const hourIcon = new St.Icon({
                icon_name: hourCondition.icon,
                icon_size: 16,
                style: 'margin-left: 10px;'
            });
            hourItem.add_child(hourIcon);
            this.hourlyWeatherSection.menu.addMenuItem(hourItem);
        });

        
        this.dailyWeatherSection.menu.removeAll();
        data.daily.forEach(day => {
            const dayCondition = WEATHER_CONDITIONS[day.weathercode] || 
                { name: 'Unknown', icon: 'weather-severe-alert-symbolic' };
            
            const dayItem = new PopupMenu.PopupMenuItem(
                `📅 ${day.day}: High ${day.high}°C / Low ${day.low}°C | ${dayCondition.name}`, 
                { reactive: false }
            );
            const dayIcon = new St.Icon({
                icon_name: dayCondition.icon,
                icon_size: 16,
                style: 'margin-left: 10px;'
            });
            dayItem.add_child(dayIcon);
            this.dailyWeatherSection.menu.addMenuItem(dayItem);
        });
    }
});

export default class WeatherExtension extends Extension {
    enable() {
        this._panelButton = new WeatherPanelButton(this);
        Main.panel.addToStatusArea('weather-extension', this._panelButton);
        
        
        this._settings = this.getSettings('org.gnome.shell.extensions.weather-extension');
        
        
        this._openManualLocationDialog();
    }

    disable() {
        if (this._panelButton) {
            this._panelButton.destroy();
            this._panelButton = null;
        }
    }

    _openManualLocationDialog() {
        const dialog = new St.Dialog({
            modal: true,
            style_class: 'manual-location-dialog',
            width: 400,
            height: 250
        });

        const titleLabel = new St.Label({
            text: 'Set Weather Location',
            style_class: 'dialog-title'
        });

        const instructionLabel = new St.Label({
            text: 'Enter city, country or precise coordinates (lat,lon)\nExamples:\n- New York, USA\n- London, UK\n- 40.7128,-74.0060',
            style_class: 'dialog-instruction'
        });

        const locationEntry = new St.Entry({
            hint_text: 'Enter location',
            style_class: 'manual-location-entry',
            can_focus: true
        });

        const buttonBox = new St.BoxLayout({
            style_class: 'dialog-button-box',
            vertical: false
        });

        const saveButton = new St.Button({
            label: 'Save',
            style_class: 'dialog-save-button'
        });

        saveButton.connect('clicked', () => {
            const input = locationEntry.get_text().trim();
            
            if (input) {
                this._resolveLocation(input);
                dialog.close();
            }
        });

        buttonBox.add_child(saveButton);

        const contentBox = new St.BoxLayout({
            vertical: true,
            style_class: 'dialog-content-box'
        });
        contentBox.add_child(titleLabel);
        contentBox.add_child(instructionLabel);
        contentBox.add_child(locationEntry);
        contentBox.add_child(buttonBox);

        dialog.add_child(contentBox);
        dialog.open();
    }

    _resolveLocation(location) {
        const session = new Soup.Session();
        const url = `${GEOCODING_URL}?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
        
        const message = Soup.Message.new('GET', url);
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                const response = JSON.parse(bytes.get_data().toString());
                
                if (response.results && response.results.length > 0) {
                    const { latitude, longitude } = response.results[0];
                    this._latitude = latitude;
                    this._longitude = longitude;
                    this._locationName = response.results[0].name;
                    this._loadWeatherData();
                } else {
                    
                    this._openManualLocationDialog();
                }
            } catch (e) {
                logError(e, 'Location Resolution Error');
                this._openManualLocationDialog();
            }
        });
    }

    _loadWeatherData() {
        const { latitude, longitude } = this._getLocation();
        const url = `${BASE_URL}?latitude=${latitude}&longitude=${longitude}&current_weather=true&windspeed=true&hourly=temperature_2m,weathercode&daily=temperature_2m_max,temperature_2m_min,weathercode`;

        const session = new Soup.Session();
        const message = Soup.Message.new('GET', url);

        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                const response = JSON.parse(bytes.get_data().toString());

                const data = {
                    current_weather: {
                        ...response.current_weather,
                        temperature: response.current_weather.temperature.toFixed(1)
                    },
                    hourly: response.hourly.time.map((time, index) => ({
                        time: time.split('T')[1].slice(0, 5),
                        temperature: response.hourly.temperature_2m[index].toFixed(1),
                        weathercode: response.hourly.weathercode[index],
                    })),
                    daily: response.daily.time.map((time, index) => ({
                        day: new Date(time).toLocaleDateString('en-US', { weekday: 'short' }),
                        high: response.daily.temperature_2m_max[index].toFixed(1),
                        low: response.daily.temperature_2m_min[index].toFixed(1),
                        weathercode: response.daily.weathercode[index],
                    })),
                };

                this._panelButton.updateWeather(data);
            } catch (e) {
                logError(e, 'Weather Extension: Failed to fetch weather data');
                this._openManualLocationDialog();
            }
        });
    }

    _getLocation() {
        
        return { 
            latitude: this._latitude || 37.7749, 
            longitude: this._longitude || -122.4194 
        };
    }
}