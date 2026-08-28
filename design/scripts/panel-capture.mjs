#!/usr/bin/env node
// Figma parity audit — Phase B live capture.
// Connects to the Gaffer CEP panel over the Chrome DevTools Protocol
// (port from panel/.debug, default 13870; requires AE open with the panel
// visible), forces each UI state via Runtime.evaluate, captures a screenshot
// plus a full per-element geometry/computed-style dump, then reloads the
// panel to restore reality.
//
// Usage: node design/scripts/panel-capture.mjs [port]

import WebSocket from '../../panel/daemon/node_modules/ws/index.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'refs', 'panel');
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.argv[2] || 13870);

const COMPUTED_PROPS = [
  'color', 'background-color', 'border-radius',
  // per-corner radii — the shorthand collapses [16,16,0,0] ambiguously; the
  // node-level diff compares corners individually against the Figma spec.
  'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-right-radius', 'border-bottom-left-radius',
  // all four border sides (Figma strokes can be one-sided, e.g. banner dock)
  'border-top-width', 'border-top-color', 'border-top-style',
  'border-right-width', 'border-right-color',
  'border-bottom-width', 'border-bottom-color',
  'border-left-width', 'border-left-color',
  'font-family', 'font-size', 'font-weight', 'line-height',
  'letter-spacing', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap', 'display',
  'align-items', 'justify-content', 'flex-direction', 'opacity', 'box-shadow',
  'text-align', 'overflow-x', 'overflow-y', 'white-space',
  'min-width', 'max-width', 'min-height', 'max-height',
  // overlay fills (layered backgrounds), transforms (toggle-knob translateX),
  // visibility, stacking, hit-testing, cursor, and text transform/decoration.
  'background-image', 'transform', 'visibility', 'z-index', 'pointer-events',
  'cursor', 'text-transform', 'text-decoration-line', 'align-self', 'flex-grow',
  'aspect-ratio', 'width', 'height', 'position',
  // SVG glyph paint (icon stroke colour/weight + non-scaling behaviour)
  'stroke', 'stroke-width', 'fill',
];

