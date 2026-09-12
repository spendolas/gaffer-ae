import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win32ClaudeCandidates } from '../claude-binary.js';

// Regression for the Windows "Claude CLI not found" bug: the native installer
// (irm claude.ai/install.ps1) puts claude.exe under %USERPROFILE%\.local\bin and
// does NOT add it to PATH, so detection must probe it directly.
test('win32 candidates include the native-installer %USERPROFILE%\\.local\\bin path', () => {
  var c = win32ClaudeCandidates({
    USERPROFILE: 'C:\\Users\\gaffer',
    LOCALAPPDATA: 'C:\\Users\\gaffer\\AppData\\Local',
  });
  // path.join uses the host separator, so match either \ or / between segments.
  assert.ok(
    c.some(function (p) { return /[\\/]\.local[\\/]bin[\\/]claude\.exe$/i.test(p); }),
    'native install location (.local/bin/claude.exe) must be a probed candidate'
  );
});

test('win32 candidates still cover the Programs and WinGet locations', () => {
  var c = win32ClaudeCandidates({
    USERPROFILE: 'C:\\Users\\gaffer',
    LOCALAPPDATA: 'C:\\Users\\gaffer\\AppData\\Local',
  });
  assert.ok(c.some(function (p) { return /Programs[\\/]claude-code[\\/]claude\.exe$/i.test(p); }), 'Programs install');
  assert.ok(c.some(function (p) { return /WinGet[\\/]Links[\\/]claude\.exe$/i.test(p); }), 'WinGet shim');
});

test('win32 candidates are safe when env vars are absent (no throw, no undefined)', () => {
  var c = win32ClaudeCandidates({});
  assert.ok(Array.isArray(c) && c.length === 3);
  c.forEach(function (p) { assert.equal(typeof p, 'string'); });
});
