// Boot: apply the look, load the manifest, start the grid, then lift the
// cover once the posters near the viewport have settled (or after a cap, so a
// slow network cannot hold the page hostage).

import { defaults, applyConfig, cloneConfig, faderShowsEllipse } from './config.js';
import { drawFader, faderParams, debounced } from './fader.js';
import { loadFirstPaintFonts } from './fonts.js';
import { createGrid } from './grid.js';
import { loadItems } from './media.js';
import { createToast, mountDock, makeExecCopy, applyHeadline, applyNote } from './dock.js';

const POSTER_TIMEOUT_MS = 2000;

let config = cloneConfig(defaults);
const stage = document.getElementById('stage');
const cover = document.getElementById('cover');
const headlineEl = document.querySelector('h1.headline');
const faderEl = document.querySelector('.fader');

// The fader is one canvas drawn by fader.js (the ellipse with its dither noise baked into the alpha).
// fader.mode: the ellipse shows in 'ellipse' and 'both'; grid.js does the row fade. Redrawn, debounced, when
// the viewport size or any fader setting changes (the pixels depend on both).
function drawFaderNow() {
  if (!faderEl || !faderShowsEllipse(config.fader.mode)) return;
  const r = faderEl.getBoundingClientRect();
  if (!r.width || !r.height) return;
  drawFader(faderEl, r.width, r.height, faderParams(config.fader, config.color.fader, r.width));
}
const scheduleFader = debounced(drawFaderNow, 60);
function applyFaderMode() {
  if (faderEl) faderEl.style.display = faderShowsEllipse(config.fader.mode) ? '' : 'none';
  scheduleFader();
}
if (faderEl && typeof ResizeObserver === 'function') new ResizeObserver(scheduleFader).observe(faderEl);

// The cover cap starts now and races the whole chain (manifest, grid,
// posters), so nothing on the network can hold the cover up past it. The
// chain still finishes after the cover lifts; it runs exactly once.
let capTimer = 0;
const cap = new Promise((resolve) => { capTimer = setTimeout(resolve, POSTER_TIMEOUT_MS); });

async function startGallery() {
  const fontsReady = loadFirstPaintFonts(document.fonts, config); // starts at once, in parallel with the manifest
  const items = await loadItems();
  const dockEl = document.getElementById('dock');
  const zones = {
    headline: [headlineEl].filter(Boolean),
    dock: [dockEl?.querySelector('.dock-pill'), dockEl?.querySelector('.dock-note')].filter(Boolean),
  };
  const grid = createGrid(stage, { items, getConfig: () => config, zones });
  await grid.ready;
  await fontsReady;
}

try {
  applyConfig(document.documentElement, config);
  applyHeadline(headlineEl, config.copy);
  applyNote(config.copy);
  applyFaderMode();
  drawFaderNow(); // synchronously at boot, so it is there when the cover lifts
  const dock = document.getElementById('dock');
  const toast = createToast(document.getElementById('toast'), { getDuration: () => config.toast.duration });
  mountDock(dock, {
    toast,
    getCopy: () => config.copy,
    getDock: () => config.dock,
    env: { get clipboard() { return navigator.clipboard; }, execCopy: makeExecCopy(dock) },
  });
  const gallery = startGallery().catch((err) => console.error('gallery failed to start', err));
  await Promise.race([gallery, cap]);
} finally {
  clearTimeout(capTimer);
  cover.classList.add('is-hidden');
}
