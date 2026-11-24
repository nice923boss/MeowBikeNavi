// Pure segment logic. A route is planned as one segment per pair of consecutive points.
// Segment: { coords, turns, distance_m, duration_s, locked, walk }
//   coords null = still to be planned; locked = kept as it is when the route is planned again;
//   walk = planned for walking the bike, for paths that the map data closes to bicycles.
import { haversine, bearing } from './geo.js';

export const blankSegment = (walk = false) => ({ coords: null, turns: [], distance_m: 0, duration_s: 0, locked: false, walk });

const samePoint = (a, b) => a.lat === b.lat && a.lon === b.lon;

/**
 * Segments for a new list of points. A locked segment whose two end points are unchanged is kept as it
 * is; an unlocked one keeps its walk flag and is planned again (planned together, neighbouring
 * segments do not double back where they meet). Points added inside a segment split it, and the parts
 * keep its walk flag. `released` = locked segments that could not be kept.
 */
export function carrySegments(oldPoints, oldSegments, newPoints) {
  const known = oldSegments.length === oldPoints.length - 1 ? oldSegments : [];
  const oldIndex = newPoints.map((p) => oldPoints.findIndex((q) => samePoint(p, q)));
  // Old segment that new segment i lies inside: its nearest old points on both sides are neighbours.
  const within = (i) => {
    const before = oldIndex.slice(0, i + 1).filter((k) => k >= 0).pop();
    const after = oldIndex.slice(i + 1).find((k) => k >= 0);
    return before !== undefined && after === before + 1 ? before : -1;
  };
  const segments = newPoints.slice(1).map((to, i) => {
    const j = within(i);
    if (j < 0 || !known[j]) return blankSegment();
    const unchanged = oldIndex[i] === j && oldIndex[i + 1] === j + 1;
    return unchanged && known[j].locked ? known[j] : blankSegment(known[j].walk);
  });
  const released = known.filter((s) => s.locked && !segments.includes(s)).length;
  return { segments, released };
}

/** Stretches to plan, one request each: [{ first, last, walk }] (inclusive segment indices). Locked segments are skipped. */
export function planRuns(segments) {
  return segments.reduce((runs, s, i) => {
    if (s.locked) return runs;
    const prev = runs[runs.length - 1];
    if (prev && prev.last === i - 1 && prev.walk === s.walk) return [...runs.slice(0, -1), { ...prev, last: i }];
    return [...runs, { first: i, last: i, walk: s.walk }];
  }, []);
}

const JOINT_LOOK_M = 15;

/** A point about JOINT_LOOK_M metres from coords[at], walking by `step` (+1 or -1). */
function lookFrom(coords, at, step) {
  let i = at;
  let dist = 0;
  while (i + step >= 0 && i + step < coords.length && dist < JOINT_LOOK_M) {
    dist += haversine(coords[i], coords[i + step]);
    i += step;
  }
  return coords[i];
}

/** Turn kind for the change of heading where one segment meets the next, or null when riding on. */
export function jointKind(coords, at) {
  const before = lookFrom(coords, at, -1);
  const after = lookFrom(coords, at, 1);
  if (before === coords[at] || after === coords[at]) return null;
  const turn = ((bearing(coords[at], after) - bearing(before, coords[at]) + 540) % 360) - 180; // + = right
  const size = Math.abs(turn);
  const side = turn > 0 ? 'right' : 'left';
  if (size < 30) return null;
  if (size < 60) return `slight_${side}`;
  if (size < 135) return side;
  if (size < 170) return `sharp_${side}`;
  return 'uturn';
}

/**
 * One line from the segments. Segments meet at a shared point, so every later segment drops its first
 * point. Valhalla gives no manoeuvre where a leg starts, so turns at the joints are worked out here.
 * Returns { coords, turns, distance_m, duration_s, ends } with ends[k] = index of segment k's last point.
 */
export function joinSegments(segments) {
  let coords = [];
  let turns = [];
  const ends = [];
  let distance_m = 0;
  let duration_s = 0;
  const joints = [];
  for (const s of segments) {
    const offset = Math.max(coords.length - 1, 0);
    if (coords.length > 0) joints.push(offset);
    coords = coords.length === 0 ? s.coords.slice() : coords.concat(s.coords.slice(1));
    turns = turns.concat(s.turns.map((t) => ({ ...t, i: t.i + offset })));
    ends.push(coords.length - 1);
    distance_m += s.distance_m;
    duration_s += s.duration_s;
  }
  const jointTurns = joints.flatMap((at) => {
    const k = jointKind(coords, at);
    return k ? [{ i: at, k }] : [];
  });
  return {
    coords,
    turns: turns.concat(jointTurns).sort((a, b) => a.i - b.i),
    distance_m,
    duration_s,
    ends,
  };
}

/** What a saved route keeps about its segments: [{ to, locked, walk, distance_m, duration_s }]. */
export function segmentMeta(segments, line) {
  return segments.map((s, k) => ({
    to: line.ends[k], locked: s.locked, walk: s.walk,
    distance_m: Math.round(s.distance_m), duration_s: Math.round(s.duration_s),
  }));
}

/**
 * Check segment data from a file: one entry per pair of waypoints, `to` rising and ending on the
 * line's last point. Returns the cleaned list, or null when it does not fit the route.
 */
export function cleanSegmentMeta(raw, waypointCount, coordCount) {
  if (!Array.isArray(raw) || raw.length !== waypointCount - 1 || raw.length === 0) return null;
  const meta = raw.map((m) => ({
    to: Number(m?.to), locked: m?.locked === true, walk: m?.walk === true,
    distance_m: Math.max(0, Number(m?.distance_m) || 0), duration_s: Math.max(0, Number(m?.duration_s) || 0),
  }));
  const rising = meta.every((m, k) => Number.isInteger(m.to) && m.to > (k === 0 ? 0 : meta[k - 1].to));
  return rising && meta[meta.length - 1].to === coordCount - 1 ? meta : null;
}

/** The segments back from a saved line (coords + turns) and its cleaned segment data. */
export function splitLine(coords, turns, meta) {
  return meta.map((m, k) => {
    const start = k === 0 ? 0 : meta[k - 1].to;
    return {
      coords: coords.slice(start, m.to + 1),
      // A turn on a joint point is worked out again when the segments are joined.
      turns: turns.filter((t) => t.i > start && t.i < m.to).map((t) => ({ ...t, i: t.i - start })),
      distance_m: m.distance_m,
      duration_s: m.duration_s,
      locked: m.locked,
      walk: m.walk,
    };
  });
}

/** A bike segment much longer than the straight line, as when the map data closes a path to bicycles. */
export function isDetour(segment, from, to) {
  if (!segment.coords || segment.walk) return false;
  const straight = haversine([from.lat, from.lon], [to.lat, to.lon]);
  return segment.distance_m > straight * 2.5 && segment.distance_m - straight > 1000;
}
