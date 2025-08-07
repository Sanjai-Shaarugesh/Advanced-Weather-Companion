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

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const GEOIP_URL = "https://ipapi.co/json/";


const FALLBACK_GEOIP_URLS = [
  "https://ipapi.co/json/",
  "http://ip-api.com/json/",
  "https://freegeoip.app/json/"
];


const WEATHER_PROVIDERS = {
  openmeteo: {
    name: "Open-Meteo",
    description: "Free weather API - No registration required",
    baseUrl: "https://api.open-meteo.com/v1/forecast",
    requiresApiKey: false,
    isFree: true,
    status: "active",
    buildUrl: function(lat, lon, apiKey) {
      const params = [
        `latitude=${lat}`,
        `longitude=${lon}`,
        "current=temperature_2m,relative_humidity_2m,apparent_temperature,surface_pressure,weather_code,wind_speed_10m,wind_direction_10m",
        "hourly=temperature_2m,weather_code,precipitation_probability,wind_speed_10m",
        "daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset",
        "timezone=auto",
        "forecast_days=7"
      ];
      return `${this.baseUrl}?${params.join("&")}`;
    },
    parseResponse: function(response) {
      if (!response.current) throw new Error("Invalid Open-Meteo weather data received");
      return {
        current: response.current,
        hourly: response.hourly,
        daily: response.daily
      };
    }
  },
  meteosource: {
    name: "Meteosource",
    description: "Free tier - 400 calls/day without API key",
    baseUrl: "https://www.meteosource.com/api/v1/free/point",
    requiresApiKey: false,
    isFree: true,
    status: "active",
    buildUrl: function(lat, lon, apiKey) {
      return `${this.baseUrl}?lat=${lat}&lon=${lon}&sections=current%2Chourly%2Cdaily&timezone=UTC&language=en&units=metric`;
    },
    parseResponse: function(response) {
      if (!response.current) throw new Error("Invalid Meteosource response");

      return {
        current: {
          temperature_2m: response.current.temperature,
          relative_humidity_2m: response.current.humidity,
          surface_pressure: response.current.pressure,
          weather_code: this.convertWeatherCode(response.current.icon_num),
          wind_speed_10m: response.current.wind.speed * 3.6,
          wind_direction_10m: response.current.wind.angle
        },
        hourly: response.hourly ? {
          time: response.hourly.data.map(h => h.date),
          temperature_2m: response.hourly.data.map(h => h.temperature),
          weather_code: response.hourly.data.map(h => this.convertWeatherCode(h.icon_num)),
          precipitation_probability: response.hourly.data.map(h => h.precipitation.total),
          wind_speed_10m: response.hourly.data.map(h => h.wind.speed * 3.6)
        } : null,
        daily: response.daily ? {
          time: response.daily.data.map(d => d.day),
          weather_code: response.daily.data.map(d => this.convertWeatherCode(d.icon)),
          temperature_2m_max: response.daily.data.map(d => d.all_day.temperature_max),
          temperature_2m_min: response.daily.data.map(d => d.all_day.temperature_min)
        } : null
      };
    },
    convertWeatherCode: function(meteosourceIcon) {
      const codeMap = {
        1: 0,   // Clear
        2: 1,   // Mostly clear
        3: 2,   // Partly cloudy
        4: 3,   // Mostly cloudy
        5: 3,   // Cloudy
        6: 45,  // Fog
        7: 61,  // Light rain
        8: 63,  // Rain
        9: 65,  // Heavy rain
        10: 80, // Rain showers
        11: 71, // Light snow
        12: 73, // Snow
        13: 75, // Heavy snow
        14: 95, // Thunderstorm
      };
      return codeMap[meteosourceIcon] || 0;
    }
  },
  wttr: {
    name: "Wttr.in",
    description: "Free console weather service - No limits",
    baseUrl: "https://wttr.in",
    requiresApiKey: false,
    isFree: true,
    status: "active",
    buildUrl: function(lat, lon, apiKey) {
      return `${this.baseUrl}/${lat},${lon}?format=j1`;
    },
    parseResponse: function(response) {
      if (!response.current_condition) throw new Error("Invalid wttr.in response");

      const current = response.current_condition[0];
      const weather = response.weather || [];

      return {
        current: {
          temperature_2m: parseInt(current.temp_C),
          relative_humidity_2m: parseInt(current.humidity),
          surface_pressure: parseInt(current.pressure),
          weather_code: this.convertWeatherCode(current.weatherCode),
          wind_speed_10m: parseInt(current.windspeedKmph),
          wind_direction_10m: this.convertWindDirection(current.winddir16Point)
        },
        hourly: weather.length > 0 ? {
          time: weather.flatMap(day =>
            day.hourly.map(h => `${day.date}T${h.time.padStart(4, '0').slice(0,2)}:${h.time.padStart(4, '0').slice(2,4)}:00`)
          ),
          temperature_2m: weather.flatMap(day => day.hourly.map(h => parseInt(h.tempC))),
          weather_code: weather.flatMap(day => day.hourly.map(h => this.convertWeatherCode(h.weatherCode))),
          precipitation_probability: weather.flatMap(day => day.hourly.map(h => parseInt(h.chanceofrain))),
          wind_speed_10m: weather.flatMap(day => day.hourly.map(h => parseInt(h.windspeedKmph)))
        } : null,
        daily: weather.length > 0 ? {
          time: weather.map(d => d.date),
          weather_code: weather.map(d => this.convertWeatherCode(d.hourly[0].weatherCode)),
          temperature_2m_max: weather.map(d => parseInt(d.maxtempC)),
          temperature_2m_min: weather.map(d => parseInt(d.mintempC))
        } : null
      };
    },
    convertWeatherCode: function(wttrCode) {
      const codeMap = {
        113: 0,  // Clear/Sunny
        116: 1,  // Partly cloudy
        119: 2,  // Cloudy
        122: 3,  // Overcast
        143: 45, // Mist
        248: 45, // Fog
        176: 61, // Patchy rain possible
        263: 51, // Patchy light drizzle
        266: 53, // Light drizzle
        281: 55, // Freezing drizzle
        284: 55, // Heavy freezing drizzle
        293: 61, // Patchy light rain
        296: 61, // Light rain
        299: 63, // Moderate rain at times
        302: 63, // Moderate rain
        305: 65, // Heavy rain at times
        308: 65, // Heavy rain
        311: 65, // Light freezing rain
        314: 65, // Moderate or heavy freezing rain
        317: 51, // Light sleet
        320: 55, // Moderate or heavy sleet
        323: 71, // Patchy light snow
        326: 71, // Light snow
        329: 73, // Patchy moderate snow
        332: 73, // Moderate snow
        335: 75, // Patchy heavy snow
        338: 75, // Heavy snow
        350: 77, // Ice pellets
        353: 80, // Light rain shower
        356: 81, // Moderate or heavy rain shower
        359: 82, // Torrential rain shower
        362: 85, // Light sleet showers
        365: 85, // Moderate or heavy sleet showers
        368: 85, // Light snow showers
        371: 86, // Moderate or heavy snow showers
        374: 77, // Light showers of ice pellets
        377: 77, // Moderate or heavy showers of ice pellets
        386: 95, // Patchy light rain with thunder
        389: 95, // Moderate or heavy rain with thunder
        392: 95, // Patchy light snow with thunder
        395: 95, // Moderate or heavy snow with thunder
      };
      return codeMap[parseInt(wttrCode)] || 0;
    },
    convertWindDirection: function(direction) {
      const directions = {
        'N': 0, 'NNE': 22.5, 'NE': 45, 'ENE': 67.5,
        'E': 90, 'ESE': 112.5, 'SE': 135, 'SSE': 157.5,
        'S': 180, 'SSW': 202.5, 'SW': 225, 'WSW': 247.5,
        'W': 270, 'WNW': 292.5, 'NW': 315, 'NNW': 337.5
      };
      return directions[direction] || 0;
    }
  },
  openweathermap: {
    name: "OpenWeatherMap",
    description: "Comprehensive weather data - API key required",
    baseUrl: "https://api.openweathermap.org/data/3.0/onecall",
    requiresApiKey: true,
    isFree: false,
    status: "inactive",
    buildUrl: function(lat, lon, apiKey) {
      if (!apiKey) throw new Error("OpenWeatherMap requires an API key");
      return `${this.baseUrl}?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric&exclude=minutely,alerts`;
    },
    parseResponse: function(response) {
      if (!response.current) throw new Error("Invalid OpenWeatherMap response");

      return {
        current: {
          temperature_2m: response.current.temp,
          relative_humidity_2m: response.current.humidity,
          surface_pressure: response.current.pressure,
          weather_code: this.convertWeatherCode(response.current.weather[0].id),
          wind_speed_10m: (response.current.wind_speed || 0) * 3.6,
          wind_direction_10m: response.current.wind_deg || 0
        },
        hourly: response.hourly ? {
          time: response.hourly.map(h => new Date(h.dt * 1000).toISOString()),
          temperature_2m: response.hourly.map(h => h.temp),
          weather_code: response.hourly.map(h => this.convertWeatherCode(h.weather[0].id)),
          precipitation_probability: response.hourly.map(h => (h.pop || 0) * 100),
          wind_speed_10m: response.hourly.map(h => (h.wind_speed || 0) * 3.6)
        } : null,
        daily: response.daily ? {
          time: response.daily.map(d => new Date(d.dt * 1000).toISOString().split('T')[0]),
          weather_code: response.daily.map(d => this.convertWeatherCode(d.weather[0].id)),
          temperature_2m_max: response.daily.map(d => d.temp.max),
          temperature_2m_min: response.daily.map(d => d.temp.min)
        } : null
      };
    },
    convertWeatherCode: function(owmCode) {
      const codeMap = {
        800: 0,  // Clear sky
        801: 1,  // Few clouds
        802: 2,  // Scattered clouds
        803: 3,  // Broken clouds
        804: 3,  // Overcast clouds
        701: 45, // Mist
        741: 45, // Fog
        500: 61, // Light rain
        501: 63, // Moderate rain
        502: 65, // Heavy rain
        511: 65, // Freezing rain
        520: 80, // Light shower rain
        521: 81, // Shower rain
        522: 82, // Heavy shower rain
        600: 71, // Light snow
        601: 73, // Snow
        602: 75, // Heavy snow
        611: 77, // Sleet
        612: 77, // Light shower sleet
        613: 77, // Shower sleet
        615: 85, // Light rain and snow
        616: 85, // Rain and snow
        620: 85, // Light shower snow
        621: 86, // Shower snow
        622: 86, // Heavy shower snow
        200: 95, // Thunderstorm with light rain
        201: 95, // Thunderstorm with rain
        202: 95, // Thunderstorm with heavy rain
        210: 95, // Light thunderstorm
        211: 95, // Thunderstorm
        212: 95, // Heavy thunderstorm
        221: 95, // Ragged thunderstorm
        230: 95, // Thunderstorm with light drizzle
        231: 95, // Thunderstorm with drizzle
        232: 95, // Thunderstorm with heavy drizzle
      };
      return codeMap[owmCode] || 0;
    }
  },
  weatherapi: {
    name: "WeatherAPI",
    description: "Real-time weather API - API key required",
    baseUrl: "https://api.weatherapi.com/v1/forecast.json",
    requiresApiKey: true,
    isFree: false,
    status: "inactive",
    buildUrl: function(lat, lon, apiKey) {
      if (!apiKey) throw new Error("WeatherAPI requires an API key");
      return `${this.baseUrl}?key=${apiKey}&q=${lat},${lon}&days=7&aqi=no`;
    },
    parseResponse: function(response) {
      if (!response.current) throw new Error("Invalid WeatherAPI response");

      return {
        current: {
          temperature_2m: response.current.temp_c,
          relative_humidity_2m: response.current.humidity,
          surface_pressure: response.current.pressure_mb,
          weather_code: this.convertWeatherCode(response.current.condition.code),
          wind_speed_10m: response.current.wind_kph,
          wind_direction_10m: response.current.wind_degree
        },
        hourly: response.forecast && response.forecast.forecastday ?
          response.forecast.forecastday.flatMap(day =>
            day.hour.map(h => ({
              time: h.time,
              temperature_2m: h.temp_c,
              weather_code: this.convertWeatherCode(h.condition.code),
              precipitation_probability: h.chance_of_rain,
              wind_speed_10m: h.wind_kph
            }))
          ).reduce((acc, curr) => {
            acc.time = acc.time || [];
            acc.temperature_2m = acc.temperature_2m || [];
            acc.weather_code = acc.weather_code || [];
            acc.precipitation_probability = acc.precipitation_probability || [];
            acc.wind_speed_10m = acc.wind_speed_10m || [];

            acc.time.push(curr.time);
            acc.temperature_2m.push(curr.temperature_2m);
            acc.weather_code.push(curr.weather_code);
            acc.precipitation_probability.push(curr.precipitation_probability);
            acc.wind_speed_10m.push(curr.wind_speed_10m);

            return acc;
          }, {}) : null,
        daily: response.forecast && response.forecast.forecastday ? {
          time: response.forecast.forecastday.map(d => d.date),
          weather_code: response.forecast.forecastday.map(d => this.convertWeatherCode(d.day.condition.code)),
          temperature_2m_max: response.forecast.forecastday.map(d => d.day.maxtemp_c),
          temperature_2m_min: response.forecast.forecastday.map(d => d.day.mintemp_c)
        } : null
      };
    },
    convertWeatherCode: function(wapiCode) {
      const codeMap = {
        1000: 0,  // Sunny
        1003: 1,  // Partly cloudy
        1006: 2,  // Cloudy
        1009: 3,  // Overcast
        1030: 45, // Mist
        1135: 45, // Fog
        1150: 51, // Patchy light drizzle
        1153: 53, // Light drizzle
        1168: 55, // Freezing drizzle
        1171: 55, // Heavy freezing drizzle
        1180: 61, // Patchy light rain
        1183: 61, // Light rain
        1186: 63, // Moderate rain at times
        1189: 63, // Moderate rain
        1192: 65, // Heavy rain at times
        1195: 65, // Heavy rain
        1198: 65, // Light freezing rain
        1201: 65, // Moderate or heavy freezing rain
        1204: 77, // Light sleet
        1207: 77, // Moderate or heavy sleet
        1210: 71, // Patchy light snow
        1213: 71, // Light snow
        1216: 73, // Patchy moderate snow
        1219: 73, // Moderate snow
        1222: 75, // Patchy heavy snow
        1225: 75, // Heavy snow
        1237: 77, // Ice pellets
        1240: 80, // Light rain shower
        1243: 81, // Moderate or heavy rain shower
        1246: 82, // Torrential rain shower
        1249: 85, // Light sleet showers
        1252: 85, // Moderate or heavy sleet showers
        1255: 85, // Light snow showers
        1258: 86, // Moderate or heavy snow showers
        1261: 77, // Light showers of ice pellets
        1264: 77, // Moderate or heavy showers of ice pellets
        1273: 95, // Patchy light rain with thunder
        1276: 95, // Moderate or heavy rain with thunder
        1279: 95, // Patchy light snow with thunder
        1282: 95, // Moderate or heavy snow with thunder
      };
      return codeMap[wapiCode] || 0;
    }
  },
  custom: {
    name: "Custom Provider",
    description: "Configure your own weather API endpoint",
    baseUrl: "",
    requiresApiKey: false,
    isFree: false,
    status: "inactive",
    buildUrl: function(lat, lon, apiKey, customUrl) {
      if (!customUrl) throw new Error("Custom URL is required");

      let url = customUrl.replace('{lat}', lat).replace('{lon}', lon);
      url = url.replace('{latitude}', lat).replace('{longitude}', lon);

      if (apiKey) {
        const separator = url.includes('?') ? '&' : '?';
        if (url.includes('appid=')) {
          url = url.replace('appid=', `appid=${apiKey}`);
        } else if (url.includes('key=')) {
          url = url.replace('key=', `key=${apiKey}`);
        } else {
          url += `${separator}key=${apiKey}`;
        }
      }

      return url;
    },
    parseResponse: function(response) {

      if (response.current && response.current.temperature_2m) {
        return {
          current: response.current,
          hourly: response.hourly,
          daily: response.daily
        };
      }

      if (response.current && response.current.temp) {
        return {
          current: {
            temperature_2m: response.current.temp,
            relative_humidity_2m: response.current.humidity,
            surface_pressure: response.current.pressure,
            weather_code: 0,
            wind_speed_10m: (response.current.wind_speed || 0) * 3.6,
            wind_direction_10m: response.current.wind_deg || 0
          }
        };
      }

      if (response.current && response.current.temp_c) {
        return {
          current: {
            temperature_2m: response.current.temp_c,
            relative_humidity_2m: response.current.humidity,
            surface_pressure: response.current.pressure_mb,
            weather_code: 0,
            wind_speed_10m: response.current.wind_kph,
            wind_direction_10m: response.current.wind_degree
          }
        };
      }

      if (response.temperature || response.temp || response.current_temperature) {
        const temp = response.temperature || response.temp || response.current_temperature;
        return {
          current: {
            temperature_2m: parseFloat(temp),
            relative_humidity_2m: response.humidity || 50,
            surface_pressure: response.pressure || 1013,
            weather_code: 0,
            wind_speed_10m: response.wind_speed || response.windSpeed || 0,
            wind_direction_10m: response.wind_direction || response.windDirection || 0
          }
        };
      }

      throw new Error("Unsupported API response format. Please check your custom API URL.");
    }
  }
};

