import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopAppCandidates, macDesktopAppCandidates, formatNotFoundMessage } from '../claude-binary.js';

// The Claude desktop app keeps its own copy of the CLI under
// %APPDATA%\Claude\claude-code and rewrites that layout on its own schedule:
//   <= 2.1.209  <version>\claude.exe
//   >= 2.1.286  <version>\<build hash>\claude.exe
// These tests build real folder trees (folders only, the candidate list does
// not need real files) so the lookup is checked against the actual fs calls.

function makeAppData(dirs) {
  var appData = mkdtempSync(join(tmpdir(), 'gaffer-appdata-'));
  var base = join(appData, 'Claude', 'claude-code');
  mkdirSync(base, { recursive: true });
  dirs.forEach(function (d) { mkdirSync(join(base, d), { recursive: true }); });
  return { appData: appData, base: base, done: function () { rmSync(appData, { recursive: true, force: true }); } };
}

test('new layout: <version>\\<hash>\\claude.exe is found, newest version first (the reported 2.1.286 / 2.1.288 machine)', () => {
  var t = makeAppData(['2.1.286/635c1867224a', '2.1.288/36aa8c97bf86']);
  try {
    var c = desktopAppCandidates(t.appData);
    assert.equal(c[0], join(t.base, '2.1.288', '36aa8c97bf86', 'claude.exe'), 'newest build is the first candidate');
    assert.ok(c.indexOf(join(t.base, '2.1.286', '635c1867224a', 'claude.exe')) > 0, 'older build still listed after it');
  } finally { t.done(); }
});

test('old layout: a version folder with no sub-folders yields <version>\\claude.exe', () => {
  var t = makeAppData(['2.1.209']);
  try {
    assert.deepEqual(desktopAppCandidates(t.appData), [join(t.base, '2.1.209', 'claude.exe')]);
  } finally { t.done(); }
});

test('inside one version: hash folders first, then the old direct path, then deeper levels', () => {
  var t = makeAppData(['2.1.300/abc123/inner', '2.1.300/def456']);
  try {
    var v = join(t.base, '2.1.300');
    var c = desktopAppCandidates(t.appData);
    var iHash = c.indexOf(join(v, 'abc123', 'claude.exe'));
    var iHash2 = c.indexOf(join(v, 'def456', 'claude.exe'));
    var iOld = c.indexOf(join(v, 'claude.exe'));
    var iDeep = c.indexOf(join(v, 'abc123', 'inner', 'claude.exe'));
    assert.ok(iHash >= 0 && iHash2 >= 0 && iOld >= 0 && iDeep >= 0, 'all four candidates present: ' + JSON.stringify(c));
    assert.ok(Math.max(iHash, iHash2) < iOld, 'every <hash> path comes before the old direct path');
    assert.ok(iOld < iDeep, 'the old direct path comes before deeper levels');
  } finally { t.done(); }
});

test('versions are ordered numerically, not as text (2.1.121 beats 2.1.9)', () => {
  var t = makeAppData(['2.1.9', '2.1.121', '2.1.286']);
  try {
    var order = desktopAppCandidates(t.appData).map(function (p) { return p.split(/[\\/]/).slice(-2, -1)[0]; });
    assert.deepEqual(order, ['2.1.286', '2.1.121', '2.1.9']);
  } finally { t.done(); }
});

test('survives one extra folder level, and stops at three levels below the version', () => {
  var t = makeAppData(['2.1.400/a/b/c/d']);
  try {
    var v = join(t.base, '2.1.400');
    var c = desktopAppCandidates(t.appData);
    assert.ok(c.indexOf(join(v, 'a', 'b', 'claude.exe')) >= 0, 'two levels below is searched');
    assert.ok(c.indexOf(join(v, 'a', 'b', 'c', 'claude.exe')) >= 0, 'three levels below is searched');
    assert.equal(c.indexOf(join(v, 'a', 'b', 'c', 'd', 'claude.exe')), -1, 'four levels below is not searched');
  } finally { t.done(); }
});

test('several build folders under one version are all listed', () => {
  var t = makeAppData(['2.1.290/aaa', '2.1.290/bbb', '2.1.290/ccc']);
  try {
    var c = desktopAppCandidates(t.appData);
    ['aaa', 'bbb', 'ccc'].forEach(function (h) {
      assert.ok(c.indexOf(join(t.base, '2.1.290', h, 'claude.exe')) >= 0, h + ' listed');
    });
  } finally { t.done(); }
});

test('stray files are ignored, a missing folder gives an empty list, never a throw', () => {
  var t = makeAppData(['2.1.288/hash1']);
  try {
    writeFileSync(join(t.base, 'notes.txt'), 'x');
    writeFileSync(join(t.base, '2.1.288', 'readme.txt'), 'x');
    var c = desktopAppCandidates(t.appData);
    assert.ok(c.every(function (p) { return !/notes\.txt|readme\.txt/.test(p); }), 'no candidate built from a file');
    assert.equal(c.length, 2, 'one hash path plus the old direct path: ' + JSON.stringify(c));
  } finally { t.done(); }
  assert.deepEqual(desktopAppCandidates(join(tmpdir(), 'gaffer-does-not-exist-' + Date.now())), []);
  assert.deepEqual(desktopAppCandidates(''), []);
  assert.deepEqual(desktopAppCandidates(undefined), []);
});

