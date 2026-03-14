import Gio from "gi://Gio";
import Soup from "gi://Soup";
import GLib from "gi://GLib";

const GEOCODING_URL   = "https://geocoding-api.open-meteo.com/v1/search";
const NOMINATIM_URL   = "https://nominatim.openstreetmap.org/reverse";

// ─── GeoIP services tried in order (best accuracy wins) ─────────────────────
const GEOIP_SERVICES = [
  {
    url: "https://ipapi.co/json/",
    parse: r => r.latitude && r.longitude
      ? {lat: r.latitude, lon: r.longitude, city: r.city, country: r.country_name, accuracy: r.accuracy ?? 50000}
      : null,
  },
  {
    url: "http://ip-api.com/json/?fields=status,lat,lon,city,country",
    parse: r => r.status === "success"
      ? {lat: r.lat, lon: r.lon, city: r.city, country: r.country, accuracy: 5000}
      : null,
  },
  {
    url: "https://freegeoip.app/json/",
    parse: r => r.latitude && r.longitude
      ? {lat: r.latitude, lon: r.longitude, city: r.city, country: r.country_name, accuracy: 10000}
      : null,
  },
];

// ─── GeoClue2 D-Bus interface definitions ────────────────────────────────────
const GEOCLUE_MANAGER_IFACE = `
<node>
  <interface name="org.freedesktop.GeoClue2.Manager">
    <method name="GetClient">
      <arg type="o" direction="out" name="client"/>
    </method>
  </interface>
</node>`;

const GEOCLUE_CLIENT_IFACE = `
<node>
  <interface name="org.freedesktop.GeoClue2.Client">
    <property name="Location" type="o" access="read"/>
    <property name="DesktopId" type="s" access="readwrite"/>
    <property name="DistanceThreshold" type="u" access="readwrite"/>
    <method name="Start"/>
    <method name="Stop"/>
    <signal name="LocationUpdated">
      <arg type="o" name="old"/>
      <arg type="o" name="new"/>
    </signal>
  </interface>
</node>`;

const GEOCLUE_LOCATION_IFACE = `
<node>
  <interface name="org.freedesktop.GeoClue2.Location">
    <property name="Latitude"  type="d" access="read"/>
    <property name="Longitude" type="d" access="read"/>
    <property name="Accuracy"  type="d" access="read"/>
  </interface>
</node>`;

// ────────────────────────────────────────────────────────────────────────────

export class LocationManager {
  constructor(session) {
    this._session = session;
  }

  // ── Public entry points ───────────────────────────────────────────────────

  /**
   * Resolve location based on settings.
   * Returns { lat, lon, name }.
   */
  async resolveLocation(settings) {
    const mode = settings.get_string("location-mode") ?? "auto";
    if (mode === "manual")
      return this._resolveManual(settings);
    return this._resolveAuto();
  }

  /**
   * Search for a city by name (used by the in-shell location search).
   * Returns an array of result objects from Open-Meteo geocoding.
   */
  async searchByName(query) {
    const url = `${GEOCODING_URL}?name=${encodeURIComponent(query)}&count=5&language=en&format=json`;
    const message = Soup.Message.new("GET", url);
    message.request_headers.append("User-Agent", "GNOME-Weather-Extension/1.0");
    const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
    if (message.status_code !== 200)
      throw new Error(`HTTP ${message.status_code}`);
    const resp = JSON.parse(new TextDecoder().decode(bytes.get_data()));
    return resp.results ?? [];
  }

  // ── Manual mode ──────────────────────────────────────────────────────────

