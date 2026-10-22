#!/usr/bin/env node
// README steps 5 to 8 (Node runtime download, SHA-256, extract, signature)
// are generated from panel/daemon/runtime-pins.json, so the URLs, hashes,
// version and signing identities in the README can never drift from the pins.
//
//   node scripts/readme-pins.mjs           check README.md, exit 1 on drift
//   node scripts/readme-pins.mjs --write   regenerate the block in README.md
//
// To change the wording of those steps, edit renderRuntimeSteps() below and
// run --write. scripts/release-docs.test.mjs runs the same check.
//
// No dependencies. README text: no em or en dashes (user-facing copy).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BEGIN_MARK = '<!-- runtime-pins:begin. Generated from panel/daemon/runtime-pins.json by scripts/readme-pins.mjs; edit the script, then run: node scripts/readme-pins.mjs --write -->';
export const END_MARK = '<!-- runtime-pins:end -->';

// Order and labels for every platform the pins may carry. A pin without a
// label here fails the render, so a new platform cannot ship undocumented.
const PLATFORMS = {
  'darwin-arm64': { os: 'mac', label: 'macOS, Apple Silicon' },
  'darwin-x64': { os: 'mac', label: 'macOS, Intel' },
  'win-x64': { os: 'win', label: 'Windows' },
};

const MAC_INSTALL = '"$HOME/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel"';
const WIN_INSTALL = '"$env:APPDATA\\Adobe\\CEP\\extensions\\com.gaffer.panel"';
const CURL_OPTS = '-fsSL --connect-timeout 20 --max-time 600';

function platformsOf(pins) {
  const n = pins && pins.node;
  if (!n || !n.platforms) throw new Error('runtime-pins.json has no node.platforms');
  const keys = Object.keys(n.platforms);
  for (const k of keys) if (!PLATFORMS[k]) throw new Error('no README label for platform ' + k + ' in scripts/readme-pins.mjs');
  return Object.keys(PLATFORMS).filter((k) => keys.includes(k)).map((k) => ({ key: k, ...PLATFORMS[k], pin: n.platforms[k] }));
}

// Indent every non-empty line of a block by three spaces (list continuation).
const ind = (s) => s.split('\n').map((l) => (l ? '   ' + l : l)).join('\n');
const fence = (lang, body) => ind('```' + lang + '\n' + body + '\n```');
const heading = (p) => ind('**`' + p.key + '`** (' + p.label + ')');

function memberParts(member) {
  const parts = member.split('/');
  return { top: parts[0], strip: parts.length - 1 };
}

