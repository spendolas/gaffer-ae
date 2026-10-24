import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';

const css = readFileSync(new URL('../../site/css/site.css', import.meta.url), 'utf8');
const fontsDir = new URL('../../site/fonts/', import.meta.url);
const faces = css.match(/@font-face\s*\{[^}]*\}/g) || [];
const face = (family) => faces.filter((f) => f.includes(`font-family: '${family}'`));

test('Source Sans 3 is one variable face, weights 200 to 900', () => {
  const f = face('Source Sans 3');
  assert.equal(f.length, 1);
  assert.match(f[0], /SourceSans3VF-Upright\.otf\.woff2/);
  assert.match(f[0], /font-weight:\s*200 900;/);
});

test('JetBrains Mono is one variable face, weights 100 to 800', () => {
  const f = face('JetBrains Mono');
  assert.equal(f.length, 1);
  assert.match(f[0], /JetBrainsMono-VF\.woff2/);
  assert.match(f[0], /font-weight:\s*100 800;/);
});

test('no static Regular, Semibold or Medium Source Sans 3 / JetBrains Mono files remain', () => {
  assert.doesNotMatch(css, /SourceSans3-(Regular|Semibold)|JetBrainsMono-(Regular|Medium)/);
  const files = readdirSync(fontsDir);
  for (const gone of ['SourceSans3-Regular.woff2', 'SourceSans3-Semibold.woff2', 'JetBrainsMono-Regular.woff2', 'JetBrainsMono-Medium.woff2']) {
    assert.equal(files.includes(gone), false, gone);
  }
});

test('the variable font files exist and each is under 250 KB', () => {
  for (const name of ['SourceSans3VF-Upright.otf.woff2', 'JetBrainsMono-VF.woff2']) {
    assert.ok(existsSync(new URL(name, fontsDir)), name);
    assert.ok(statSync(new URL(name, fontsDir)).size < 250 * 1024, name);
  }
});

test('the prompt reads its weight from --type-mono-weight', () => {
  assert.match(css, /\.dock-prompt \{[^}]*font-weight: var\(--type-mono-weight, 400\);/);
});
