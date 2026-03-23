let _gettext = (s) => s;
export function setGettext(fn) {
  _gettext = fn;
}
const _ = (s) => _gettext(s);

export const WEATHER_PROVIDERS = {
  openmeteo: {
    name: "Open-Meteo",
    description: "Free weather API – No registration required",
    baseUrl: "https://api.open-meteo.com/v1/forecast",
    requiresApiKey: false,
    isFree: true,
    rateLimit: "10,000 requests/day",
    supportedParams: [
      "temperature_2m",
      "relative_humidity_2m",
      "weather_code",
      "wind_speed_10m",
      "surface_pressure",
    ],
    buildUrl(lat, lon, _apiKey) {
      const params = [
        `latitude=${lat}`,
        `longitude=${lon}`,
        "current=temperature_2m,relative_humidity_2m,apparent_temperature,surface_pressure,weather_code,wind_speed_10m,wind_direction_10m",
        "hourly=temperature_2m,weather_code,precipitation_probability,wind_speed_10m",
        "daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset",
        "timezone=auto",
        "forecast_days=7",
      ];
      return `${this.baseUrl}?${params.join("&")}`;
    },
    parseResponse(response) {
      if (!response.current) throw new Error("Invalid Open-Meteo response");
      return {
        current: response.current,
        hourly: response.hourly ?? null,
        daily: response.daily ?? null,
      };
    },
  },

  meteosource: {
    name: "Meteosource",
    description: "Free tier – 400 calls/day without API key",
    baseUrl: "https://www.meteosource.com/api/v1/free/point",
    requiresApiKey: false,
    isFree: true,
    rateLimit: "400 requests/day (free tier)",
    supportedParams: [
      "temperature",
      "humidity",
      "weather_icon",
      "wind_speed",
      "pressure",
    ],
    buildUrl(lat, lon, _apiKey) {
      return `${this.baseUrl}?lat=${lat}&lon=${lon}&sections=current%2Chourly%2Cdaily&timezone=UTC&language=en&units=metric`;
    },
    parseResponse(response) {
      if (!response.current) throw new Error("Invalid Meteosource response");
      return {
        current: {
          temperature_2m: response.current.temperature,
          relative_humidity_2m: response.current.humidity,
          surface_pressure: response.current.pressure,
          weather_code: this._convertCode(response.current.icon_num),
          wind_speed_10m: (response.current.wind?.speed ?? 0) * 3.6,
          wind_direction_10m: response.current.wind?.angle ?? 0,
        },
        hourly: response.hourly
          ? {
              time: response.hourly.data.map((h) => h.date),
              temperature_2m: response.hourly.data.map((h) => h.temperature),
              weather_code: response.hourly.data.map((h) =>
                this._convertCode(h.icon_num),
              ),
              precipitation_probability: response.hourly.data.map(
                (h) => h.precipitation?.total ?? 0,
              ),
              wind_speed_10m: response.hourly.data.map(
                (h) => (h.wind?.speed ?? 0) * 3.6,
              ),
            }
          : null,
        daily: response.daily
          ? {
              time: response.daily.data.map((d) => d.day),
              weather_code: response.daily.data.map((d) =>
                this._convertCode(d.icon),
              ),
              temperature_2m_max: response.daily.data.map(
                (d) => d.all_day?.temperature_max ?? 0,
              ),
              temperature_2m_min: response.daily.data.map(
                (d) => d.all_day?.temperature_min ?? 0,
              ),
            }
          : null,
      };
    },
    _convertCode(n) {
      return (
        {
          1: 0,
          2: 1,
          3: 2,
          4: 3,
          5: 3,
          6: 45,
          7: 61,
          8: 63,
          9: 65,
          10: 80,
          11: 71,
          12: 73,
          13: 75,
          14: 95,
        }[n] ?? 0
      );
    },
  },

  wttr: {
    name: "Wttr.in",
    description: "Free console weather service – No limits",
    baseUrl: "https://wttr.in",
    requiresApiKey: false,
    isFree: true,
    rateLimit: "No limits",
    supportedParams: [
      "temp_C",
      "humidity",
      "weatherCode",
      "windspeedKmph",
      "pressure",
    ],
    buildUrl(lat, lon, _apiKey) {
      return `${this.baseUrl}/${lat},${lon}?format=j1`;
    },
    parseResponse(response) {
      if (!response.current_condition)
        throw new Error("Invalid wttr.in response");
      const c = response.current_condition[0];
      const weather = response.weather ?? [];
      return {
        current: {
          temperature_2m: parseInt(c.temp_C),
          relative_humidity_2m: parseInt(c.humidity),
          surface_pressure: parseInt(c.pressure),
          weather_code: this._convertCode(c.weatherCode),
          wind_speed_10m: parseInt(c.windspeedKmph),
          wind_direction_10m: this._windDir(c.winddir16Point),
        },
        hourly:
          weather.length > 0
            ? {
                time: weather.flatMap((day) =>
                  day.hourly.map((h) => {
                    const t = h.time.padStart(4, "0");
                    return `${day.date}T${t.slice(0, 2)}:${t.slice(2, 4)}:00`;
                  }),
                ),
                temperature_2m: weather.flatMap((d) =>
                  d.hourly.map((h) => parseInt(h.tempC)),
                ),
                weather_code: weather.flatMap((d) =>
                  d.hourly.map((h) => this._convertCode(h.weatherCode)),
                ),
                precipitation_probability: weather.flatMap((d) =>
                  d.hourly.map((h) => parseInt(h.chanceofrain)),
                ),
                wind_speed_10m: weather.flatMap((d) =>
                  d.hourly.map((h) => parseInt(h.windspeedKmph)),
                ),
              }
            : null,
        daily:
          weather.length > 0
            ? {
                time: weather.map((d) => d.date),
                weather_code: weather.map((d) =>
                  this._convertCode(d.hourly[0]?.weatherCode ?? 113),
                ),
                temperature_2m_max: weather.map((d) => parseInt(d.maxtempC)),
                temperature_2m_min: weather.map((d) => parseInt(d.mintempC)),
              }
            : null,
      };
    },
    _convertCode(code) {
      return (
        {
          113: 0,
          116: 1,
          119: 2,
          122: 3,
          143: 45,
          248: 45,
          176: 61,
          263: 51,
          266: 53,
          281: 55,
          284: 55,
          293: 61,
          296: 61,
          299: 63,
          302: 63,
          305: 65,
          308: 65,
          311: 65,
          314: 65,
          317: 51,
          320: 55,
          323: 71,
          326: 71,
          329: 73,
          332: 73,
          335: 75,
          338: 75,
          350: 77,
          353: 80,
          356: 81,
          359: 82,
          362: 85,
          365: 85,
          368: 85,
          371: 86,
          374: 77,
          377: 77,
          386: 95,
          389: 95,
          392: 95,
          395: 95,
        }[parseInt(code)] ?? 0
      );
    },
    _windDir(dir) {
      return (
        {
          N: 0,
          NNE: 22.5,
          NE: 45,
          ENE: 67.5,
          E: 90,
          ESE: 112.5,
          SE: 135,
          SSE: 157.5,
          S: 180,
          SSW: 202.5,
          SW: 225,
          WSW: 247.5,
          W: 270,
          WNW: 292.5,
          NW: 315,
          NNW: 337.5,
        }[dir] ?? 0
      );
    },
  },

  openweathermap: {
    name: "OpenWeatherMap",
    description: "Comprehensive weather data – API key required",
    baseUrl: "https://api.openweathermap.org/data/2.5/weather",
    requiresApiKey: true,
    isFree: false,
    rateLimit: "1,000 requests/day (free tier)",
    supportedParams: ["temp", "humidity", "weather", "wind_speed", "pressure"],
    buildUrl(lat, lon, apiKey) {
      if (!apiKey?.trim())
        throw new Error("OpenWeatherMap requires an API key");
      return `${this.baseUrl}?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`;
    },
    parseResponse(response) {
      if (!response.main) throw new Error("Invalid OpenWeatherMap response");
      return {
        current: {
          temperature_2m: response.main.temp,
          relative_humidity_2m: response.main.humidity,
          surface_pressure: response.main.pressure,
          weather_code: this._convertCode(response.weather?.[0]?.id ?? 800),
          wind_speed_10m: (response.wind?.speed ?? 0) * 3.6,
          wind_direction_10m: response.wind?.deg ?? 0,
        },
        hourly: null,
        daily: null,
      };
    },
    _convertCode(id) {
      if (id === 800) return 0;
      if (id >= 801 && id <= 804) return id - 799;
      if (id === 701 || id === 741) return 45;
      if (id >= 500 && id < 505) return [61, 63, 65, 65, 65][id - 500] ?? 61;
      if (id >= 520 && id < 523) return [80, 81, 82][id - 520] ?? 80;
      if (id >= 600 && id < 605) return [71, 73, 75, 77, 77][id - 600] ?? 71;
      if (id >= 611 && id < 623) return 77;
      if (id >= 200 && id < 300) return 95;
      if (id >= 300 && id < 400) return 51;
      return 0;
    },
  },

  weatherapi: {
    name: "WeatherAPI",
    description: "Accurate weather with free tier – API key required",
    baseUrl: "https://api.weatherapi.com/v1/current.json",
    requiresApiKey: true,
    isFree: false,
    rateLimit: "1,000,000 calls/month (free tier)",
    supportedParams: [
      "temp_c",
      "humidity",
      "condition",
      "wind_kph",
      "pressure_mb",
    ],
    buildUrl(lat, lon, apiKey) {
      if (!apiKey?.trim()) throw new Error("WeatherAPI requires an API key");
      return `${this.baseUrl}?key=${apiKey}&q=${lat},${lon}&aqi=no`;
    },
    parseResponse(response) {
      if (!response.current) throw new Error("Invalid WeatherAPI response");
      return {
        current: {
          temperature_2m: response.current.temp_c,
          relative_humidity_2m: response.current.humidity,
          surface_pressure: response.current.pressure_mb,
          weather_code: this._convertCode(
            response.current.condition?.code ?? 1000,
          ),
          wind_speed_10m: response.current.wind_kph,
          wind_direction_10m: response.current.wind_degree ?? 0,
        },
        hourly: null,
        daily: null,
      };
    },
    _convertCode(code) {
      const map = {
        1000: 0,
        1003: 1,
        1006: 2,
        1009: 3,
        1030: 45,
        1135: 45,
        1147: 48,
        1063: 61,
        1180: 61,
        1183: 61,
        1186: 63,
        1189: 63,
        1192: 65,
        1195: 65,
        1150: 51,
        1153: 51,
        1168: 55,
        1171: 55,
        1066: 71,
        1210: 71,
        1213: 73,
        1216: 73,
        1219: 75,
        1222: 75,
        1225: 75,
        1069: 77,
        1204: 77,
        1207: 77,
        1114: 77,
        1117: 77,
        1072: 55,
        1087: 95,
        1273: 95,
        1276: 95,
        1279: 95,
        1282: 95,
        1237: 77,
        1261: 85,
        1264: 86,
        1246: 82,
        1243: 81,
        1240: 80,
      };
      return map[code] ?? 0;
    },
  },

  // Weather Underground / custom JSON endpoint

  custom: {
    name: "Custom / Weather Underground",
    description: "Your own API URL or a Weather Underground PWS endpoint",
    baseUrl: "",
    requiresApiKey: false,
    isFree: false,
    rateLimit: "Depends on provider",
    supportedParams: [],
    buildUrl(lat, lon, apiKey, customUrl) {
      if (!customUrl?.trim()) throw new Error("Custom URL is required");

      let url = customUrl
        .replace("{lat}", lat)
        .replace("{latitude}", lat)
        .replace("{lon}", lon)
        .replace("{longitude}", lon);

      if (apiKey?.trim()) {
        const hasKey =
          url.includes("apiKey=") ||
          url.includes("api_key=") ||
          url.includes("key=") ||
          url.includes("appid=");
        if (!hasKey) {
          url += (url.includes("?") ? "&" : "?") + `apiKey=${apiKey}`;
        }
      }
      return url;
    },
    parseResponse(response) {
      if (response.current?.temperature_2m !== undefined) {
        return {
          current: response.current,
          hourly: response.hourly ?? null,
          daily: response.daily ?? null,
        };
      }

      if (response.observations?.[0]) {
        const obs = response.observations[0];
        const metric = obs.metric ?? obs.metric_si ?? {};
        const imperial = obs.imperial ?? {};
        const tempC =
          metric.temp ??
          (imperial.temp !== undefined
            ? ((imperial.temp - 32) * 5) / 9
            : undefined);
        const humidity = obs.humidity ?? obs.relativeHumidity;
        const pressure = metric.pressure ?? imperial.pressure ?? 1013;
        const windKph =
          metric.windSpeed ??
          (imperial.windSpeed !== undefined ? imperial.windSpeed * 1.60934 : 0);
        const windDeg = obs.winddir ?? 0;

        if (tempC === undefined)
          throw new Error("Weather Underground response has no temperature");

        return {
          current: {
            temperature_2m: tempC,
            relative_humidity_2m: humidity ?? 50,
            surface_pressure: pressure,
            weather_code: 0,
            wind_speed_10m: windKph,
            wind_direction_10m: windDeg,
          },
          hourly: null,
          daily: null,
        };
      }

      if (response.main?.temp !== undefined) {
        return {
          current: {
            temperature_2m: response.main.temp,
            relative_humidity_2m: response.main.humidity ?? 50,
            surface_pressure: response.main.pressure ?? 1013,
            weather_code: 0,
            wind_speed_10m: (response.wind?.speed ?? 0) * 3.6,
            wind_direction_10m: response.wind?.deg ?? 0,
          },
          hourly: null,
          daily: null,
        };
      }

      if (response.current) {
        const cur = response.current;
        const tempC =
          cur.temp ?? (cur.temp_c !== undefined ? cur.temp_c : undefined);
        if (tempC !== undefined) {
          return {
            current: {
              temperature_2m: tempC,
              relative_humidity_2m: cur.humidity ?? 50,
              surface_pressure: cur.pressure ?? cur.pressure_mb ?? 1013,
              weather_code: 0,
              wind_speed_10m: cur.wind_kph ?? (cur.wind_speed ?? 0) * 3.6,
              wind_direction_10m: cur.wind_degree ?? cur.wind_deg ?? 0,
            },
            hourly: null,
            daily: null,
          };
        }
      }

      const tempC =
        response.temperature ??
        response.temp ??
        response.current_temperature ??
        null;

      if (tempC !== null) {
        return {
          current: {
            temperature_2m: parseFloat(tempC),
            relative_humidity_2m:
              response.humidity ?? response.relativeHumidity ?? 50,
            surface_pressure:
              response.pressure ?? response.stationPressure ?? 1013,
            weather_code: 0,
            wind_speed_10m:
              response.wind_speed ??
              response.windSpeed ??
              response.windSpeedKph ??
              0,
            wind_direction_10m:
              response.wind_direction ?? response.windDirection ?? 0,
          },
          hourly: null,
          daily: null,
        };
      }

      throw new Error(
        "Unsupported API response format. Check your custom URL and API key.",
      );
    },
  },
};

