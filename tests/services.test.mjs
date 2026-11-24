import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniquePlaces } from '../js/services.js';

const pier = (lat, detail = '大稻埕碼頭, 淡水河河濱自行車道, 永樂里, 大同區, 臺北市') =>
  ({ name: '大稻埕碼頭', detail, lat, lon: 121.508 });

test('uniquePlaces drops rows with the same address, keeping the first', () => {
  const places = [pier(25.056), pier(25.057), pier(25.058, '大稻埕碼頭, 淡埕橋, 大有里, 大同區, 臺北市')];
  const result = uniquePlaces(places);
  assert.deepEqual(result.map((p) => p.lat), [25.056, 25.058]);
});

test('uniquePlaces keeps same-named places at different addresses', () => {
  const places = [pier(25.056, '7-ELEVEN, 中山區'), pier(25.04, '7-ELEVEN, 大安區')];
  assert.equal(uniquePlaces(places).length, 2);
});
