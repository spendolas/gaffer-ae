// Daemon log lines must not carry em or en dashes: the Windows log
// (%TEMP%\gaffer-daemon.log) is read in a console that renders them as
// garbage. Scans every daemon source file (not vendor/, test/, node_modules/)
// for string literals inside console.log/warn/error/info/debug arguments.
// No dependencies: a small lexer that knows strings, templates and comments.
//
// Known limits of the scanner (good enough for a lint, not a parser):
// - a regex literal containing a quote inside a console call argument is
//   read as the start of a string and can swallow or split what follows;
// - a string built elsewhere (stored in a variable, returned by a helper,
//   read from a file) and then logged is not seen; only literals written
//   directly in the console call's argument list are checked;
// - the daemon's own log helpers (if any wrap console) are not followed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAEMON = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['vendor', 'test', 'node_modules', 'test-fixtures']);
const DASH = /[–—]/;

function sources(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) out.push(...sources(join(dir, e.name))); }
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

// Returns [{ text, index }] for every string literal (and template text)
// inside the argument list of each console.log/warn/error call in src.
export function consoleLiterals(src) {
  const found = [];
  const re = /\bconsole\.(log|warn|error|info|debug)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) i = src.length; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; if (i === 1) i = src.length; continue; }
      if (c === '\'' || c === '"' || c === '`') {
        const start = i;
        i++;
        while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; }
        found.push({ text: src.slice(start, i + 1), index: start });
        i++;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    re.lastIndex = i;
  }
  return found;
}

test('the lexer finds literals in console calls and ignores comments', () => {
  const src = [
    "console.log('a — b' + x); // — comment",
    "console.warn(`t ${y}`, /* – */ \"c\");",
    "var z = 'not logged —';",
    "console.error('ok', fn('nested –'));",
    "console.info('i'); console.debug(\"d\");",
  ].join('\n');
  const lits = consoleLiterals(src).map((l) => l.text);
  assert.deepEqual(lits, ["'a — b'", '`t ${y}`', '"c"', "'ok'", "'nested –'", "'i'", '"d"']);
});

test('no daemon console.log/warn/error/info/debug string carries an em or en dash', () => {
  const files = sources(DAEMON);
  assert.ok(files.some((f) => f.endsWith('chat-handler.js')), 'scanned the daemon sources');
  const bad = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const l of consoleLiterals(src)) {
      if (DASH.test(l.text)) {
        const line = src.slice(0, l.index).split('\n').length;
        bad.push(f.slice(DAEMON.length) + ':' + line + ' ' + l.text);
      }
    }
  }
  assert.deepEqual(bad, []);
});