// Each state: name + a DOM-level setup snippet (no reliance on main.js
// internals — the panel script is an IIFE). States are cumulative-safe:
// every snippet first calls reset().
const HARNESS = `
window.__audit = (function () {
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function chat() { return document.getElementById('chatMessages'); }
  function reset() {
    // Neutralise the user's A-/A+ chat text-zoom (--chat-text, persisted at any
    // factor) — parity numbers are defined at 1.0×, not whatever the live panel
    // was left at. The var lives on <html> (root), so set it there: the reply
    // quote scales with it too but sits OUTSIDE #chatMessages, so a chatMessages-
    // only override wouldn't reach it.
    document.documentElement.style.setProperty('--chat-text', '1');
    chat().innerHTML = '';
    document.getElementById('updateBanner').classList.remove('visible');
    document.getElementById('dropOverlay').classList.remove('visible');
    var lb = document.getElementById('imgLightbox'); lb.hidden = true;
    document.getElementById('pastePreviewRow').innerHTML = '';
    if (window.__gaffer && window.__gaffer.clearReplyQuotes) window.__gaffer.clearReplyQuotes();
    var rq = document.getElementById('replyQuotes');
    if (rq) { rq.classList.remove('visible'); rq.style.maxHeight = '0px'; rq.innerHTML = ''; }
    document.querySelector('.activity-log').classList.remove('expanded');
    document.getElementById('stopBtn').style.display = 'none';
    document.getElementById('sendBtn').style.display = '';
    // Clear body-appended fixtures so states don't bleed into each other.
    var sc = document.querySelector('.selection-cta'); if (sc && sc.parentNode) sc.parentNode.removeChild(sc);
    var ts = document.getElementById('toastStack'); if (ts) ts.innerHTML = '';
    var sm = document.getElementById('settingsModal'); if (sm) sm.hidden = true;
    var pops = document.querySelectorAll('.select-popup'); for (var pi = 0; pi < pops.length; pi++) pops[pi].hidden = true;
    // The 'disabled' state force-sets .disabled on every button matching this
    // selector (see below) to capture the Figma State=Disabled variant. Undo
    // it here so it doesn't bleed into every state captured afterward (e.g.
    // 'settings' would otherwise render its close button / Check now / etc.
    // stuck at opacity .4, contaminating the parity capture with a state the
    // real app never produces for these controls). Excludes .send-btn/.stop-btn
    // — those two carry real reactive disabled logic (hasContent/chatBusy,
    // main.js) that other states rely on being left alone.
    var dsel = '.icon-btn, .text-btn, #updateBtn, #dismissUpdateBtn, #checkNowBtn';
    var dels = document.querySelectorAll(dsel);
    for (var di = 0; di < dels.length; di++) dels[di].disabled = false;
  }
  function bubble(role, text) {
    var m = el('div', 'chat-msg ' + role);
    // Anchor to the Figma Bubble variant so the diff verifies bubble params.
    var fig = { user: '176:928', assistant: '176:931', error: '176:934' }[role];
    if (fig) m.setAttribute('data-fig', fig);
    m.appendChild(el('div', 'msg-text', text));
    chat().appendChild(m);
    return m;
  }
  var states = {
    'empty': function () { reset(); },
    'conversation': function () {
      reset();
      bubble('user', 'Add a wiggle to the selected layer with 4 rotations per second');
      var a = bubble('assistant', 'I added a wiggle expression to the Rotation property of "Logo". The layer now rotates with 4 oscillations per second at 30 degrees amplitude.');
      var row = el('div', 'tool-pills-row');
      row.appendChild(el('span', 'tool-pill done', 'runJSX: wiggle rotation'));
      a.insertBefore(row, a.firstChild);
      bubble('error', 'Could not reach After Effects — is the panel open?');
    },
    'busy-pills': function () {
      reset();
      bubble('user', 'Analyse the comp and list all expressions');
      var a = bubble('assistant', '');
      var row = el('div', 'tool-pills-row');
      row.appendChild(el('span', 'tool-pill running', 'listExpressions'));
      row.appendChild(el('span', 'tool-pill done', 'getProjectSummary'));
      row.appendChild(el('span', 'tool-pill error', 'captureFrame: comp too large'));
      a.appendChild(row);
      var t = el('span', 'typing-indicator');
      t.innerHTML = '<i></i><i></i><i></i>';
      a.appendChild(t);
      document.getElementById('stopBtn').style.display = '';
      document.getElementById('sendBtn').style.display = 'none';
    },
    'markdown': function () {
      reset();
      var a = bubble('assistant', '');
      a.querySelector('.msg-text').innerHTML = '<h1>H1</h1><h2>H2</h2><h3>H3</h3><p>Paragraph with <strong>bold</strong>, <em>italic</em>, <code>inline code</code> and a <a href="#">link</a>.</p><ul><li>bullet one<ul><li>nested</li></ul></li><li>bullet two</li></ul><ol><li>numbered</li></ol><blockquote>Blockquote text</blockquote><pre><code>var x = comp.layer(1);\\nx.property("Rotation");</code></pre><table><thead><tr><th>Prop</th><th>Value</th></tr></thead><tbody><tr><td>Rotation</td><td>30deg</td></tr></tbody></table><hr>';
    },
    'notice-error': function () {
      reset();
      chat().appendChild(el('div', 'chat-notice', 'Conversation too long for the model. Session reset — your next message starts a fresh context.'));
    },
    'update-banner': function () {
      reset();
      document.getElementById('updateText').textContent = '\\u2b06 Update available: 1661198 (current: a406084)';
      document.getElementById('updateBanner').classList.add('visible');
    },
    'activity-open': function () {
      reset();
      document.querySelector('.activity-log').classList.add('expanded');
    },
    'paste-preview': function () {
      reset();
      var row = document.getElementById('pastePreviewRow');
      var chip = el('span', 'paste-chip');
      chip.setAttribute('data-fig', '475:10182'); // ImageChip (current master)
      var img = document.createElement('canvas'); img.width = 48; img.height = 48;
      chip.appendChild(img);
      var cx = el('span', 'paste-chip-x', '\\u2715');
      cx.setAttribute('data-fig', 'I475:10182;219:3708'); // CloseBtn within ImageChip
      chip.appendChild(cx);
      row.appendChild(chip);
    },
    'reply-quote': function () {
      reset();
      // drive the real builder (window.__gaffer) so we capture shipping DOM
      if (window.__gaffer && window.__gaffer.addReplyQuote) {
        window.__gaffer.addReplyQuote('The visuals must be accurate to Figma.');
      }
    },
    'drop-overlay': function () {
      reset();
      document.getElementById('dropOverlay').classList.add('visible');
    },
    'lightbox': function () {
      reset();
      var lb = document.getElementById('imgLightbox');
      lb.hidden = false;
    },
    'disconnected': function () {
      reset();
      document.getElementById('led').className = 'led';
      var wrap = document.getElementById('statusWrap');
      if (wrap) wrap.title = 'Disconnected';
    },
    // DOM-forced states (reachable without synthetic input).
    'disabled': function () {
      reset();
      // Disabled = the Figma State=Disabled variant (fill @ .4, no hover). Force
      // it on every control class so the diff can assert the dim + inertness.
      var sel = '.send-btn, .stop-btn, .icon-btn, .text-btn, #updateBtn, #dismissUpdateBtn, #checkNowBtn';
      var els = document.querySelectorAll(sel);
      for (var i = 0; i < els.length; i++) els[i].disabled = true;
      // stop-btn shares the row with send-btn; show both so both capture disabled.
      document.getElementById('stopBtn').style.display = '';
    },
    'offline': function () {
      reset();
      document.getElementById('sendBtn').classList.add('offline');
    },
    'selection-cta': function () {
      reset();
      var c = el('div', 'selection-cta visible');
      c.setAttribute('data-fig', '507:40583'); // SelectedTextActions
      c.style.top = '120px'; c.style.left = '120px';
      var figs = ['507:40563', '507:40567'];
      for (var i = 0; i < 2; i++) {
        var b = el('button', 'icon-btn hollow');
        b.setAttribute('data-fig', figs[i]);
        b.appendChild(el('span', 'gicon'));
        c.appendChild(b);
      }
      document.body.appendChild(c);
    },
    'toast': function () {
      reset();
      if (!(window.__gaffer && window.__gaffer.showToast)) return;
      ['info', 'success', 'warning', 'error', 'neutral'].forEach(function (ty) {
        window.__gaffer.showToast(ty, 'Toast label', { duration: 0 });
      });
    },
    'settings': function () {
      reset();
      if (window.__gaffer && window.__gaffer.openSettings) window.__gaffer.openSettings();
      else document.getElementById('settingsModal').hidden = false;
      // Match Figma's depicted toggle states so the diff compares like-for-like
      // (design = off #000@.5 / on primary-ghost; state is runtime).
      document.getElementById('setAutoCheck').checked = false;
      document.getElementById('setScrooge').checked = false;
      document.getElementById('setSoundOn').checked = true;
    },
    // Account / API — 3 Figma states (516:42191 / 480:20902 / 516:43487) driven
    // via the window.__gaffer.setApiState() review hook (scaffold — no real key).
    'api-nokey': function () {
      reset();
      if (window.__gaffer && window.__gaffer.openSettings) window.__gaffer.openSettings();
      else document.getElementById('settingsModal').hidden = false;
      if (window.__gaffer && window.__gaffer.setApiState) window.__gaffer.setApiState('nokey');
    },
    'api-haskey-disc': function () {
      reset();
      if (window.__gaffer && window.__gaffer.openSettings) window.__gaffer.openSettings();
      else document.getElementById('settingsModal').hidden = false;
      if (window.__gaffer && window.__gaffer.setApiState) window.__gaffer.setApiState('disconnected');
    },
    'api-haskey-conn': function () {
      reset();
      if (window.__gaffer && window.__gaffer.openSettings) window.__gaffer.openSettings();
      else document.getElementById('settingsModal').hidden = false;
      if (window.__gaffer && window.__gaffer.setApiState) window.__gaffer.setApiState('connected');
    },
    'dropdown': function () {
      reset();
      document.querySelector('.activity-log').classList.add('expanded');
      var b = document.getElementById('modelSelectBtn');
      if (b) b.click(); // open the model Dropdown popup
    },
  };
  // Interactive elements whose :hover/:focus/:active variants exist in Figma but
  // are unreachable by DOM injection. Returns viewport-centre coords so the Node
  // side can drive a REAL pointer over each via CDP Input, then read the style.
  function interactiveTargets() {
    reset();
    document.getElementById('updateBanner').classList.add('visible'); // expose banner buttons
    var sel = '.send-btn, .stop-btn, .icon-btn, .text-btn, #updateBtn, #dismissUpdateBtn, #checkNowBtn, .toggle-label, .reply-quote-x, .select-btn';
    var els = document.querySelectorAll(sel);
    var out = [];
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      out.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
        id: els[i].id || null, cls: clsOf(els[i]), fig: els[i].getAttribute('data-fig') || null });
    }
    return out;
  }
  // Read the element currently under (x,y) — after CDP has moved the real pointer
  // there, its :hover (and ::before/::after) are live. Walks up to the nearest
  // control so we grab the button, not a glyph span inside it.
  function captureAt(x, y, props, extra) {
    var n = document.elementFromPoint(x, y);
    var control = n && n.closest ? (n.closest('button, .toggle-label, [data-fig], .select-btn') || n) : n;
    if (!control) return null;
    var cs = getComputedStyle(control);
    var r = control.getBoundingClientRect();
    var rec = { tag: control.tagName.toLowerCase(), id: control.id || null, cls: clsOf(control),
      fig: control.getAttribute('data-fig') || null, phase: extra || null,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height }, style: readStyle(cs, props) };
    var pb = pseudo(control, '::before', props); if (pb) rec.before = pb;
    var pa = pseudo(control, '::after', props); if (pa) rec.after = pa;
    return rec;
  }
  function readStyle(cs, props) {
    var st = {};
    for (var j = 0; j < props.length; j++) st[props[j]] = cs.getPropertyValue(props[j]);
    return st;
  }
  // A ::before/::after only exists when content is not none/normal. Capture it
  // when generated — three shipping visuals (tool-pill dash, input fader, model
  // chevron) live entirely in pseudo-elements and were invisible before.
  function pseudo(n, sel, props) {
    var cs = getComputedStyle(n, sel);
    var content = cs.getPropertyValue('content');
    if (content === 'none' || content === 'normal' || content === '') return null;
    if (cs.getPropertyValue('display') === 'none') return null;
    var st = readStyle(cs, props);
    st.content = content;
    return st;
  }
  function clsOf(n) {
    if (!n.className) return null;
    return n.className.baseVal === undefined ? n.className : (n.className.baseVal || null); // SVG className is an object
  }
  function metrics(props) {
    var out = [];
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') continue;
      var r = n.getBoundingClientRect();
      var fig = (n.getAttribute && n.getAttribute('data-fig')) || null;
      var id = n.id || null;
      var box0 = (r.width === 0 && r.height === 0);
      // Keep anchored/identified 0-box nodes (flagged) so the diff can FAIL on
      // "should render, collapsed to nothing" instead of silently missing it.
      // Drop only anonymous zero-box noise.
      if (box0 && !fig && !id) continue;
      var cs = getComputedStyle(n);
      var parent = n.parentElement;
      var rec = {
        tag: n.tagName.toLowerCase(), id: id, cls: clsOf(n), fig: fig,
        parentFig: (parent && parent.getAttribute && parent.getAttribute('data-fig')) || null,
        parentId: (parent && parent.id) || null,
        childIndex: parent ? Array.prototype.indexOf.call(parent.children, n) : -1,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        style: readStyle(cs, props),
      };
      if (box0) rec.box0 = true;
      var pb = pseudo(n, '::before', props); if (pb) rec.before = pb;
      var pa = pseudo(n, '::after', props); if (pa) rec.after = pa;
      out.push(rec);
    }
    return out;
  }
  return { states: states, run: function (name) { states[name](); }, list: Object.keys(states),
    metrics: metrics, interactiveTargets: interactiveTargets, captureAt: captureAt };
})();
window.__audit.list.join(',');
`;