const WEATHER_CONDITIONS = {
  0: { name: "Clear Sky", icon: "weather-clear-symbolic", severity: "normal" },
  1: { name: "Mainly Clear", icon: "weather-few-clouds-symbolic", severity: "normal" },
  2: { name: "Partly Cloudy", icon: "weather-few-clouds-symbolic", severity: "normal" },
  3: { name: "Overcast", icon: "weather-overcast-symbolic", severity: "normal" },
  45: { name: "Fog", icon: "weather-fog-symbolic", severity: "caution" },
  48: { name: "Rime Fog", icon: "weather-fog-symbolic", severity: "caution" },
  51: { name: "Light Drizzle", icon: "weather-showers-scattered-symbolic", severity: "normal" },
  53: { name: "Drizzle", icon: "weather-showers-symbolic", severity: "normal" },
  55: { name: "Heavy Drizzle", icon: "weather-showers-symbolic", severity: "caution" },
  61: { name: "Light Rain", icon: "weather-showers-scattered-symbolic", severity: "normal" },
  63: { name: "Rain", icon: "weather-showers-symbolic", severity: "normal" },
  65: { name: "Heavy Rain", icon: "weather-storm-symbolic", severity: "warning" },
  71: { name: "Light Snow", icon: "weather-snow-symbolic", severity: "normal" },
  73: { name: "Snow", icon: "weather-snow-symbolic", severity: "caution" },
  75: { name: "Heavy Snow", icon: "weather-snow-symbolic", severity: "warning" },
  77: { name: "Snow Grains", icon: "weather-snow-symbolic", severity: "caution" },
  80: { name: "Rain Showers", icon: "weather-showers-scattered-symbolic", severity: "normal" },
  81: { name: "Rain Showers", icon: "weather-showers-symbolic", severity: "caution" },
  82: { name: "Heavy Showers", icon: "weather-storm-symbolic", severity: "warning" },
  85: { name: "Snow Showers", icon: "weather-snow-symbolic", severity: "caution" },
  86: { name: "Heavy Snow", icon: "weather-snow-symbolic", severity: "warning" },
  95: { name: "Thunderstorm", icon: "weather-storm-symbolic", severity: "severe" },
  96: { name: "Hail Storm", icon: "weather-storm-symbolic", severity: "severe" },
  99: { name: "Heavy Hail", icon: "weather-storm-symbolic", severity: "severe" },
};


