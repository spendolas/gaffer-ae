import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHECK_PATH, INSTALL_PROMPT, DEEP_LINK_MAX_PROMPT, desktopLink, copyText, createToast, applyHeadline, applyNote, splitNote, isDesktopPlatform, readEnvironment } from '../../site/js/dock.js';

import { defaults } from '../../site/js/config.js';

const html = readFileSync(new URL('../../site/index.html', import.meta.url), 'utf8');

test('installPromptIsTheExactConstant', () => {
  assert.equal(INSTALL_PROMPT, 'Install Gaffer by following https://gafferae.com/install.md');
});

test('staticDockCarriesThePromptAndThePlainNoteWithoutJs', () => {
  assert.ok(html.includes(`<code class="dock-prompt">${INSTALL_PROMPT}</code>`), 'prompt text');
  const note = html.match(/<p class="dock-note">([^<]*(?:<[^>]*>[^<]*)*?)<\/p>/);
  assert.ok(note, 'note present');
  assert.equal(note[1], defaults.copy.note, 'the static note equals the default, so applyNote changes no visible text on load');
  assert.ok(!/<a[\s>]/.test(note[1]), 'note has no anchor');
  assert.ok(!/dock-wordmark/.test(html), 'no wordmark element in the pill');
  assert.ok(!html.includes('<h1 class="visually-hidden">'), 'the hidden h1 is gone');
  assert.ok(/<div id="toast"[^>]*aria-live="polite"/.test(html), 'toast live region');
  assert.ok(!html.includes('dock-button'), 'copy button is added by JS only');
});

test('usesClipboardWhenAvailable', async () => {
  const written = [];
  const env = { clipboard: { writeText: async (t) => { written.push(t); } }, execCopy: () => { throw new Error('unused'); } };
  assert.equal(await copyText('hi', env), 'clipboard');
  assert.deepEqual(written, ['hi']);
});

test('fallsBackWhenClipboardRejects', async () => {
  const env = { clipboard: { writeText: async () => { throw new Error('denied'); } }, execCopy: () => true };
  assert.equal(await copyText('hi', env), 'fallback');
});

test('fallsBackWhenClipboardMissing', async () => {
  assert.equal(await copyText('hi', { execCopy: () => true }), 'fallback');
});

test('failsWhenBothFail', async () => {
  const env = { clipboard: { writeText: async () => { throw new Error('denied'); } }, execCopy: () => false };
  assert.equal(await copyText('hi', env), 'failed');
  assert.equal(await copyText('hi', { execCopy: () => { throw new Error('nope'); } }), 'failed');
  assert.equal(await copyText('hi', {}), 'failed');
});

function fakeEl() {
  const classes = new Set();
  const attrs = {};
  return {
    textContent: '',
    dataset: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    setAttribute: (k, v) => { attrs[k] = v; },
    attrs,
  };
}

function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => { pending.set(next, { fn, ms }); return next++; },
    clearTimeout: (id) => { pending.delete(id); },
    pending,
  };
}

test('toastShowsThenDismissesAndResetsTimer', () => {
  const el = fakeEl();
  const timers = fakeTimers();
  const toast = createToast(el, { timers });
  assert.equal(el.attrs['aria-live'], 'polite');
  toast.show('Copied.');
  assert.equal(el.textContent, 'Copied.');
  assert.ok(el.classList.contains('is-visible'));
  assert.equal([...timers.pending.values()][0].ms, 2000);
  toast.show('Copy failed.', 'error');
  assert.equal(timers.pending.size, 1, 'old timer cleared');
  assert.equal(el.dataset.kind, 'error');
  [...timers.pending.values()][0].fn();
  assert.ok(!el.classList.contains('is-visible'));
});

test('toastReadsTheDurationAtEachShow', () => {
  const el = fakeEl();
  const timers = fakeTimers();
  let duration = 2000;
  const toast = createToast(el, { timers, getDuration: () => duration });
  toast.show('a');
  assert.equal([...timers.pending.values()][0].ms, 2000);
  duration = 4500;
  toast.show('b');
  assert.equal([...timers.pending.values()][0].ms, 4500);
});

// Fake DOM for makeExecCopy: a Selection that holds ranges, a document with
// execCommand and an active element.
function fakeCopyDom({ visiblePrompt, copyOk, selected = [], active = null }) {
  const ranges = [...selected];
  const sel = {
    get rangeCount() { return ranges.length; },
    getRangeAt: (i) => ranges[i],
    removeAllRanges: () => { ranges.length = 0; },
    addRange: (r) => { ranges.push(r); },
  };
  const button = { focus() { doc.activeElement = button; } };
  const body = {};
  const created = [];
  const doc = {
    activeElement: active === 'button' ? button : body,
    body: { append: (n) => created.push(n), ...body },
    createRange: () => ({ tag: 'prompt-range', selectNodeContents() {} }),
    createElement: () => {
      const ta = {
        style: {}, removed: false,
        setAttribute() {},
        select() { ranges.length = 0; ranges.push({ tag: 'textarea-range' }); doc.activeElement = ta; },
        remove() { ta.removed = true; if (doc.activeElement === ta) doc.activeElement = body; },
        focus() { doc.activeElement = ta; },
      };
      return ta;
    },
    execCommand: (c) => { assert.equal(c, 'copy'); return copyOk; },
  };
  doc.body = Object.assign(doc.body, { tag: 'body' });
  doc.activeElement = active === 'button' ? button : doc.body;
  const root = {
    querySelector: () => ({ getClientRects: () => (visiblePrompt ? [{}] : []) }),
  };
  return { doc, sel, root, ranges, button, created };
}

