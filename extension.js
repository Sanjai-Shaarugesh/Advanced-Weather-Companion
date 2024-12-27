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

const WEATHER_CONDITIONS = {
  0: {
    name: "Clear Sky",
    icon: "weather-clear-symbolic",
    description: "Completely clear, sunny day",
  },
  1: {
    name: "Mainly Clear",
    icon: "weather-few-clouds-symbolic",
    description: "Mostly clear with some clouds",
  },
  2: {
    name: "Partly Cloudy",
    icon: "weather-overcast-symbolic",
    description: "Partial cloud cover",
  },
  3: {
    name: "Overcast",
    icon: "weather-overcast-symbolic",
    description: "Fully covered by clouds",
  },
  45: {
    name: "Foggy",
    icon: "weather-fog-symbolic",
    description: "Foggy conditions",
  },
  48: {
    name: "Depositing Rime Fog",
    icon: "weather-fog-symbolic",
    description: "Freezing fog",
  },
  51: {
    name: "Light Drizzle",
    icon: "weather-showers-scattered-symbolic",
    description: "Slight drizzle",
  },
  53: {
    name: "Moderate Drizzle",
    icon: "weather-showers-symbolic",
    description: "Moderate drizzle",
  },
  55: {
    name: "Dense Drizzle",
    icon: "weather-showers-symbolic",
    description: "Heavy drizzle",
  },
  61: {
    name: "Slight Rain",
    icon: "weather-showers-scattered-symbolic",
    description: "Light rain",
  },
  63: {
    name: "Moderate Rain",
    icon: "weather-showers-symbolic",
    description: "Moderate rain",
  },
  65: {
    name: "Heavy Rain",
    icon: "weather-storm-symbolic",
    description: "Heavy rainfall",
  },
  71: {
    name: "Slight Snow",
    icon: "weather-snow-symbolic",
    description: "Light snowfall",
  },
  73: {
    name: "Moderate Snow",
    icon: "weather-snow-symbolic",
    description: "Moderate snow",
  },
  75: {
    name: "Heavy Snow",
    icon: "weather-snow-symbolic",
    description: "Heavy snowfall",
  },
  77: {
    name: "Snow Grains",
    icon: "weather-snow-symbolic",
    description: "Snow grains",
  },
  80: {
    name: "Slight Rain Showers",
    icon: "weather-showers-scattered-symbolic",
    description: "Light rain showers",
  },
  81: {
    name: "Moderate Rain Showers",
    icon: "weather-showers-symbolic",
    description: "Moderate rain showers",
  },
  82: {
    name: "Violent Rain Showers",
    icon: "weather-storm-symbolic",
    description: "Intense rain showers",
  },
  85: {
    name: "Slight Snow Showers",
    icon: "weather-snow-symbolic",
    description: "Light snow showers",
  },
  86: {
    name: "Heavy Snow Showers",
    icon: "weather-snow-symbolic",
    description: "Heavy snow showers",
  },
  95: {
    name: "Thunderstorm",
    icon: "weather-storm-symbolic",
    description: "Thunderstorm",
  },
  96: {
    name: "Thunderstorm with Light Hail",
    icon: "weather-storm-symbolic",
    description: "Thunderstorm with light hail",
  },
  99: {
    name: "Thunderstorm with Heavy Hail",
    icon: "weather-storm-symbolic",
    description: "Thunderstorm with heavy hail",
  },
};