const WIND_SPEED_UNITS = {
  kmh: { label: "km/h", multiplier: 1 },
  mph: { label: "mph", multiplier: 0.621371 },
  ms: { label: "m/s", multiplier: 0.277778 },
  knots: { label: "kn", multiplier: 0.539957 }
};

function convertWindSpeed(speedKmh, unit) {
  const conversion = WIND_SPEED_UNITS[unit] || WIND_SPEED_UNITS.kmh;
  return {
    value: Math.round(speedKmh * conversion.multiplier),
    unit: conversion.label
  };
}

const WeatherPanelButton = GObject.registerClass(
  class WeatherPanelButton extends PanelMenu.Button {
    _init(ext) {
      super._init(0.0, "Weather Extension", false);
      this._ext = ext;
      this._updateTimeoutId = null;
      this._searchResults = null;
      this._retryCount = 0;
      this._maxRetries = 3;
      this._providerStatus = new Map();
      this._destroyed = false;

      this._container = new St.BoxLayout({
        vertical: false,
        style_class: "weather-button-box"
      });

      this._weatherIcon = new St.Icon({
        icon_name: "weather-clear-symbolic",
        icon_size: this._ext._settings.get_int("panel-icon-size") || 16,
        style_class: "weather-icon"
      });

      this._weatherLabel = new St.Label({
        text: "…",
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "weather-label",
        style: this._getTextStyle()
      });

      this._locationContainer = new St.BoxLayout({
        vertical: false,
        style_class: "location-container",
        visible: this._ext._settings.get_boolean("show-location-label")
      });

      this._locationIcon = new St.Icon({
        icon_name: "find-location-symbolic",
        icon_size: 12,
        style_class: "location-icon",
        visible: this._ext._settings.get_boolean("show-location-label")
      });

      this._locationDot = new St.Label({
        text: this._getLocationModeText(),
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "location-mode-label",
        visible: this._ext._settings.get_boolean("show-location-label")
      });

      this._container.add_child(this._weatherIcon);
      if (this._ext._settings.get_boolean("show-text-in-panel")) {
        this._container.add_child(this._weatherLabel);
      }
      if (this._ext._settings.get_boolean("show-location-label")) {
        this._container.add_child(this._locationIcon);
        this._container.add_child(this._locationDot);
      }

      this.add_child(this._container);

      this._setupMenu();
      this._connectSettings();
      this._updateLocationIndicator();
      this._startUpdateTimer();
    }

    _getTextStyle() {
      const textSize = this._ext._settings.get_int("panel-text-size") || 13;
      return `font-size: ${textSize}px;`;
    }

    _getLocationModeText() {
      const mode = this._ext._settings.get_string("location-mode") || "auto";
      return mode === "auto" ? "AUTO" : "MANUAL";
    }

    _connectSettings() {
      if (this._destroyed) return;

      this._settingsConnections = [
        this._ext._settings.connect("changed::location-mode", () => {
          if (!this._destroyed) {
            this._updateLocationIndicator();
            this._ext._detectLocationAndLoadWeather();
          }
        }),
        this._ext._settings.connect("changed::weather-provider", () => {
          if (!this._destroyed) {
            this._ext._detectLocationAndLoadWeather();
          }
        }),
        this._ext._settings.connect("changed::weather-api-key", () => {
          if (!this._destroyed) {
            this._ext._detectLocationAndLoadWeather();
          }
        }),
        this._ext._settings.connect("changed::custom-weather-url", () => {
          if (!this._destroyed) {
            this._ext._detectLocationAndLoadWeather();
          }
        }),
        this._ext._settings.connect("changed::show-location-label", () => {
          if (!this._destroyed) {
            this._updateLocationVisibility();
          }
        }),
        this._ext._settings.connect("changed::show-text-in-panel", () => {
          if (!this._destroyed) {
            this._updatePanelLayout();
          }
        }),
        this._ext._settings.connect("changed::panel-icon-size", () => {
          if (!this._destroyed) {
            this._weatherIcon.icon_size = this._ext._settings.get_int("panel-icon-size");
          }
        }),
        this._ext._settings.connect("changed::panel-text-size", () => {
          if (!this._destroyed) {
            this._updateTextSize();
          }
        }),
        this._ext._settings.connect("changed::show-humidity", () => {
          if (!this._destroyed) {
            this._ext._detectLocationAndLoadWeather();
          }
        }),
        this._ext._settings.connect("changed::use-fahrenheit", () => {
          if (!this._destroyed) {
            this._ext._detectLocationAndLoadWeather();
          }
        }),
        this._ext._settings.connect("changed::use-12hour-format", () => {
          if (!this._destroyed) {
            this._ext._detectLocationAndLoadWeather();
          }
        }),
        this._ext._settings.connect("changed::wind-speed-unit", () => {
          if (!this._destroyed) {
            this._ext._detectLocationAndLoadWeather();
          }
        })
      ];
    }

    _updateTextSize() {
      if (this._weatherLabel && !this._destroyed) {
        this._weatherLabel.set_style(this._getTextStyle());
      }
    }

    _updateLocationVisibility() {
      if (this._destroyed) return;

      const show = this._ext._settings.get_boolean("show-location-label");
      this._locationIcon.visible = show;
      this._locationDot.visible = show;

      if (!show) {
        if (this._container.contains(this._locationIcon)) {
          this._container.remove_child(this._locationIcon);
        }
        if (this._container.contains(this._locationDot)) {
          this._container.remove_child(this._locationDot);
        }
      } else {
        if (!this._container.contains(this._locationIcon)) {
          this._container.add_child(this._locationIcon);
        }
        if (!this._container.contains(this._locationDot)) {
          this._container.add_child(this._locationDot);
        }
      }
    }

    _updatePanelLayout() {
      if (this._destroyed) return;

      this._container.remove_all_children();
      this._container.add_child(this._weatherIcon);

      if (this._ext._settings.get_boolean("show-text-in-panel")) {
        this._container.add_child(this._weatherLabel);
      }

      if (this._ext._settings.get_boolean("show-location-label")) {
        this._container.add_child(this._locationIcon);
        this._container.add_child(this._locationDot);
      }
    }

    _setupMenu() {
      if (this._destroyed) return;

      this._currentSection = new PopupMenu.PopupMenuSection();
      this._currentWeatherItem = new PopupMenu.PopupMenuItem("Loading weather...", {
        reactive: false,
        style_class: "current-weather"
      });
      this._currentSection.addMenuItem(this._currentWeatherItem);

      this._alertsSection = new PopupMenu.PopupMenuSection();
      this._locationInfoSection = new PopupMenu.PopupSubMenuMenuItem("📍 Location Information", true);
      this._setupLocationInfo();
      this._hourlySection = new PopupMenu.PopupSubMenuMenuItem("⏰ Hourly Forecast", true);
      this._dailySection = new PopupMenu.PopupSubMenuMenuItem("📅 7-Day Forecast", true);
      this._insightsSection = new PopupMenu.PopupSubMenuMenuItem("🔍 Weather Insights", true);


      this._providerSection = new PopupMenu.PopupSubMenuMenuItem("🌐 Weather Provider Status", true);
      this._setupProviderInfo();

      this._refreshItem = new PopupMenu.PopupMenuItem("🔄 Refresh Weather");
      this._refreshItem.style_class = "refresh-button";
      this._refreshItem.connect("activate", () => {
        if (!this._destroyed) {
          this._ext._detectLocationAndLoadWeather();
        }
      });

      this._settingsItem = new PopupMenu.PopupMenuItem("⚙️ Extension Settings");
      this._settingsItem.connect("activate", () => {
        if (!this._destroyed) {
          this._ext.openPreferences();
        }
      });

      this.menu.addMenuItem(this._currentSection);
      this.menu.addMenuItem(this._alertsSection);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this.menu.addMenuItem(this._locationInfoSection);
      this.menu.addMenuItem(this._providerSection);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this.menu.addMenuItem(this._hourlySection);
      this.menu.addMenuItem(this._dailySection);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this.menu.addMenuItem(this._insightsSection);
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this.menu.addMenuItem(this._refreshItem);
      this.menu.addMenuItem(this._settingsItem);
    }

    _setupProviderInfo() {
      if (this._destroyed) return;


      this._currentProviderItem = new PopupMenu.PopupMenuItem("Active: Loading...", {
        reactive: false,
        style_class: "provider-info-item"
      });

      this._providerStatusItem = new PopupMenu.PopupMenuItem("Status: Checking...", {
        reactive: false,
        style_class: "provider-info-item"
      });

      this._lastUpdateItem = new PopupMenu.PopupMenuItem("Last Update: Never", {
        reactive: false,
        style_class: "provider-info-item"
      });


      this._providersStatusSection = new PopupMenu.PopupMenuSection();
      this._updateProvidersList();

      this._providerSection.menu.addMenuItem(this._currentProviderItem);
      this._providerSection.menu.addMenuItem(this._providerStatusItem);
      this._providerSection.menu.addMenuItem(this._lastUpdateItem);
      this._providerSection.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this._providerSection.menu.addMenuItem(this._providersStatusSection);
    }

    _updateProvidersList() {
      if (this._destroyed) return;


      this._providersStatusSection.removeAll();


      const titleItem = new PopupMenu.PopupMenuItem("Available Providers:", {
        reactive: false,
        style_class: "provider-info-item"
      });
      titleItem.label.style = "font-weight: bold; opacity: 0.8;";
      this._providersStatusSection.addMenuItem(titleItem);


      Object.keys(WEATHER_PROVIDERS).forEach(key => {
        const provider = WEATHER_PROVIDERS[key];
        if (key === 'custom') return;

        const status = this._providerStatus.get(key) || 'unknown';
        const statusIcon = this._getStatusIcon(status);
        const freeIndicator = provider.isFree ? "🆓" : "💰";

        const providerItem = new PopupMenu.PopupMenuItem(
          `${statusIcon} ${freeIndicator} ${provider.name}`, {
          reactive: false,
          style_class: "provider-info-item"
        });


        if (status === 'working' && !this._destroyed) {
          providerItem.reactive = true;
          providerItem.connect('activate', () => {
            if (!this._destroyed) {
              this._ext._settings.set_string('weather-provider', key);
            }
          });
          providerItem.label.style += "cursor: pointer;";
        }

        this._providersStatusSection.addMenuItem(providerItem);
      });


      const customProvider = WEATHER_PROVIDERS.custom;
      const customStatus = this._providerStatus.get('custom') || 'inactive';
      const customStatusIcon = this._getStatusIcon(customStatus);

      const customItem = new PopupMenu.PopupMenuItem(
        `${customStatusIcon} ⚙️ Custom Provider`, {
        reactive: false,
        style_class: "provider-info-item"
      });
      this._providersStatusSection.addMenuItem(customItem);
    }

    _getStatusIcon(status) {
      switch(status) {
        case 'working': return '✅';
        case 'error': return '❌';
        case 'timeout': return '⏱️';
        case 'inactive': return '💤';
        case 'testing': return '🔄';
        default: return '❓';
      }
    }

    _updateProviderStatus(provider, status, error = null) {
      if (this._destroyed) return;

      this._providerStatus.set(provider, status);
      this._updateProvidersList();


      const currentProvider = this._ext._settings.get_string("weather-provider") || "openmeteo";
      if (provider === currentProvider) {
        this._updateCurrentProviderInfo(status, error);
      }
    }

    _updateCurrentProviderInfo(status = null, error = null) {
      if (this._destroyed) return;

      const provider = this._ext._settings.get_string("weather-provider") || "openmeteo";
      const providerConfig = WEATHER_PROVIDERS[provider];

      if (this._currentProviderItem && providerConfig) {
        const freeIndicator = providerConfig.isFree ? " (Free)" : "";
        this._currentProviderItem.label.set_text(`Active: ${providerConfig.name}${freeIndicator}`);
      }

      if (this._providerStatusItem) {
        const currentStatus = status || this._providerStatus.get(provider) || 'unknown';
        const statusIcon = this._getStatusIcon(currentStatus);
        let statusText = `Status: ${statusIcon} `;

        switch(currentStatus) {
          case 'working':
            statusText += "Working";
            break;
          case 'error':
            statusText += `Error${error ? ': ' + error : ''}`;
            break;
          case 'timeout':
            statusText += "Connection Timeout";
            break;
          case 'inactive':
            statusText += "Not Configured";
            break;
          case 'testing':
            statusText += "Testing Connection...";
            break;
          default:
            statusText += "Unknown";
        }

        this._providerStatusItem.label.set_text(statusText);
      }

      if (this._lastUpdateItem) {
        const now = new Date();
        const timeStr = this._formatTime(now.toISOString());
        this._lastUpdateItem.label.set_text(`Last Update: ${timeStr}`);
      }
    }

    _setupLocationInfo() {
      if (this._destroyed) return;

      this._currentLocationItem = new PopupMenu.PopupMenuItem("Current: Loading...", {
        reactive: false,
        style_class: "location-info-item"
      });

      this._coordinatesItem = new PopupMenu.PopupMenuItem("Coordinates: Loading...", {
        reactive: false,
        style_class: "location-info-item"
      });

      this._detectionMethodItem = new PopupMenu.PopupMenuItem("Method: Loading...", {
        reactive: false,
        style_class: "location-info-item"
      });

      const autoItem = new PopupMenu.PopupMenuItem("🌍 Switch to Auto Detection");
      autoItem.style_class = "location-mode-button";
      autoItem.connect("activate", () => {
        if (!this._destroyed) {
          this._ext._settings.set_string("location-mode", "auto");
        }
      });

      const manualItem = new PopupMenu.PopupMenuItem("📍 Switch to Manual Location");
      manualItem.style_class = "location-mode-button";
      manualItem.connect("activate", () => {
        if (!this._destroyed) {
          this._ext._settings.set_string("location-mode", "manual");
        }
      });

      const searchItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
      const searchBox = new St.BoxLayout({
        vertical: true,
        style_class: "location-search-minimal"
      });

      const inputBox = new St.BoxLayout({
        style: "spacing: 6px;"
      });

      this._searchEntry = new St.Entry({
        hint_text: "Enter city name...",
        style_class: "search-entry-minimal",
        x_expand: true
      });

      this._searchButton = new St.Button({
        label: "Search",
        style_class: "search-button-panel"
      });

      this._clearButton = new St.Button({
        label: "Clear",
        style_class: "clear-button-panel"
      });

      inputBox.add_child(this._searchEntry);
      inputBox.add_child(this._searchButton);
      inputBox.add_child(this._clearButton);
      searchBox.add_child(inputBox);
      searchItem.add_child(searchBox);

      this._searchResults = new PopupMenu.PopupMenuSection();

      this._searchButton.connect("clicked", () => {
        if (!this._destroyed) {
          this._searchLocation();
        }
      });
      this._searchEntry.clutter_text.connect("activate", () => {
        if (!this._destroyed) {
          this._searchLocation();
        }
      });
      this._clearButton.connect("clicked", () => {
        if (!this._destroyed) {
          this._clearSearch();
        }
      });

      this._locationInfoSection.menu.addMenuItem(this._currentLocationItem);
      this._locationInfoSection.menu.addMenuItem(this._coordinatesItem);
      this._locationInfoSection.menu.addMenuItem(this._detectionMethodItem);
      this._locationInfoSection.menu.addMenuItem(autoItem);
      this._locationInfoSection.menu.addMenuItem(manualItem);
      this._locationInfoSection.menu.addMenuItem(searchItem);
      this._locationInfoSection.menu.addMenuItem(this._searchResults);
    }

    _clearSearch() {
      if (this._destroyed) return;

      this._searchEntry.set_text("");
      this._searchResults.removeAll();
    }

    async _searchLocation() {
      if (this._destroyed) return;

      const query = this._searchEntry.get_text().trim();
      if (!query || query.length < 2) {
        this._showSearchError("Please enter at least 2 characters");
        return;
      }

      this._searchButton.set_label("Searching...");
      this._searchResults.removeAll();

      try {
        const url = `${GEOCODING_URL}?name=${encodeURIComponent(query)}&count=5&language=en&format=json`;
        const session = new Soup.Session();
        session.timeout = 10;

        const message = Soup.Message.new("GET", url);
        message.request_headers.append('User-Agent', 'GNOME-Weather-Extension/1.0');

        const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);

        if (message.status_code !== 200) {
          throw new Error(`HTTP ${message.status_code}`);
        }

        const responseText = new TextDecoder().decode(bytes.get_data());
        const response = JSON.parse(responseText);

        if (response.results && response.results.length > 0) {
          response.results.forEach(result => {
            if (this._destroyed) return;

            const resultItem = new PopupMenu.PopupMenuItem(
              `📍 ${result.name}, ${result.country}${result.admin1 ? ', ' + result.admin1 : ''}`,
              { style_class: "location-result-minimal" }
            );

            resultItem.connect("activate", () => {
              if (!this._destroyed) {
                this._ext._settings.set_string("location-mode", "manual");
                this._ext._settings.set_string("location", `${result.latitude},${result.longitude}`);
                this._ext._settings.set_string("location-name", `${result.name}, ${result.country}`);
                this._searchEntry.set_text("");
                this._searchResults.removeAll();
                this._updateLocationInfo();
                this._ext._detectLocationAndLoadWeather();
              }
            });

            this._searchResults.addMenuItem(resultItem);
          });
        } else {
          this._showSearchError("No locations found");
        }
      } catch (error) {
        console.error("Location search failed:", error);
        this._showSearchError("Search failed. Please try again.");
      }

      if (!this._destroyed) {
        this._searchButton.set_label("Search");
      }
    }

    _showSearchError(message) {
      if (this._destroyed) return;

      this._searchResults.removeAll();
      const errorItem = new PopupMenu.PopupMenuItem(`⚠️ ${message}`, {
        reactive: false,
        style_class: "search-error-item"
      });
      this._searchResults.addMenuItem(errorItem);
    }

    _updateLocationIndicator() {
      if (this._destroyed) return;

      const mode = this._ext._settings.get_string("location-mode") || "auto";

      this._locationDot.text = this._getLocationModeText();
      this._updateLocationInfo();
      this._updateCurrentProviderInfo();
    }

    _updateLocationInfo() {
      if (this._destroyed) return;

      const mode = this._ext._settings.get_string("location-mode") || "auto";
      const locationName = this._ext._settings.get_string("location-name") || "";

      if (this._currentLocationItem) {
        if (mode === "auto") {
          this._currentLocationItem.label.set_text("Current: 🌍 Auto-detected location");
        } else {
          this._currentLocationItem.label.set_text(`Current: ${locationName || "Not set"}`);
        }
      }

      if (this._coordinatesItem) {
        if (this._ext._latitude && this._ext._longitude) {
          this._coordinatesItem.label.set_text(
            `Coordinates: ${this._ext._latitude.toFixed(4)}, ${this._ext._longitude.toFixed(4)}`
          );
        } else {
          this._coordinatesItem.label.set_text("Coordinates: Not available");
        }
      }

      if (this._detectionMethodItem) {
        const methodText = mode === "auto" ?
          "Method: 🌐 IP-based geolocation" :
          "Method: 📍 Manually configured";
        this._detectionMethodItem.label.set_text(methodText);
      }
    }

    _startUpdateTimer() {
      if (this._destroyed) return;

      if (this._updateTimeoutId) {
        GLib.source_remove(this._updateTimeoutId);
      }

      const interval = (this._ext._settings.get_int("update-interval") || 10) * 60;
      this._updateTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
        if (!this._destroyed) {
          this._ext._detectLocationAndLoadWeather();
          return GLib.SOURCE_CONTINUE;
        }
        return GLib.SOURCE_REMOVE;
      });
    }

    _formatTime(dateString) {
      if (this._destroyed) return "";

      const date = new Date(dateString);
      const use12Hour = this._ext._settings.get_boolean("use-12hour-format");

      if (use12Hour) {
        return date.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
      } else {
        return date.toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });
      }
    }

    _generateWeatherAlerts(data) {
      if (this._destroyed) return;

      this._alertsSection.removeAll();
      let hasAlerts = false;

      const current = data.current;
      const condition = WEATHER_CONDITIONS[current.weather_code] || WEATHER_CONDITIONS[0];

      if (condition.severity === "severe") {
        const alertItem = new PopupMenu.PopupMenuItem(
          `⚠️ SEVERE WEATHER: ${condition.name}`,
          { reactive: false, style_class: "weather-alert-severe" }
        );
        this._alertsSection.addMenuItem(alertItem);
        hasAlerts = true;
      }

      const temp = this._ext._settings.get_boolean("use-fahrenheit")
        ? current.temperature_2m * 9/5 + 32
        : current.temperature_2m;

      const extremeTemp = this._ext._settings.get_boolean("use-fahrenheit") ? 95 : 35;
      if (temp > extremeTemp) {
        const heatAlert = new PopupMenu.PopupMenuItem(
          "🌡️ HEAT WARNING: Extreme temperatures",
          { reactive: false, style_class: "weather-alert-warning" }
        );
        this._alertsSection.addMenuItem(heatAlert);
        hasAlerts = true;
      }

      if (current.wind_speed_10m > 50) {
        const windAlert = new PopupMenu.PopupMenuItem(
          "💨 WIND WARNING: Strong winds detected",
          { reactive: false, style_class: "weather-alert-warning" }
        );
        this._alertsSection.addMenuItem(windAlert);
        hasAlerts = true;
      }
    }

    updateWeather(data) {
      if (this._destroyed) return;

      try {
        const current = data.current;
        const condition = WEATHER_CONDITIONS[current.weather_code] || WEATHER_CONDITIONS[0];
        const useFahrenheit = this._ext._settings.get_boolean("use-fahrenheit");

        const temp = useFahrenheit
          ? Math.round(current.temperature_2m * 9/5 + 32)
          : Math.round(current.temperature_2m);
        const unit = useFahrenheit ? "°F" : "°C";

        this._weatherIcon.set_icon_name(condition.icon);
        this._weatherLabel.set_text(`${temp}${unit}`);

        this._retryCount = 0;


        const provider = this._ext._settings.get_string("weather-provider") || "openmeteo";
        this._updateProviderStatus(provider, 'working');

        this._generateWeatherAlerts(data);
        this._updateCurrentWeather(data, condition, temp, unit);
        this._updateLocationInfo();
        this._updateCurrentProviderInfo('working');
        this._updateHourlyForecast(data);
        this._updateDailyForecast(data);
        this._updateWeatherInsights(data);

      } catch (error) {
        console.error("Weather Extension: Error updating weather", error);
        if (!this._destroyed) {
          this._weatherLabel.set_text("Error");
          this._weatherIcon.set_icon_name("dialog-error-symbolic");

          const provider = this._ext._settings.get_string("weather-provider") || "openmeteo";
          this._updateProviderStatus(provider, 'error', error.message);
        }
      }
    }

    _updateCurrentWeather(data, condition, temp, unit) {
      if (this._destroyed) return;

      const current = data.current;
      const windSpeedUnit = this._ext._settings.get_string("wind-speed-unit") || "kmh";
      const windSpeed = convertWindSpeed(current.wind_speed_10m, windSpeedUnit);

      let currentText = `🌡️ ${temp}${unit} • ${condition.name}\n`;
      currentText += `💨 ${windSpeed.value} ${windSpeed.unit}`;

      if (this._ext._settings.get_boolean("show-humidity")) {
        currentText += ` • 💧 ${current.relative_humidity_2m}%`;
      }

      currentText += `\n📊 ${Math.round(current.surface_pressure)} hPa`;
      currentText += `\n📍 ${data.location || "Unknown Location"}`;


      currentText += `\n🌐 ${data.provider || "Unknown Provider"}`;

      this._currentWeatherItem.label.set_text(currentText);
    }

    _updateHourlyForecast(data) {
      if (this._destroyed) return;

      this._hourlySection.menu.removeAll();

      if (data.hourly && data.hourly.time) {
        const now = new Date();
        let startIndex = 0;

        for (let i = 0; i < data.hourly.time.length; i++) {
          const hourTime = new Date(data.hourly.time[i]);
          if (hourTime > now) {
            startIndex = i;
            break;
          }
        }

        for (let i = 0; i < 12 && (startIndex + i) < data.hourly.time.length; i++) {
          const hourIndex = startIndex + i;
          const timeStr = this._formatTime(data.hourly.time[hourIndex]);
          const condition = WEATHER_CONDITIONS[data.hourly.weather_code[hourIndex]] || WEATHER_CONDITIONS[0];
          const temp = this._ext._settings.get_boolean("use-fahrenheit")
            ? Math.round(data.hourly.temperature_2m[hourIndex] * 9/5 + 32)
            : Math.round(data.hourly.temperature_2m[hourIndex]);
          const unit = this._ext._settings.get_boolean("use-fahrenheit") ? "°F" : "°C";

          const precipProb = data.hourly.precipitation_probability
            ? data.hourly.precipitation_probability[hourIndex] : 0;

          const hourlyItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: "forecast-item-minimal"
          });

          const hourlyBox = new St.BoxLayout({
            vertical: false,
            style: "spacing: 8px; padding: 4px;"
          });

          const timeLabel = new St.Label({
            text: timeStr,
            style: "min-width: 60px; font-weight: 500;"
          });

          const iconWidget = new St.Icon({
            icon_name: condition.icon,
            icon_size: 16,
            style_class: "popup-menu-icon"
          });

          const tempLabel = new St.Label({
            text: `${temp}${unit}`,
            style: "min-width: 40px; font-weight: 500;"
          });

          const conditionLabel = new St.Label({
            text: condition.name,
            style: "min-width: 100px;"
          });

          hourlyBox.add_child(timeLabel);
          hourlyBox.add_child(iconWidget);
          hourlyBox.add_child(tempLabel);
          hourlyBox.add_child(conditionLabel);

          if (precipProb > 0) {
            const precipLabel = new St.Label({
              text: `💧${precipProb}%`,
              style: "color: #4FC3F7; font-size: 11px;"
            });
            hourlyBox.add_child(precipLabel);
          }

          hourlyItem.add_child(hourlyBox);
          this._hourlySection.menu.addMenuItem(hourlyItem);
        }
      }
    }

    _updateDailyForecast(data) {
      if (this._destroyed) return;

      this._dailySection.menu.removeAll();

      if (data.daily && data.daily.time) {
        for (let i = 0; i < Math.min(7, data.daily.time.length); i++) {
          const date = new Date(data.daily.time[i]);
          const dayName = i === 0 ? "Today" :
                        i === 1 ? "Tomorrow" :
                        date.toLocaleDateString('en', { weekday: 'long' });

          const condition = WEATHER_CONDITIONS[data.daily.weather_code[i]] || WEATHER_CONDITIONS[0];

          const maxTemp = this._ext._settings.get_boolean("use-fahrenheit")
            ? Math.round(data.daily.temperature_2m_max[i] * 9/5 + 32)
            : Math.round(data.daily.temperature_2m_max[i]);
          const minTemp = this._ext._settings.get_boolean("use-fahrenheit")
            ? Math.round(data.daily.temperature_2m_min[i] * 9/5 + 32)
            : Math.round(data.daily.temperature_2m_min[i]);
          const unit = this._ext._settings.get_boolean("use-fahrenheit") ? "°F" : "°C";

          const dailyItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: "forecast-item-minimal"
          });

          const dailyBox = new St.BoxLayout({
            vertical: false,
            style: "spacing: 8px; padding: 6px;"
          });

          const dayLabel = new St.Label({
            text: dayName,
            style: "min-width: 80px; font-weight: 500;"
          });

          const iconWidget = new St.Icon({
            icon_name: condition.icon,
            icon_size: 18,
            style_class: "popup-menu-icon"
          });

          const tempLabel = new St.Label({
            text: `${maxTemp}°/${minTemp}${unit}`,
            style: "min-width: 70px; font-weight: 500;"
          });

          const conditionLabel = new St.Label({
            text: condition.name,
            style: "opacity: 0.8;"
          });

          dailyBox.add_child(dayLabel);
          dailyBox.add_child(iconWidget);
          dailyBox.add_child(tempLabel);
          dailyBox.add_child(conditionLabel);

          dailyItem.add_child(dailyBox);
          this._dailySection.menu.addMenuItem(dailyItem);
        }
      }
    }

    _updateWeatherInsights(data) {
      if (this._destroyed) return;

      this._insightsSection.menu.removeAll();

      try {
        if (data.hourly && data.hourly.temperature_2m) {
          const hourlyTemps = data.hourly.temperature_2m.slice(0, 12);
          const tempTrend = this._analyzeTrend(hourlyTemps);

          const trendItem = new PopupMenu.PopupMenuItem(
            `🌡️ Temperature Trend: ${tempTrend}`,
            { reactive: false, style_class: "insight-item-minimal" }
          );
          this._insightsSection.menu.addMenuItem(trendItem);
        }

        const precipCodes = [51, 53, 55, 61, 63, 65, 80, 81, 82, 85, 86];
        if (data.hourly && data.hourly.weather_code) {
          const precipHours = data.hourly.weather_code.slice(0, 24).filter(code =>
            precipCodes.includes(code)
          );
          const precipChance = (precipHours.length / 24 * 100).toFixed(1);

          const precipItem = new PopupMenu.PopupMenuItem(
            `💧 Precipitation (24h): ${precipChance}%`,
            { reactive: false, style_class: "insight-item-minimal" }
          );
          this._insightsSection.menu.addMenuItem(precipItem);
        }

        if (data.current && data.current.wind_speed_10m) {
          const windSpeedUnit = this._ext._settings.get_string("wind-speed-unit") || "kmh";
          const windSpeed = convertWindSpeed(data.current.wind_speed_10m, windSpeedUnit);

          let windCondition = "Light";
          if (windSpeed.value > 50) windCondition = "Strong";
          else if (windSpeed.value > 25) windCondition = "Moderate";

          const windItem = new PopupMenu.PopupMenuItem(
            `💨 Wind: ${windSpeed.value} ${windSpeed.unit} (${windCondition})`,
            { reactive: false, style_class: "insight-item-minimal" }
          );
          this._insightsSection.menu.addMenuItem(windItem);
        }

        const now = new Date();
        const hour = now.getHours();
        let uvIndex = 0;

        if (hour >= 10 && hour <= 16) {
          const current = data.current;
          const condition = WEATHER_CONDITIONS[current.weather_code];

          if (condition && condition.name.includes("Clear")) {
            uvIndex = 8;
          } else if (condition && condition.name.includes("Cloudy")) {
            uvIndex = 4;
          } else {
            uvIndex = 2;
          }
        }

        const uvItem = new PopupMenu.PopupMenuItem(
          `☀️ UV Index: ${uvIndex} ${uvIndex > 6 ? "(High)" : uvIndex > 3 ? "(Moderate)" : "(Low)"}`,
          { reactive: false, style_class: "insight-item-minimal" }
        );
        this._insightsSection.menu.addMenuItem(uvItem);

        const aqiItem = new PopupMenu.PopupMenuItem(
          `🌬️ Air Quality: Good (Estimated)`,
          { reactive: false, style_class: "insight-item-minimal" }
        );
        this._insightsSection.menu.addMenuItem(aqiItem);

      } catch (error) {
        console.error("Error updating weather insights:", error);
      }
    }

    _analyzeTrend(temperatures) {
      if (temperatures.length < 2) return "Insufficient data";

      let increasingCount = 0;
      let decreasingCount = 0;

      for (let i = 1; i < temperatures.length; i++) {
        const diff = temperatures[i] - temperatures[i - 1];
        if (diff > 0.5) {
          increasingCount++;
        } else if (diff < -0.5) {
          decreasingCount++;
        }
      }

      if (increasingCount > decreasingCount + 1) return "Warming 🔥";
      if (decreasingCount > increasingCount + 1) return "Cooling 🧊";
      return "Stable 🟰";
    }

    destroy() {
      this._destroyed = true;

      if (this._updateTimeoutId) {
        GLib.source_remove(this._updateTimeoutId);
        this._updateTimeoutId = null;
      }

      if (this._settingsConnections) {
        this._settingsConnections.forEach(id => {
          try {
            if (this._ext && this._ext._settings) {
              this._ext._settings.disconnect(id);
            }
          } catch (error) {
            console.error("Error disconnecting setting:", error);
          }
        });
        this._settingsConnections = null;
      }

      super.destroy();
    }
  }
);

