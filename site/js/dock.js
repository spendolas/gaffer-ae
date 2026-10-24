// The install dock: the visible install prompt, a group of two buttons (the
// primary "Install with Claude" link, then the secondary icon-only Copy button) and the
// "Requires Claude Code" note. The markup is static in index.html (dock.test.mjs
// pins it to INSTALL_PROMPT); mountDock adds the Copy button.
// Copy logic and the toast are pure and tested. The button labels and toast
// messages come from config.copy, read at use time.

import { defaults } from './config.js';

export const INSTALL_PROMPT = 'Install Gaffer by following https://gafferae.com/install.md';

// Deep link that opens the Claude desktop app (Code tab) with the install prompt
// prefilled. Documented at code.claude.com/docs/en/deep-links; the prompt is never
// sent automatically and q is capped at 5,000 characters. No cwd or repo parameters.
export const DEEP_LINK_MAX_PROMPT = 5000;
export const desktopLink = (prompt) => `claude://code/new?q=${encodeURIComponent(prompt)}`;

// Whether the visitor is on a desktop platform (macOS, Windows, Linux), where the
// Claude desktop app and its claude:// handler are documented to exist. This is a
// platform guess, not a check that the app is installed. Pure; inputs come from
// readEnvironment. Prefers navigator.userAgentData, else parses platform/userAgent.
// iPadOS in desktop-site mode reports 'MacIntel' with a touch screen, Android reports
// 'Linux armv81' style strings, ChromeOS is 'CrOS': none of those are desktop.
// When the environment gives no information at all (every input missing, e.g. a
// stripped context behind a privacy extension) the answer is true, so a desktop
// visitor is not denied the button; a phone with nothing to read is the rare loss.
export function isDesktopPlatform({ uaDataPlatform, uaDataMobile, platform, userAgent, maxTouchPoints } = {}) {
  const str = (v) => (typeof v === 'string' ? v : '');
  const has = (v) => v !== undefined && v !== null;
  if (![uaDataPlatform, uaDataMobile, platform, userAgent, maxTouchPoints].some(has)) return true;

  const uaPlatform = str(uaDataPlatform).trim();
  if (uaPlatform) {
    if (uaDataMobile === true) return false;
    return /^(macos|windows|linux)$/i.test(uaPlatform);
  }

  const ua = str(userAgent);
  const pl = str(platform);
  if (/android|iphone|ipad|ipod|crOS|mobile/i.test(`${ua} ${pl}`)) return false;
  if (/^MacIntel$/.test(pl) && typeof maxTouchPoints === 'number' && maxTouchPoints > 1) return false;
  // Android Firefox in "desktop site" mode: desktop-looking UA, but an ARM Linux platform on a
  // touch screen. (An ARM Linux laptop without a touch screen stays desktop.)
  if (/arm|aarch64/i.test(pl) && typeof maxTouchPoints === 'number' && maxTouchPoints > 1) return false;
  if (/^(Mac|Win|Linux)/.test(pl)) return true;
  if (pl) return false;
  return /Macintosh|Windows NT|X11; Linux|Linux x86/.test(ua);
}

// Collects the platform inputs from a navigator-like object. Never throws.
export function readEnvironment(nav = typeof navigator === 'undefined' ? undefined : navigator) {
  const read = (fn) => { try { return fn(); } catch { return undefined; } };
  return {
    uaDataPlatform: read(() => nav.userAgentData.platform),
    uaDataMobile: read(() => nav.userAgentData.mobile),
    platform: read(() => nav.platform),
    userAgent: read(() => nav.userAgent),
    maxTouchPoints: read(() => nav.maxTouchPoints),
  };
}

// Resolves "clipboard" | "fallback" | "failed". Never rejects.
export async function copyText(text, env = {}) {
  if (env.clipboard && typeof env.clipboard.writeText === 'function') {
    try {
      await env.clipboard.writeText(text);
      return 'clipboard';
    } catch { /* blocked or denied: try the fallback */ }
  }
  try {
    if (typeof env.execCopy === 'function' && env.execCopy()) return 'fallback';
  } catch { /* fall through */ }
  return 'failed';
}

