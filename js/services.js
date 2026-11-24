// Route planning (Valhalla) and place search (Nominatim), called straight from the browser.
import { ROUTER_URL, GEOCODER_URL, VEHICLES, BIKE_PRESETS } from './config.js';
import { decodePolyline } from './geo.js';
import { turnsFromLegs } from './turns.js';

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

/**
 * Shortest path through the points in order.
 * Returns [{ coords, turns, distance_m, duration_s }]; more than one entry only when there are no via points.
 */
export async function planRoute({ vehicle, preset, points }, signal) {
  const costing = VEHICLES[vehicle].costing;
  const options = vehicle === 'bicycle' ? BIKE_PRESETS[preset]?.options ?? {} : {};
  const last = points.length - 1;
  const build = (viaType) => ({
    locations: points.map((p, i) => ({ lat: p.lat, lon: p.lon, type: i === 0 || i === last ? 'break' : viaType })),
    costing,
    units: 'kilometers',
    ...(Object.keys(options).length ? { costing_options: { [costing]: options } } : {}),
    ...(points.length === 2 ? { alternates: 2 } : {}),
  });

  let data;
  try {
    // "through": pass the via point without stopping or doubling back.
    data = await callRouter(build('through'), signal);
  } catch (err) {
    if (err.code !== 'no_route' || points.length === 2) throw err;
    data = await callRouter(build('break'), signal);
  }

  const trips = [data.trip, ...(data.alternates ?? []).map((alt) => alt.trip)].filter(Boolean);
  return trips.map((trip) => {
    const shapes = trip.legs.map((leg) => decodePolyline(leg.shape));
    return {
      // Consecutive legs share their joint point, so drop the first point of every later leg.
      coords: shapes.flatMap((shape, i) => (i === 0 ? shape : shape.slice(1))),
      turns: turnsFromLegs(trip.legs.map((leg, i) => ({ maneuvers: leg.maneuvers, count: shapes[i].length }))),
      distance_m: trip.summary.length * 1000,
      duration_s: trip.summary.time,
    };
  });
}

let lastGeocode = 0;
const SEARCH_LIMIT = 6;

/** Place search in Taiwan. Nominatim allows at most one request per second. */
export async function geocode(query) {
  const wait = lastGeocode + 1100 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastGeocode = Date.now();
  const params = new URLSearchParams({
    q: query, format: 'jsonv2', limit: '10', // extra rows so duplicates removed below still leave SEARCH_LIMIT results countrycodes: 'tw', 'accept-language': 'zh-TW',
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
