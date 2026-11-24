// Voice prompt settings (drawer + HUD mute button). Returns the { say, stop } object nav.js speaks through.
import { createSpeaker, chineseVoices, pickVoice, voiceLabel, watchVoices } from './voice.js';
import { h, toast, lsGet, lsSet } from './ui.js';

const $ = (id) => document.getElementById(id);

export function setupVoice({ sim = false } = {}) {
  const supported = Boolean(window.speechSynthesis && window.SpeechSynthesisUtterance);
  const saved = lsGet('mbn.voice', {}) ?? {};
  let prefs = {
    on: typeof saved.on === 'boolean' ? saved.on : true,
    name: typeof saved.name === 'string' ? saved.name : '',
    rate: Number.isFinite(saved.rate) ? Math.min(1.5, Math.max(0.7, saved.rate)) : 1,
  };
  let voices = [];
  let loaded = false;
  if (sim) {
    window.__mbnSaid = []; // every prompt handed to the speech engine
    window.__mbnSpoken = []; // [text, status] reported back by the engine
  }
  const speaker = supported ? createSpeaker({
    onFallback: (from, to) => toast(`線上語音「${from.name}」沒有回應，改用本機語音「${to.name}」`),
    onResult: sim ? (text, status) => window.__mbnSpoken.push([text, status]) : undefined,
  }) : null;
  const speak = (text) => {
    if (sim) window.__mbnSaid.push(text);
    speaker?.say(text, { voice: pickVoice(voices, prefs.name).voice, rate: prefs.rate });
  };

  function render() {
    const { voice: current, missing } = pickVoice(voices, prefs.name);
    const list = chineseVoices(voices);
    const option = (value, label) => h('option', { value, selected: value === prefs.name }, label);
    const group = (label, items) => items.length > 0 && h('optgroup', { label }, items.map((v) => option(v.name, voiceLabel(v))));
    $('voice-name').replaceChildren(...[
      option('', current && !prefs.name ? `自動（目前是 ${current.name}）` : '自動'),
      group('本機語音（離線可用）', list.filter((v) => v.localService)),
      group('線上語音（需要網路）', list.filter((v) => !v.localService)),
    ].filter(Boolean));
    if (missing) $('voice-name').value = '';
    $('voice-on').checked = prefs.on;
    $('voice-rate').value = String(prefs.rate);
    $('voice-rate-out').textContent = `${prefs.rate.toFixed(1)} 倍`;
    for (const id of ['voice-on', 'voice-name', 'voice-rate', 'btn-voice-test']) $(id).disabled = !supported;

    let message = '';
    if (!supported) message = '這個瀏覽器不支援語音，導航時只會顯示文字提醒。';
    else if (loaded && list.length === 0) message = '這支手機找不到中文語音，請到系統設定的「文字轉語音」下載中文語音。';
    else if (loaded && missing) message = `這支手機沒有之前選的「${missing}」，暫時改用 ${current.name}。`;
    $('voice-msg').textContent = message;
    $('voice-msg').hidden = !message;

    const button = $('btn-voice');
    button.hidden = !supported;
    button.textContent = prefs.on ? '🔊 語音' : '🔇 靜音';
    button.setAttribute('aria-pressed', String(prefs.on));
    button.setAttribute('aria-label', prefs.on ? '語音提醒開啟中，點一下靜音' : '語音提醒已關閉，點一下開啟');
  }

  function setPrefs(patch) {
    prefs = { ...prefs, ...patch };
    lsSet('mbn.voice', prefs);
    render();
  }
  function setOn(on) {
    setPrefs({ on });
    if (on) speak('語音提醒已開啟');
    else speaker?.cancel();
  }
  $('voice-on').addEventListener('change', (event) => setOn(event.target.checked));
  $('btn-voice').addEventListener('click', () => setOn(!prefs.on));
  $('voice-name').addEventListener('change', (event) => setPrefs({ name: event.target.value }));
  $('voice-rate').addEventListener('input', (event) => setPrefs({ rate: Number(event.target.value) }));
  // The test plays even with prompts turned off, so the rider can pick a voice first.
  $('btn-voice-test').addEventListener('click', () => speak('前方 100 公尺右轉，進入中山北路'));
  render();
  if (supported) {
    watchVoices((list) => {
      voices = list;
      loaded = true;
      render();
    });
  }

  return {
    say: (text) => { if (prefs.on) speak(text); },
    stop: () => speaker?.cancel(),
  };
}