//  Weather condition table

export function getWeatherConditions() {
  return {
    0: {
      name: _("Clear Sky"),
      icon: "weather-clear-symbolic",
      severity: "normal",
    },
    1: {
      name: _("Mainly Clear"),
      icon: "weather-few-clouds-symbolic",
      severity: "normal",
    },
    2: {
      name: _("Partly Cloudy"),
      icon: "weather-few-clouds-symbolic",
      severity: "normal",
    },
    3: {
      name: _("Overcast"),
      icon: "weather-overcast-symbolic",
      severity: "normal",
    },
    45: { name: _("Fog"), icon: "weather-fog-symbolic", severity: "caution" },
    48: {
      name: _("Rime Fog"),
      icon: "weather-fog-symbolic",
      severity: "caution",
    },
    51: {
      name: _("Light Drizzle"),
      icon: "weather-showers-scattered-symbolic",
      severity: "normal",
    },
    53: {
      name: _("Drizzle"),
      icon: "weather-showers-symbolic",
      severity: "normal",
    },
    55: {
      name: _("Heavy Drizzle"),
      icon: "weather-showers-symbolic",
      severity: "caution",
    },
    61: {
      name: _("Light Rain"),
      icon: "weather-showers-scattered-symbolic",
      severity: "normal",
    },
    63: {
      name: _("Rain"),
      icon: "weather-showers-symbolic",
      severity: "normal",
    },
    65: {
      name: _("Heavy Rain"),
      icon: "weather-storm-symbolic",
      severity: "warning",
    },
    71: {
      name: _("Light Snow"),
      icon: "weather-snow-symbolic",
      severity: "normal",
    },
    73: { name: _("Snow"), icon: "weather-snow-symbolic", severity: "caution" },
    75: {
      name: _("Heavy Snow"),
      icon: "weather-snow-symbolic",
      severity: "warning",
    },
    77: {
      name: _("Snow Grains"),
      icon: "weather-snow-symbolic",
      severity: "caution",
    },
    80: {
      name: _("Rain Showers"),
      icon: "weather-showers-scattered-symbolic",
      severity: "normal",
    },
    81: {
      name: _("Rain Showers"),
      icon: "weather-showers-symbolic",
      severity: "caution",
    },
    82: {
      name: _("Heavy Showers"),
      icon: "weather-storm-symbolic",
      severity: "warning",
    },
    85: {
      name: _("Snow Showers"),
      icon: "weather-snow-symbolic",
      severity: "caution",
    },
    86: {
      name: _("Heavy Snow Showers"),
      icon: "weather-snow-symbolic",
      severity: "warning",
    },
    95: {
      name: _("Thunderstorm"),
      icon: "weather-storm-symbolic",
      severity: "severe",
    },
    96: {
      name: _("Hail Storm"),
      icon: "weather-storm-symbolic",
      severity: "severe",
    },
    99: {
      name: _("Heavy Hail"),
      icon: "weather-storm-symbolic",
      severity: "severe",
    },
  };
}

