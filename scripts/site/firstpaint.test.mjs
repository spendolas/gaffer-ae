import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaults, configToCssVars } from '../../site/js/config.js';
import { loadFirstPaintFonts } from '../../site/js/fonts.js';
import { renderBlock, syncHtml, isInSync, BEGIN, END } from './sync-boot-vars.mjs';

const html = readFileSync(new URL('../../site/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../site/css/site.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('../../site/js/main.js', import.meta.url), 'utf8');
const vars = configToCssVars(defaults);
const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));

test('boot-vars block matches configToCssVars(defaults) (run node scripts/site/sync-boot-vars.mjs when this fails)', () => {
  assert.ok(isInSync(html, vars));
  const block = html.slice(html.indexOf(BEGIN), html.indexOf(END) + END.length);
  assert.equal(block, renderBlock(vars));
  for (const [name, value] of Object.entries(vars)) assert.ok(block.includes(`${name}: ${value};`), name);
});

test('syncHtml detects drift, repairs it and reports missing markers', () => {
  const stale = html.replace('--color-stage: #121212;', '--color-stage: #000000;');
  assert.equal(isInSync(stale, vars), false);
  assert.equal(syncHtml(stale, vars), html);
  assert.equal(syncHtml('<head></head>', vars), null);
  assert.equal(isInSync(html, { ...vars, '--new-key': '1' }), false);
});

