// Run from the project root:  node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLine, advance, START } from '../js/track.js';
import { bearing } from '../js/geo.js';

const near = (actual, expected, tolerance) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `${actual} not within ${tolerance} of ${expected}`,
);
const fix = (lat, lon, accuracy = 5) => ({ lat, lon, accuracy });
// At latitude 25: 0.001 deg of latitude = 111 m, 0.001 deg of longitude = 101 m.

const east = makeLine([[25.0, 121.5], [25.0, 121.52]]); // about 2 km heading east

test('on the line: progress follows the rider and nothing is flagged', () => {
  const a = advance(START, east, fix(25.00005, 121.502));
  assert.equal(a.off, false);
  near(a.along, 202, 5);
  near(a.remaining, east.total - 202, 5);
  const b = advance(a, east, fix(25.0, 121.505));
  near(b.along, 504, 5);
  assert.equal(b.arrived, false);
});

test('leaving the line: needs two far fixes, then points back without moving the line', () => {
  const on = advance(START, east, fix(25.0, 121.505));
  const once = advance(on, east, fix(25.001, 121.506)); // 111 m north
  assert.equal(once.off, false, 'a single far fix can be GPS noise');
  near(once.along, on.along, 0.001);
  const twice = advance(once, east, fix(25.0015, 121.507)); // 167 m north
  assert.equal(twice.off, true);
  near(twice.target.distance, 167, 3);
  near(bearing(twice.position, twice.target.point), 180, 1); // the line is due south
  near(twice.along, on.along, 0.001);
  near(twice.remaining, 167 + east.total - 706, 8);
  assert.deepEqual(east.coords, [[25.0, 121.5], [25.0, 121.52]]);
});

test('coming back: stays flagged inside the hysteresis band, clears when close', () => {
  let t = advance(START, east, fix(25.0, 121.505));
  t = advance(t, east, fix(25.001, 121.506));
  t = advance(t, east, fix(25.001, 121.507));
  assert.equal(t.off, true);
  t = advance(t, east, fix(25.0003, 121.508)); // 33 m: between exit (25) and enter (40)
  assert.equal(t.off, true);
  t = advance(t, east, fix(25.0001, 121.509)); // 11 m
  assert.equal(t.off, false);
  near(t.along, 908, 6);
});

test('poor GPS accuracy widens the off-route threshold', () => {
  let t = advance(START, east, fix(25.0, 121.505, 80));
  t = advance(t, east, fix(25.0006, 121.506, 80)); // 67 m away but accuracy is 80 m
  t = advance(t, east, fix(25.0006, 121.507, 80));
  assert.equal(t.off, false);
});

test('arrival: only near the end of the line', () => {
  let t = advance(START, east, fix(25.0, 121.519));
  assert.equal(t.arrived, false);
  t = advance(t, east, fix(25.0, 121.5198));
  assert.equal(t.arrived, true);
});

test('loop: the first fix at the shared start/end counts as the start', () => {
  const loop = makeLine([[25.0, 121.5], [25.0, 121.51], [25.01, 121.51], [25.01, 121.5], [25.0, 121.5]]);
  const t = advance(START, loop, fix(25.00001, 121.50001));
  near(t.along, 1, 3);
  assert.equal(t.arrived, false);
  // After riding the loop, the same spot is the finish.
  const back = advance({ ...t, along: loop.total - 200 }, loop, fix(25.0001, 121.5));
  near(back.along, loop.total - 11, 3);
  assert.equal(back.arrived, true);
});

test('out-and-back: stays on the return pass', () => {
  const line = makeLine([[25.0, 121.5], [25.0, 121.51], [25.0, 121.5]]);
  const returning = advance({ ...START, along: line.cum[1] + 500 }, line, fix(25.00002, 121.504));
  near(returning.along, line.cum[1] + 605, 8);
  near(returning.remaining, line.total - returning.along, 0.001);
});

test('started far from the line: flagged after two fixes and progress stays unknown', () => {
  let t = advance(START, east, fix(25.005, 121.5));
  assert.equal(t.along, null);
  t = advance(t, east, fix(25.005, 121.5));
  assert.equal(t.off, true);
  assert.equal(t.along, null);
  near(t.target.distance, 556, 5);
});
