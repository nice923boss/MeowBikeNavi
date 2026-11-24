import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniquePlaces, geocode, planSegments } from '../js/services.js';
import { encodePolyline } from '../js/geo.js';
import { blankSegment } from '../js/segments.js';

/** Replace fetch for one test; returns the request bodies/URLs seen. */
function fakeFetch(t, respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    return { ok: true, status: 200, json: async () => respond(body, String(url)) };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const leg = (coords, km) => ({ shape: encodePolyline(coords), maneuvers: [], summary: { length: km, time: km * 240 } });

test('geocode limits the search to Taiwan, in Chinese', async (t) => {
  const calls = fakeFetch(t, () => []);
  await geocode('新月橋');
  const params = new URL(calls[0].url).searchParams;
  assert.equal(params.get('countrycodes'), 'tw');
  assert.equal(params.get('accept-language'), 'zh-TW');
});

test('planSegments plans unlocked stretches only, walking ones on foot', async (t) => {
  const pts = [{ lat: 25, lon: 121 }, { lat: 25.01, lon: 121 }, { lat: 25.02, lon: 121 }, { lat: 25.03, lon: 121 }];
  const calls = fakeFetch(t, (body) => ({
    trip: {
      legs: body.locations.slice(1).map((to, i) => leg([[body.locations[i].lat, 121], [to.lat, 121]], 1)),
    },
  }));
  const locked = { coords: [[25, 121], [25.01, 121]], turns: [], distance_m: 1500, duration_s: 300, locked: true, walk: false };
  const { segments } = await planSegments(
    { vehicle: 'bicycle', preset: 'balanced', points: pts, segments: [locked, blankSegment(), blankSegment(true)] },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.costing, 'bicycle');
  assert.deepEqual(calls[0].body.locations.map((l) => l.lat), [25.01, 25.02]);
  assert.equal(calls[1].body.costing, 'pedestrian');
  assert.equal(segments[0], locked);
  assert.deepEqual(segments[1].coords, [[25.01, 121], [25.02, 121]]);
  assert.equal(segments[2].walk, true);
  assert.ok(segments[2].duration_s >= 1000 / (4 / 3.6) - 1, 'walking pace is used for a pushed bike');
});

test('planSegments asks for via points that split legs without doubling back', async (t) => {
  const pts = [{ lat: 25, lon: 121 }, { lat: 25.01, lon: 121 }, { lat: 25.02, lon: 121 }];
  const calls = fakeFetch(t, (body) => ({
    trip: { legs: body.locations.slice(1).map((to, i) => leg([[body.locations[i].lat, 121], [to.lat, 121]], 1)) },
  }));
  const { segments } = await planSegments({ vehicle: 'car', preset: 'balanced', points: pts, segments: [blankSegment(), blankSegment(true)] });
  assert.equal(calls.length, 1, 'walking only applies to bicycles');
  assert.deepEqual(calls[0].body.locations.map((l) => l.type), ['break', 'break_through', 'break']);
  assert.equal(segments.length, 2);
});

const pier = (lat, detail = '大稻埕碼頭, 淡水河河濱自行車道, 永樂里, 大同區, 臺北市') =>
  ({ name: '大稻埕碼頭', detail, lat, lon: 121.508 });

test('uniquePlaces drops rows with the same address, keeping the first', () => {
  const places = [pier(25.056), pier(25.057), pier(25.058, '大稻埕碼頭, 淡埕橋, 大有里, 大同區, 臺北市')];
  const result = uniquePlaces(places);
  assert.deepEqual(result.map((p) => p.lat), [25.056, 25.058]);
});

test('uniquePlaces keeps same-named places at different addresses', () => {
  const places = [pier(25.056, '7-ELEVEN, 中山區'), pier(25.04, '7-ELEVEN, 大安區')];
  assert.equal(uniquePlaces(places).length, 2);
});