test('the cover, html and body have literal dark fallbacks', () => {
  assert.match(css, /#cover \{[^}]*background: var\(--color-stage, #121212\);/);
  assert.match(css, /\nhtml \{[^}]*background: var\(--color-stage, #121212\);[^}]*color-scheme: dark;/);
  assert.match(css, /\nbody \{[^}]*background: var\(--color-stage, #121212\);/);
});

test('color-scheme and theme-color metas', () => {
  assert.match(head, /<meta name="color-scheme" content="dark">/);
  assert.match(head, /<meta name="theme-color" content="#121212">/);
});

test('both fonts are preloaded with crossorigin', () => {
  for (const file of ['SourceSans3VF-Upright.otf.woff2', 'JetBrainsMono-VF.woff2']) {
    assert.match(head, new RegExp(`<link rel="preload" as="font" type="font/woff2" crossorigin href="fonts/${file.replace(/\./g, '\\.')}">`));
  }
});

test('font-display is block on Source Sans 3 and JetBrains Mono', () => {
  const faces = css.match(/@font-face\s*\{[^}]*\}/g);
  const display = (family) => faces.find((f) => f.includes(`'${family}'`)).match(/font-display:\s*(\w+)/)[1];
  assert.equal(display('Source Sans 3'), 'block');
  assert.equal(display('JetBrains Mono'), 'block');
});

test('head order: boot vars, then stylesheet, then module script', () => {
  const boot = head.indexOf('<style id="boot-vars">');
  const sheet = head.indexOf('<link rel="stylesheet" href="css/site.css">');
  const script = head.indexOf('<script type="module" src="js/main.js">');
  assert.ok(boot > -1 && boot < sheet && sheet < script);
  assert.ok(head.indexOf('<noscript>') > sheet, 'noscript overrides come after the stylesheet');
});

test('noscript still hides the cover', () => {
  assert.match(head, /<noscript>\s*<style>\s*#cover \{ display: none; \}/);
});

test('loadFirstPaintFonts loads both faces at the live weights and settles on errors', async () => {
  const asked = [];
  const fonts = { load: (q) => { asked.push(q); return q.includes('Mono') ? Promise.reject(new Error('x')) : Promise.resolve([]); } };
  await loadFirstPaintFonts(fonts, defaults);
  assert.deepEqual(asked, [`${defaults.headline.weight} 1em "Source Sans 3"`, `${defaults.type.monoWeight} 1em "JetBrains Mono"`]);
  await loadFirstPaintFonts(undefined, defaults);
});

test('main.js gates the cover on the fonts inside the existing single cap', () => {
  assert.match(main, /loadFirstPaintFonts\(document\.fonts, config\)/);
  assert.match(main, /await fontsReady;/);
  assert.equal((main.match(/setTimeout\(/g) || []).length, 1);
});

test('the cover has a CSS-only failsafe that fires after the JS cap', () => {
  const cap = Number(main.match(/POSTER_TIMEOUT_MS = (\d+)/)[1]);
  assert.match(css, /@keyframes cover-failsafe \{\s*to \{ opacity: 0; visibility: hidden; \}\s*\}/);
  const m = css.match(/#cover \{[^}]*animation: cover-failsafe ([\d.]+)s linear ([\d.]+)s forwards;/);
  assert.ok(m, 'cover uses the failsafe animation');
  assert.ok(Number(m[2]) * 1000 > cap, 'failsafe delay is above the JS cap');
});

test('the faded cover is not painted: is-hidden sets visibility with a delayed transition', () => {
  const rule = css.match(/#cover\.is-hidden \{[^}]*\}/)[0];
  assert.match(rule, /opacity: 0;/);
  assert.match(rule, /visibility: hidden;/);
  assert.match(rule, /pointer-events: none;/);
  assert.match(rule, /transition: opacity 0\.4s, visibility 0s 0\.4s;/);
});

test('noscript keeps only layout and the cover rule: the boot variables carry the palette', () => {
  const ns = html.match(/<noscript>\s*<style>([\s\S]*?)<\/style>/)[1];
  assert.doesNotMatch(ns, /#[0-9a-fA-F]{3,8}\b/, 'no literal colours');
  assert.doesNotMatch(ns, /\b(background|border-color|font-family)\s*:/);
  assert.match(ns, /\.dock-app \{ text-decoration: underline; \}/);
  assert.match(ns, /@media \(max-width: 600px\)[\s\S]*\.dock-prompt \{ display: block;[^}]*white-space: normal;/);
});

test('var() fallbacks in site.css match the config defaults', () => {
  const pin = [
    ['--headline-dock-gap', `${defaults.headline.dockGap}px`], ['--headline-weight', `${defaults.headline.weight}`],
    ['--headline-line-height', `${defaults.headline.lineHeight}`], ['--headline-dock-gap-compact', `${defaults.headline.dockGapCompact}px`],
    ['--fader-opacity', `${defaults.fader.opacity}`],
    ['--dock-gap', `${defaults.dock.gap / 16}rem`],
    ['--dock-padding', `${defaults.dock.padding / 16}rem`], ['--type-weight', `${defaults.type.weight}`],
    ['--toast-radius', `${defaults.toast.radius}px`],
  ];
  for (const [name, value] of pin) {
    const found = [...css.matchAll(new RegExp(`var\\(${name}, ([^)]*)\\)`, 'g'))].map((m) => m[1]);
    assert.ok(found.length > 0, name);
    for (const f of found) assert.equal(f, value, `${name} fallback`);
  }
});

test('pinch zoom is allowed: no zoom lock in the viewport, the stage lets the browser pinch, ctrl + wheel is not swallowed', () => {
  const meta = html.match(/<meta name="viewport" content="([^"]*)">/)[1];
  assert.doesNotMatch(meta, /maximum-scale|user-scalable/);
  assert.match(meta, /initial-scale=1/);
  assert.match(css, /#stage \{[^}]*touch-action: pinch-zoom;/);
  const grid = readFileSync(new URL('../../site/js/grid.js', import.meta.url), 'utf8');
  assert.match(grid, /function onWheel\(e\) \{[^}]*if \(e\.ctrlKey\) return;[^}]*e\.preventDefault\(\);/);
  // While zoomed in, touch drags go to the browser (it pans the zoomed view), not to the grid.
  assert.match(grid, /vv\.scale > 1\.02/);
  assert.match(grid, /'pan-x pan-y pinch-zoom'/);
  assert.match(grid, /if \(zoomedIn && e\.pointerType !== 'mouse'\) return;/);
});