test('a runaway folder cannot blow up the candidate list (capped per level)', () => {
  var dirs = [];
  for (var i = 0; i < 120; i++) dirs.push('2.1.500/h' + i);
  var t = makeAppData(dirs);
  try {
    assert.ok(desktopAppCandidates(t.appData).length <= 60, 'bounded list');
  } finally { t.done(); }
});

// Mac: the desktop app keeps the same version/hash layout under
// ~/Library/Application Support/Claude/claude-code, with the binary inside a
// claude.app bundle.
function makeHome(dirs) {
  var home = mkdtempSync(join(tmpdir(), 'gaffer-home-'));
  var base = join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  mkdirSync(base, { recursive: true });
  dirs.forEach(function (d) { mkdirSync(join(base, d), { recursive: true }); });
  return { home: home, base: base, done: function () { rmSync(home, { recursive: true, force: true }); } };
}

var MAC_LEAF = ['claude.app', 'Contents', 'MacOS', 'claude'];

test('mac: <version>/<hash>/claude.app/Contents/MacOS/claude, newest version first (the 2.1.288 / 2.1.289 machine)', () => {
  var t = makeHome(['2.1.288/0f3a', '2.1.289/1a416eb22c68']);
  try {
    var c = macDesktopAppCandidates(t.home);
    assert.equal(c[0], join.apply(null, [t.base, '2.1.289', '1a416eb22c68'].concat(MAC_LEAF)), 'newest build first');
    assert.ok(c.indexOf(join.apply(null, [t.base, '2.1.288', '0f3a'].concat(MAC_LEAF))) > 0, 'older build after it');
    assert.ok(c.every(function (p) { return /claude\.app[\\/]Contents[\\/]MacOS[\\/]claude$/.test(p); }), 'every candidate is the binary inside the bundle, never claude.app itself');
  } finally { t.done(); }
});

test('mac: hash folders first, then the direct path, then deeper; numeric version order; missing home is empty', () => {
  var t = makeHome(['2.1.9/aaa/inner', '2.1.121/bbb']);
  try {
    var c = macDesktopAppCandidates(t.home);
    var v9 = join(t.base, '2.1.9'), v121 = join(t.base, '2.1.121');
    assert.ok(c.indexOf(join.apply(null, [v121, 'bbb'].concat(MAC_LEAF))) < c.indexOf(join.apply(null, [v9, 'aaa'].concat(MAC_LEAF))), '2.1.121 before 2.1.9');
    var iHash = c.indexOf(join.apply(null, [v9, 'aaa'].concat(MAC_LEAF)));
    var iDirect = c.indexOf(join.apply(null, [v9].concat(MAC_LEAF)));
    var iDeep = c.indexOf(join.apply(null, [v9, 'aaa', 'inner'].concat(MAC_LEAF)));
    assert.ok(iHash >= 0 && iHash < iDirect && iDirect < iDeep, JSON.stringify(c));
  } finally { t.done(); }
  assert.deepEqual(macDesktopAppCandidates(join(tmpdir(), 'gaffer-no-home-' + Date.now())), []);
  assert.deepEqual(macDesktopAppCandidates(''), []);
  assert.deepEqual(macDesktopAppCandidates(undefined), []);
});

test('not-found message explains what was checked (desktop folder versions, what PATH returned)', () => {
  var msg = formatNotFoundMessage({
    desktopBase: 'C:\\Users\\x\\AppData\\Roaming\\Claude\\claude-code',
    desktopVersions: ['2.1.288', '2.1.286'],
    pathLines: ['C:\\Program Files\\nodejs\\claude.cmd'],
  }, 'C:\\Users\\x\\AppData\\Roaming\\Gaffer\\config.json');
  assert.match(msg, /Claude CLI not found/);
  assert.match(msg, /2\.1\.288/, 'names the versions it saw in the desktop folder');
  assert.match(msg, /claude\.cmd/, 'shows what PATH returned');
  assert.match(msg, /config\.json/, 'still points at the pinned-path escape hatch');
  assert.match(msg, /https:\/\/claude\.com\/download/, 'desktop app install link');
  assert.match(msg, /https:\/\/claude\.ai\/code/, 'CLI install link');
  assert.doesNotMatch(msg, /[\u2013\u2014]/, 'no em or en dashes');
});

test('not-found message copes with every diagnostic being empty', () => {
  var msg = formatNotFoundMessage({ desktopBase: null, desktopVersions: [], pathLines: [] }, '/tmp/config.json');
  assert.match(msg, /Claude CLI not found/);
  assert.match(msg, /nothing/i, 'says PATH returned nothing');
  assert.doesNotMatch(msg, /undefined|null/);
});