export function renderRuntimeSteps(pins) {
  const n = pins.node;
  const plats = platformsOf(pins);
  const out = [];

  // ---- 5. download ----
  out.push('5. **Download the Node.js runtime.** Gaffer runs on the official Node.js ' + n.version + ' from nodejs.org, kept as a single file inside Gaffer\'s own folder. Nothing is installed system-wide and nothing is added to PATH. Run only the block for the platform step 3 printed.');
  out.push('');
  for (const p of plats) {
    const a = p.pin.archive;
    out.push(heading(p));
    out.push('');
    if (p.os === 'mac') {
      out.push(fence('bash', [
        'DL="${TMPDIR:-/tmp}/gaffer-download"',
        'mkdir -p "$DL" && curl ' + CURL_OPTS + ' -o "$DL/' + a + '" ' + n.official + a,
      ].join('\n')));
    } else {
      out.push(fence('powershell', [
        '$dl = "$env:TEMP\\gaffer-download"',
        'New-Item -ItemType Directory -Path $dl -Force | Out-Null',
        'curl.exe ' + CURL_OPTS + ' -o "$dl\\' + a + '" ' + n.official + a,
        'if ($LASTEXITCODE -ne 0) { Write-Host "Download failed (curl exit $LASTEXITCODE)" }',
      ].join('\n')));
    }
    out.push('');
    out.push(ind('If that download fails, for example because your network blocks nodejs.org, download the same file from Gaffer\'s mirror: `' + n.mirror + a + '`. The mirror is byte-identical: its SHA-256 equals the value in nodejs.org\'s SHASUMS256.txt for this file.'));
    out.push('');
  }
  out.push(ind('For the mirror, run the same command with the mirror URL in place of the nodejs.org URL, and tell the user that you used the mirror. If the mirror download fails too, stop and tell the user: "Could not download the Node runtime from nodejs.org or Gaffer\'s mirror. Check your network and try again."'));
  out.push('');

  // ---- 6. archive SHA-256 ----
  out.push('6. **Verify the SHA-256 of the Node.js download.** It must equal the value written here for your platform.');
  out.push('');
  for (const p of plats) {
    const a = p.pin.archive;
    out.push(heading(p) + ' expected SHA-256 `' + p.pin.archiveSha256 + '`');
    out.push('');
    if (p.os === 'mac') {
      out.push(fence('bash', 'cd "${TMPDIR:-/tmp}/gaffer-download" && echo "' + p.pin.archiveSha256 + '  ' + a + '" | shasum -a 256 -c -'));
      out.push('');
      out.push(ind('It must print `' + a + ': OK`.'));
    } else {
      out.push(fence('powershell', [
        '$got = (Get-FileHash "$env:TEMP\\gaffer-download\\' + a + '" -Algorithm SHA256).Hash.ToLower()',
        'if ($got -eq "' + p.pin.archiveSha256 + '") { "SHA-256 OK" } else { "SHA-256 MISMATCH: $got" }',
      ].join('\n')));
      out.push('');
      out.push(ind('It must print `SHA-256 OK`.'));
    }
    out.push('');
  }
  out.push(ind('On a mismatch, delete the downloaded file. If it came from nodejs.org, download it once from the mirror (step 5) and check again. If the mirror\'s copy does not match either, stop and tell the user that the download did not match the expected checksum. Never extract an archive that failed this check.'));
  out.push('');

  // ---- 7. extract ----
  out.push('7. **Extract only the `node` binary into Gaffer\'s folder, then delete the archive.** The archive also contains npm and other tools; Gaffer needs only the one file.');
  out.push('');
  for (const p of plats) {
    const a = p.pin.archive;
    const { top, strip } = memberParts(p.pin.member);
    out.push(heading(p));
    out.push('');
    if (p.os === 'mac') {
      out.push(fence('bash', [
        'INSTALL_DIR=' + MAC_INSTALL,
        'DL="${TMPDIR:-/tmp}/gaffer-download"',
        'mkdir -p "$INSTALL_DIR/daemon/runtime" && tar -xzf "$DL/' + a + '" -C "$INSTALL_DIR/daemon/runtime" --strip-components=' + strip + ' ' + p.pin.member + ' && rm -rf "$DL"',
      ].join('\n')));
    } else {
      const leaf = p.pin.member.split('/').pop();
      out.push(fence('powershell', [
        '$installDir = ' + WIN_INSTALL,
        '$dl = "$env:TEMP\\gaffer-download"',
        '$rt = "$installDir\\daemon\\runtime"',
        'New-Item -ItemType Directory -Path $rt -Force | Out-Null',
        'tar.exe -xf "$dl\\' + a + '" -C $rt ' + p.pin.member,
        'if ($LASTEXITCODE -eq 0) {',
        '  Move-Item -Force "$rt\\' + top + '\\' + leaf + '" "$rt\\' + leaf + '"',
        '  Remove-Item -Recurse -Force "$rt\\' + top + '", $dl',
        '} else { Write-Host "Extract failed (tar exit $LASTEXITCODE)" }',
      ].join('\n')));
    }
    out.push('');
  }
  out.push(ind('The result is one file: `daemon/runtime/node` (Windows: `daemon\\runtime\\node.exe`) inside the install folder. Delete the archive and any download folder you created, including empty ones.'));
  out.push('');

  // ---- 8. signature and first run ----
  out.push('8. **Verify the runtime\'s code signature, then run it once.** If nodejs.org is unreachable, the code signature is the independent check. It shows the file was signed by the Node.js project and not changed since.');
  out.push('');
  for (const p of plats) {
    const stamp = n.version + ' ' + p.key;
    out.push(heading(p));
    out.push('');
    if (p.os === 'mac') {
      out.push(fence('bash', [
        'RT=' + MAC_INSTALL.slice(0, -1) + '/daemon/runtime"',
        'codesign --verify --strict "$RT/node" \\',
        '  && codesign -dv "$RT/node" 2>&1 | grep -x "TeamIdentifier=' + n.signing.darwinTeamId + '" \\',
        '  && "$RT/node" --version | grep -x "' + n.version + '" \\',
        '  && printf \'%s\\n\' "' + stamp + '" > "$RT/VERSION"',
      ].join('\n')));
      out.push('');
      out.push(ind('It must print `TeamIdentifier=' + n.signing.darwinTeamId + '` (the Node.js Foundation\'s Apple Developer ID) and then `' + n.version + '`. The last command records the verified version only when every check passed.'));
    } else {
      out.push(fence('powershell', [
        '$rt = ' + WIN_INSTALL.slice(0, -1) + '\\daemon\\runtime"',
        '$sig = Get-AuthenticodeSignature "$rt\\node.exe"',
        '"$($sig.Status) | $($sig.SignerCertificate.Subject)"',
        'if ($sig.Status -eq "Valid" -and $sig.SignerCertificate.Subject -like "*' + n.signing.windowsSigner + '*") {',
        '  $ver = & "$rt\\node.exe" --version',
        '  $ver',
        '  if ($ver -eq "' + n.version + '") { Set-Content -LiteralPath "$rt\\VERSION" -Value "' + stamp + '" -Encoding Ascii }',
        '}',
      ].join('\n')));
      out.push('');
      out.push(ind('The first line must start with `Valid` and name `' + n.signing.windowsSigner + '`, and the second must be `' + n.version + '`. The first run can take several seconds while Windows Defender scans the new file; later runs are fast. The verified version is recorded only when every check passed.'));
    }
    out.push('');
  }
  out.push(ind('If the signature check or the version check fails, delete the `daemon/runtime` folder, stop and tell the user: "The Node runtime\'s signature could not be verified. Nothing was installed."'));
  return out.join('\n');
}

