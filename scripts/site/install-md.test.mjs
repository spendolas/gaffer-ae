import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderInstallMd, extractInstall } from './build-install-md.mjs';

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const installMd = readFileSync(new URL('../../site/install.md', import.meta.url), 'utf8');

test('site/install.md is exactly what the README produces (run build-install-md.mjs to refresh)', () => {
  assert.equal(installMd, renderInstallMd(readme));
});

test('install.md keeps the rules, every numbered step and the troubleshooting list', () => {
  for (const heading of ['# Install Gaffer', '## Requirements', '## First: confirm you are running on the user\'s own computer', '## Rules for Claude', '## What to do', '## Troubleshooting']) {
    assert.ok(installMd.includes(`\n${heading}\n`) || installMd.startsWith(`${heading}\n`), heading);
  }
  for (let n = 1; n <= 9; n++) assert.match(installMd, new RegExp(`^${n}\\. \\*\\*`, 'm'), `step ${n}`);
  assert.ok(installMd.includes('Do not skip, reorder, or combine steps'));
});

test('install.md has no HTML wrapper and downloads only from the latest release', () => {
  assert.doesNotMatch(installMd, /<details|<summary|<\/details/);
  assert.ok(installMd.includes('https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-install-mac.tar.gz'));
  assert.ok(installMd.includes('https://github.com/spendolas/gaffer-ae/releases/latest/download/gaffer-install-win.zip'));
  assert.doesNotMatch(installMd, /releases\/download\/v\d/, 'no hard-coded version');
});

test('extractInstall fails loudly when the README section moves', () => {
  assert.throws(() => extractInstall('# Gaffer\nnothing here'), /no "## Install Instructions for Claude" section/);
  assert.throws(() => extractInstall('## Install Instructions for Claude\n<details>'), /no closing/);
});

test('install.md tells an agent in a sandbox (Cowork, web, container) to stop before installing anything', () => {
  const first = installMd.slice(installMd.indexOf('## First: confirm'), installMd.indexOf('## Rules for Claude'));
  assert.ok(first.includes('Claude Cowork'));
  assert.ok(first.includes('uname -s') && first.includes('Darwin') && first.includes('Windows_NT'));
  assert.ok(first.includes('STOP'));
  assert.ok(first.includes('Code tab in the Claude desktop app'));
  assert.ok(installMd.indexOf('## First: confirm') < installMd.indexOf('## What to do'), 'before any step');
});
