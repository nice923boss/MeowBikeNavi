// Spoken prompts through the browser's speech engine (Web Speech API). Voice handling follows the
// decisions tested in the ListenUp Quiz speech spike: explicit voice and lang on every utterance,
// local voices before online ones, watchdogs for an utterance that never starts or never ends,
// and a local replacement for an online voice that fails.

const START_TIMEOUT_MS = 3000;
const VOICE_WAIT_MS = 1500;
const AFTER_CANCEL_MS = 150; // Chrome can swallow a speak() that follows cancel() at once
const DEFAULT_LANG = 'zh-TW';

const tagOf = (lang) => String(lang || '').replace(/_/g, '-').toLowerCase();
const isChinese = (lang) => /^(?:zh|cmn|yue)(?:-|$)/.test(tagOf(lang));
// Cantonese voices read the prompts in Cantonese, so they are the last resort.
const isCantonese = (lang) => /^(?:yue|zh-hk|zh-mo)(?:-|$)/.test(tagOf(lang)) || /-hk$/.test(tagOf(lang));
const isTaiwan = (lang) => /-tw$/.test(tagOf(lang));

/** Chinese voices, best first: Mandarin before Cantonese, local before online, Taiwan first. */
export function chineseVoices(voices) {
  const key = (v) => [Number(isCantonese(v.lang)), Number(!v.localService), Number(!isTaiwan(v.lang))];
  return (voices ?? [])
    .map((voice, index) => ({ voice, index, key: key(voice) }))
    .filter(({ voice }) => isChinese(voice.lang))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2] || a.index - b.index)
    .map(({ voice }) => voice);
}

/** Saved name -> voice. A name this device does not have falls back to the best Chinese voice. */
export function pickVoice(voices, name) {
  const list = chineseVoices(voices);
  const found = name ? list.find((v) => v.name === name) : null;
  return { voice: found ?? list[0] ?? null, missing: name && !found ? name : '' };
}

export const voiceLabel = (voice) => `${voice.name}（${voice.lang}）`;

/** Calls onChange with the voice list now and on every voiceschanged (Chrome fires it twice). */
export function watchVoices(onChange, synth = globalThis.speechSynthesis) {
  if (!synth) {
    onChange([]);
    return;
  }
  let waited = false;
  const emit = () => {
    const list = synth.getVoices();
    if (list.length > 0 || waited) onChange(list);
  };
  synth.addEventListener?.('voiceschanged', () => { waited = true; emit(); });
  emit();
  setTimeout(() => { waited = true; emit(); }, VOICE_WAIT_MS);
}

/** Latin words plus Han characters: a rough length of the spoken text. */
export function speechUnits(text) {
  const s = String(text ?? '');
  return (s.match(/[A-Za-z0-9']+/g) ?? []).length + (s.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
}

/** Seconds after which one utterance is given up on. */
export const watchdogSec = (text, rate) => (speechUnits(text) / (2.5 * rate)) * 2 + 5;

/**
 * Speaker with a latest-wins queue: a prompt that arrives while another is being spoken waits for
 * it to finish and replaces any prompt already waiting, so stale prompts are never read out.
 * onResult(text, status) reports 'end' | 'error' | 'no-start' | 'timeout' | 'cancelled'.
 */
export function createSpeaker(options = {}) {
  const synth = options.synth ?? globalThis.speechSynthesis;
  const Utterance = options.Utterance ?? globalThis.SpeechSynthesisUtterance;
  const clock = options.clock ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
  const getVoices = options.getVoices ?? (() => synth.getVoices());
  const onFallback = options.onFallback ?? (() => {});
  const onResult = options.onResult ?? (() => {});
  const failed = new Set();
  let current = null; // { utterance, cancel }: also keeps the utterance from being collected mid-speech
  let waiting = null;
  let busy = false;

  function speakOnce(text, voice, rate) {
    return new Promise((resolve) => {
      const u = new Utterance(text);
      if (voice) u.voice = voice;
      u.lang = voice ? voice.lang : DEFAULT_LANG;
      u.rate = rate;
      let settled = false;
      let startTimer = null;
      let limitTimer = null;
      const finish = (status, error) => {
        if (settled) return;
        settled = true;
        clock.clearTimeout(startTimer);
        clock.clearTimeout(limitTimer);
        if (current?.utterance === u) current = null;
        resolve({ status, error: error ?? '' });
      };
      const giveUp = (status, reason) => {
        console.warn(`[voice] ${reason}: "${text}" (${voice ? voice.name : 'default voice'})`);
        finish(status);
        synth.cancel();
      };
      u.onstart = () => clock.clearTimeout(startTimer);
      u.onend = () => finish('end');
      u.onerror = (event) => finish('error', event.error);
      current = { utterance: u, cancel: () => finish('cancelled') };
      startTimer = clock.setTimeout(() => giveUp('no-start', `not started within ${START_TIMEOUT_MS} ms`), START_TIMEOUT_MS);
      limitTimer = clock.setTimeout(() => giveUp('timeout', 'ran past the watchdog limit'), watchdogSec(text, rate) * 1000);
      synth.speak(u);
    });
  }

  const localSpare = () => chineseVoices(getVoices()).find((v) => v.localService && !failed.has(v.name)) ?? null;

  async function run(job) {
    busy = true;
    let voice = job.voice && failed.has(job.voice.name) ? localSpare() : job.voice;
    let result = await speakOnce(job.text, voice, job.rate);
    // An online voice that errors or stays silent is replaced by a local one for this session.
    while (voice && !voice.localService && (result.status === 'error' || result.status === 'no-start')) {
      failed.add(voice.name);
      const spare = localSpare();
      if (!spare) break;
      onFallback(voice, spare);
      voice = spare;
      result = await speakOnce(job.text, voice, job.rate);
    }
    if (result.status === 'error') console.warn(`[voice] speech error "${result.error}": "${job.text}"`);
    onResult(job.text, result.status);
    if (result.status !== 'end') await new Promise((resolve) => { clock.setTimeout(resolve, AFTER_CANCEL_MS); });
    busy = false;
    if (waiting) {
      const next = waiting;
      waiting = null;
      run(next);
    }
  }

  return {
    /** Speak now, or right after the prompt being spoken. */
    say(text, { voice = null, rate = 1 } = {}) {
      const job = { text, voice, rate };
      if (busy) waiting = job;
      else run(job);
    },
    cancel() {
      waiting = null;
      current?.cancel();
      synth.cancel();
    },
  };
}