// A short-lived message in a polite live region. A new show() restarts the timer
// and reads the current duration (ms).
export function createToast(el, { getDuration = () => defaults.toast.duration, timers } = {}) {
  const t = timers ?? { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) };
  let timer = null;
  el.setAttribute('aria-live', 'polite');
  return {
    show(message, kind = 'ok') {
      if (timer !== null) t.clearTimeout(timer);
      el.textContent = message;
      el.dataset.kind = kind;
      el.classList.add('is-visible');
      timer = t.setTimeout(() => {
        timer = null;
        el.classList.remove('is-visible');
      }, getDuration());
    },
  };
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function selectNode(node, doc = document, sel = getSelection()) {
  const range = doc.createRange();
  range.selectNodeContents(node);
  sel.removeAllRanges();
  sel.addRange(range);
}

// execCommand fallback. Selects the visible prompt; in the compact variant the
// prompt is not rendered, so a throwaway textarea carries the full text.
// On success the selection and focus are put back as they were before the copy;
// on failure the selection is left alone (the dock keeps the prompt selected so
// the visitor can copy by hand). `dom` is injectable for tests.
export function makeExecCopy(root, dom = {}) {
  const doc = dom.document ?? document;
  const getSel = dom.getSelection ?? (() => getSelection());
  return () => {
    const sel = getSel();
    const savedRanges = [];
    for (let i = 0; i < sel.rangeCount; i++) savedRanges.push(sel.getRangeAt(i));
    const savedFocus = doc.activeElement;
    let ta = null;
    let ok = false;
    try {
      const prompt = root.querySelector('.dock-prompt');
      if (prompt && prompt.getClientRects().length > 0) {
        selectNode(prompt, doc, sel);
      } else {
        ta = doc.createElement('textarea');
        ta.value = INSTALL_PROMPT;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        doc.body.append(ta);
        ta.select();
      }
      ok = Boolean(doc.execCommand('copy'));
      return ok;
    } finally {
      if (ta) ta.remove();
      if (ok) {
        sel.removeAllRanges();
        for (const r of savedRanges) sel.addRange(r);
        if (savedFocus && savedFocus !== doc.body && doc.activeElement !== savedFocus
          && typeof savedFocus.focus === 'function') savedFocus.focus({ preventScroll: true });
      }
    }
  };
}

// The Copy icon is Lucide's "copy" (ISC licence, see site/LICENSE-lucide.txt).
// Static markup set through innerHTML on a span; sized and coloured from CSS.
const COPY_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>'
  + '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

// The success icon is Lucide's "check" (ISC licence, same file). pathLength="1" lets CSS draw it in
// with a stroke-dashoffset from 1 to 0 whatever the path's real length.
export const CHECK_PATH = 'M20 6 9 17l-5-5';
const CHECK_ICON = '<svg class="dock-icon-check" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + `<path d="${CHECK_PATH}" pathLength="1"/></svg>`;