test('execCopyRestoresPriorSelectionAndFocusOnSuccess', async () => {
  const { makeExecCopy } = await import('../../site/js/dock.js');
  for (const visiblePrompt of [true, false]) {
    const note = { tag: 'note-range' };
    const f = fakeCopyDom({ visiblePrompt, copyOk: true, selected: [note], active: 'button' });
    const ok = makeExecCopy(f.root, { document: f.doc, getSelection: () => f.sel })();
    assert.equal(ok, true);
    assert.deepEqual(f.ranges, [note], 'user selection restored');
    assert.equal(f.doc.activeElement, f.button, 'focus back on the button');
    if (!visiblePrompt) assert.ok(f.created[0].removed, 'temporary textarea removed');
  }
});

test('execCopyClearsSelectionOnSuccessWhenNothingWasSelected', async () => {
  const { makeExecCopy } = await import('../../site/js/dock.js');
  for (const visiblePrompt of [true, false]) {
    const f = fakeCopyDom({ visiblePrompt, copyOk: true, active: 'button' });
    assert.equal(makeExecCopy(f.root, { document: f.doc, getSelection: () => f.sel })(), true);
    assert.equal(f.sel.rangeCount, 0);
    assert.equal(f.doc.activeElement, f.button);
  }
});

test('execCopyLeavesSelectionAloneOnFailure', async () => {
  const { makeExecCopy } = await import('../../site/js/dock.js');
  const f = fakeCopyDom({ visiblePrompt: true, copyOk: false, selected: [{ tag: 'note-range' }], active: 'button' });
  assert.equal(makeExecCopy(f.root, { document: f.doc, getSelection: () => f.sel })(), false);
  assert.deepEqual(f.ranges.map((r) => r.tag), ['prompt-range'], 'prompt stays selected');
  const g = fakeCopyDom({ visiblePrompt: false, copyOk: false, active: 'button' });
  assert.equal(makeExecCopy(g.root, { document: g.doc, getSelection: () => g.sel })(), false);
  assert.ok(g.created[0].removed);
});

test('deepLinkBuilderEncodesTheInstallPromptExactly', () => {
  const q = 'Install%20Gaffer%20by%20following%20https%3A%2F%2Fgafferae.com%2Finstall.md';
  assert.equal(desktopLink(INSTALL_PROMPT), `claude://code/new?q=${q}`);
});

test('deepLinkCarriesOnlyQAndStaysWithinTheDocumentedLimit', () => {
  const link = desktopLink(INSTALL_PROMPT);
  assert.deepEqual([...new URL(link).searchParams.keys()], ['q']);
  assert.ok(!/cwd|repo|folder/i.test(link));
  assert.ok(!/[ :]/.test(link.split('?q=')[1]), 'spaces and colons are encoded');
  assert.ok(!link.split('?q=')[1].includes('/'), 'slashes are encoded');
  assert.ok(INSTALL_PROMPT.length <= DEEP_LINK_MAX_PROMPT);
});

