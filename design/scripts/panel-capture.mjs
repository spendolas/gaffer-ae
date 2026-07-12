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
  'color', 'background-color', 'border-radius', 'border-top-width', 'border-top-color',
  'border-top-style', 'font-family', 'font-size', 'font-weight', 'line-height',
  'letter-spacing', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap', 'display',
  'align-items', 'justify-content', 'flex-direction', 'opacity', 'box-shadow',
  'text-align', 'overflow-x', 'overflow-y', 'white-space',
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
    chat().innerHTML = '';
    document.getElementById('updateBanner').classList.remove('visible');
    document.getElementById('dropOverlay').classList.remove('visible');
    var lb = document.getElementById('imgLightbox'); lb.hidden = true;
    document.getElementById('pastePreviewRow').innerHTML = '';
    document.querySelector('.activity-log').open = false;
    document.getElementById('stopBtn').style.display = 'none';
    document.getElementById('sendBtn').style.display = '';
  }
  function bubble(role, text) {
    var m = el('div', 'chat-msg ' + role);
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
      document.querySelector('.activity-log').open = true;
    },
    'paste-preview': function () {
      reset();
      var row = document.getElementById('pastePreviewRow');
      var chip = el('span', 'paste-chip');
      var img = document.createElement('canvas'); img.width = 48; img.height = 48;
      chip.appendChild(img);
      chip.appendChild(el('span', 'paste-chip-x', '\\u2715'));
      row.appendChild(chip);
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
      document.getElementById('led').className = 'led error';
      document.getElementById('statusText').textContent = 'Disconnected';
    },
  };
  function metrics(props) {
    var out = [];
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') continue;
      var r = n.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      var cs = getComputedStyle(n);
      var style = {};
      for (var j = 0; j < props.length; j++) style[props[j]] = cs.getPropertyValue(props[j]);
      out.push({
        tag: n.tagName.toLowerCase(), id: n.id || null, cls: n.className && n.className.baseVal === undefined ? n.className : null,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height }, style: style,
      });
    }
    return out;
  }
  return { states: states, run: function (name) { states[name](); }, list: Object.keys(states), metrics: metrics };
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

  await evalJs(ws, 'setTimeout(function(){ location.reload(); }, 100); "reloading"');
  console.log('panel reloaded to restore real state');
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
