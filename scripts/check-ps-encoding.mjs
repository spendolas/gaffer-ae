#!/usr/bin/env node
// Pre-release guard for the PowerShell 5.1 encoding landmine: every .ps1
// must be ASCII-only with a UTF-8 BOM. PS 5.1 reads BOM-less files as
// Windows-1252 — one typographic dash in a comment breaks the parser (see
// scripts/windows-tests/test-1-bom.ps1 for the repro). Runs on any OS.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const files = execSync("git ls-files '*.ps1'", { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
let fail = 0;
for (const f of files) {
  const buf = readFileSync(f);
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const body = hasBom ? buf.subarray(3) : buf;
  const nonAscii = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] > 127) nonAscii.push(i + (hasBom ? 3 : 0));
  }
  const ok = hasBom && nonAscii.length === 0;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + f + (hasBom ? '' : '  [no BOM]') + (nonAscii.length ? `  [${nonAscii.length} non-ASCII bytes, first at ${nonAscii[0]}]` : ''));
  if (!ok) fail++;
}
process.exit(fail ? 1 : 0);
