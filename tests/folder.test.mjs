import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueFileName } from '../js/folder.js';

test('uniqueFileName keeps the route name when free', () => {
  assert.equal(uniqueFileName('河濱短程', []), '河濱短程.gpx');
});

test('uniqueFileName numbers taken names, ignoring case', () => {
  assert.equal(uniqueFileName('Ride', ['ride.GPX']), 'Ride (2).gpx');
  assert.equal(uniqueFileName('Ride', ['Ride.gpx', 'Ride (2).gpx']), 'Ride (3).gpx');
});

test('uniqueFileName replaces characters phones cannot store', () => {
  assert.equal(uniqueFileName('晨騎/大稻埕:早上?', []), '晨騎_大稻埕_早上_.gpx');
  assert.equal(uniqueFileName('   ', []), 'route.gpx');
});
