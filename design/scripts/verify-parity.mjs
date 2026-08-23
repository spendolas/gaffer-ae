#!/usr/bin/env node
// Figma parity audit — step 8 numeric verification.
// Asserts captured computed styles/geometry (design/refs/panel/state-*.metrics.json,
// from panel-capture.mjs) against Figma spec numbers. Each assertion names the
// Figma node it comes from. Exits non-zero if anything fails.
//
// Usage: node design/scripts/verify-parity.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL = join(__dirname, '..', 'refs', 'panel');

const states = {};
function els(state) {
  if (!states[state]) states[state] = JSON.parse(readFileSync(join(PANEL, `state-${state}.metrics.json`), 'utf8'));
  return states[state];
}
function find(state, pred) { return els(state).find(pred); }
function byCls(state, cls) { return find(state, (e) => typeof e.cls === 'string' && e.cls.split(' ').indexOf(cls) !== -1); }
function byId(state, id) { return find(state, (e) => e.id === id); }

const results = [];
function check(name, actual, expected, tol) {
  let ok;
  if (typeof expected === 'number' && typeof actual === 'number') ok = Math.abs(actual - expected) <= (tol ?? 1);
  else if (expected instanceof RegExp) ok = expected.test(String(actual));
  else ok = String(actual) === String(expected);
  results.push({ name, ok, actual, expected: String(expected) });
}
const px = (v) => parseFloat(v);

// ── Typography & bubbles (Bubble 176:928/931, audit §4.1) ──
{
  const user = byCls('conversation', 'user');
  const asst = byCls('conversation', 'assistant');
  check('user bubble bg #000 (bubble/user-bg)', user.style['background-color'], 'rgb(0, 0, 0)');
  // serializer drops the 4th value when it equals the 2nd
  check('user bubble radius 16/16/2/16', user.style['border-radius'], /^16px 16px 2px( 16px)?$/);
  check('assistant bubble radius 16/16/16/2', asst.style['border-radius'], '16px 16px 16px 2px');
  check('bubble padding 8', user.style['padding-top'], '8px');
  check('bubble gap 12', asst.style['gap'], '12px');
  const txt = find('conversation', (e) => e.cls === 'msg-text' && e.tag === 'div');
  check('body text 14px', txt.style['font-size'], '14px');
  check('body line-height 18px', txt.style['line-height'], '18px');
  check('body font Source Sans 3 (bundled OFL baseline)', txt.style['font-family'], /Source Sans 3/);
  check('body weight regular', txt.style['font-weight'], '400');
}

// ── Markdown (CodeInline 216:2914, CodeBlock 216:2929, quote 216:2944, table 216:2962) ──
{
  // inline code sits on one line (~22px); the block <code> lives in a <pre> and
  // is much taller — height is the only cue in the flat metrics dump.
  const code = find('markdown', (e) => e.tag === 'code' && e.rect.h < 30);
  check('inline code 12px SF Mono', code.style['font-size'], '12px');
  check('inline code line-height 16px', code.style['line-height'], '16px');
  check('inline code color #efaa3c (text/code)', code.style['color'], 'rgb(239, 170, 60)');
  const pre = find('markdown', (e) => e.tag === 'pre');
  check('code block r8', pre.style['border-radius'], '8px');
  check('code block bg #121212 (bg/input)', pre.style['background-color'], 'rgb(18, 18, 18)');
  const bq = find('markdown', (e) => e.tag === 'blockquote');
  check('blockquote text muted #aaa', bq.style['color'], 'rgb(170, 170, 170)');
  const th = find('markdown', (e) => e.tag === 'th');
  check('table header 12px', th.style['font-size'], '12px');
  // MarkdownTable header cells (185:1150/1151) are text/light-2 SemiBold — NOT
  // text/strong (the v2 audit note was wrong; the fresh walk is ground truth).
  check('table header text/light-2 #cccccc (185:1150)', th.style['color'], 'rgb(204, 204, 204)');
}

// ── Tool status dashes (chips reduced per 2026-07-14 direction) ──
{
  const run = byCls('busy-pills', 'running');
  const done = byCls('busy-pills', 'done');
  const err = byCls('busy-pills', 'error');
  check('dash running amber #d09726', run.style['color'], 'rgb(208, 151, 38)');
  check('dash done green #3dc17f', done.style['color'], 'rgb(61, 193, 127)');
  check('dash error red #cc4444', err.style['color'], 'rgb(204, 68, 68)');
  check('dash 16x8 hit area', [Math.round(run.rect.w), Math.round(run.rect.h)].join('x'), '16x8');
  check('dash label hidden', run.style['font-size'], '0px');
}

