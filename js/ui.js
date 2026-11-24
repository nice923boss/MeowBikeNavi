// Small DOM helpers shared by the planner and the navigator.

/** Create an element. Props starting with "on" are listeners; null/false props are skipped. */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value);
  }
  el.append(...children.flat().filter((child) => child != null && child !== false));
  return el;
}

let toastTimer;
export function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 6000 : 3500);
}

/**
 * Modal dialog. buttons: [{ label, value, primary?, danger? }].
 * Resolves { value, text }; value is null when dismissed with Esc or the back gesture.
 */
export function dialog({ title, message, image, input, buttons }) {
  return new Promise((resolve) => {
    const dlg = document.getElementById('dlg');
    let result = { value: null, text: '' };
    const field = input
      ? h('input', { type: 'text', value: input.value ?? '', placeholder: input.placeholder ?? '', maxLength: 80 })
      : null;
    const choose = (value) => {
      result = { value, text: field ? field.value.trim() : '' };
      dlg.close();
    };
    const form = h('form', {
      onsubmit: (event) => {
        event.preventDefault();
        choose((buttons.find((b) => b.primary) ?? buttons[0]).value);
      },
    },
      image && h('img', { src: image, alt: '' }),
      title && h('h3', null, title),
      message && h('p', null, message),
      field,
      h('div', { class: 'buttons' }, buttons.map((b) => h('button', {
        type: 'button',
        class: b.primary ? 'primary' : b.danger ? 'danger' : '',
        onclick: () => choose(b.value),
      }, b.label))),
    );
    dlg.replaceChildren(form);
    dlg.addEventListener('close', () => resolve(result), { once: true });
    dlg.showModal();
    field?.select();
  });
}

/**
 * Hand a text file to the user: the share sheet on phones that can share files (iOS "儲存到檔案",
 * cloud drive apps), otherwise a normal download. Returns 'shared', 'cancelled' or 'downloaded'.
 */
export async function shareOrDownload(filename, text, mime) {
  const file = new File([text], filename, { type: mime });
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
      console.warn('[export] share failed, falling back to download', err);
    }
  }
  const url = URL.createObjectURL(file);
  const link = h('a', { href: url, download: filename, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

/** Open the system file picker. No `accept` filter: iOS greys out extensions it does not know (.gpx). */
export function pickFiles() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', multiple: true, hidden: true });
    const done = (files) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files)));
    input.addEventListener('cancel', () => done([]));
    document.body.append(input); // iOS ignores click() on a detached input
    input.click();
  });
}

/** Small preferences; losing one is harmless, so failures are only logged. */
export function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch (err) {
    console.warn('[prefs] cannot read', key, err);
    return fallback;
  }
}

export function lsSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('[prefs] cannot save', key, err);
  }
}

export function geoErrorText(err) {
  if (err.code === 1) return '定位權限被拒絕，請到瀏覽器設定允許這個網站使用位置';
  if (err.code === 3) return '定位逾時，請到空曠處再試';
  return '目前收不到定位訊號';
}
