import test from 'node:test';
import assert from 'node:assert/strict';
import { chineseVoices, pickVoice, speechUnits, watchdogSec, createSpeaker } from '../js/voice.js';

const v = (name, lang, localService = true) => ({ name, lang, localService });
const VOICES = [
  v('English', 'en-US'),
  v('Online HK', 'zh-HK', false),
  v('Online TW', 'zh-TW', false),
  v('Local CN', 'zh-CN'),
  v('Local TW', 'zh_TW'),
  v('Local HK', 'zh-HK'),
];

test('chineseVoices orders Mandarin, local, Taiwan first and leaves out other languages', () => {
  assert.deepEqual(chineseVoices(VOICES).map((x) => x.name), ['Local TW', 'Local CN', 'Online TW', 'Local HK', 'Online HK']);
});

test('pickVoice uses the saved voice or falls back to the best one', () => {
  assert.equal(pickVoice(VOICES, 'Online TW').voice.name, 'Online TW');
  assert.deepEqual(pickVoice(VOICES, 'Gone'), { voice: VOICES[4], missing: 'Gone' });
  assert.deepEqual(pickVoice([v('English', 'en-US')], ''), { voice: null, missing: '' });
});

test('speech length counts Han characters and Latin words', () => {
  assert.equal(speechUnits('前方 100 公尺右轉'), 7);
  assert.equal(watchdogSec('前方右轉', 1), 4 / 2.5 * 2 + 5);
});

// Fake engine: every speak() is recorded; the test decides when it starts, ends or fails.
function fakeEnv() {
  const spoken = [];
  const timers = new Map();
  let now = 0;
  let seq = 0;
  const env = {
    spoken,
    synth: { speak: (u) => spoken.push(u), cancel: () => {}, getVoices: () => VOICES },
    Utterance: class { constructor(text) { this.text = text; } },
    clock: {
      setTimeout: (fn, ms) => { seq += 1; timers.set(seq, { fn, at: now + ms }); return seq; },
      clearTimeout: (id) => timers.delete(id),
    },
    results: [],
    async tick(ms) {
      await flush();
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && timers.has(id)) {
          timers.delete(id);
          t.fn();
          await flush();
        }
      }
      await flush();
    },
  };
  return env;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a prompt waits for the current one and only the latest waiting prompt is spoken', async () => {
  const env = fakeEnv();
  const speaker = createSpeaker({ ...env, onResult: (text, status) => env.results.push([text, status]) });
  speaker.say('一');
  speaker.say('二');
  speaker.say('三');
  await flush();
  assert.deepEqual(env.spoken.map((u) => u.text), ['一']);
  assert.equal(env.spoken[0].lang, 'zh-TW');
  env.spoken[0].onstart();
  env.spoken[0].onend();
  await flush();
  assert.deepEqual(env.spoken.map((u) => u.text), ['一', '三']);
  env.spoken[1].onend();
  await flush();
  assert.deepEqual(env.results, [['一', 'end'], ['三', 'end']]);
});

test('cancel drops the waiting prompt', async () => {
  const env = fakeEnv();
  const speaker = createSpeaker({ ...env, onResult: (text, status) => env.results.push([text, status]) });
  speaker.say('一');
  speaker.say('二');
  await flush();
  speaker.cancel();
  await env.tick(200);
  assert.deepEqual(env.spoken.map((u) => u.text), ['一']);
  assert.deepEqual(env.results, [['一', 'cancelled']]);
});

test('an online voice that never starts is replaced by a local one', async () => {
  const env = fakeEnv();
  const fallbacks = [];
  const speaker = createSpeaker({ ...env, onFallback: (from, to) => fallbacks.push([from.name, to.name]) });
  const online = VOICES[2];
  speaker.say('右轉', { voice: online });
  await flush();
  assert.equal(env.spoken[0].voice.name, 'Online TW');
  await env.tick(3000);
  assert.deepEqual(fallbacks, [['Online TW', 'Local TW']]);
  assert.equal(env.spoken[1].voice.name, 'Local TW');
  assert.equal(env.spoken[1].lang, 'zh_TW');
  env.spoken[1].onend();
  await env.tick(200);
  // Later prompts skip the failed voice straight away.
  speaker.say('左轉', { voice: online });
  await flush();
  assert.equal(env.spoken[2].voice.name, 'Local TW');
});

test('an utterance that runs too long is given up on', async () => {
  const env = fakeEnv();
  const speaker = createSpeaker({ ...env, onResult: (text, status) => env.results.push([text, status]) });
  speaker.say('前方右轉');
  await flush();
  env.spoken[0].onstart();
  await env.tick(watchdogSec('前方右轉', 1) * 1000);
  assert.deepEqual(env.results, [['前方右轉', 'timeout']]);
});