// Static fallback
export const WEATHER_CONDITIONS = {
  0: { name: "Clear Sky", icon: "weather-clear-symbolic", severity: "normal" },
  1: {
    name: "Mainly Clear",
    icon: "weather-few-clouds-symbolic",
    severity: "normal",
  },
  2: {
    name: "Partly Cloudy",
    icon: "weather-few-clouds-symbolic",
    severity: "normal",
  },
  3: {
    name: "Overcast",
    icon: "weather-overcast-symbolic",
    severity: "normal",
  },
  45: { name: "Fog", icon: "weather-fog-symbolic", severity: "caution" },
  48: { name: "Rime Fog", icon: "weather-fog-symbolic", severity: "caution" },
  51: {
    name: "Light Drizzle",
    icon: "weather-showers-scattered-symbolic",
    severity: "normal",
  },
  53: { name: "Drizzle", icon: "weather-showers-symbolic", severity: "normal" },
  55: {
    name: "Heavy Drizzle",
    icon: "weather-showers-symbolic",
    severity: "caution",
  },
  61: {
    name: "Light Rain",
    icon: "weather-showers-scattered-symbolic",
    severity: "normal",
  },
  63: { name: "Rain", icon: "weather-showers-symbolic", severity: "normal" },
  65: {
    name: "Heavy Rain",
    icon: "weather-storm-symbolic",
    severity: "warning",
  },
  71: { name: "Light Snow", icon: "weather-snow-symbolic", severity: "normal" },
  73: { name: "Snow", icon: "weather-snow-symbolic", severity: "caution" },
  75: {
    name: "Heavy Snow",
    icon: "weather-snow-symbolic",
    severity: "warning",
  },
  77: {
    name: "Snow Grains",
    icon: "weather-snow-symbolic",
    severity: "caution",
  },
  80: {
    name: "Rain Showers",
    icon: "weather-showers-scattered-symbolic",
    severity: "normal",
  },
  81: {
    name: "Rain Showers",
    icon: "weather-showers-symbolic",
    severity: "caution",
  },
  82: {
    name: "Heavy Showers",
    icon: "weather-storm-symbolic",
    severity: "warning",
  },
  85: {
    name: "Snow Showers",
    icon: "weather-snow-symbolic",
    severity: "caution",
  },
  86: {
    name: "Heavy Snow Showers",
    icon: "weather-snow-symbolic",
    severity: "warning",
  },
  95: {
    name: "Thunderstorm",
    icon: "weather-storm-symbolic",
    severity: "severe",
  },
  96: {
    name: "Hail Storm",
    icon: "weather-storm-symbolic",
    severity: "severe",
  },
  99: {
    name: "Heavy Hail",
    icon: "weather-storm-symbolic",
    severity: "severe",
  },
};

export const WIND_SPEED_UNITS = {
  kmh: { label: "km/h", multiplier: 1 },
  mph: { label: "mph", multiplier: 0.621371 },
  ms: { label: "m/s", multiplier: 0.277778 },
  knots: { label: "kn", multiplier: 0.539957 },
};

export function convertWindSpeed(speedKmh, unit) {
  const c = WIND_SPEED_UNITS[unit] ?? WIND_SPEED_UNITS.kmh;
  return { value: Math.round(speedKmh * c.multiplier), unit: c.label };
}