const WeatherPanelButton = GObject.registerClass(
  class WeatherPanelButton extends PanelMenu.Button {
    _init(ext) {
      super._init(0.0, "Weather Extension");
      this._ext = ext;

      this._weatherIcon = new St.Icon({
        icon_name: "weather-clear-day-symbolic",
        icon_size: 24,
        style_class: "weather-icon",
      });

      this._weatherLabel = new St.Label({
        text: "Detecting Location...",
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "weather-label",
      });

      this._locationIcon = new St.Icon({
        icon_name: "find-location-symbolic",
        icon_size: 16,
        style_class: "location-icon",
      });

      this._locationModeLabel = new St.Label({
        text: this._getInitialLocationMode(),
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "location-mode-label",
      });

      const buttonBox = new St.BoxLayout({ style_class: "weather-button-box" });
      buttonBox.add_child(this._weatherIcon);
      buttonBox.add_child(this._weatherLabel);
      buttonBox.add_child(this._locationIcon);
      buttonBox.add_child(this._locationModeLabel);
      this.add_child(buttonBox);

      this.currentWeatherSection = new PopupMenu.PopupSubMenuMenuItem(
        "📍 Current Weather",
        true
      );
      this.hourlyWeatherSection = new PopupMenu.PopupSubMenuMenuItem(
        "⏰ Hourly Forecast",
        true
      );
      this.dailyWeatherSection = new PopupMenu.PopupSubMenuMenuItem(
        "📅 Daily Forecast",
        true
      );
      this.insightsSection = new PopupMenu.PopupSubMenuMenuItem(
        "🔍 Weather Insights",
        true
      );
      this.locationSection = new PopupMenu.PopupSubMenuMenuItem(
        "📱 Location Settings",
        true
      );

      this._setupLocationSwitcher();

      this.menu.addMenuItem(this.currentWeatherSection);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this.menu.addMenuItem(this.hourlyWeatherSection);
      this.menu.addMenuItem(this.dailyWeatherSection);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this.menu.addMenuItem(this.insightsSection);
      this.menu.addMenuItem(this.locationSection);

      const refreshButton = new PopupMenu.PopupMenuItem("🔄 Refresh Weather", {
        style_class: "refresh-button",
      });
      refreshButton.connect("activate", () => {
        this._animateRefresh();
        this._ext._detectLocationAndLoadWeather();
      });
      this.menu.addMenuItem(refreshButton);

      
      this._ext._settings.connect('changed::location-mode', () => {
        this._updateLocationModeDisplay();
      });
    }

    _getInitialLocationMode() {
      const mode = this._ext._settings.get_string('location-mode');
      return mode.toUpperCase() || 'AUTO';
    }

    _updateLocationModeDisplay() {
      const mode = this._ext._settings.get_string('location-mode');
      this._locationModeLabel.set_text(mode.toUpperCase());
      this._animateLocationUpdate();
    }

    _setupLocationSwitcher() {
      const locationModeBox = new St.BoxLayout({
        style_class: "location-mode-box",
      });

      const autoLocationButton = new PopupMenu.PopupMenuItem("🌍 Auto Detect", {
        style_class: "location-mode-button",
      });
      const manualLocationButton = new PopupMenu.PopupMenuItem(
        "📍 Manual Location",
        { style_class: "location-mode-button" }
      );

      this.locationSection.menu.addMenuItem(autoLocationButton);
      this.locationSection.menu.addMenuItem(manualLocationButton);

      const locationInput = new St.Entry({
        hint_text: "Enter coordinates (lat,lon)",
        style_class: "location-input",
      });

      const locationInputItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
      });
      locationInputItem.add_child(locationInput);

      this.locationSection.menu.addMenuItem(locationInputItem);
      this.locationSection.actor.add_style_class_name("location-section");

      autoLocationButton.connect("activate", () => {
        this._ext._settings.set_string("location-mode", "auto");
        this._locationModeLabel.set_text("AUTO");
        this._animateLocationChange();
        this._ext._detectLocationAndLoadWeather();
      });

      manualLocationButton.connect("activate", () => {
        this._ext._settings.set_string("location-mode", "manual");
        this._locationModeLabel.set_text("MANUAL");
        this._animateLocationChange();
      });

      locationInput.clutter_text.connect("activate", () => {
        const text = locationInput.get_text();
        if (text) {
          this._ext._settings.set_string("location", text);
          this._ext._detectLocationAndLoadWeather();
          this._animateLocationUpdate();
        }
      });
    }

    _animateRefresh() {
      this._weatherIcon.ease({
        rotation_angle_z: 360,
        duration: 1000,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        onComplete: () => {
          this._weatherIcon.set_rotation_angle(Clutter.RotateAxis.Z_AXIS, 0);
        },
      });
    }

    _animateLocationChange() {
      this._locationIcon.ease({
        scale_x: 1.2,
        scale_y: 1.2,
        duration: 200,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
          this._locationIcon.ease({
            scale_x: 1.0,
            scale_y: 1.0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          });
        },
      });
    }

    _animateLocationUpdate() {
      this._locationModeLabel.ease({
        opacity: 0,
        duration: 200,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
          this._locationModeLabel.ease({
            opacity: 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          });
        },
      });
    }

    updateWeather(data, useFahrenheit) {
      const current = data.current_weather;
      const weatherCondition = WEATHER_CONDITIONS[current.weathercode] || {
        name: "Unknown",
        icon: "weather-severe-alert-symbolic",
        description: "Unable to determine",
      };

      const temperature = useFahrenheit
        ? (current.temperature * 9/5 + 32).toFixed(1)
        : current.temperature;
      const tempUnit = useFahrenheit ? "°F" : "°C";

      this._weatherIcon.set_icon_name(weatherCondition.icon);
      this._weatherLabel.set_text(
        `${temperature}${tempUnit} | ${weatherCondition.name}`
      );

      this.currentWeatherSection.menu.removeAll();
      const temperatureItem = new PopupMenu.PopupMenuItem(
        `🌡️ Temperature: ${temperature}${tempUnit}`
      );
      const conditionItem = new PopupMenu.PopupMenuItem(
        `☁️ Condition: ${weatherCondition.name}`
      );
      const descriptionItem = new PopupMenu.PopupMenuItem(
        `📝 Description: ${weatherCondition.description}`
      );
      const windItem = new PopupMenu.PopupMenuItem(
        `💨 Wind: ${current.windspeed} km/h`
      );

      this.currentWeatherSection.menu.addMenuItem(temperatureItem);
      this.currentWeatherSection.menu.addMenuItem(conditionItem);
      this.currentWeatherSection.menu.addMenuItem(descriptionItem);
      this.currentWeatherSection.menu.addMenuItem(windItem);

      this.hourlyWeatherSection.menu.removeAll();
      data.hourly.slice(0, 12).forEach((hour) => {
        const hourCondition = WEATHER_CONDITIONS[hour.weathercode] || {
          name: "Unknown",
          icon: "weather-severe-alert-symbolic",
        };

        const hourTemp = useFahrenheit
          ? (parseFloat(hour.temperature) * 9/5 + 32).toFixed(1)
          : hour.temperature;

        const hourItem = new PopupMenu.PopupMenuItem(
          `⏰ ${hour.time}: ${hourTemp}${tempUnit} | ${hourCondition.name}`,
          { reactive: false }
        );
        const hourIcon = new St.Icon({
          icon_name: hourCondition.icon,
          icon_size: 16,
          style: "margin-left: 10px;",
        });
        hourItem.add_child(hourIcon);
        this.hourlyWeatherSection.menu.addMenuItem(hourItem);
      });

      this.dailyWeatherSection.menu.removeAll();
      data.daily.forEach((day) => {
        const dayCondition = WEATHER_CONDITIONS[day.weathercode] || {
          name: "Unknown",
          icon: "weather-severe-alert-symbolic",
        };

        const highTemp = useFahrenheit
          ? (parseFloat(day.high) * 9/5 + 32).toFixed(1)
          : day.high;
        const lowTemp = useFahrenheit
          ? (parseFloat(day.low) * 9/5 + 32).toFixed(1)
          : day.low;

        const dayItem = new PopupMenu.PopupMenuItem(
          `📅 ${day.day}: High ${highTemp}${tempUnit} / Low ${lowTemp}${tempUnit} | ${dayCondition.name}`,
          { reactive: false }
        );
        const dayIcon = new St.Icon({
          icon_name: dayCondition.icon,
          icon_size: 16,
          style: "margin-left: 10px;",
        });
        dayItem.add_child(dayIcon);
        this.dailyWeatherSection.menu.addMenuItem(dayItem);
      });

      this.insightsSection.menu.removeAll();
      const hourlyTemps = data.hourly.map(h => parseFloat(h.temperature));
      const tempTrend = this._analyzeTrend(hourlyTemps);
      
      const trendItem = new PopupMenu.PopupMenuItem(
        `🌡️ Temperature Trend: ${tempTrend}`,
        { reactive: false }
      );
      this.insightsSection.menu.addMenuItem(trendItem);
      
      const precipCodes = [51, 53, 55, 61, 63, 65, 80, 81, 82, 85, 86];
      const precipHours = data.hourly.filter(h => precipCodes.includes(h.weathercode));
      const precipChance = (precipHours.length / data.hourly.length * 100).toFixed(1);
      const precipItem = new PopupMenu.PopupMenuItem(
        `💧 Precipitation Chance: ${precipChance}%`,
        { reactive: false }
      );
      this.insightsSection.menu.addMenuItem(precipItem);
      
      const extremeWeatherCodes = [95, 96, 99, 82, 86];
      const extremeWeather = data.hourly.some(h => extremeWeatherCodes.includes(h.weathercode));
      if (extremeWeather) {
        const warningItem = new PopupMenu.PopupMenuItem(
          "⚠️ Extreme Weather Alert!",
          { 
            reactive: false,
            style_class: "popup-menu-item-warning"
          }
        );
        this.insightsSection.menu.addMenuItem(warningItem);
      }

      this._weatherLabel.ease({
        opacity: 0,
        duration: 200,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
          this._weatherLabel.set_text(
            `${temperature}${tempUnit} | ${weatherCondition.name}`
          );
          this._weatherLabel.ease({
            opacity: 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          });
        },
      });
    }

    _analyzeTrend(temperatures) {
      if (temperatures.length < 2) return "Insufficient data";
      
      let increasingCount = 0;
      let decreasingCount = 0;
      
      for (let i = 1; i < temperatures.length; i++) {
        if (temperatures[i] > temperatures[i - 1]) {
          increasingCount++;
        } else if (temperatures[i] < temperatures[i - 1]) {
          decreasingCount++;
        }
      }
      
      if (increasingCount > decreasingCount) return "Warming 🔥";
      if (decreasingCount > increasingCount) return "Cooling 🧊";
      return "Stable 🟰";
    }
  }
);

