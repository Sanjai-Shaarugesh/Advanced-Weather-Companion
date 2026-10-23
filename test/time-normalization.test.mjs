#!/usr/bin/env node
/**
 * Time normalization tests.
 *
 * The cache is only queryable if every provider stores its time axes in one
 * shape. These checks pin that contract: canonical keys are local wall-clock
 * `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM`, epoch inputs are normalized on ingest, and
 * malformed values are dropped instead of being smuggled into the cache.
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

async function loadProviders() {
  const mod = await import(pathToFileURL(path.join(root, 'lib/providers.js')).href);
  return mod;
}

/** Local `YYYY-MM-DDTHH:MM` for an epoch, using the same local getters. */
function localKey(seconds) {
  const d = new Date(seconds * 1000);
  const p = (v, w = 2) => String(v).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e?.message ?? String(e) });
  }
}

const { canonicalTime, canonicalTimes, canonicalizeSeries, WEATHER_PROVIDERS } = await loadProviders();

check('canonicalTime keeps ISO wall clock and drops the offset', () => {
  assert.equal(canonicalTime('2026-10-22T14:00:00+00:00'), '2026-10-22T14:00');
  assert.equal(canonicalTime('2026-10-22T14:00'), '2026-10-22T14:00');
  assert.equal(canonicalTime('2026-10-22'), '2026-10-22');
  assert.equal(canonicalTime('2026-10-22 14:00:00'), '2026-10-22T14:00');
});

check('canonicalTime turns epoch seconds and milliseconds into local keys', () => {
  const seconds = 1_792_659_490;
  assert.equal(canonicalTime(seconds), localKey(seconds));
  assert.equal(canonicalTime(String(seconds)), localKey(seconds));
  assert.equal(canonicalTime(seconds * 1000), localKey(seconds));
  assert.equal(canonicalTime(String(seconds * 1000)), localKey(seconds));
  // a bare `0` is not a usable forecast stamp; refuse it rather than call it 1970
  assert.equal(canonicalTime(0), null);
});