// Enhances the static dock in index.html (prompt, note and the app link render
// without JS): adds the Copy button to the .dock-ctas group, which only works
// with JS, and keeps the labels in step with config.
// `nav` overrides navigator for tests. `getDock` supplies dock.iconRevertMs (how long the check stays after a
// successful copy) at use time; `timers` is injectable like createToast's.
// Returns { refresh(), destroy() }: refresh re-reads the labels after a config change, destroy clears the check timer.
export function mountDock(root, { toast, env, getCopy = () => defaults.copy, getDock = () => defaults.dock, nav, timers }) {
  const t = timers ?? { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) };
  const pill = root.querySelector('.dock-pill');
  const prompt = root.querySelector('.dock-prompt');
  const group = root.querySelector('.dock-ctas');
  if (!pill || !prompt || !group || pill.querySelector('.dock-button')) return { refresh() {}, destroy() {} };
  prompt.textContent = INSTALL_PROMPT;
  // No app link off desktop: CSS hides it and turns Copy into the single filled button.
  if (!isDesktopPlatform(readEnvironment(nav))) root.dataset.app = 'none';
  const button = h('button', 'dock-cta dock-button');
  button.type = 'button';
  const icon = h('span', 'dock-icon');
  icon.innerHTML = COPY_ICON + CHECK_ICON; // copy first; both stacked by CSS
  const short = h('span', 'dock-label-short'); // shown only in the compact variant
  const appAnchor = group.querySelector('.dock-app');
  const refresh = () => {
    if (appAnchor) appAnchor.textContent = getCopy().linkDesktop;
    // Icon-only on desktop: the accessible name and tooltip are the wording config.
    // With no app link the visible label is shown, and the accessible name follows it
    // (label in name); otherwise the button is icon-only and copy.button names it.
    const name = root.dataset.app === 'none' ? getCopy().buttonCompact : getCopy().button;
    button.setAttribute('aria-label', name);
    button.title = name;
    short.textContent = getCopy().buttonCompact;
  };
  refresh();
  button.append(icon, short);
  group.append(button); // the static app link first, then Copy

  // Failed copy in the compact variant: show the prompt, selected, until the
  // next successful copy or a press anywhere outside the dock.
  const onOutside = (e) => { if (!root.contains(e.target)) hide(); };
  const hide = () => {
    root.classList.remove('is-revealed');
    document.removeEventListener('pointerdown', onOutside, true);
  };

  // Successful copy: the button shows the check (class is-copied) for iconRevertMs, then reverts.
  // A new success during the hold restarts the timer; the class stays on, so nothing flickers.
  let iconTimer = null;
  const clearIconTimer = () => {
    if (iconTimer !== null) { t.clearTimeout(iconTimer); iconTimer = null; }
  };
  const showCheck = () => {
    clearIconTimer();
    button.classList.add('is-copied');
    iconTimer = t.setTimeout(() => {
      iconTimer = null;
      button.classList.remove('is-copied');
    }, getDock().iconRevertMs);
  };

  button.addEventListener('click', async () => {
    const result = await copyText(INSTALL_PROMPT, env);
    if (result === 'failed') {
      toast.show(getCopy().toastError, 'error');
      root.classList.add('is-revealed');
      selectNode(prompt);
      document.addEventListener('pointerdown', onOutside, true);
    } else {
      hide();
      toast.show(getCopy().toastOk);
      showCheck();
    }
  });
  return {
    refresh,
    destroy() {
      clearIconTimer();
      button.classList.remove('is-copied');
      hide();
    },
  };
}

// The h1's two lines are static in index.html; this keeps them following config.copy
// (headlineTitle, headlineSub; textContent only; a missing element is ignored).
// The note splits on the bullet: "A \u2022 B \u2022 C" gives ['A', 'B', 'C'] (trimmed, empty parts dropped).
export function splitNote(text) {
  return String(text ?? '').split('\u2022').map((p) => p.trim()).filter(Boolean);
}

// The small note under the dock (static in index.html) follows copy.note: one span per part with a
// bullet span between them. The bullets show beside each other on one line and are hidden when the
// parts stack on phones (css). Built with textContent only.
export function applyNote(copy = defaults.copy, root = document) {
  const node = root?.querySelector?.('#dock .dock-note');
  if (!node) return;
  const parts = splitNote(copy.note);
  const key = parts.join('\u0000');
  if (node.dataset && node.dataset.noteKey === key) return;
  const doc = node.ownerDocument ?? document;
  const kids = [];
  parts.forEach((text, i) => {
    if (i > 0) {
      const sep = doc.createElement('span');
      sep.className = 'dock-note-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '\u2022';
      kids.push(sep);
    }
    const part = doc.createElement('span');
    part.className = 'dock-note-part';
    part.textContent = text;
    kids.push(part);
  });
  node.replaceChildren(...kids);
  if (node.dataset) node.dataset.noteKey = key;
}

export function applyHeadline(el, copy = defaults.copy) {
  const set = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };
  set(el?.querySelector('.headline-title'), copy.headlineTitle);
  set(el?.querySelector('.headline-sub'), copy.headlineSub);
}
