import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blankSegment, carrySegments, planRuns, joinSegments, jointKind, segmentMeta, cleanSegmentMeta, splitLine, isDetour, viaSlot,
} from '../js/segments.js';

const P = (lat, lon) => ({ lat, lon });
const A = P(25, 121);
const B = P(25.01, 121);
const C = P(25.02, 121);
const D = P(25.03, 121);
const planned = (coords, extra = {}) => ({ coords, turns: [], distance_m: 100, duration_s: 20, locked: false, walk: false, ...extra });

test('carrySegments keeps a locked segment whose ends did not move and replans the rest', () => {
  const locked = planned([[25, 121], [25.01, 121]], { locked: true });
  const walk = planned([[25.01, 121], [25.02, 121]], { walk: true });
  const { segments, released } = carrySegments([A, B, C], [locked, walk], [A, B, D, C]);
  assert.equal(segments[0], locked);
  assert.equal(segments[1].coords, null);
  assert.equal(segments[2].coords, null);
  assert.equal(released, 0);
});

test('carrySegments keeps the walk flag of an unchanged unlocked segment, unplanned', () => {
  const walk = planned([[25, 121], [25.01, 121]], { walk: true });
  const { segments } = carrySegments([A, B], [walk], [A, B]);
  assert.deepEqual(segments[0], blankSegment(true));
});

test('carrySegments keeps walking on both parts of a segment split by a new point', () => {
  const walk = planned([[25, 121], [25.01, 121]], { walk: true });
  const { segments } = carrySegments([A, B, C], [walk, planned([])], [A, D, B, C]);
  assert.deepEqual(segments.map((s) => s.walk), [true, true, false]);
});

test('carrySegments does not carry walking over to a moved or removed point', () => {
  const walk = planned([[25, 121], [25.01, 121]], { walk: true });
  assert.deepEqual(carrySegments([A, B, C], [walk, planned([])], [A, D, C]).segments.map((s) => s.walk), [false, false]);
  assert.deepEqual(carrySegments([A, B, C], [walk, planned([])], [A, C]).segments.map((s) => s.walk), [false]);
});

test('carrySegments releases a locked segment split by a new point', () => {
  const locked = planned([[25, 121], [25.01, 121]], { locked: true });
  const { segments, released } = carrySegments([A, B], [locked], [A, D, B]);
  assert.equal(released, 1);
  assert.ok(segments.every((s) => !s.locked && s.coords === null));
});

test('carrySegments counts locked segments lost when one of their points moves', () => {
  const locked = planned([[25, 121], [25.01, 121]], { locked: true });
  const { released } = carrySegments([A, B, C], [locked, planned([])], [A, D, C]);
  assert.equal(released, 1);
});

test('carrySegments ignores segment data that does not match the points', () => {
  const { segments } = carrySegments([A, B, C], [planned([], { locked: true })], [A, B, C]);
  assert.deepEqual(segments, [blankSegment(), blankSegment()]);
});

test('planRuns groups neighbouring unlocked segments with the same walk flag', () => {
  const s = (locked, walk) => ({ ...blankSegment(walk), locked });
  const runs = planRuns([s(false, false), s(false, false), s(true, false), s(false, false), s(false, true), s(false, true)]);
  assert.deepEqual(runs, [
    { first: 0, last: 1, walk: false },
    { first: 3, last: 3, walk: false },
    { first: 4, last: 5, walk: true },
  ]);
});

test('joinSegments drops shared joint points and shifts turn indices', () => {
  const one = planned([[25, 121], [25.0005, 121], [25.001, 121]], { turns: [{ i: 1, k: 'left' }] });
  const two = planned([[25.001, 121], [25.0015, 121], [25.002, 121]], { turns: [{ i: 1, k: 'right' }] });
  const line = joinSegments([one, two]);
  assert.equal(line.coords.length, 5);
  assert.deepEqual(line.ends, [2, 4]);
  assert.deepEqual(line.turns, [{ i: 1, k: 'left' }, { i: 3, k: 'right' }]);
  assert.equal(line.distance_m, 200);
});