let msgId = 0;
function rpc(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const onMsg = (data) => {
      const m = JSON.parse(data.toString());
      if (m.id !== id) return;
      ws.off('message', onMsg);
      if (m.error) reject(new Error(method + ': ' + JSON.stringify(m.error)));
      else resolve(m.result);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function evalJs(ws, expression) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && /gaffer/i.test((t.url || '') + (t.title || '')));
  if (!page) throw new Error('no gaffer page target; targets: ' + targets.map((t) => t.title + '|' + t.url).join(' ; '));

  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Runtime.enable');

  // Always reload first so the capture reflects the CURRENT panel code — the
  // deployed panel symlinks the repo, so edited data-fig anchors / CSS only
  // appear after a reload. Without this we'd diff stale DOM.
  await evalJs(ws, "localStorage.setItem('gafferAudit', '1'); 'set'");
  await rpc(ws, 'Page.reload', {});
  await sleep(600);
  for (let i = 0; i < 40; i++) { try { if (await evalJs(ws, '!!(window.__gaffer && window.__gaffer.addReplyQuote)')) break; } catch (_) { /* reloading */ } await sleep(250); }

  // The panel exposes its real builders on window.__gaffer only when
  // localStorage.gafferAudit === '1' (so no test seam ships to end users). Set
  // the flag and reload once if the hooks aren't there yet; the flag persists,
  // so subsequent runs skip the reload.
  const hasHook = await evalJs(ws, '!!(window.__gaffer && window.__gaffer.addReplyQuote)');
  if (!hasHook) {
    await evalJs(ws, "localStorage.setItem('gafferAudit', '1'); 'set'");
    await rpc(ws, 'Page.reload', {});
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      await sleep(250);
      try { ready = await evalJs(ws, '!!(window.__gaffer && window.__gaffer.addReplyQuote)'); } catch (_) { /* context reloading */ }
    }
    if (!ready) throw new Error('audit seam not available after enabling gafferAudit + reload');
    console.log('enabled gafferAudit seam (reloaded)');
  }

  const env = {
    browser: version.Browser,
    userAgent: version['User-Agent'],
    webkit: version['WebKit-Version'],
    probe: await evalJs(ws, `JSON.stringify({
      dpr: window.devicePixelRatio, w: innerWidth, h: innerHeight,
      fonts: getComputedStyle(document.body).fontFamily,
      skin: (function(){ try { var cs = new CSInterface(); return cs.getHostEnvironment().appSkinInfo; } catch(e){ return String(e); } })()
    })`),
  };
  writeFileSync(join(OUT, 'env.json'), JSON.stringify(env, null, 2));
  console.log('env:', env.browser, '| viewport:', env.probe.slice(0, 120));

  const stateList = (await evalJs(ws, HARNESS)).split(',');
  console.log('states:', stateList.join(' '));

  for (const state of stateList) {
    await evalJs(ws, `window.__audit.run(${JSON.stringify(state)}); 'ok'`);
    await sleep(350);
    const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png', fromSurface: true });
    writeFileSync(join(OUT, `state-${state}.png`), Buffer.from(shot.data, 'base64'));
    const metrics = await evalJs(ws, `JSON.stringify(window.__audit.metrics(${JSON.stringify(COMPUTED_PROPS)}))`);
    writeFileSync(join(OUT, `state-${state}.metrics.json`), metrics);
    console.log('captured', state, '(' + JSON.parse(metrics).length + ' elements)');
  }

  // ── Interactive states: :hover / :active / :focus ──────────────────────────
  // DOM injection can't synthesize these — drive a REAL pointer via CDP Input so
  // Chromium applies the pseudo-classes, then read the element under it. This is
  // the only way to reach the Figma State=Hover variant axis.
  await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 }); // park pointer
  const hitTargets = JSON.parse(await evalJs(ws, 'JSON.stringify(window.__audit.interactiveTargets())'));
  const P = JSON.stringify(COMPUTED_PROPS);
  const hover = [], active = [], focus = [];
  for (const t of hitTargets) {
    // hover: move real pointer onto the control
    await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.x, y: t.y });
    await sleep(40);
    const h = await evalJs(ws, `JSON.stringify(window.__audit.captureAt(${t.x},${t.y},${P},'hover'))`);
    if (h && h !== 'null') hover.push(JSON.parse(h));
    // active: press (hold) then read, then release
    await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: t.x, y: t.y, button: 'left', clickCount: 1 });
    await sleep(30);
    const a = await evalJs(ws, `JSON.stringify(window.__audit.captureAt(${t.x},${t.y},${P},'active'))`);
    if (a && a !== 'null') active.push(JSON.parse(a));
    await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: t.x, y: t.y, button: 'left', clickCount: 1 });
    // focus: keyboard-style focus so :focus-visible engages, then read
    const f = await evalJs(ws, `(function(){var n=document.elementFromPoint(${t.x},${t.y});var c=n&&n.closest?(n.closest('button,.toggle-label,[data-fig],.select-btn')||n):n;if(!c)return 'null';if(c.focus)c.focus({focusVisible:true});return JSON.stringify(window.__audit.captureAt(${t.x},${t.y},${P},'focus'));})()`);
    if (f && f !== 'null') focus.push(JSON.parse(f));
    await evalJs(ws, 'if(document.activeElement&&document.activeElement.blur)document.activeElement.blur(); "b"');
  }
  await rpc(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 }); // park pointer off controls
  for (const [name, arr] of [['hover', hover], ['active', active], ['focus', focus]]) {
    writeFileSync(join(OUT, `state-${name}.metrics.json`), JSON.stringify(arr));
    console.log('captured', name, '(' + arr.length + ' controls)');
  }

  await evalJs(ws, 'setTimeout(function(){ location.reload(); }, 100); "reloading"');
  console.log('panel reloaded to restore real state');
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