function block(readme) {
  const b = readme.indexOf(BEGIN_MARK);
  const e = readme.indexOf(END_MARK);
  if (b === -1 || e === -1 || e < b) return null;
  if (readme.indexOf(BEGIN_MARK, b + 1) !== -1 || readme.indexOf(END_MARK, e + 1) !== -1) return null;
  return { start: b + BEGIN_MARK.length, end: e };
}

export function writeRuntimeSteps(readme, pins) {
  const pos = block(readme);
  if (!pos) throw new Error('README.md has no single runtime-pins block (' + BEGIN_MARK + ' ... ' + END_MARK + ')');
  return readme.slice(0, pos.start) + '\n' + renderRuntimeSteps(pins) + '\n' + readme.slice(pos.end);
}

// Returns a list of problems; empty means the README agrees with the pins.
export function checkReadme(readme, pins) {
  const problems = [];
  const n = pins.node;
  let rendered;
  try { rendered = renderRuntimeSteps(pins); } catch (e) { return [e.message]; }
  const pos = block(readme);
  if (!pos) problems.push('README.md has no single runtime-pins block');
  else if (readme.slice(pos.start, pos.end) !== '\n' + rendered + '\n') {
    problems.push('README runtime steps differ from runtime-pins.json (run: node scripts/readme-pins.mjs --write)');
  }

  // Anywhere in the README, inside or outside the block: every runtime value
  // must be a pinned one.
  const shas = new Set();
  for (const p of Object.values(n.platforms)) { shas.add(p.archiveSha256); shas.add(p.binarySha256); }
  for (const m of readme.matchAll(/\b[0-9a-fA-F]{64}\b/g)) {
    if (!shas.has(m[0].toLowerCase())) problems.push('unpinned SHA-256 in README: ' + m[0]);
  }
  const urlEnd = '[^\\s`"\'<>)\\]]*';
  for (const m of readme.matchAll(new RegExp('https://nodejs\\.org/dist/' + urlEnd, 'g'))) {
    if (!m[0].startsWith(n.official)) problems.push('nodejs.org URL not under the pinned version: ' + m[0]);
  }
  for (const m of readme.matchAll(new RegExp('https://github\\.com/spendolas/gaffer-ae/releases/download/' + urlEnd, 'g'))) {
    if (!m[0].startsWith(n.mirror)) problems.push('mirror URL not the pinned mirror: ' + m[0]);
  }
  for (const m of readme.matchAll(/TeamIdentifier=(\w+)/g)) {
    if (m[1] !== n.signing.darwinTeamId) problems.push('Team ID differs from the pin: ' + m[0]);
  }
  for (const m of readme.matchAll(/\bnode-(v\d+\.\d+\.\d+)/g)) {
    if (m[1] !== n.version) problems.push('Node version differs from the pin: ' + m[0]);
  }
  for (const m of readme.matchAll(/Node\.js (v\d+\.\d+\.\d+)/g)) {
    if (m[1] !== n.version) problems.push('Node version differs from the pin: ' + m[0]);
  }
  if (!readme.includes(n.signing.windowsSigner)) problems.push('Windows signer missing: ' + n.signing.windowsSigner);
  return problems;
}

function main() {
  const readmePath = fileURLToPath(new URL('../README.md', import.meta.url));
  const pinsPath = fileURLToPath(new URL('../panel/daemon/runtime-pins.json', import.meta.url));
  const pins = JSON.parse(readFileSync(pinsPath, 'utf8'));
  const readme = readFileSync(readmePath, 'utf8');
  if (process.argv.includes('--write')) {
    const next = writeRuntimeSteps(readme, pins);
    if (next !== readme) { writeFileSync(readmePath, next); console.log('README.md runtime steps regenerated'); }
    else console.log('README.md runtime steps already current');
    return;
  }
  const problems = checkReadme(readme, pins);
  if (problems.length) {
    for (const p of problems) console.error('readme-pins: ' + p);
    process.exit(1);
  }
  console.log('README.md runtime steps match runtime-pins.json');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