test('joinSegments adds a turn where the next segment leaves at a corner', () => {
  // North, then east: a right turn at the joint.
  const north = planned([[25, 121], [25.0005, 121], [25.001, 121]]);
  const east = planned([[25.001, 121], [25.001, 121.0005], [25.001, 121.001]]);
  const line = joinSegments([north, east]);
  assert.deepEqual(line.turns, [{ i: 2, k: 'right' }]);
});

test('jointKind gives nothing when the line runs straight on', () => {
  const coords = [[25, 121], [25.0005, 121], [25.001, 121], [25.0015, 121], [25.002, 121]];
  assert.equal(jointKind(coords, 2), null);
  const back = [[25, 121], [25.0005, 121], [25.001, 121], [25.0005, 121.00001], [25, 121.00002]];
  assert.equal(jointKind(back, 2), 'uturn');
});

test('segmentMeta and splitLine give back the segments of a saved line', () => {
  const one = planned([[25, 121], [25.0005, 121], [25.001, 121]], { turns: [{ i: 1, k: 'left' }], locked: true });
  const two = planned([[25.001, 121], [25.001, 121.0005], [25.001, 121.001]], { walk: true });
  const line = joinSegments([one, two]);
  const meta = segmentMeta([one, two], line);
  assert.deepEqual(meta.map((m) => m.to), [2, 4]);
  const clean = cleanSegmentMeta(JSON.parse(JSON.stringify(meta)), 3, line.coords.length);
  const back = splitLine(line.coords, line.turns, clean);
  assert.deepEqual(back.map((s) => s.coords), [one.coords, two.coords]);
  assert.deepEqual(back[0].turns, [{ i: 1, k: 'left' }]);
  assert.deepEqual(back[1].turns, []); // the joint turn is worked out again when joined
  assert.deepEqual(joinSegments(back).turns, line.turns);
  assert.deepEqual(back.map((s) => [s.locked, s.walk]), [[true, false], [false, true]]);
});

test('cleanSegmentMeta rejects data that does not fit the route', () => {
  const ok = [{ to: 3, locked: true }, { to: 7 }];
  assert.ok(cleanSegmentMeta(ok, 3, 8));
  assert.equal(cleanSegmentMeta(ok, 4, 8), null); // wrong number of segments
  assert.equal(cleanSegmentMeta(ok, 3, 9), null); // does not end on the last point
  assert.equal(cleanSegmentMeta([{ to: 5 }, { to: 3 }], 3, 4), null); // not rising
  assert.equal(cleanSegmentMeta('x', 3, 8), null);
  assert.equal(cleanSegmentMeta(ok, 3, 8)[0].locked, true);
  assert.equal(cleanSegmentMeta([{ to: 3, locked: 'yes' }, { to: 7 }], 3, 8)[0].locked, false);
});

test('isDetour flags a bike segment far longer than the straight line', () => {
  const from = P(25.0324, 121.4503);
  const to = P(25.0300, 121.4513); // about 280 m apart
  assert.equal(isDetour(planned([[0, 0]], { distance_m: 4500 }), from, to), true);
  assert.equal(isDetour(planned([[0, 0]], { distance_m: 600 }), from, to), false);
  assert.equal(isDetour(planned([[0, 0]], { distance_m: 4500, walk: true }), from, to), false);
  assert.equal(isDetour(blankSegment(), from, to), false);
});

test('viaSlot puts a new point before the first via farther along the line', () => {
  const line = [[25, 121], [25.01, 121], [25.02, 121], [25.03, 121]];
  assert.equal(viaSlot(line, [], P(25.015, 121)), 0);
  assert.equal(viaSlot(line, [B, C], P(25.005, 121.0005)), 0);
  assert.equal(viaSlot(line, [B, C], P(25.015, 121.0005)), 1);
  assert.equal(viaSlot(line, [B, C], P(25.025, 121.0005)), 2);
});

test('viaSlot trusts a given distance along the line over where the point projects', () => {
  // An out-and-back line: the point lies on both passes; the rider is on the way back.
  const line = [[25, 121], [25.02, 121], [25, 121.0001]];
  const out = P(25.015, 121); // on the way out
  const back = P(25.005, 121.00008); // on the way back
  const rider = P(25.01, 121.00001); // nearer the way out
  const total = 2 * 2224; // about 2.2 km each way
  assert.equal(viaSlot(line, [out, back], rider), 0);
  assert.equal(viaSlot(line, [out, back], rider, total * 0.75), 1);
});
