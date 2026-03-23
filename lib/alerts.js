let _gettext = (s) => s;
export function setGettext(fn) {
  _gettext = fn;
}
const _ = (s) => _gettext(s);

//  Threshold constants
export const THRESHOLDS = {
  heatC: 35, // °C
  heatF: 95, // °F
  coldC: -10, // °C
  coldF: 14, // °F
  windStorm: 80, // km/h  → severe
  windStrong: 50, // km/h  → warning
  humidHeat: 40, // °C apparent (heat-index trigger)
};

// Severity levels that warrant a desktop notification
export const NOTIFIABLE_SEVERITIES = new Set(["warning", "severe"]);

/**
 * Evaluate current weather data and return an array of active alert objects
 *
 * @param {object} current
 * @param {string} location – human-readable location name
 * @param {boolean} useFahr – display temperatures in Fahrenheit
 * @param {object} conditions
 * @returns {Alert[]}
 */
export function evaluateAlerts(current, location, useFahr, conditions) {
  const alerts = [];
  const cond = conditions[current.weather_code] ?? conditions[0];

  if (cond.severity === "severe") {
    alerts.push({
      key: `code:severe:${current.weather_code}`,
      title: _("⚠️ Severe Weather Alert"),
      body: cond.name + " — " + location,
      advice: _severePanelAdvice(current.weather_code),
      severity: "severe",
      icon: "weather-storm-symbolic",
    });
  } else if (cond.severity === "warning") {
    alerts.push({
      key: `code:warning:${current.weather_code}`,
      title: _("⚠️ Weather Warning"),
      body: cond.name + " — " + location,
      advice: _warningPanelAdvice(current.weather_code),
      severity: "warning",
      icon: "weather-storm-symbolic",
    });
  }

  // Temperature conversion
  const tempDisp = useFahr
    ? Math.round((current.temperature_2m * 9) / 5 + 32)
    : Math.round(current.temperature_2m);
  const heatLim = useFahr ? THRESHOLDS.heatF : THRESHOLDS.heatC;
  const coldLim = useFahr ? THRESHOLDS.coldF : THRESHOLDS.coldC;
  const unit = useFahr ? "°F" : "°C";

  //  Extreme heat
  if (tempDisp > heatLim) {
    alerts.push({
      key: `heat:${tempDisp}`,
      title: _("🌡️ Extreme Heat Warning"),
      body:
        _("Dangerously high temperature") +
        " (" +
        tempDisp +
        unit +
        ") — " +
        location,
      advice: [
        _("Stay indoors during peak hours (10 AM – 4 PM)"),
        _("Drink water regularly — at least 2–3 litres per day"),
        _("Wear light, loose, light-coloured clothing"),
        _("Never leave children or pets in parked vehicles"),
        _("Check on elderly neighbours and relatives"),
        _("Use fans or air conditioning if available"),
      ],
      severity: "warning",
      icon: "weather-clear-symbolic",
    });
  }

  // Extreme cold
  if (tempDisp < coldLim) {
    alerts.push({
      key: `cold:${tempDisp}`,
      title: _("🥶 Extreme Cold Warning"),
      body:
        _("Dangerously low temperature") +
        " (" +
        tempDisp +
        unit +
        ") — " +
        location,
      advice: [
        _("Layer clothing: base layer, insulation, waterproof outer shell"),
        _("Cover exposed skin — risk of frostbite within 30 minutes"),
        _("Keep emergency supplies in your vehicle if driving"),
        _("Check heating systems and carbon-monoxide detectors"),
        _("Check on elderly and vulnerable people"),
        _("Bring pets indoors"),
      ],
      severity: "warning",
      icon: "weather-snow-symbolic",
    });
  }

  // Storm-force winds
  if (current.wind_speed_10m > THRESHOLDS.windStorm) {
    const windDisp = Math.round(current.wind_speed_10m);
    alerts.push({
      key: `wind:storm:${windDisp}`,
      title: _("🌀 Severe Storm Warning"),
      body:
        _("Dangerous wind speed") + " (" + windDisp + " km/h) — " + location,
      advice: [
        _("Avoid all unnecessary travel"),
        _("Stay away from trees, scaffolding, and signs"),
        _("Do not attempt to drive high-sided vehicles"),
        _("Secure or bring inside any outdoor furniture"),
        _("Stay indoors away from windows"),
        _("Follow local emergency service guidance"),
      ],
      severity: "severe",
      icon: "weather-storm-symbolic",
    });
  } else if (current.wind_speed_10m > THRESHOLDS.windStrong) {
    const windDisp = Math.round(current.wind_speed_10m);
    alerts.push({
      key: `wind:strong:${windDisp}`,
      title: _("💨 Strong Wind Warning"),
      body:
        _("Strong winds detected") + " (" + windDisp + " km/h) — " + location,
      advice: [
        _(
          "Take care when walking or cycling — gusts may be stronger than the average",
        ),
        _("Secure loose outdoor items (bins, garden furniture, etc.)"),
        _("Drive with extra caution, especially on exposed roads or bridges"),
        _("Cyclists and motorcyclists should be especially cautious"),
      ],
      severity: "warning",
      icon: "weather-windy-symbolic",
    });
  }

  return alerts;
}

function _severePanelAdvice(code) {
  // code 95/96/99 = thunderstorm & hail
  if ([95, 96, 99].includes(code)) {
    return [
      _("Seek shelter immediately in a sturdy building"),
      _("Avoid open fields, hilltops, and isolated trees"),
      _("Stay away from water, metal objects, and electrical equipment"),
      _("If outdoors and unable to shelter, crouch low — do not lie flat"),
      _("Avoid using corded phones or plugged-in devices"),
      _("Keep away from windows and doors"),
    ];
  }
  return [
    _("Follow official emergency service guidance"),
    _("Stay informed via local weather services"),
    _("Avoid non-essential travel"),
  ];
}

function _warningPanelAdvice(code) {
  // Heavy rain & showers 65, 82
  if ([65, 82].includes(code)) {
    return [
      _(
        "Avoid driving through flooded roads — even 30 cm can sweep a car away",
      ),
      _("Be aware of localised flooding in low-lying areas"),
      _("Carry waterproof clothing if you must travel"),
      _("Check your local flood risk map"),
    ];
  }
  // Heavy snow 75, 86
  if ([75, 86].includes(code)) {
    return [
      _("Avoid travel unless absolutely necessary"),
      _("If driving, carry a winter emergency kit (blanket, shovel, water)"),
      _("Clear snow from paths and driveways carefully to avoid injury"),
      _("Be aware of roof loading from heavy snow accumulation"),
    ];
  }
  return [
    _("Exercise caution outdoors"),
    _("Stay informed via local weather forecasts"),
  ];
}
