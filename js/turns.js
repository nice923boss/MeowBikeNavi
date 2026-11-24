// Pure turn logic. Turns come from the router's manoeuvres when a route is planned and are stored
// with the route as { i, k, from?, to? }: i = index into the line's coordinates, k = kind,
// from/to = the street left and the street entered. The line itself is never re-planned.

// Valhalla manoeuvre types that ask the rider to do something. Start, destination, continue,
// merge, ferry and transit types are left out.
const KIND_BY_TYPE = {
  9: 'slight_right', 10: 'right', 11: 'sharp_right', 12: 'uturn', 13: 'uturn', 14: 'sharp_left',
  15: 'left', 16: 'slight_left', 18: 'keep_right', 19: 'keep_left', 20: 'keep_right', 21: 'keep_left',
  23: 'keep_right', 24: 'keep_left', 26: 'rb_in', 27: 'rb_out',
};

const PHRASE = {
  left: '左轉', right: '右轉', slight_left: '稍微向左轉', slight_right: '稍微向右轉',
  sharp_left: '向左急轉', sharp_right: '向右急轉', uturn: '迴轉',
  keep_left: '靠左行駛', keep_right: '靠右行駛', rb_in: '進入圓環', rb_out: '離開圓環',
};

// The same corner ridden the other way. A fork becomes a merge, which needs no prompt (null).
const MIRROR = {
  left: 'right', right: 'left', slight_left: 'slight_right', slight_right: 'slight_left',
  sharp_left: 'sharp_right', sharp_right: 'sharp_left', uturn: 'uturn',
  keep_left: null, keep_right: null, rb_in: 'rb_out', rb_out: 'rb_in',
};

const CHAIN_M = 50; // a second turn this soon after the first is announced together with it
const EARLY_M = 30; // a turn first seen this close to the final distance gets one prompt, not two
const MAX_STREET = 60;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const street = (value) => (typeof value === 'string' ? value.trim().slice(0, MAX_STREET) : '');

/**
 * legs: [{ maneuvers, count }] in travel order, count = number of shape points of the leg.
 * Later legs drop their first point when the line is joined, hence the running offset.
 */
export function turnsFromLegs(legs) {
  const turns = [];
  let offset = 0;
  for (const leg of legs) {
    let previous = '';
    for (const m of leg.maneuvers ?? []) {
      const to = street(m.street_names?.[0]);
      const kind = KIND_BY_TYPE[m.type];
      if (kind && Number.isInteger(m.begin_shape_index)) {
        turns.push({
          i: offset + m.begin_shape_index, k: kind,
          ...(previous ? { from: previous } : {}), ...(to ? { to } : {}),
        });
      }
      previous = to;
    }
    offset += leg.count - 1;
  }
  return turns;
}

/** Keep only well-formed turns that sit inside a line of `count` points (for imported files). */
export function cleanTurns(raw, count) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => t && Number.isInteger(t.i) && t.i > 0 && t.i < count - 1 && t.k in PHRASE)
    .map((t) => {
      const from = street(t.from);
      const to = street(t.to);
      return { i: t.i, k: t.k, ...(from ? { from } : {}), ...(to ? { to } : {}) };
    })
    .sort((a, b) => a.i - b.i);
}

/** Turns for the same line walked backwards: left and right swap, and so do the streets. */
export function reverseTurns(turns, count) {
  return turns
    .filter((t) => MIRROR[t.k])
    .map((t) => ({
      i: count - 1 - t.i, k: MIRROR[t.k],
      ...(t.to ? { from: t.to } : {}), ...(t.from ? { to: t.from } : {}),
    }))
    .reverse();
}

/** Attach the distance along the line (`at`, metres) to every turn. line = makeLine(coords). */
export function placeTurns(turns, line) {
  return cleanTurns(turns, line.coords.length).map((t) => ({ ...t, at: line.cum[t.i] }));
}

/** How far ahead to speak, from the route's average speed in m/s: { pre, near } in metres. */
export const cueLimits = (speed) => ({
  pre: clamp(speed * 25, 100, 300),
  near: clamp(speed * 7, 30, 80),
});

/** The next turn ahead of `along` (metres of progress): { index, turn, dist } or null. */
export function nextTurn(turns, along) {
  const index = turns.findIndex((t) => t.at > along);
  return index < 0 ? null : { index, turn: turns[index], dist: turns[index].at - along };
}

/**
 * The prompt to speak now, or null. `said` maps a turn's index to the stage already spoken
 * (1 = announced ahead, 2 = final); the returned cue carries the updated map as `said`.
 */
export function nextCue(turns, along, said, limits) {
  const next = nextTurn(turns, along);
  if (!next) return null;
  const { index, turn, dist } = next;
  const stage = said[index] ?? 0;
  const firstAndClose = stage < 1 && dist <= limits.near + EARLY_M;
  if (stage < 2 && (dist <= limits.near || firstAndClose)) {
    const after = turns[index + 1];
    const then = after && after.at - turn.at <= CHAIN_M ? after : null;
    return {
      turn, dist, stage: 2, early: dist > limits.near, then,
      said: { ...said, [index]: 2, ...(then ? { [index + 1]: Math.max(said[index + 1] ?? 0, 1) } : {}) },
    };
  }
  if (stage < 1 && dist <= limits.pre) {
    return { turn, dist, stage: 1, early: false, then: null, said: { ...said, [index]: 1 } };
  }
  return null;
}

export const turnPhrase = (turn) => PHRASE[turn.k];

/** 右轉，進入承德路四段 */
export function turnText(turn) {
  return turn.to && turn.k !== 'rb_in' ? `${PHRASE[turn.k]}，進入${turn.to}` : PHRASE[turn.k];
}

/** Spoken text of a cue from nextCue. */
export function cueText(cue) {
  const lead = cue.stage === 1
    ? `前方 ${Math.max(10, Math.round(cue.dist / 10) * 10)} 公尺`
    : cue.early ? '前方' : '';
  return `${lead}${turnText(cue.turn)}${cue.then ? `，接著${PHRASE[cue.then.k]}` : ''}`;
}