export default class WeatherExtension extends Extension {
  enable() {
    this._settings = this.getSettings(
      "org.gnome.shell.extensions.advanced-weather"
    );
    
    this._panelButton = new WeatherPanelButton(this);
    Main.panel.addToStatusArea("weather-extension", this._panelButton);

    this._settings.connect(
      "changed::location-mode",
      () => this._detectLocationAndLoadWeather()
    );
    this._settings.connect(
      "changed::location",
      () => this._detectLocationAndLoadWeather()
    );
    this._settings.connect(
      "changed::use-fahrenheit",
      () => this._reloadWeatherDisplay()
    );

    this._detectLocationAndLoadWeather();
  }

  disable() {
    if (this._panelButton) {
      this._panelButton.destroy();
      this._panelButton = null;
    }

    if (this._settings) {
      this._settings = null;
    }
  }

  _reloadWeatherDisplay() {
    if (this._lastWeatherData) {
      const useFahrenheit = this._settings.get_boolean("use-fahrenheit");
      this._panelButton.updateWeather(this._lastWeatherData, useFahrenheit);
    }
  }

  _detectLocationAndLoadWeather() {
    const session = new Soup.Session();
    const locationMode = this._settings.get_string("location-mode");
    const fallbackLocations = [
      { name: "San Francisco, USA", lat: 37.7749, lon: -122.4194 },
      { name: "New York, USA", lat: 40.7128, lon: -74.0060 },
      { name: "London, UK", lat: 51.5074, lon: -0.1278 },
    ];

    const geolocServices = [
      {
        url: "https://ipapi.co/json/",
        parser: (response) => ({
          latitude: response.latitude,
          longitude: response.longitude,
          locationName: `${response.city}, ${response.country_name}`,
        }),
      },
      {
        url: "https://ipinfo.io/json",
        parser: (response) => {
          const [latitude, longitude] = response.loc.split(",").map(parseFloat);
          return {
            latitude,
            longitude,
            locationName: `${response.city}, ${response.country}`,
          };
        },
      },
    ];

    const setManualLocation = () => {
      const manualLocation = this._settings.get_string("location");
      const coordMatch = manualLocation.match(
        /^([-+]?\d+\.?\d*),\s*([-+]?\d+\.?\d*)$/
      );
      if (coordMatch) {
        this._latitude = parseFloat(coordMatch[1]);
        this._longitude = parseFloat(coordMatch[2]);
        this._locationName = manualLocation;
        this._loadWeatherData();
        return true;
      }
      console.error("City name geocoding not implemented. Please use coordinates.");
      return false;
    };

    const tryNextService = (serviceIndex = 0) => {
      if (locationMode === "manual") {
        if (setManualLocation()) return;
      }

      if (serviceIndex >= geolocServices.length) {
        const fallback = fallbackLocations[
          Math.floor(Math.random() * fallbackLocations.length)
        ];
        this._latitude = fallback.lat;
        this._longitude = fallback.lon;
        this._locationName = fallback.name;
        this._loadWeatherData();
        return;
      }

      const service = geolocServices[serviceIndex];
      const message = Soup.Message.new("GET", service.url);

      session.send_and_read_async(
        message,
        GLib.PRIORITY_DEFAULT,
        null,
        (session, result) => {
          try {
            const bytes = session.send_and_read_finish(result);
            const response = JSON.parse(bytes.get_data().toString());
            const locationData = service.parser(response);

            if (locationData.latitude && locationData.longitude) {
              this._latitude = locationData.latitude;
              this._longitude = locationData.longitude;
              this._locationName = locationData.locationName || "Unknown Location";
              this._loadWeatherData();
            } else {
              tryNextService(serviceIndex + 1);
            }
          } catch (e) {
            console.error(`Geolocation service ${service.url} failed:`, e);
            tryNextService(serviceIndex + 1);
          }
        }
      );
    };

    tryNextService();
  }

