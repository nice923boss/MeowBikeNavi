import test from 'node:test';
import assert from 'node:assert/strict';
import {
  turnsFromLegs, cleanTurns, reverseTurns, placeTurns, cueLimits, nextTurn, nextCue, turnText, cueText,
} from '../js/turns.js';
import { makeLine } from '../js/track.js';

// A straight line north, one point every ~11.1 m (0.0001 deg of latitude).
const straight = (n) => Array.from({ length: n }, (_, i) => [25 + i * 0.0001, 121.5]);

test('turnsFromLegs keeps actionable manoeuvres and offsets later legs', () => {
  const legs = [
    {
      count: 10,
      maneuvers: [
        { type: 1, begin_shape_index: 0, street_names: ['中山北路'] },
        { type: 10, begin_shape_index: 4, street_names: ['民生東路'] },
        { type: 8, begin_shape_index: 6 },
        { type: 4, begin_shape_index: 9 },
      ],
    },
    {
      count: 5,
      maneuvers: [
        { type: 3, begin_shape_index: 0, street_names: ['民生東路'] },
        { type: 15, begin_shape_index: 2 },
        { type: 4, begin_shape_index: 4 },
      ],
    },
  ];
  assert.deepEqual(turnsFromLegs(legs), [
    { i: 4, k: 'right', from: '中山北路', to: '民生東路' },
    { i: 11, k: 'left', from: '民生東路' },
  ]);
});

test('cleanTurns drops bad entries and turns at the ends', () => {
  const raw = [{ i: 0, k: 'left' }, { i: 3, k: 'right', to: ' 路 ' }, { i: 9, k: 'left' }, { i: 2, k: 'fly' }, null, { i: 1.5, k: 'left' }];
  assert.deepEqual(cleanTurns(raw, 10), [{ i: 3, k: 'right', to: '路' }]);
  assert.deepEqual(cleanTurns('nope', 10), []);
});

test('reverseTurns mirrors direction, swaps streets and drops forks', () => {
  const turns = [
    { i: 2, k: 'right', from: 'A', to: 'B' },
    { i: 4, k: 'keep_left' },
    { i: 6, k: 'rb_in' },
    { i: 7, k: 'slight_left', to: 'C' },
  ];
  assert.deepEqual(reverseTurns(turns, 10), [
    { i: 2, k: 'slight_right', from: 'C' },
    { i: 3, k: 'rb_out' },
    { i: 7, k: 'left', from: 'B', to: 'A' },
  ]);
});

test('placeTurns adds the distance along the line', () => {
  const line = makeLine(straight(20));
  const placed = placeTurns([{ i: 10, k: 'left' }, { i: 5, k: 'right' }], line);
  assert.equal(placed.length, 2);
  assert.equal(placed[0].k, 'right');
  assert.equal(placed[0].at, line.cum[5]);
  assert.ok(Math.abs(placed[1].at - 111.2) < 1);
});

test('cueLimits scale with speed and stay in range', () => {
  assert.deepEqual(cueLimits(4.8), { pre: 120, near: 33.6 });
  assert.deepEqual(cueLimits(1), { pre: 100, near: 30 });
  assert.deepEqual(cueLimits(30), { pre: 300, near: 80 });
});

test('nextTurn finds the first turn ahead', () => {
  const turns = [{ at: 100 }, { at: 300 }];
  assert.deepEqual(nextTurn(turns, 150), { index: 1, turn: turns[1], dist: 150 });
  assert.equal(nextTurn(turns, 300), null);
});

test('nextCue speaks ahead once, then at the turn once', () => {
  const turns = [{ at: 500, k: 'right', to: '民生東路' }];
  const limits = { pre: 120, near: 33 };
  assert.equal(nextCue(turns, 300, {}, limits), null);
  const first = nextCue(turns, 390, {}, limits);
  assert.equal(first.stage, 1);
  assert.equal(cueText(first), '前方 110 公尺右轉，進入民生東路');
  assert.equal(nextCue(turns, 420, first.said, limits), null);
  const final = nextCue(turns, 470, first.said, limits);
  assert.equal(final.stage, 2);
  assert.equal(cueText(final), '右轉，進入民生東路');
  assert.equal(nextCue(turns, 490, final.said, limits), null);
});

test('nextCue gives one early prompt for a turn first seen close by', () => {
  const turns = [{ at: 100, k: 'left' }];
  const cue = nextCue(turns, 45, {}, { pre: 120, near: 33 });
  assert.equal(cue.stage, 2);
  assert.equal(cue.early, true);
  assert.equal(cueText(cue), '前方左轉');
});

test('nextCue chains a second turn that follows closely', () => {
  const turns = [{ at: 200, k: 'right' }, { at: 240, k: 'left' }, { at: 600, k: 'left' }];
  const limits = { pre: 120, near: 33 };
  const cue = nextCue(turns, 175, { 0: 1 }, limits);
  assert.equal(cueText(cue), '右轉，接著左轉');
  // The chained turn already had its warning, so after the first corner only its final prompt is left.
  assert.equal(cue.said[1], 1);
  assert.equal(nextCue(turns, 205, cue.said, limits), null);
  assert.equal(nextCue(turns, 210, cue.said, limits).stage, 2);
});

test('turnText leaves the street out when entering a roundabout', () => {
  assert.equal(turnText({ k: 'rb_in', to: '圓環路' }), '進入圓環');
  assert.equal(turnText({ k: 'rb_out', to: '中正路' }), '離開圓環，進入中正路');
  assert.equal(cueText({ stage: 1, dist: 3, turn: { k: 'uturn' } }), '前方 10 公尺迴轉');
});