// ── Input row (InputField 185:1132, Button 240:1324) ──
{
  const row = byCls('empty', 'chat-input-row');
  check('input pill h 48 (InputField)', row.rect.h, 48);
  check('input pill r24', row.style['border-radius'], '24px');
  check('input pill bg #121212 (bg/input)', row.style['background-color'], 'rgb(18, 18, 18)');
  check('input pill pad 8', row.style['padding-left'], '8px');
  const send = byId('empty', 'sendBtn');
  check('send btn 32x32', send.rect.w, 32);
  check('send btn r16', send.style['border-radius'], '16px');
  check('send btn bg #4a7dc9 (btn/primary)', send.style['background-color'], 'rgb(74, 125, 201)');
  check('send btn idle opacity .4', send.style['opacity'], '0.4');
}

// ── Chat geometry (chat behind input, fader anchoring) ──
{
  const chat = byId('empty', 'chatMessages');
  const area = byCls('empty', 'chat-input-area');
  check('chat bleed 28px into the area', chat.rect.y + chat.rect.h - area.rect.y, 28);
  check('chat bottom pad 34 (constant, anti-shift)', chat.style['padding-bottom'], '34px');
  check('area height 52 (row + 4)', area.rect.h, 52);
}

// ── Update banner (UpdateBanner 290:8929) ──
{
  const pill = byCls('update-banner', 'banner-pill');
  check('banner pill bg #173658 (bg/banner)', pill.style['background-color'], 'rgb(23, 54, 88)');
  check('banner pill r 16/16/0/0', pill.style['border-radius'], '16px 16px 0px 0px');
  check('banner pill pad 6/6/6/12', [pill.style['padding-top'], pill.style['padding-right'], pill.style['padding-bottom'], pill.style['padding-left']].join(' '), '6px 6px 6px 12px');
  check('banner pill gap 40', pill.style['gap'], '40px');
  const txt = byId('update-banner', 'updateText');
  check('banner text 12/16 accent/blue', [txt.style['font-size'], txt.style['line-height'], txt.style['color']].join(' '), '12px 16px rgb(77, 157, 247)');
  const row = byCls('update-banner', 'chat-input-row');
  check('banner flush on input row', Math.abs((pill.rect.y + pill.rect.h) - row.rect.y), 0);
  const btn = byId('update-banner', 'updateBtn');
  check('update btn bg btn/primary', btn.style['background-color'], 'rgb(74, 125, 201)');
  check('update btn h 20 r8', [Math.round(btn.rect.h), btn.style['border-radius']].join(' '), '20 8px');
  const dis = byId('update-banner', 'dismissUpdateBtn');
  check('dismiss 20x20 pad2 r8', [Math.round(dis.rect.w), dis.style['padding-top'], dis.style['border-radius']].join(' '), '20 2px 8px');
}

// ── Paste tray + chips (PastePreviewRow 185:1163, ImageChip 176:940) ──
{
  const tray = byId('paste-preview', 'pastePreviewRow');
  check('tray bg #121212 (bg/input)', tray.style['background-color'], 'rgb(18, 18, 18)');
  check('tray r12', tray.style['border-radius'], '12px');
  check('tray pad 4 gap 4', [tray.style['padding-top'], tray.style['gap']].join(' '), '4px 4px');
  const chip = byCls('paste-preview', 'paste-chip');
  check('chip h 80', chip.rect.h, 80);
  const x = byCls('paste-preview', 'paste-chip-x');
  check('chip X 16x16 r8', [Math.round(x.rect.w), x.style['border-radius']].join(' '), '16 8px');
  check('chip X overhangs corner -6', Math.round(x.rect.y - chip.rect.y), -6);
  check('chip X bg #000@.7 (btn/icon-bg)', x.style['background-color'], 'rgba(0, 0, 0, 0.7)');
}

// ── Drop overlay (191:1275) + lightbox (191:1276) ──
{
  const drop = byId('drop-overlay', 'dropOverlay');
  check('drop overlay #233C64@.95', drop.style['background-color'], 'rgba(35, 60, 100, 0.95)');
  check('drop text 10/15 border/banner', [drop.style['font-size'], drop.style['line-height'], drop.style['color']].join(' '), '10px 15px rgb(88, 118, 178)');
  check('drop overlay column gap 8', drop.style['gap'], '8px');
  const lb = byId('lightbox', 'imgLightbox');
  check('lightbox #000@.95', lb.style['background-color'], 'rgba(0, 0, 0, 0.95)');
}

// ── Status cluster + MCP tiles (Status 24 star, tiles) ──
{
  const wrap = byId('empty', 'statusWrap');
  if (wrap) check('status square 24', Math.round(wrap.rect.w), 24);
  const notice = byCls('notice-error', 'chat-notice');
  check('notice text muted', notice.style['color'], /rgb\(170, 170, 170\)|rgb\(136, 136, 136\)/);
}

// ── Report ──
const fails = results.filter((r) => !r.ok);
for (const r of results) {
  console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.ok ? '' : `  — actual: ${JSON.stringify(r.actual)} expected: ${r.expected}`));
}
console.log(`\n${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