  _loadWeatherData() {
    const url = `${BASE_URL}?latitude=${this._latitude}&longitude=${this._longitude}&current_weather=true&windspeed=true&hourly=temperature_2m,weathercode&daily=temperature_2m_max,temperature_2m_min,weathercode`;
    
    const session = new Soup.Session();
    const message = Soup.Message.new("GET", url);
    
    session.send_and_read_async(
      message,
      GLib.PRIORITY_DEFAULT,
      null,
      (session, result) => {
        try {
          const bytes = session.send_and_read_finish(result);
          const response = JSON.parse(bytes.get_data().toString());
          
          const data = {
            location: this._locationName,
            current_weather: {
              ...response.current_weather,
              temperature: response.current_weather.temperature.toFixed(1)
            },
            hourly: response.hourly.time.map((time, index) => ({
              time: time.split("T")[1].slice(0, 5),
              temperature: response.hourly.temperature_2m[index].toFixed(1),
              weathercode: response.hourly.weathercode[index]
            })),
            daily: response.daily.time.map((time, index) => ({
              day: new Date(time).toLocaleDateString("en-US", { weekday: "short" }),
              high: response.daily.temperature_2m_max[index].toFixed(1),
              low: response.daily.temperature_2m_min[index].toFixed(1),
              weathercode: response.daily.weathercode[index]
            }))
          };
          
          this._lastWeatherData = data;
          const useFahrenheit = this._settings.get_boolean("use-fahrenheit");
          this._panelButton.updateWeather(data, useFahrenheit);
          
          if (this._panelButton.currentWeatherSection) {
            const locationItem = new PopupMenu.PopupMenuItem(
              `📍 Location: ${this._locationName}`,
              { reactive: false }
            );
            this._panelButton.currentWeatherSection.menu.addMenuItem(locationItem, 0);
          }
        } catch (e) {
          console.error("Weather Extension: Failed to fetch weather data", e);
        }
      }
    );
  }
}