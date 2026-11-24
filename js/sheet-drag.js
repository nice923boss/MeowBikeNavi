// On phones the planner is a bottom sheet: drag its handle to set how tall it is, tap it to fold it.
import { lsGet, lsSet } from './ui.js';

const KEY = 'mbn.sheetMax';
const TAP = 6; // pointer travel (px) below which a press counts as a tap
const POINTS_MIN = 60; // px of the point list kept in view at the lowest open height

/** sheet: #planner (re-renders its children, so the handle is found per press); topbar: the sheet never covers it. */
export function setupSheetDrag(sheet, topbar, wide) {
  let max = Math.max(Number(lsGet(KEY, 0)) || 0, 0);
  let drag = null;
  let eatClick = false;

  const limit = () => document.documentElement.clientHeight - topbar.getBoundingClientRect().bottom - 8;
  const apply = () => {
    const sized = !wide.matches && max > 0;
    sheet.classList.toggle('sized', sized);
    sheet.style.setProperty('--sheet-max', sized ? `${Math.round(Math.min(max, limit()))}px` : '');
  };
  // Height of the sheet with only the handle and the summary showing.
  const foldedHeight = (rect) => {
    if (sheet.classList.contains('collapsed')) return rect.height;
    const summary = sheet.querySelector('.summary');
    return (summary ? summary.getBoundingClientRect().bottom - rect.top : 60) + parseFloat(getComputedStyle(sheet).paddingBottom);
  };
  // Lowest open height: everything shows, the point list keeps at least POINTS_MIN px (measured unfolded).
  const openHeight = () => {
    const points = sheet.querySelector('.points');
    if (!points) return sheet.scrollHeight;
    return sheet.scrollHeight - points.clientHeight + Math.min(points.scrollHeight, POINTS_MIN);
  };

  sheet.addEventListener('pointerdown', (event) => {
    eatClick = false;
    const handle = event.target.closest('.handle');
    if (!handle || wide.matches || (event.pointerType === 'mouse' && event.button !== 0)) return;
    handle.setPointerCapture(event.pointerId);
    const rect = sheet.getBoundingClientRect();
    drag = { y: event.clientY, top: rect.top, bottom: rect.bottom, folded: foldedHeight(rect), from: max, moved: false };
  });
  sheet.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < TAP) return;
    drag.moved = true;
    const height = drag.bottom - (drag.top + dy);
    sheet.classList.remove('collapsed');
    const open = openHeight();
    // Below halfway between folded and the lowest open height, the sheet folds.
    if (height < (drag.folded + open) / 2) {
      sheet.classList.add('collapsed');
      return;
    }
    max = Math.min(Math.max(height, open), limit());
    apply();
  });
  const end = () => {
    if (!drag) return;
    if (drag.moved) {
      eatClick = true; // the handle's own click would fold or unfold the sheet again
      // Folding keeps the height it had, so a tap opens it to that height again.
      if (sheet.classList.contains('collapsed')) max = drag.from;
      apply();
      lsSet(KEY, Math.round(max) || null);
    }
    drag = null;
  };
  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
  sheet.addEventListener('click', (event) => {
    if (eatClick && event.target.closest('.handle')) {
      event.stopPropagation();
      event.preventDefault();
    }
    eatClick = false;
  }, true);

  wide.addEventListener('change', apply);
  window.addEventListener('resize', apply);
  apply();
}