check('canonicalTime refuses junk instead of inventing a date', () => {
  for (const bad of [null, undefined, '', '   ', 'today', '2026-13-45', '2026-10-22T24:00', {}, [], NaN]) {
    assert.equal(canonicalTime(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

check('canonicalTimes maps one-to-one so parallel series stay aligned', () => {
  const times = canonicalTimes(['2026-10-22T00:00', 'garbage', '2026-10-22T01:00']);
  assert.deepEqual(times, ['2026-10-22T00:00', null, '2026-10-22T01:00']);

  const block = canonicalizeSeries({
    time: ['2026-10-22T00:00', 'garbage'],
    temperature_2m: [10, 11],
  });
  assert.deepEqual(block.time, ['2026-10-22T00:00', null]);
  assert.deepEqual(block.temperature_2m, [10, 11]);
  assert.equal(canonicalTimes(undefined), undefined);
});

check('open-meteo adapter normalizes epoch time axes', () => {
  const data = WEATHER_PROVIDERS.openmeteo.parseResponse({
    current: { temperature_2m: 21 },
    hourly: { time: ['1792659490', '1792663090'], temperature_2m: [21, 22], weather_code: [1, 2] },
    daily: { time: ['1792659490'], temperature_2m_max: [24], temperature_2m_min: [12], weather_code: [1] },
  });

  for (const t of data.hourly.time) {
    assert.match(t, /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, `not canonical: ${t}`);
  }
  assert.deepEqual(data.hourly.time, [localKey(1_792_659_490), localKey(1_792_663_090)]);
  assert.equal(data.daily.time.length, 1);
  assert.equal(data.daily.time[0].slice(0, 10), localKey(1_792_659_490).slice(0, 10));

  for (const [key, arr] of Object.entries(data.hourly)) {
    assert.equal(arr.length, data.hourly.time.length, `hourly.${key} is misaligned`);
  }
});

check('meteosource asks for local time and canonicalizes date/day keys', () => {
  const ms = WEATHER_PROVIDERS.meteosource;
  assert.match(ms.buildUrl(30.66, 104.06, ''), /[?&]timezone=local(&|$)/);
  assert.doesNotMatch(ms.buildUrl(30.66, 104.06, ''), /timezone=UTC/);

  const data = ms.parseResponse({
    current: { temperature: 21, humidity: 60, pressure: 1013, icon_num: 1, wind: { speed: 5, angle: 90 } },
    hourly: {
      data: [
        { date: '2026-10-22T14:00:00+00:00', temperature: 21, icon_num: 1, precipitation: { total: 0 }, wind: { speed: 5, angle: 90 } },
        { date: '2026-10-22T15:00:00+00:00', temperature: 22, icon_num: 2, precipitation: { total: 1 }, wind: { speed: 5, angle: 90 } },
      ],
    },
    daily: {
      data: [
        { day: '2026-10-22T00:00:00+00:00', icon: 'clear', all_day: { temperature_max: 24, temperature_min: 12 } },
        { day: '2026-10-23T00:00:00+00:00', icon: 'cloudy', all_day: { temperature_max: 25, temperature_min: 13 } },
      ],
    },
  });

  assert.deepEqual(data.hourly.time, ['2026-10-22T14:00', '2026-10-22T15:00']);
  assert.deepEqual(data.daily.time, ['2026-10-22', '2026-10-23']);
  assert.deepEqual(data.daily.weather_code, [data.daily.weather_code[0], data.daily.weather_code[1]]);
  assert.equal(data.hourly.temperature_2m.length, 2);
  assert.equal(data.daily.temperature_2m_max.length, 2);
});

check('wttr hourly slots are indexed to real hours and 2400 is not duplicated', () => {
  const slots = [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400];
  const data = WEATHER_PROVIDERS.wttr.parseResponse({
    current_condition: [
      { temp_C: '10', humidity: '50', pressure: '1013', weatherCode: '113', windspeedKmph: '5', winddir16Point: 'N' },
    ],
    weather: [
      {
        date: '2026-10-22',
        maxtempC: '12',
        mintempC: '3',
        hourly: slots.map((time) => ({
          time: String(time),
          tempC: '10',
          weatherCode: '113',
          chanceofrain: '0',
          windspeedKmph: '5',
        })),
      },
    ],
  });

  const { time, temperature_2m, weather_code, precipitation_probability } = data.hourly;
  assert.equal(time.length, 8, 'the 24:00 slot must not add a 9th hour');
  assert.equal(new Set(time).size, time.length, 'duplicate hour keys');
  assert.ok(time.includes('2026-10-22T00:00'), 'midnight missing');
  assert.ok(time.includes('2026-10-22T21:00'), '21:00 missing');
  assert.ok(!time.some((t) => t.endsWith('T24:00')), `bogus slot: ${time.join(', ')}`);

  for (const arr of [temperature_2m, weather_code, precipitation_probability]) {
    assert.equal(arr.length, time.length, 'series misaligned with time');
  }
  assert.deepEqual(data.daily.time, ['2026-10-22']);
});

check('custom endpoint payload gets the same canonical time axes', () => {
  const data = WEATHER_PROVIDERS.custom.parseResponse({
    current: { temperature_2m: 20 },
    hourly: { time: [1_792_659_490], temperature_2m: [20] },
    daily: { time: [1_792_659_490], temperature_2m_max: [24], temperature_2m_min: [12] },
  });

  assert.deepEqual(data.hourly.time, [localKey(1_792_659_490)]);
  assert.equal(data.daily.time[0].slice(0, 10), localKey(1_792_659_490).slice(0, 10));
});

check('providers agree on the canonical key pattern', () => {
  const key = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
  const payloads = [
    WEATHER_PROVIDERS.openmeteo.parseResponse({
      current: { temperature_2m: 1 },
      hourly: { time: ['2026-10-22T14:00+02:00'], temperature_2m: [1] },
      daily: { time: ['2026-10-22'], temperature_2m_max: [1] },
    }),
    WEATHER_PROVIDERS.meteosource.parseResponse({
      current: { temperature: 1, humidity: 1, pressure: 1, icon_num: 1, wind: { speed: 1, angle: 1 } },
      hourly: { data: [{ date: 1_792_659_490, temperature: 1, icon_num: 1, wind: { speed: 1, angle: 1 } }] },
      daily: { data: [{ day: '2026-10-22', icon: 'clear', all_day: { temperature_max: 1, temperature_min: 0 } }] },
    }),
  ];

  for (const payload of payloads) {
    for (const axis of [payload.hourly.time, payload.daily.time]) {
      for (const t of axis) assert.match(t, key, `not canonical: ${t}`);
    }
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`time-normalization: ${results.length - failed.length} passed, ${failed.length} failed`);
for (const f of failed) console.log(`  ✗ ${f.name}\n    ${f.error}`);
process.exit(failed.length ? 1 : 0);