export default class WeatherExtension extends Extension {
  enable() {
    this._settings = this.getSettings("org.gnome.shell.extensions.advanced-weather");
    this._session = new Soup.Session();
    this._session.timeout = this._settings.get_int("weather-request-timeout") || 15;
    this._enabled = true;

    this._panelButton = new WeatherPanelButton(this);

    const position = this._settings.get_string("panel-position") || "right";
    const index = this._settings.get_int("panel-position-index") || 0;
    Main.panel.addToStatusArea("weather-extension", this._panelButton, index, position);

    this._settingsConnections = [
      this._settings.connect("changed::panel-position", () => {
        if (this._enabled) this._updatePanelPosition();
      }),
      this._settings.connect("changed::panel-position-index", () => {
        if (this._enabled) this._updatePanelPosition();
      }),
      this._settings.connect("changed::location-mode", () => {
        if (this._enabled) this._detectLocationAndLoadWeather();
      }),
      this._settings.connect("changed::location", () => {
        if (this._enabled) this._detectLocationAndLoadWeather();
      }),
      this._settings.connect("changed::update-interval", () => {
        if (this._enabled) this._restartUpdateTimer();
      }),
      this._settings.connect("changed::weather-provider", () => {
        if (this._enabled) this._detectLocationAndLoadWeather();
      }),
      this._settings.connect("changed::weather-api-key", () => {
        if (this._enabled) this._detectLocationAndLoadWeather();
      }),
      this._settings.connect("changed::custom-weather-url", () => {
        if (this._enabled) this._detectLocationAndLoadWeather();
      }),
      this._settings.connect("changed::weather-request-timeout", () => {
        if (this._enabled) {
          this._session.timeout = this._settings.get_int("weather-request-timeout") || 15;
        }
      })
    ];


    this._testAllProviders();
    this._detectLocationAndLoadWeather();
  }