  async _resolveManual(settings) {
    const raw = (settings.get_string("location") ?? "").trim();
    if (!raw) throw new Error("No manual location set");

    const coordMatch = raw.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lon = parseFloat(coordMatch[2]);
      const name =
        settings.get_string("location-name")?.trim() ||
        `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
      return {lat, lon, name};
    }

    // City name – geocode it
    const results = await this.searchByName(raw);
    if (!results.length) throw new Error("Location not found");
    const r = results[0];
    return {
      lat: r.latitude,
      lon: r.longitude,
      name: r.admin1 ? `${r.name}, ${r.admin1}, ${r.country}` : `${r.name}, ${r.country}`,
    };
  }

  // ── Auto mode: GeoClue → GeoIP cascade ───────────────────────────────────

  async _resolveAuto() {
    // 1. Try GeoClue2 (precise)
    try {
      const loc = await this._tryGeoclue();
      if (loc) {
        const name = await this._reverseGeocode(loc.lat, loc.lon)
          .catch(() => `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}`);
        console.log(`[Weather] GeoClue2: ${name} ±${Math.round(loc.accuracy)}m`);
        return {lat: loc.lat, lon: loc.lon, name};
      }
    } catch (_) { /* not available */ }

    // 2. Try GeoIP services
    let best = null;
    for (const svc of GEOIP_SERVICES) {
      try {
        const msg = Soup.Message.new("GET", svc.url);
        msg.request_headers.append("User-Agent", "GNOME-Weather-Extension/1.0");
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
        if (msg.status_code !== 200) continue;
        const r = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        const loc = svc.parse(r);
        if (loc && (!best || loc.accuracy < best.accuracy)) best = loc;
        if (best && best.accuracy < 1000) break;
      } catch (_) { /* try next */ }
    }

    if (best) {
      console.log(`[Weather] GeoIP: ${best.city}, ${best.country} ~${Math.round(best.accuracy / 1000)}km`);
      return {lat: best.lat, lon: best.lon, name: `${best.city}, ${best.country}`};
    }

    throw new Error("All location services failed");
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  async _reverseGeocode(lat, lon) {
    const url = `${NOMINATIM_URL}?format=json&lat=${lat}&lon=${lon}&zoom=10`;
    const msg = Soup.Message.new("GET", url);
    msg.request_headers.append("User-Agent", "GNOME-Weather-Extension/1.0");
    const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    if (msg.status_code !== 200) throw new Error(`HTTP ${msg.status_code}`);
    const r = JSON.parse(new TextDecoder().decode(bytes.get_data()));
    const a = r.address ?? {};
    const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county;
    if (city && a.country) return `${city}, ${a.country}`;
    throw new Error("No city in reverse geocode");
  }

  async _tryGeoclue() {
    const GeoclueProxy         = Gio.DBusProxy.makeProxyWrapper(GEOCLUE_MANAGER_IFACE);
    const GeoclueClientProxy   = Gio.DBusProxy.makeProxyWrapper(GEOCLUE_CLIENT_IFACE);
    const GeoclueLocationProxy = Gio.DBusProxy.makeProxyWrapper(GEOCLUE_LOCATION_IFACE);

    return new Promise((resolve, reject) => {
      let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
        timeoutId = null;
        reject(new Error("GeoClue2 timeout"));
        return GLib.SOURCE_REMOVE;
      });

      const clearTimeout = () => {
        if (timeoutId) { GLib.source_remove(timeoutId); timeoutId = null; }
      };

      new GeoclueProxy(
        Gio.DBus.system,
        "org.freedesktop.GeoClue2",
        "/org/freedesktop/GeoClue2/Manager",
        (proxy, err) => {
          if (err) { clearTimeout(); reject(err); return; }

          proxy.GetClientRemote((result, err2) => {
            if (err2) { clearTimeout(); reject(err2); return; }

            new GeoclueClientProxy(
              Gio.DBus.system,
              "org.freedesktop.GeoClue2",
              result[0],
              (client, err3) => {
                if (err3) { clearTimeout(); reject(err3); return; }

                client.DesktopId = "org.gnome.shell.extensions.advanced-weather";
                client.DistanceThreshold = 0;

                const sigId = client.connectSignal("LocationUpdated", (_p, _s, [, newPath]) => {
                  new GeoclueLocationProxy(
                    Gio.DBus.system,
                    "org.freedesktop.GeoClue2",
                    newPath,
                    (loc, err4) => {
                      client.disconnectSignal(sigId);
                      client.StopRemote(() => {});
                      clearTimeout();
                      if (err4) { reject(err4); return; }
                      resolve({lat: loc.Latitude, lon: loc.Longitude, accuracy: loc.Accuracy});
                    }
                  );
                });

                client.StartRemote((_r, err5) => {
                  if (err5) { clearTimeout(); reject(err5); }
                });
              }
            );
          });
        }
      );
    });
  }
}
