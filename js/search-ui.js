// Place search box: results list under the search bar. onPick(place) runs when a result is tapped.
import { geocode, ServiceError } from './services.js';
import { h, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const cat = (name) => h('img', { src: `img/cat-${name}.webp`, alt: '' });

export function setupSearch(onPick) {
  const results = $('search-results');
  let searchSeq = 0;
  function hide() {
    searchSeq += 1;
    results.hidden = true;
  }
  $('search-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = $('search-input').value.trim();
    hide();
    if (!query) return;
    const seq = searchSeq;
    results.replaceChildren(h('div', { class: 'empty' }, cat('think'), '搜尋中…'));
    results.hidden = false;
    try {
      const places = await geocode(query);
      if (seq !== searchSeq) return;
      if (places.length === 0) {
        results.replaceChildren(h('div', { class: 'empty' }, cat('search'), `找不到「${query}」，換個關鍵字試試`));
        return;
      }
      results.replaceChildren(...places.map((place) => h('button', {
        type: 'button',
        onclick: () => {
          hide();
          $('search-input').blur();
          onPick(place);
        },
      }, place.name, h('small', null, place.detail))));
    } catch (err) {
      console.error('[search] failed', err);
      if (seq !== searchSeq) return;
      results.hidden = true;
      toast(err instanceof ServiceError ? err.message : '搜尋失敗，請稍後再試', 'error');
    }
  });
  $('search-input').addEventListener('input', (event) => {
    if (!event.target.value) hide();
  });
  return { hide };
}
