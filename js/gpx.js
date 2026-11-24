// Route files: GPX 1.1 for single routes (also readable by other apps), JSON for a full backup.
import { VEHICLES, BIKE_PRESETS } from './config.js';
import { encodePolyline, decodePolyline, haversine } from './geo.js';
import { cleanTurns } from './turns.js';

const NS = 'urn:meowbikenavi:gpx:1';
const MAX_TRACK_POINTS = 20000;
const MAX_WAYPOINTS = 50;

/** A route name made safe to use as a file name on phones and computers. */
export const fileSafe = (name) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'route';

const esc = (value) => String(value).replace(/[<>&"']/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]
));

export function routeToGpx(route) {
  const coords = decodePolyline(route.geometry);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="MeowBikeNavi" xmlns="http://www.topografix.com/GPX/1/1" xmlns:mbn="${NS}">`,
    '<metadata>',
    `<name>${esc(route.name)}</name>`,
    `<time>${new Date().toISOString()}</time>`,
    '<extensions>',
    `<mbn:vehicle>${esc(route.vehicle)}</mbn:vehicle>`,
    `<mbn:preset>${esc(route.preset ?? 'balanced')}</mbn:preset>`,
    `<mbn:distance>${Math.round(route.distance_m)}</mbn:distance>`,
    `<mbn:duration>${Math.round(route.duration_s)}</mbn:duration>`,
    // Turn prompts: i = index of the trkpt where the turn is.
    ...(route.turns ?? []).map((t) => `<mbn:turn i="${t.i}" k="${esc(t.k)}"${t.from ? ` from="${esc(t.from)}"` : ''}${t.to ? ` to="${esc(t.to)}"` : ''}/>`),
    '</extensions>',
    '</metadata>',
    // rte = the points the rider placed (start, via points, end); trk = the exact line to follow.
    `<rte><name>${esc(route.name)}</name>`,
    ...route.waypoints.map((p) => (
      `<rtept lat="${p.lat}" lon="${p.lon}">${p.label ? `<name>${esc(p.label)}</name>` : ''}</rtept>`
    )),
    '</rte>',
    `<trk><name>${esc(route.name)}</name><trkseg>`,
    ...coords.map(([lat, lon]) => `<trkpt lat="${lat}" lon="${lon}"/>`),
    '</trkseg></trk>',
    '</gpx>',
  ];
  return lines.join('\n');
}

export function backupJson(routes) {
  const clean = routes.map(({ id, ...route }) => route);
  return JSON.stringify({ app: 'MeowBikeNavi', version: 1, exported_at: new Date().toISOString(), routes: clean });
}

const validPoint = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon)
  && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

/** Check a route object from a backup file and keep only the known fields. */
function normalizeRoute(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('備份檔內的路線格式錯誤');
  const waypoints = Array.isArray(raw.waypoints) ? raw.waypoints.filter(validPoint) : [];
  if (typeof raw.geometry !== 'string' || !/^[?-~]{4,}$/.test(raw.geometry) || waypoints.length < 2) {
    throw new Error('備份檔內的路線缺少座標');
  }
  return {
    name: String(raw.name || '未命名路線').slice(0, 80),
    vehicle: raw.vehicle in VEHICLES ? raw.vehicle : 'bicycle',
    preset: raw.preset in BIKE_PRESETS ? raw.preset : 'balanced',
    waypoints: waypoints.slice(0, MAX_WAYPOINTS).map((p) => ({
      lat: p.lat, lon: p.lon, ...(typeof p.label === 'string' && p.label ? { label: p.label.slice(0, 120) } : {}),
    })),
    geometry: raw.geometry,
    turns: cleanTurns(raw.turns, decodePolyline(raw.geometry).length),
    distance_m: Number(raw.distance_m) || 0,
    duration_s: Number(raw.duration_s) || 0,
  };
}

function parseGpx(text, filename) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'gpx') {
    throw new Error('不是有效的 GPX 檔');
  }
  const pointsOf = (tag) => Array.from(doc.getElementsByTagNameNS('*', tag), (el) => ({
    lat: Number(el.getAttribute('lat')),
    lon: Number(el.getAttribute('lon')),
    label: el.getElementsByTagNameNS('*', 'name')[0]?.textContent.trim() || '',
  })).filter(validPoint);

  const routePoints = pointsOf('rtept');
  let line = pointsOf('trkpt');
  if (line.length < 2) line = routePoints;
  if (line.length < 2) throw new Error('檔案內沒有路線座標');
  // Turn indices point at trkpt entries, so they only hold while the track is kept as it is.
  let turns = line === routePoints ? [] : cleanTurns(Array.from(doc.getElementsByTagNameNS(NS, 'turn'), (el) => ({
    i: Number(el.getAttribute('i')), k: el.getAttribute('k'), from: el.getAttribute('from'), to: el.getAttribute('to'),
  })), line.length);
  if (line.length > MAX_TRACK_POINTS) {
    turns = [];
    // Thin very dense recordings so they fit in phone storage; the end point is always kept.
    const step = Math.ceil(line.length / MAX_TRACK_POINTS);
    line = line.filter((_, i) => i % step === 0 || i === line.length - 1);
  }
  const coords = line.map((p) => [p.lat, p.lon]);

  const hasOwnWaypoints = routePoints.length >= 2 && routePoints.length <= MAX_WAYPOINTS && routePoints !== line;
  const waypoints = (hasOwnWaypoints ? routePoints : [line[0], line[line.length - 1]]).map((p, i, arr) => ({
    lat: p.lat,
    lon: p.lon,
    label: (p.label || (i === 0 ? '起點' : i === arr.length - 1 ? '終點' : `中途點 ${i}`)).slice(0, 120),
  }));

  const ext = (tag) => doc.getElementsByTagNameNS(NS, tag)[0]?.textContent.trim() ?? '';
  const nameEl = doc.querySelector('metadata > name') ?? doc.querySelector('trk > name') ?? doc.querySelector('rte > name');
  const vehicle = ext('vehicle') in VEHICLES ? ext('vehicle') : 'bicycle';
  let distance = 0;
  for (let i = 1; i < coords.length; i++) distance += haversine(coords[i - 1], coords[i]);
  const duration = Number(ext('duration')) || distance / (VEHICLES[vehicle].kmh / 3.6);

  return {
    name: (nameEl?.textContent.trim() || filename.replace(/\.[^.]+$/, '') || '匯入的路線').slice(0, 80),
    vehicle,
    preset: ext('preset') in BIKE_PRESETS ? ext('preset') : 'balanced',
    waypoints,
    geometry: encodePolyline(coords),
    turns,
    distance_m: Number(ext('distance')) || distance,
    duration_s: duration,
  };
}

/** Parse a GPX file or a MeowBikeNavi backup. Returns an array of routes (without ids). */
export function parseRouteFile(text, filename) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (err) {
      throw new Error('備份檔內容損毀');
    }
    if (data.app !== 'MeowBikeNavi' || !Array.isArray(data.routes)) throw new Error('不是喵騎導航的備份檔');
    return data.routes.map(normalizeRoute);
  }
  return [parseGpx(text, filename)];
}