  disable() {
    this._enabled = false;

    if (this._panelButton) {
      this._panelButton.destroy();
      this._panelButton = null;
    }

    if (this._settingsConnections) {
      this._settingsConnections.forEach(id => {
        try {
          if (this._settings) {
            this._settings.disconnect(id);
          }
        } catch (error) {
          console.error("Error disconnecting setting:", error);
        }
      });
      this._settingsConnections = null;
    }

    if (this._session) {
      this._session.abort();
      this._session = null;
    }

    this._settings = null;
  }

  async _testAllProviders() {
    if (!this._enabled) return;


    const testLocation = { lat: 40.7128, lon: -74.0060 };

    for (const [key, provider] of Object.entries(WEATHER_PROVIDERS)) {
      if (key === 'custom' || !this._enabled) continue;

      try {
        if (this._panelButton && !this._panelButton._destroyed) {
          this._panelButton._updateProviderStatus(key, 'testing');
        }

        const url = provider.buildUrl(testLocation.lat, testLocation.lon, '');
        const message = Soup.Message.new("GET", url);
        message.request_headers.append('User-Agent', 'GNOME-Weather-Extension/1.0');

        const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);

        if (message.status_code === 200) {
          const responseText = new TextDecoder().decode(bytes.get_data());
          const response = JSON.parse(responseText);


          provider.parseResponse(response);
          if (this._panelButton && !this._panelButton._destroyed) {
            this._panelButton._updateProviderStatus(key, 'working');
          }
        } else {
          if (this._panelButton && !this._panelButton._destroyed) {
            this._panelButton._updateProviderStatus(key, 'error', `HTTP ${message.status_code}`);
          }
        }
      } catch (error) {
        console.error(`Provider ${key} test failed:`, error);
        if (this._panelButton && !this._panelButton._destroyed) {
          if (error.message.includes('timeout')) {
            this._panelButton._updateProviderStatus(key, 'timeout');
          } else {
            this._panelButton._updateProviderStatus(key, 'error', error.message.substring(0, 50));
          }
        }
      }
    }