test('staticDockHasOnlyTheAppLinkInsideTheCtaGroupAfterThePrompt', () => {
  const hrefs = [...html.matchAll(/<a class="dock-cta[^"]*" href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, [desktopLink(INSTALL_PROMPT)], 'one deep link, equal to the builder output');
  assert.ok(!/claude-cli|terminal/i.test(html.replace(/<noscript>[\s\S]*?<\/noscript>/g, '')), 'no terminal link');
  assert.ok(html.includes('title="Opens the Claude desktop app (Code tab) with the install prompt filled in. You press Enter to send it."'));
  assert.ok(!/dock-app[^>]*(onclick|target=)/.test(html), 'plain anchor, no handler');
  const group = html.indexOf('<div class="dock-ctas">');
  assert.ok(html.indexOf('<code class="dock-prompt"') < group);
  const anchor = html.indexOf('class="dock-cta dock-cta-primary dock-app"');
  assert.ok(group < anchor);
  assert.ok(anchor < html.indexOf('</div>', group), 'the app link is inside the group');
  assert.ok(/<a class="dock-cta dock-cta-primary dock-app"/.test(html), 'app link is the primary button');
});

test('staticDockExposesTheCaveatAsAnAccessibleDescription', () => {
  const text = 'Opens the Claude desktop app (Code tab) with the install prompt filled in. You press Enter to send it.';
  assert.ok(html.includes(`<span class="visually-hidden" id="dock-hint-app" hidden>${text}</span>`), 'hint is hidden so it is not read twice when the link is display:none');
  assert.ok(html.includes(`title="${text}"`), 'title and hint share one wording');
  assert.match(html, /class="dock-cta dock-cta-primary dock-app"[^>]*aria-describedby="dock-hint-app"/);
  assert.ok(!/<a class="dock-cta[^>]*aria-label/.test(html), 'visible text stays the name');
  assert.ok(!/dock-hint-cli/.test(html));
  const pillEnd = html.indexOf('</div>', html.indexOf('</div>', html.indexOf('<div class="dock-ctas">')) + 1);
  assert.ok(html.indexOf('id="dock-hint-app"') > pillEnd, 'the hint sits outside the pill');
  assert.ok(html.indexOf('id="dock-hint-app"') < html.indexOf('</div>', pillEnd + 1), 'the hint stays inside #dock');
  assert.ok(/<noscript>[\s\S]*\.dock-app \{[^}]*underline/.test(html), 'no-JS affordance');
});

test('mountDockRefreshesLabelsAndAppendsCopyToTheGroupOnce', async () => {
  const { mountDock } = await import('../../site/js/dock.js');
  const mk = (cls) => ({ className: cls, textContent: '', children: [], dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, append(...n) { this.children.push(...n); }, addEventListener() {}, classList: { add() {}, remove() {} } });
  const prompt = mk('dock-prompt');
  const app = mk('dock-app');
  const group = { kids: [app], append(n) { this.kids.push(n); }, querySelector(sel) { return this.kids.find((k) => '.' + k.className.split(' ').pop() === sel) || null; } };
  const pill = { querySelector(sel) {
    if (sel === '.dock-button') return group.kids.find((k) => k.className.includes('dock-button')) || null;
    return null;
  } };
  const root = { dataset: {}, classList: { add() {}, remove() {} }, contains: () => true,
    querySelector: (sel) => ({ '.dock-pill': pill, '.dock-prompt': prompt, '.dock-ctas': group })[sel] ?? null };
  const prevDoc = globalThis.document;
  globalThis.document = { createElement: () => mk(''), addEventListener() {}, removeEventListener() {} };
  try {
    const copy = { buttonCompact: 'C', linkDesktop: 'App', toastOk: 'ok', toastError: 'err' };
    const ui = mountDock(root, { toast: { show() {} }, env: {}, getCopy: () => copy });
    assert.equal(app.textContent, 'App');
    assert.deepEqual(group.kids.map((k) => k.className), ['dock-app', 'dock-cta dock-button'], 'app first, then Copy');
    const btn = group.kids[1];
    const [icon, short] = btn.children;
    assert.equal(icon.className, 'dock-icon');
    assert.match(icon.innerHTML, /^<svg [^>]*viewBox="0 0 24 24"[^>]*fill="none"[^>]*stroke="currentColor"[^>]*stroke-width="2"[^>]*stroke-linecap="round"[^>]*stroke-linejoin="round"[^>]*aria-hidden="true"[^>]*focusable="false"/);
    assert.ok(icon.innerHTML.includes('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>'), 'Lucide copy rect');
    assert.ok(icon.innerHTML.includes('d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"'), 'Lucide copy path');
    assert.equal(btn.attrs['aria-label'], 'C', 'the visible label names the button');
    assert.equal(btn.title, undefined, 'no tooltip repeating a visible label');
    assert.equal(short.className, 'dock-label-short');
    assert.equal(short.textContent, 'C', 'compact label from config');
    copy.buttonCompact = 'Cp';
    copy.linkDesktop = 'App2';
    ui.refresh();
    assert.equal(btn.attrs['aria-label'], 'Cp', 'label updates live');
    assert.equal(short.textContent, 'Cp');
    assert.equal(app.textContent, 'App2');
    mountDock(root, { toast: { show() {} }, env: {}, getCopy: () => copy });
    assert.equal(group.kids.length, 2, 'second mount adds nothing');
    // No app link (data-app none): the visible label is shown, so it names the button.
    const group2 = { kids: [], append(n) { this.kids.push(n); }, querySelector: () => null };
    const root2 = { ...root, dataset: {}, querySelector: (sel) => ({ '.dock-pill': { querySelector: () => null }, '.dock-prompt': prompt, '.dock-ctas': group2 })[sel] ?? null };
    const phone = { userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile', platform: 'Linux armv81', maxTouchPoints: 5 };
    copy.buttonCompact = 'Copy install prompt';
    const ui2 = mountDock(root2, { toast: { show() {} }, env: {}, getCopy: () => copy, nav: phone });
    assert.equal(root2.dataset.app, 'none');
    const btn2 = group2.kids[0];
    assert.equal(btn2.attrs['aria-label'], 'Copy install prompt');
    copy.buttonCompact = 'Copy it all';
    ui2.refresh();
    assert.equal(btn2.attrs['aria-label'], 'Copy it all', 'follows the visible label live');
    assert.equal(root.dataset.links, undefined, 'no data-links switch any more');
  } finally {
    globalThis.document = prevDoc;
  }
});

test('licenceFileForTheLucideIconShipsWithTheSite', () => {
  const lic = readFileSync(new URL('../../site/LICENSE-lucide.txt', import.meta.url), 'utf8');
  assert.match(lic, /ISC License/);
  assert.match(lic, /Lucide Icons and Contributors/);
});

test('stylesheetCopyIsBorderlessSecondaryFillAndTheGroupPaddingIsTheConfiguredZero', () => {
  const css = readFileSync(new URL('../../site/css/site.css', import.meta.url), 'utf8');
  const cta = css.match(/\.dock-cta \{[^}]*\}/)[0];
  assert.match(cta, /border: 0;/);
  assert.ok(!/calc\(0\.625rem - 1px\)/.test(css), 'no 1px padding hack');
  assert.match(css, /\.dock-button \{[^}]*background: var\(--color-secondary-fill\)/);
  assert.match(css, /\.dock-button:hover \{[^}]*background: var\(--color-secondary-hover\)/);
  assert.match(css, /\.dock-ctas \{[^}]*padding: var\(--dock-cta-padding, 0\);/, 'group padding follows the config (0), at every width');
});

test('stylesheetHidesThePromptAtEveryWidthAndRevealsItOnlyAfterAFailedCopy', () => {
  const css = readFileSync(new URL('../../site/css/site.css', import.meta.url), 'utf8');
  assert.match(css, /\.dock-prompt \{\s*display: none;/, 'hidden by default, not only in a phone media query');
  assert.match(css, /#dock\.is-revealed \.dock-prompt \{\s*display: block;/);
  // The revealed state on a wide screen is the designed one-line pill, not a wrapped box: wrapping is phone-only.
  const at = css.indexOf('#dock.is-revealed .dock-pill');
  const wide = css.slice(at, css.indexOf('@media (max-width: 600px) {', at));
  assert.doesNotMatch(wide, /flex-wrap: wrap/);
  assert.match(css, /@media \(max-width: 600px\) \{\s*#dock\.is-revealed \.dock-pill \{[^}]*flex-wrap: wrap;/);
  assert.doesNotMatch(css.match(/\n\.dock-pill \{[^}]*\}/)[0], /\+ 0\.75rem/, 'no extra padding for the prompt side in the normal pill: it holds just the buttons');
  assert.match(css, /\.dock-pill \{[^}]*justify-content: center;/, 'the two buttons are centred');
});

const nav = (o) => readEnvironment(o);
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

test('platformDesktopWithUserAgentData', () => {
  const d = (platform, mobile = false) => isDesktopPlatform(nav({ userAgentData: { platform, mobile }, platform: 'x', userAgent: 'x', maxTouchPoints: 0 }));
  assert.equal(d('macOS'), true, 'macOS Chrome');
  assert.equal(d('Windows'), true);
  assert.equal(d('Linux'), true);
  assert.equal(d('Android', true), false);
  assert.equal(d('Linux', true), false, 'mobile flag wins');
  assert.equal(d('Chrome OS'), false);
  assert.equal(d('iOS'), false);
});

test('platformFallbackParsesPlatformAndUserAgent', () => {
  assert.equal(isDesktopPlatform({ platform: 'MacIntel', userAgent: MAC_UA, maxTouchPoints: 0 }), true, 'macOS Safari');
  assert.equal(isDesktopPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', maxTouchPoints: 0 }), true, 'Windows Chrome');
  assert.equal(isDesktopPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0' }), true, 'Windows Firefox');
  assert.equal(isDesktopPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' }), true, 'Linux Chrome');
  assert.equal(isDesktopPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:121.0) Firefox/121.0' }), true, 'Linux Firefox');
  assert.equal(isDesktopPlatform({ userAgent: MAC_UA }), true, 'platform missing, UA says Mac');
});

test('platformMobileAndOtherAreNotDesktop', () => {
  assert.equal(isDesktopPlatform(nav({ userAgentData: { platform: 'Android', mobile: true }, platform: 'Linux armv81', userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537.36', maxTouchPoints: 5 })), false, 'Android Chrome');
  assert.equal(isDesktopPlatform({ platform: 'Linux armv81', userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537.36', maxTouchPoints: 5 }), false, 'Android legacy strings');
  assert.equal(isDesktopPlatform({ platform: 'Linux armv81' }), true, 'bare Linux string without mobile markers stays desktop');
  assert.equal(isDesktopPlatform({ platform: 'Linux armv81', userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0', maxTouchPoints: 5 }), false, 'Android Firefox in desktop-site mode');
  assert.equal(isDesktopPlatform({ platform: 'Linux aarch64', userAgent: 'Mozilla/5.0 (X11; Linux aarch64; rv:120.0) Gecko/20100101 Firefox/120.0', maxTouchPoints: 10 }), false, 'ARM Linux with a touch screen');
  assert.equal(isDesktopPlatform({ platform: 'Linux aarch64', userAgent: 'Mozilla/5.0 (X11; Linux aarch64; rv:120.0) Gecko/20100101 Firefox/120.0', maxTouchPoints: 0 }), true, 'ARM Linux laptop without touch stays desktop');
  assert.equal(isDesktopPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0', maxTouchPoints: 5 }), true, 'x86 Linux touch laptop stays desktop');
  assert.equal(isDesktopPlatform({ platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', maxTouchPoints: 5 }), false, 'iPhone Safari');
  assert.equal(isDesktopPlatform({ platform: 'MacIntel', userAgent: MAC_UA, maxTouchPoints: 5 }), false, 'iPadOS desktop-site');
  assert.equal(isDesktopPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/120' }), false, 'ChromeOS');
});

test('platformEmptyEnvironmentIsDesktopButGarbageIsNot', () => {
  assert.equal(isDesktopPlatform({}), true, 'no information at all: show the button');
  assert.equal(isDesktopPlatform(), true);
  assert.equal(isDesktopPlatform(nav({})), true);
  assert.equal(isDesktopPlatform({ uaDataPlatform: 'qzx', platform: 'lorem ipsum', userAgent: 'zzz 123 !!!', maxTouchPoints: 0 }), false);
  assert.equal(isDesktopPlatform({ platform: 'asdf', userAgent: 'qwerty' }), false);
});

test('readEnvironmentNeverThrows', () => {
  assert.deepEqual(readEnvironment({}), { uaDataPlatform: undefined, uaDataMobile: undefined, platform: undefined, userAgent: undefined, maxTouchPoints: undefined });
  assert.doesNotThrow(() => readEnvironment(undefined));
  assert.doesNotThrow(() => readEnvironment(null));
  const hostile = { get userAgentData() { throw new Error('x'); }, get platform() { throw new Error('y'); } };
  assert.doesNotThrow(() => readEnvironment(hostile));
  assert.deepEqual(readEnvironment({ userAgentData: { platform: 'macOS', mobile: false }, platform: 'MacIntel', userAgent: 'u', maxTouchPoints: 0 }),
    { uaDataPlatform: 'macOS', uaDataMobile: false, platform: 'MacIntel', userAgent: 'u', maxTouchPoints: 0 });
});

test('mountDockMarksNonDesktopWithDataAppNone', async () => {
  const { mountDock } = await import('../../site/js/dock.js');
  const mk = (cls) => ({ className: cls, textContent: '', children: [], attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, append(...n) { this.children.push(...n); }, addEventListener() {} });
  const build = () => {
    const kids = [mk('dock-app')];
    const group = { append(n) { kids.push(n); }, querySelector: () => kids[0] };
    const pill = { querySelector: () => null };
    return { dataset: {}, classList: { add() {}, remove() {} }, contains: () => true,
      querySelector: (sel) => ({ '.dock-pill': pill, '.dock-prompt': mk('dock-prompt'), '.dock-ctas': group })[sel] ?? null };
  };
  const prevDoc = globalThis.document;
  globalThis.document = { createElement: () => mk(''), addEventListener() {}, removeEventListener() {} };
  try {
    const run = (navigator) => { const root = build(); mountDock(root, { toast: { show() {} }, env: {}, nav: navigator }); return root.dataset.app; };
    assert.equal(run({ platform: 'Linux armv81', userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile', maxTouchPoints: 5 }), 'none', 'phone');
    assert.equal(run({ platform: 'MacIntel', userAgent: MAC_UA, maxTouchPoints: 0 }), undefined, 'desktop Mac');
    assert.equal(run({}), undefined, 'empty environment keeps the button');
  } finally {
    globalThis.document = prevDoc;
  }
});

test('stylesheetAppLinkHidesByDataAttributeNotByWidth', () => {
  const css = readFileSync(new URL('../../site/css/site.css', import.meta.url), 'utf8');
  assert.match(css, /#dock\[data-app="none"\] \.dock-app \{\s*display: none;/);
  const compact = css.match(/@media \(max-width: 600px\) \{[\s\S]*?\n\}\n/)[0];
  assert.ok(!/\.dock-app/.test(compact), 'no width-based hiding of the app link');
  assert.ok(!/\.dock-app \{ display: none/.test(html), 'no-JS block does not hide the app link either');
});

test('staticHeadlineIsTheOnlyH1AndSitsInTheBottomStackAboveTheDock', () => {
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'exactly one h1');
  assert.ok(html.includes('<h1 class="headline"><span class="headline-title">Gaffer</span><span class="visually-hidden">, </span><span class="headline-sub">your AI crew in After Effects</span></h1>'), 'two spans in order with the hidden separator');
  const h1 = html.indexOf('<h1');
  const stack = html.indexOf('<div class="bottom-stack">');
  assert.ok(stack > html.indexOf('<div class="fader"'), 'the stack follows the fader');
  assert.ok(h1 > stack && h1 < html.indexOf('<div id="dock"'), 'the h1 is in the stack, before the dock');
  assert.ok(html.indexOf('<div id="dock"') < html.indexOf('<div id="toast"'), 'the stack closes before the toast');
  const stageAt = html.indexOf('<div id="stage"');
  assert.ok(!html.slice(stageAt, html.indexOf('</div>', stageAt)).includes('<h1'), 'not inside the stage');
  assert.ok(!/<h1[^>]*(hidden|visually-hidden)/.test(html), 'visible');
  assert.ok(!html.includes('.headline { color:'), 'no dead noscript colour rule');
});

const fakeHeadline = () => {
  const title = { textContent: 'old title' };
  const sub = { textContent: 'old sub' };
  return { title, sub, el: { querySelector: (sel) => ({ '.headline-title': title, '.headline-sub': sub })[sel] ?? null } };
};

test('applyHeadlineSetsBothSpansByTextContentOnlyAndToleratesMissingElements', () => {
  const { title, sub, el } = fakeHeadline();
  applyHeadline(el, { headlineTitle: '<b>T</b>', headlineSub: '<i>S</i>' });
  assert.equal(title.textContent, '<b>T</b>');
  assert.equal(sub.textContent, '<i>S</i>');
  assert.equal('innerHTML' in title, false);
  applyHeadline(el);
  assert.equal(title.textContent, 'Gaffer');
  assert.equal(sub.textContent, 'your AI crew in After Effects');
  assert.doesNotThrow(() => applyHeadline(null, defaults.copy));
  assert.doesNotThrow(() => applyHeadline({ querySelector: () => null }, defaults.copy));
  const only = fakeHeadline();
  only.el.querySelector = (sel) => (sel === '.headline-sub' ? only.sub : null);
  assert.doesNotThrow(() => applyHeadline(only.el, { headlineTitle: 'a', headlineSub: 'b' }));
  assert.equal(only.sub.textContent, 'b');
});

const cssText = readFileSync(new URL('../../site/css/site.css', import.meta.url), 'utf8');
const rule = (sel) => {
  const m = cssText.match(new RegExp(`(?:^|\\n)${sel.replace(/[.#]/g, '\\$&')} \\{([^}]*)\\}`));
  assert.ok(m, `rule ${sel}`);
  return m[1];
};
const zOf = (sel) => Number(rule(sel).match(/z-index:\s*(\d+)/)[1]);

test('headlineNeverTakesPointerEventsAndTheBottomStackIsOneLayerAnchoredToTheBottom', () => {
  const r = rule('.headline');
  assert.match(r, /pointer-events:\s*none/);
  assert.ok(!/position:\s*fixed/.test(r), 'the headline flows inside the stack');
  assert.ok(!/\bbottom:/.test(r) && !/\btop:/.test(r), 'no offsets of its own');
  assert.ok(!/headline-y/.test(cssText), 'headline.y is gone');
  assert.ok(!/will-change/.test(r), 'no will-change');
  const s = rule('.bottom-stack');
  assert.match(s, /position:\s*fixed/);
  assert.match(s, /bottom:\s*max\(1\.5rem, env\(safe-area-inset-bottom\)\)/);
  assert.match(s, /transform:\s*translate3d\(-50%, 0, 0\)/);
  assert.match(s, /flex-direction:\s*column/);
  assert.match(s, /gap:\s*var\(--headline-dock-gap, 24px\)/);
  assert.match(s, /pointer-events:\s*none/);
  assert.match(cssText.match(/@media \(max-width: 600px\) \{[^@]*?\.bottom-stack \{([^}]*)\}/)[1], /gap:\s*var\(--headline-dock-gap-compact, 24px\)/);
  assert.match(rule('#dock'), /pointer-events:\s*auto/);
  assert.ok(!/position:\s*fixed/.test(rule('#dock')), 'the dock flows inside the stack');
});

test('bottomStackStacksAboveTheStageAndFaderAndBelowTheToastAndCover', () => {
  assert.ok(zOf('.bottom-stack') > zOf('#stage'));
  assert.ok(zOf('.bottom-stack') > zOf('.fader'));
  assert.ok(zOf('.bottom-stack') < zOf('#toast'));
  assert.ok(zOf('.bottom-stack') < zOf('#cover'));
});

test('the toast sits at the top of the screen and keeps a short message on one line', () => {
  const r = rule('#toast');
  assert.match(r, /top:\s*calc\(max\(1rem, env\(safe-area-inset-top\)\) \+ 0\.5rem\)/);
  assert.ok(!/\bbottom:/.test(r), 'no bottom offset');
  assert.match(r, /width:\s*max-content/);
  assert.match(r, /max-width:\s*calc\(100vw - 2rem\)/);
  assert.match(r, /translateY\(-0\.5rem\)/, 'drops in from above');
  assert.ok(!/is-revealed\) ~ #toast/.test(cssText), 'no dock-relative toast offset any more');
});

test('headlineDefaultCopyEqualsTheStaticSpans', () => {
  const t = html.match(/<span class="headline-title">([^<]*)<\/span>/);
  const u = html.match(/<span class="headline-sub">([^<]*)<\/span>/);
  assert.equal(t[1], defaults.copy.headlineTitle);
  assert.equal(u[1], defaults.copy.headlineSub);
  const h1 = html.match(/<h1[^]*?<\/h1>/)[0];
  assert.ok(h1.indexOf('headline-title') < h1.indexOf('visually-hidden') && h1.indexOf('visually-hidden') < h1.indexOf('headline-sub'));
  assert.ok(!html.slice(html.indexOf('<div id="stage"'), html.indexOf('<canvas class="fader"')).includes('<h1'), 'not inside #stage');
});

test('headlineClampsToViewportHeightAndKeepsTwoShadowLayersPerLine', () => {
  const r = rule('.headline');
  assert.match(r, /--hl-font:\s*var\(--hl-size\)/);
  assert.match(r, /--sl-font:\s*var\(--sl-size\)/);
  assert.match(rule('.headline-title'), /font-size:\s*var\(--hl-font\)/);
  assert.match(rule('.headline-sub'), /font-size:\s*var\(--sl-font\)/);
  assert.match(rule('.headline-title'), /text-shadow:\s*0\s+0\s+0\.2em\s+rgb\(\s*0\s+0\s+0\s*\/\s*0\.6\s*\)/, 'plain fallback shadow');
  const supports = cssText.match(/@supports \(background: color-mix[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(supports, '@supports color-mix block');
  assert.match(supports[1], /\.headline-title \{\s*text-shadow:\s*0\s+0\s+calc\(\s*var\(--hl-font\)\s*\*\s*0\.04\s*\)[^;]*,\s*0\s+0\s+calc\(\s*var\(--hl-font\)\s*\*\s*0\.4\s*\)/);
  assert.match(supports[1], /\.headline-sub \{\s*text-shadow:\s*0\s+0\s+calc\(\s*var\(--sl-font\)[^;]*,\s*0\s+0\s+calc\(\s*var\(--sl-font\)/);
});

test('bothHeadlineLinesAreBlocksAndForceLigaturesWithAFallback', () => {
  const shared = cssText.match(/\.headline-title,\s*\.headline-sub \{([^}]*)\}/)[1];
  assert.match(shared, /display:\s*block/);
  assert.match(shared, /font-feature-settings:\s*"liga" var\(--headline-ligatures, 1\),\s*"clig" var\(--headline-ligatures, 1\)/);
  assert.ok(!/::first-line/.test(cssText), 'no ::first-line');
  assert.match(rule('.headline'), /pointer-events:\s*none/);
});

test('headlineGapIsASpacerInTheTitleEmThatVanishesWithAnEmptySubtitle', () => {
  assert.ok(!/margin-bottom/.test(rule('.headline-title')), 'no title margin');
  const spacer = rule('.headline-sub::before');
  assert.match(spacer, /font-size:\s*var\(--hl-font\)/);
  assert.match(spacer, /height:\s*var\(--headline-gap, 0\.12em\)/);
  assert.match(rule('.headline-sub:empty'), /display:\s*none/);
});

test('headlineShadowVariablesHaveNoJsFallbacks', () => {
  const supports = cssText.match(/@supports \(background: color-mix[^{]*\{([\s\S]*?)\n\}/)[1];
  assert.match(supports, /var\(--color-stage, #121212\)/);
  assert.match(supports, /var\(--headline-shadow-strength, 0\)/);
  assert.match(supports, /var\(--subline-shadow-strength, 0\.2\)/);
});

test('promptCarriesTheCodeLigaturesSwitchWithAFallback', () => {
  assert.match(rule('.dock-prompt'), /font-feature-settings:\s*"calt" var\(--type-code-ligatures, 1\),\s*"liga" var\(--type-code-ligatures, 1\)/);
});

test('staticFaderIsOneAriaHiddenCanvasAfterTheStageAndOutsideIt', () => {
  assert.equal((html.match(/class="fader"/g) || []).length, 1, 'exactly one fader');
  assert.ok(html.includes('<canvas class="fader" aria-hidden="true"></canvas>'), 'decorative, one canvas, nothing else (no separate noise layer)');
  assert.ok(!/fader-dither/.test(html), 'the old dither layer is gone');
  const stage = html.indexOf('<div id="stage"');
  const fader = html.indexOf('<canvas class="fader"');
  assert.ok(stage >= 0 && fader > stage, 'after the stage in the source');
  assert.ok(html.slice(stage, fader).includes('</div>'), 'the stage is closed before the fader');
  assert.equal(html.slice(stage, fader), '<div id="stage" aria-hidden="true"></div>\n  ', 'not inside the stage');
  assert.ok(fader < html.indexOf('<div id="dock"'), 'before the dock');
});

test('faderCssIsOneInertFullViewportCanvasBetweenTheStageAndTheHeadline', () => {
  const fader = rule('.fader');
  assert.match(fader, /position: fixed;/);
  assert.match(fader, /inset: 0;/);
  assert.match(fader, /pointer-events: none;/);
  assert.match(fader, /transform: translate3d\(0, 0, 0\);/);
  assert.match(fader, /opacity: var\(--fader-opacity, 1\);/);
  assert.ok(!/gradient|mask|filter|clip-path/.test(fader), 'no gradient, mask or filter: the pixels come from fader.js');
  assert.ok(!/fader-dither|dither\.png/.test(cssText), 'no separate noise layers');
  assert.ok(zOf('#stage') < zOf('.fader'), 'above the stage');
  assert.ok(zOf('.fader') < zOf('.bottom-stack'), 'below the headline and dock stack');
});

// ---- the animated copy -> check icon -------------------------------------------------------------

function iconHarness({ results, dockCfg = { iconRevertMs: 2000 } }) {
  const classes = new Set();
  const mk = (cls) => ({ className: cls, textContent: '', children: [], dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, append(...n) { this.children.push(...n); }, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; }, classList: { add(c) { classes.add(c); }, remove(c) { classes.delete(c); } } });
  const group = { kids: [], append(n) { this.kids.push(n); }, querySelector: () => null };
  const root = { dataset: {}, classList: { add() {}, remove() {} }, contains: () => true,
    querySelector: (sel) => ({ '.dock-pill': { querySelector: () => null }, '.dock-prompt': mk('dock-prompt'), '.dock-ctas': group })[sel] ?? null };
  const pending = new Map();
  let nextId = 1;
  const cleared = [];
  const timers = {
    setTimeout: (f, ms) => { const id = nextId++; pending.set(id, { f, ms }); return id; },
    clearTimeout: (id) => { cleared.push(id); pending.delete(id); },
  };
  const toasts = [];
  const queue = [...results];
  const env = { clipboard: { writeText: async () => { if (queue.shift() === 'failed') throw new Error('denied'); } }, execCopy: () => false };
  return { classes, group, root, pending, cleared, timers, toasts, env, dockCfg, mk };
}

const withDom = async (h, fn) => {
  const { mountDock } = await import('../../site/js/dock.js');
  const prevDoc = globalThis.document;
  const prevSel = globalThis.getSelection;
  globalThis.document = { createElement: () => h.mk(''), addEventListener() {}, removeEventListener() {} };
  globalThis.getSelection = () => ({ removeAllRanges() {}, addRange() {}, rangeCount: 0 });
  globalThis.document.createRange = () => ({ selectNodeContents() {} });
  try {
    const ui = mountDock(h.root, { toast: { show: (m, k) => h.toasts.push([m, k]) }, env: h.env, getDock: () => h.dockCfg, timers: h.timers });
    return await fn(ui, h.group.kids[0]);
  } finally {
    globalThis.document = prevDoc;
    globalThis.getSelection = prevSel;
  }
};

test('successfulCopyShowsTheCheckThenRevertsAfterTheHold', async () => {
  const h = iconHarness({ results: ['ok'], dockCfg: { iconRevertMs: 700 } });
  await withDom(h, async (ui, btn) => {
    assert.equal(h.classes.has('is-copied'), false, 'copy icon at rest');
    await btn.listeners.click();
    assert.equal(h.classes.has('is-copied'), true);
    assert.deepEqual([...h.pending.values()].map((p) => p.ms), [700], 'hold comes from dock.iconRevertMs');
    assert.equal(h.toasts[0][1], undefined, 'the toast still shows');
    assert.equal(btn.attrs['aria-label'], 'Copy install prompt', 'the accessible name never changes');
    const [fid, fired] = [...h.pending.entries()][0];
    h.pending.delete(fid);
    fired.f();
    assert.equal(h.classes.has('is-copied'), false, 'reverted');
    assert.equal(h.pending.size, 0);
    ui.destroy();
  });
});

test('aSecondCopyDuringTheHoldRestartsTheTimerAndKeepsTheCheck', async () => {
  const h = iconHarness({ results: ['ok', 'ok'] });
  await withDom(h, async (ui, btn) => {
    await btn.listeners.click();
    const firstId = [...h.pending.keys()][0];
    await btn.listeners.click();
    assert.equal(h.classes.has('is-copied'), true, 'check stays on');
    assert.deepEqual(h.cleared, [firstId], 'first timer cancelled');
    assert.equal(h.pending.size, 1, 'exactly one hold timer');
    assert.equal(h.pending.has(firstId), false);
    ui.destroy();
  });
});

test('aFailedCopyNeverChangesTheIcon', async () => {
  const h = iconHarness({ results: ['failed'] });
  await withDom(h, async (ui, btn) => {
    await btn.listeners.click();
    assert.equal(h.classes.has('is-copied'), false);
    assert.equal(h.pending.size, 0);
    assert.equal(h.toasts[0][1], 'error');
    ui.destroy();
  });
});

test('failedCopyDuringTheHoldLeavesTheCheckAndItsTimer', async () => {
  const h = iconHarness({ results: ['ok', 'failed'] });
  await withDom(h, async (ui, btn) => {
    await btn.listeners.click();
    await btn.listeners.click();
    assert.equal(h.classes.has('is-copied'), true);
    assert.equal(h.pending.size, 1);
    ui.destroy();
  });
});

test('destroyClearsTheHoldTimerAndTheCheck', async () => {
  const h = iconHarness({ results: ['ok'] });
  await withDom(h, async (ui, btn) => {
    await btn.listeners.click();
    ui.destroy();
    assert.equal(h.pending.size, 0);
    assert.equal(h.classes.has('is-copied'), false);
    assert.doesNotThrow(() => ui.destroy());
  });
});

test('theLucideCheckIconIsPinnedAndStackedWithTheCopyIcon', async () => {
  assert.equal(CHECK_PATH, 'M20 6 9 17l-5-5', 'lucide-static v1.59.0 icons/check.svg');
  const h = iconHarness({ results: [] });
  await withDom(h, async (ui, btn) => {
    const icon = btn.children[0];
    const copyAt = icon.innerHTML.indexOf('<rect');
    const checkAt = icon.innerHTML.indexOf('dock-icon-check');
    assert.ok(copyAt > 0 && checkAt > copyAt, 'copy svg first, check second');
    assert.ok(icon.innerHTML.includes('<path d="M20 6 9 17l-5-5" pathLength="1"/>'));
    assert.match(icon.innerHTML, /<svg class="dock-icon-check"[^>]*viewBox="0 0 24 24"[^>]*stroke="currentColor"[^>]*stroke-width="2"[^>]*stroke-linecap="round"[^>]*stroke-linejoin="round"[^>]*aria-hidden="true"[^>]*focusable="false"/);
    ui.destroy();
  });
});

test('stylesheetStacksTheIconsAndAnimatesTheCheckWithTheConfigVariable', () => {
  const css = readFileSync(new URL('../../site/css/site.css', import.meta.url), 'utf8');
  assert.match(css, /\.dock-icon \{[^}]*position: relative;[^}]*width: 1\.25rem;[^}]*height: 1\.25rem;/, 'fixed icon box');
  assert.match(css, /\.dock-icon svg \{[^}]*position: absolute;[^}]*transition: opacity var\(--dock-icon-anim-ms, 280ms\) ease, transform var\(--dock-icon-anim-ms, 280ms\) ease;/);
  assert.match(css, /\.dock-icon-check path \{[^}]*stroke-dasharray: 1;[^}]*stroke-dashoffset: 1;[^}]*transition: stroke-dashoffset var\(--dock-icon-anim-ms, 280ms\)/);
  assert.match(css, /\.dock-button\.is-copied \.dock-icon \.dock-icon-check path \{[^}]*stroke-dashoffset: 0;/);
  assert.match(css, /\.dock-button\.is-copied \.dock-icon svg:first-child \{[^}]*opacity: 0;/);
  assert.match(css, /\.dock-button\.is-copied \.dock-icon \.dock-icon-check \{[^}]*opacity: 1;/);
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)[0];
  assert.match(reduced, /\.dock-icon svg,\s*\.dock-icon \.dock-icon-check path \{\s*transition: none;/, 'instant swap under reduced motion');
  const copiedRules = [...css.matchAll(/(\.dock-button\.is-copied[^{}]*)\{([^}]*)\}/g)];
  assert.ok(copiedRules.length >= 3);
  for (const [, , body] of copiedRules) assert.ok(!/(^|\s)(width|height|padding|margin)\s*:/.test(body), 'the swap never changes the size');
});

test('splitNote splits on the bullet, trims, and drops empty parts', () => {
  assert.deepEqual(splitNote('A \u2022 B \u2022 C'), ['A', 'B', 'C']);
  assert.deepEqual(splitNote('Requires Claude Code'), ['Requires Claude Code']);
  assert.deepEqual(splitNote('\u2022 A \u2022\u2022  \u2022'), ['A']);
  assert.deepEqual(splitNote(''), []);
  assert.deepEqual(splitNote(undefined), []);
});

function fakeNoteDom() {
  const mk = (tag) => ({ tag, className: '', textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  const node = { dataset: {}, children: [], replaceChildren(...k) { this.children = k; }, ownerDocument: { createElement: mk } };
  return { node, root: { querySelector: (sel) => (sel === '#dock .dock-note' ? node : null) } };
}

test('applyNote builds a span per part with a bullet between, by textContent only, once per change', () => {
  const { node, root } = fakeNoteDom();
  applyNote({ note: '<b>Panel</b> \u2022 Needs Claude Code \u2022 AE 2022+' }, root);
  assert.deepEqual(node.children.map((c) => c.className), ['dock-note-part', 'dock-note-sep', 'dock-note-part', 'dock-note-sep', 'dock-note-part']);
  assert.deepEqual(node.children.filter((c) => c.className === 'dock-note-part').map((c) => c.textContent), ['<b>Panel</b>', 'Needs Claude Code', 'AE 2022+']);
  assert.equal(node.children[1].textContent, '\u2022');
  assert.equal(node.children[1].attrs['aria-hidden'], 'true');
  const first = node.children;
  applyNote({ note: '<b>Panel</b> \u2022 Needs Claude Code \u2022 AE 2022+' }, root);
  assert.equal(node.children, first, 'the same note is not rebuilt');
  applyNote({ note: 'Only one' }, root);
  assert.deepEqual(node.children.map((c) => c.className), ['dock-note-part'], 'a note without a bullet has no separator');
  assert.doesNotThrow(() => applyNote({ note: 'x' }, { querySelector: () => null }));
  assert.equal(defaults.copy.note, 'A panel extension for AE 2022+\u2022Rides your Claude Code subscription');
});

test('the note has padding from dock.notePadding, a row layout, and stacks without bullets on phones', () => {
  const css = readFileSync(new URL('../../site/css/site.css', import.meta.url), 'utf8');
  const r = rule('.dock-note');
  assert.match(r, /padding:\s*var\(--dock-note-padding, 8px\)/);
  assert.match(r, /display:\s*flex/);
  assert.equal(defaults.dock.notePadding, 8);
  assert.equal(defaults.dock.noteGap, 6);
  assert.match(r, /gap:\s*0 var\(--dock-note-gap, 6px\)/);
  assert.match(css, /@media \(max-width: 600px\) \{\s*\.dock-note \{ flex-direction: column;[^}]*\}\s*\.dock-note-sep \{ display: none; \}/);
});

test('the dock note is positioned above the pill so the glass shadow never dims it', () => {
  const r = rule('.dock-note');
  assert.match(r, /position:\s*relative/);
  assert.match(r, /z-index:\s*1/);
});
