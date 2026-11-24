// Route planning (Valhalla) and place search (Nominatim), called straight from the browser.
import { ROUTER_URL, GEOCODER_URL, VEHICLES, BIKE_PRESETS } from './config.js';
import { decodePolyline } from './geo.js';
import { turnsFromLegs } from './turns.js';
import { planRuns } from './segments.js';

export class ServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function callRouter(payload, signal) {
  let res;
  try {
    res = await fetch(`${ROUTER_URL}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.error('[router] unreachable', err);
    throw new ServiceError('unreachable', '路線伺服器沒有回應，請確認網路後再試');
  }
  if (res.ok) return res.json();
  const detail = await res.text().catch(() => '');
  console.error('[router] HTTP', res.status, detail.slice(0, 300));
  if (res.status === 400) throw new ServiceError('no_route', '找不到可通行的路線，請調整地點或載具');
  if (res.status === 429) throw new ServiceError('busy', '路線伺服器忙碌中，請稍後再試');
  throw new ServiceError('router_error', '路線伺服器回應錯誤，請稍後再試');
}

const WALK_KMH = 4; // pushing a bike is slower than walking

/** One leg of a Valhalla trip as a segment line: { coords, turns, distance_m, duration_s }. */
function legLine(leg, walk) {
  const coords = decodePolyline(leg.shape);
  const distance_m = leg.summary.length * 1000;
  return {
    coords,
    turns: turnsFromLegs([{ maneuvers: leg.maneuvers, count: coords.length }]),
    distance_m,
    duration_s: walk ? Math.max(leg.summary.time, distance_m / (WALK_KMH / 3.6)) : leg.summary.time,
  };
}

/**
 * Path through the points in order, one leg per pair of points.
 * walk: plan for walking (the bike pushed), which may use paths closed to bicycles.
 * Returns trips, each a list of leg lines; more than one trip only when asked for alternatives.
 */
async function requestLegs({ vehicle, preset, points, walk, alternates }, signal) {
  const costing = walk ? 'pedestrian' : VEHICLES[vehicle].costing;
  const options = !walk && vehicle === 'bicycle' ? BIKE_PRESETS[preset]?.options ?? {} : {};
  const last = points.length - 1;
  const build = (viaType) => ({
    locations: points.map((p, i) => ({ lat: p.lat, lon: p.lon, type: i === 0 || i === last ? 'break' : viaType })),
    costing,
    units: 'kilometers',
    ...(Object.keys(options).length ? { costing_options: { [costing]: options } } : {}),
    ...(alternates ? { alternates: 2 } : {}),
  });

  let data;
  try {
    // "break_through": a leg ends at the via point, without stopping or doubling back there.
    data = await callRouter(build('break_through'), signal);
  } catch (err) {
    if (err.code !== 'no_route' || points.length === 2) throw err;
    data = await callRouter(build('break'), signal);
  }
  const trips = [data.trip, ...(data.alternates ?? []).map((alt) => alt.trip)].filter(Boolean);
  return trips.map((trip) => trip.legs.map((leg) => legLine(leg, walk)));
}

/**
 * Plan every segment that is not locked, one request per stretch of neighbouring segments
 * (see planRuns). Walking only applies to bicycles.
 * Returns { segments, alternatives }; alternatives = other lines for a single unlocked segment.
 */
export async function planSegments({ vehicle, preset, points, segments }, signal) {
  const single = segments.length === 1 && !segments[0].locked;
  let planned = segments;
  let alternatives = [];
  // Pushing the bike only means something on a bicycle; otherwise walk flags must not split the runs.
  const bike = vehicle === 'bicycle';
  for (const run of planRuns(bike ? segments : segments.map((s) => ({ ...s, walk: false })))) {
    const trips = await requestLegs(
      { vehicle, preset, points: points.slice(run.first, run.last + 2), walk: run.walk, alternates: single }, signal,
    );
    const keep = (s) => ({ locked: s.locked, walk: s.walk });
    planned = planned.map((s, k) => (k < run.first || k > run.last ? s : { ...trips[0][k - run.first], ...keep(s) }));
    if (single) alternatives = trips.map((legs) => ({ ...legs[0], ...keep(segments[0]) }));
  }
  return { segments: planned, alternatives };
}

let lastGeocode = 0;
const SEARCH_LIMIT = 6;

/** Place search in Taiwan. Nominatim allows at most one request per second. */
export async function geocode(query) {
  const wait = lastGeocode + 1100 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastGeocode = Date.now();
  const params = new URLSearchParams({
    // limit: extra rows so the duplicates removed below still leave SEARCH_LIMIT results
    q: query, format: 'jsonv2', limit: '10', countrycodes: 'tw', 'accept-language': 'zh-TW',
  });
  let res;
  try {
    res = await fetch(`${GEOCODER_URL}/search?${params}`);
  } catch (err) {
    console.error('[geocode] unreachable', err);
    throw new ServiceError('unreachable', '地點搜尋服務沒有回應，請確認網路後再試');
  }
  if (!res.ok) {
    console.error('[geocode] HTTP', res.status);
    throw new ServiceError('geocode_error', '地點搜尋服務暫時無法使用，請稍後再試');
  }
  const rows = await res.json();
  return uniquePlaces(rows.map((row) => ({
    name: row.name || String(row.display_name).split(',')[0],
    detail: row.display_name,
    lat: Number(row.lat),
    lon: Number(row.lon),
  }))).slice(0, SEARCH_LIMIT);
}

/**
 * Nominatim returns one row per OSM object, so a pier mapped as both a node and an area
 * shows up twice with the same address. Keep the first row of each address.
 */
export function uniquePlaces(places) {
  const seen = new Set();
  return places.filter((place) => {
    const key = place.detail.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
