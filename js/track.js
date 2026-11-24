// Pure navigation tracking: where the rider is relative to a fixed line. The line never changes;
// when the rider leaves it, the tracker only reports which way leads back.
import { cumulative, projectOnRoute } from './geo.js';

export const OFF_ENTER_M = 40; // farther than this for two fixes in a row = off the route
export const OFF_EXIT_M = 25; // closer than this = back on the route
export const ARRIVE_M = 30;

export function makeLine(coords) {
  const cum = cumulative(coords);
  return { coords, cum, total: cum[cum.length - 1] };
}

export const START = {
  along: null, off: false, offCount: 0, position: null, snapped: null, target: null, remaining: null, arrived: false,
};

/**
 * Next tracking state for a GPS fix { lat, lon, accuracy }.
 * - along: progress in metres at the last fix that was on the line (null before the first one)
 * - snapped: the matched point on the line; target: the nearest point to head for when off the line
 */
export function advance(prev, line, fix) {
  const p = [fix.lat, fix.lon];
  const nearest = projectOnRoute(line.coords, line.cum, p);
  // Prefer a match that continues from the last position, so a line that crosses or retraces itself
  // (loops, out-and-back) does not jump to the other pass. First fix: a loop starts in its first half.
  const windows = prev.along == null
    ? [{ from: 0, to: line.total / 2 }]
    : [{ from: prev.along - 100, to: prev.along + 300 }, { from: prev.along, to: line.total }];
  const limit = Math.max(25, nearest.distance + 15);
  let hit = nearest;
  for (const window of windows) {
    const local = projectOnRoute(line.coords, line.cum, p, window);
    if (local && local.distance <= limit) {
      hit = local;
      break;
    }
  }

  const far = hit.distance > Math.max(OFF_ENTER_M, Math.min(fix.accuracy || 0, 100));
  let { off, offCount } = prev;
  if (off) {
    if (hit.distance < OFF_EXIT_M) {
      off = false;
      offCount = 0;
    }
  } else {
    offCount = far ? offCount + 1 : 0;
    off = offCount >= 2;
  }

  const target = off ? nearest : hit;
  return {
    along: off || far ? prev.along : hit.along,
    off,
    offCount,
    position: p,
    snapped: hit,
    target,
    remaining: line.total - target.along + (off ? target.distance : 0),
    arrived: !off && !far && line.total - hit.along <= ARRIVE_M,
  };
}