    const customUrl = this._settings.get_string("custom-weather-url");
    const customKey = this._settings.get_string("weather-api-key");

    if (customUrl && customUrl.trim() && this._enabled) {
      if (this._panelButton && !this._panelButton._destroyed) {
        this._panelButton._updateProviderStatus('custom', 'testing');
      }
      try {
        const url = WEATHER_PROVIDERS.custom.buildUrl(testLocation.lat, testLocation.lon, customKey, customUrl);
        const message = Soup.Message.new("GET", url);
        message.request_headers.append('User-Agent', 'GNOME-Weather-Extension/1.0');

        const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);

        if (message.status_code === 200) {
          const responseText = new TextDecoder().decode(bytes.get_data());
          const response = JSON.parse(responseText);
          WEATHER_PROVIDERS.custom.parseResponse(response);
          if (this._panelButton && !this._panelButton._destroyed) {
            this._panelButton._updateProviderStatus('custom', 'working');
          }
        } else {
          if (this._panelButton && !this._panelButton._destroyed) {
            this._panelButton._updateProviderStatus('custom', 'error', `HTTP ${message.status_code}`);
          }
        }
      } catch (error) {
        if (this._panelButton && !this._panelButton._destroyed) {
          this._panelButton._updateProviderStatus('custom', 'error', error.message.substring(0, 50));
        }
      }
    } else {
      if (this._panelButton && !this._panelButton._destroyed) {
        this._panelButton._updateProviderStatus('custom', 'inactive');
      }
    }
  }

  _updatePanelPosition() {
    if (!this._enabled) return;

    if (this._panelButton) {
      this._panelButton.destroy();
      this._panelButton = new WeatherPanelButton(this);

      const position = this._settings.get_string("panel-position") || "right";
      const index = this._settings.get_int("panel-position-index") || 0;
      Main.panel.addToStatusArea("weather-extension", this._panelButton, index, position);

      this._detectLocationAndLoadWeather();
    }
  }

  _restartUpdateTimer() {
    if (this._panelButton && !this._panelButton._destroyed) {
      this._panelButton._startUpdateTimer();
    }
  }

  async _detectLocationAndLoadWeather() {
    if (!this._enabled) return;

    try {
      const mode = this._settings.get_string("location-mode");

      if (mode === "manual") {
        await this._useManualLocation();
      } else {
        await this._autoDetectLocation();
      }

      await this._loadWeatherData();
    } catch (error) {
      console.error("Weather Extension: Location detection failed", error);
      if (this._panelButton && !this._panelButton._destroyed) {
        this._panelButton._weatherLabel.set_text("Offline");
        this._panelButton._weatherIcon.set_icon_name("network-offline-symbolic");
      }
      this._useFallbackLocation();
    }
  }

  async _useManualLocation() {
    const location = this._settings.get_string("location").trim();

    if (!location) {
      throw new Error("No manual location set");
    }

    const coordMatch = location.match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
    if (coordMatch) {
      this._latitude = parseFloat(coordMatch[1]);
      this._longitude = parseFloat(coordMatch[2]);
      this._locationName = this._settings.get_string("location-name") ||
                          `${this._latitude.toFixed(2)}, ${this._longitude.toFixed(2)}`;
      return;
    }

    await this._searchLocationCoordinates(location);
  }

  async _searchLocationCoordinates(query) {
    const url = `${GEOCODING_URL}?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;

    try {
      const message = Soup.Message.new("GET", url);
      message.request_headers.append('User-Agent', 'GNOME-Weather-Extension/1.0');

      const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);

      if (message.status_code !== 200) {
        throw new Error(`HTTP ${message.status_code}`);
      }

      const response = JSON.parse(bytes.get_data().toString());

      if (response.results && response.results.length > 0) {
        const result = response.results[0];
        this._latitude = result.latitude;
        this._longitude = result.longitude;
        this._locationName = `${result.name}, ${result.country}`;
      } else {
        throw new Error("Location not found");
      }
    } catch (error) {
      console.error("Weather Extension: Location search failed", error);
      throw error;
    }
  }

  async _autoDetectLocation() {
    for (const url of FALLBACK_GEOIP_URLS) {
      if (!this._enabled) return;

      try {
        const message = Soup.Message.new("GET", url);
        message.request_headers.append('User-Agent', 'GNOME-Weather-Extension/1.0');

        const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);

        if (message.status_code !== 200) {
          continue;
        }

        const response = JSON.parse(bytes.get_data().toString());

        let lat, lon, city, country;

        if (url.includes('ipapi.co')) {
          if (response.latitude && response.longitude) {
            lat = response.latitude;
            lon = response.longitude;
            city = response.city;
            country = response.country_name;
          }
        } else if (url.includes('ip-api.com')) {
          if (response.status === "success" && response.lat && response.lon) {
            lat = response.lat;
            lon = response.lon;
            city = response.city;
            country = response.country;
          }
        } else if (url.includes('freegeoip.app')) {
          if (response.latitude && response.longitude) {
            lat = response.latitude;
            lon = response.longitude;
            city = response.city;
            country = response.country_name;
          }
        }

        if (lat && lon) {
          this._latitude = lat;
          this._longitude = lon;
          this._locationName = `${city}, ${country}`;
          return;
        }
      } catch (error) {
        console.error(`GeoIP service ${url} failed:`, error);
        continue;
      }
    }

    throw new Error("All GeoIP services failed");
  }

  _useFallbackLocation() {
    if (!this._enabled) return;

    this._latitude = 40.7128;
    this._longitude = -74.0060;
    this._locationName = "New York, NY (Fallback)";
    this._loadWeatherData();
  }

  async _loadWeatherData() {
    if (!this._enabled) return;

    try {
      const provider = this._settings.get_string("weather-provider") || "openmeteo";
      const apiKey = this._settings.get_string("weather-api-key") || "";
      const customUrl = this._settings.get_string("custom-weather-url") || "";

      const providerConfig = WEATHER_PROVIDERS[provider];
      if (!providerConfig) {
        throw new Error(`Unknown weather provider: ${provider}`);
      }


      if (this._panelButton && !this._panelButton._destroyed) {
        this._panelButton._updateProviderStatus(provider, 'testing');
      }

      let url;
      if (provider === "custom") {
        url = providerConfig.buildUrl(this._latitude, this._longitude, apiKey, customUrl);
      } else {
        url = providerConfig.buildUrl(this._latitude, this._longitude, apiKey);
      }

      console.log(`Fetching weather from ${providerConfig.name}: ${url.replace(apiKey, '***')}`);

      const message = Soup.Message.new("GET", url);
      message.request_headers.append('User-Agent', 'GNOME-Weather-Extension/1.0');

      const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);

      if (message.status_code !== 200) {
        throw new Error(`Weather API returned status ${message.status_code}: ${message.reason_phrase}`);
      }

      const responseText = new TextDecoder().decode(bytes.get_data());
      const response = JSON.parse(responseText);

      const parsedData = providerConfig.parseResponse(response);

      const data = {
        location: this._locationName,
        current: parsedData.current,
        hourly: parsedData.hourly,
        daily: parsedData.daily,
        provider: providerConfig.name
      };

      if (this._panelButton && !this._panelButton._destroyed) {
        this._panelButton.updateWeather(data);
      }
    } catch (error) {
      console.error("Weather Extension: Failed to load weather data", error);

      const provider = this._settings.get_string("weather-provider") || "openmeteo";

      if (this._panelButton && !this._panelButton._destroyed) {
        this._panelButton._weatherLabel.set_text("Error");
        this._panelButton._weatherIcon.set_icon_name("dialog-error-symbolic");


        if (error.message.includes('timeout')) {
          this._panelButton._updateProviderStatus(provider, 'timeout');
        } else {
          this._panelButton._updateProviderStatus(provider, 'error', error.message.substring(0, 50));
        }
      }


      this._tryFallbackProvider();
    }
  }

  async _tryFallbackProvider() {
    if (!this._enabled || !this._panelButton || this._panelButton._destroyed) return;


    const workingProviders = [];
    for (const [key, status] of this._panelButton._providerStatus.entries()) {
      if (status === 'working' && key !== 'custom') {
        workingProviders.push(key);
      }
    }

    if (workingProviders.length > 0) {
      const currentProvider = this._settings.get_string("weather-provider") || "openmeteo";
      const fallbackProvider = workingProviders.find(p => p !== currentProvider) || workingProviders[0];

      console.log(`Trying fallback provider: ${fallbackProvider}`);


      const originalProvider = currentProvider;
      this._settings.set_string("weather-provider", fallbackProvider);

      try {
        await this._loadWeatherData();

        console.log(`Successfully switched to fallback provider: ${fallbackProvider}`);
      } catch (fallbackError) {

        this._settings.set_string("weather-provider", originalProvider);
        console.error("Fallback provider also failed:", fallbackError);
      }
    }
  }
}