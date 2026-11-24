// Pure geometry helpers. Coordinates are [lat, lon] in degrees, distances in metres.
const R = 6371008.8;
const RAD = Math.PI / 180;

export function haversine(a, b) {
  const dLat = (b[0] - a[0]) * RAD;
  const dLon = (b[1] - a[1]) * RAD;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

/** Initial bearing from a to b: 0 = north, 90 = east. */
export function bearing(a, b) {
  const dLon = (b[1] - a[1]) * RAD;
  const y = Math.sin(dLon) * Math.cos(b[0] * RAD);
  const x = Math.cos(a[0] * RAD) * Math.sin(b[0] * RAD) - Math.sin(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.cos(dLon);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

const COMPASS = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
export const compassText = (deg) => COMPASS[Math.round(deg / 45) % 8];

export function decodePolyline(str, precision = 6) {
  const factor = 10 ** precision;
  const coords = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = str.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next();
    lon += next();
    coords.push([lat / factor, lon / factor]);
  }
  return coords;
}

export function encodePolyline(coords, precision = 6) {
  const factor = 10 ** precision;
  const enc = (value) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let out = '';
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return out + String.fromCharCode(v + 63);
  };
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  for (const [la, lo] of coords) {
    const lat = Math.round(la * factor);
    const lon = Math.round(lo * factor);
    out += enc(lat - prevLat) + enc(lon - prevLon);
    prevLat = lat;
    prevLon = lon;
  }
  return out;
}

/** Distance from the first point to each point along the line. */
export function cumulative(coords) {
  const cum = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + haversine(coords[i - 1], coords[i]);
  return cum;
}

/**
 * Closest point on the line to p.
 * `window` = { from, to } limits the search to that stretch (distance along the line), which keeps
 * the match on the right pass of a line that overlaps itself. Ties go to the earliest segment.
 * Returns { distance, along, index, point } or null when no segment is in range.
 */
export function projectOnRoute(coords, cum, p, window) {
  const kx = Math.cos(p[0] * RAD) * RAD * R;
  const ky = RAD * R;
  let best = null;
  for (let i = 0; i < coords.length - 1; i++) {
    // A segment that only touches the window at its end point belongs to the stretch before it.
    if (window && (cum[i + 1] <= window.from || cum[i] > window.to)) continue;
    const ax = (coords[i][1] - p[1]) * kx;
    const ay = (coords[i][0] - p[0]) * ky;
    const dx = (coords[i + 1][1] - p[1]) * kx - ax;
    const dy = (coords[i + 1][0] - p[0]) * ky - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const distance = Math.hypot(ax + t * dx, ay + t * dy);
    if (!best || distance < best.distance) best = { distance, index: i, t };
  }
  if (!best) return null;
  const a = coords[best.index];
  const b = coords[best.index + 1];
  return {
    distance: best.distance,
    index: best.index,
    along: cum[best.index] + best.t * (cum[best.index + 1] - cum[best.index]),
    point: [a[0] + best.t * (b[0] - a[0]), a[1] + best.t * (b[1] - a[1])],
  };
}

export function formatDistance(m) {
  if (!Number.isFinite(m)) return '--';
  if (m < 1000) return `${Math.round(m / 10) * 10} 公尺`;
  return `${(m / 1000).toFixed(m < 100000 ? 1 : 0)} 公里`;
}

export function formatDuration(s) {
  if (!Number.isFinite(s)) return '--';
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} 分`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${hours} 小時 ${rest} 分` : `${hours} 小時`;
}
