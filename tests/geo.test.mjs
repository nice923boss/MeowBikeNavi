// Run from the project root:  node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  haversine, bearing, compassText, decodePolyline, encodePolyline, cumulative, projectOnRoute,
  formatDistance, formatDuration,
} from '../js/geo.js';

const near = (actual, expected, tolerance) => assert.ok(
  Math.abs(actual - expected) <= tolerance, `${actual} not within ${tolerance} of ${expected}`,
);

test('polyline: decodes the reference string from the format documentation', () => {
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

test('polyline: precision 6 round trip keeps Taiwan coordinates', () => {
  const coords = [[25.047812, 121.517034], [25.03301, 121.565418], [24.999999, 121.000001], [22.627278, 120.301435]];
  const encoded = encodePolyline(coords);
  assert.match(encoded, /^[?-~]+$/);
  assert.deepEqual(decodePolyline(encoded), coords);
});

test('haversine and bearing: Taipei Main Station to Taipei 101', () => {
  const station = [25.0478, 121.517];
  const tower = [25.0337, 121.5645];
  near(haversine(station, tower), 5040, 60);
  near(bearing(station, tower), 108, 3);
  assert.equal(compassText(bearing(station, tower)), '東');
  assert.equal(compassText(350), '北');
  assert.equal(compassText(225), '西南');
});

// A line running 1 km east, then 1 km north.
const corner = [[25.0, 121.5], [25.0, 121.50992], [25.009, 121.50992]];
const cum = cumulative(corner);

test('projectOnRoute: snaps to the nearest segment and reports distance along the line', () => {
  near(cum[2], 2000, 10);
  const hit = projectOnRoute(corner, cum, [25.0005, 121.505]); // about 55 m north of the first leg
  near(hit.distance, 55.6, 1);
  near(hit.along, 512, 10);
  assert.equal(hit.index, 0);
  near(hit.point[0], 25.0, 1e-9);
});

test('projectOnRoute: clamps to the ends of the line', () => {
  const before = projectOnRoute(corner, cum, [25.0, 121.49]);
  near(before.along, 0, 1e-6);
  near(before.distance, 1008, 10);
  const after = projectOnRoute(corner, cum, [25.02, 121.50992]);
  near(after.along, cum[2], 1e-6);
});

test('projectOnRoute: window keeps the match on the right pass of an out-and-back line', () => {
  const outAndBack = [[25.0, 121.5], [25.0, 121.51], [25.0, 121.5]];
  const c = cumulative(outAndBack);
  const p = [25.0001, 121.502];
  const first = projectOnRoute(outAndBack, c, p);
  near(first.along, 201, 5); // ties go to the earliest pass
  const returning = projectOnRoute(outAndBack, c, p, { from: c[1], to: c[2] });
  near(returning.along, c[2] - 201, 5);
  assert.equal(projectOnRoute(outAndBack, c, p, { from: c[2] + 10, to: c[2] + 20 }), null);
});

test('formatting', () => {
  assert.equal(formatDistance(84), '80 公尺');
  assert.equal(formatDistance(12345), '12.3 公里');
  assert.equal(formatDuration(20), '1 分');
  assert.equal(formatDuration(2940), '49 分');
  assert.equal(formatDuration(3600), '1 小時');
  assert.equal(formatDuration(5400), '1 小時 30 分');
});
