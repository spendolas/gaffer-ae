// fetch-runtime.ps1 (Windows runtime provisioning, spec section 3).
//
// Two layers:
//  1. Static checks that run everywhere: encoding (ASCII + UTF-8 BOM, which
//     PowerShell 5.1 needs), the contract strings, the commands the spec
//     names, test seams gated on GAFFER_FETCH_TEST, and a scan for syntax
//     that PowerShell 5.1 does not have.
//  2. Behaviour, Windows only (skipped elsewhere): drives the script with
//     powershell.exe against fake archives served over file:// URLs. The fake
//     "node.exe" is a copy of the node.exe running this test, zipped under the
//     pinned member path, with pins written to match it.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync,
  copyFileSync, readdirSync, statSync, truncateSync, renameSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, '..', 'fetch-runtime.ps1');
const raw = readFileSync(scriptPath);
const text = raw.subarray(3).toString('utf8');
// Code lines only: drop full-line comments so prose cannot satisfy or trip
// the syntax checks.
const codeLines = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
const code = codeLines.join('\n');

describe('fetch-runtime.ps1 static checks', () => {
  test('starts with a UTF-8 BOM and is ASCII-only', () => {
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'missing UTF-8 BOM');
    const bad = [];
    for (let i = 3; i < raw.length; i++) if (raw[i] > 127) bad.push(i);
    assert.equal(bad.length, 0, 'non-ASCII bytes at ' + bad.slice(0, 5).join(','));
  });

  test('prints the exact contract lines and exits 0 / 1', () => {
    for (const s of ['Write-Output "runtime:current"', 'Write-Output "runtime:installed $version $platform"',
      'Write-Output "err:runtime"', 'exit 0', 'exit 1']) {
      assert.ok(code.includes(s), 'missing ' + s);
    }
    assert.ok(code.includes('official download failed, using the mirror'), 'missing the mirror log line');
  });

  test('takes -Into and -StageOnly', () => {
    assert.match(code, /param\(\s*\[string\]\s*\$Into\s*=\s*"",\s*\[switch\]\s*\$StageOnly\s*\)/);
  });

  test('uses the commands the spec names', () => {
    for (const s of ['System32\\curl.exe', '"--fail"', '"--proto"', '"=https"', '"--location"',
      '"--connect-timeout", "20"', '"--max-time", "600"', '"--retry", "3"', '"--retry-delay", "2"',
      'Get-FileHash -LiteralPath $path -Algorithm SHA256', 'System32\\tar.exe', '"-xf"',
      '[System.IO.Compression.ZipFile]::OpenRead', '$zip.GetEntry($member)',
      'Get-AuthenticodeSignature -LiteralPath $newExe', '$sig.Status -ne "Valid"',
      'signing.windowsSigner', '$newExe --version', '$ProgressPreference = "SilentlyContinue"',
      'runtime.new', 'runtime.old', 'gaffer-runtime-', '"VERSION"', '"VERIFIED"']) {
      assert.ok(code.includes(s), 'missing ' + s);
    }
  });

  test('never uses Invoke-WebRequest, Invoke-RestMethod or a transcript', () => {
    for (const s of ['Invoke-WebRequest', 'Invoke-RestMethod', 'Start-Transcript', 'Start-BitsTransfer', 'Expand-Archive']) {
      assert.ok(!code.includes(s), 'must not use ' + s);
    }
  });

  test('test seams are honoured only in test mode', () => {
    const seams = ['GAFFER_FETCH_BASE_OFFICIAL', 'GAFFER_FETCH_BASE_MIRROR', 'GAFFER_FETCH_PINS',
      'GAFFER_FETCH_SKIP_CODESIGN', 'GAFFER_FETCH_PLATFORM', 'GAFFER_FETCH_NO_TAR', 'GAFFER_FETCH_NO_CURL'];
    for (const seam of seams) assert.ok(text.includes('#   ' + seam), seam + ' is not documented in the header');
    assert.ok(code.includes('$testMode = ($env:GAFFER_FETCH_TEST -eq "1")'));
    for (const seam of seams) {
      const uses = codeLines.filter((l) => l.includes('$env:' + seam));
      assert.ok(uses.length > 0, seam + ' is not read');
      // Each use sits on a line gated by $testMode, or inside the
      // `if ($testMode) {` block that overrides the base URLs.
      for (const l of uses) {
        const idx = codeLines.indexOf(l);
        const gated = l.includes('$testMode') || codeLines[idx - 1].includes('if ($testMode) {')
          || codeLines[idx - 2].includes('if ($testMode) {');
        assert.ok(gated, seam + ' read outside test mode: ' + l.trim());
      }
    }
    assert.match(code, /\$proto = "=https"\s*\n\s*if \(\$testMode\) \{ \$proto = "=https,http,file" \}/);
  });

  test('uses -LiteralPath for every path cmdlet (paths may contain brackets)', () => {
    const cmdlets = ['Test-Path', 'Remove-Item', 'Get-Item', 'Move-Item', 'Get-FileHash', 'Get-ChildItem',
      'Get-AuthenticodeSignature', 'Copy-Item', 'Rename-Item', 'Set-Content', 'Get-Content'];
    for (const l of codeLines) {
      for (const c of cmdlets) {
        if (new RegExp('\\b' + c + '\\b').test(l)) {
          assert.ok(l.includes('-LiteralPath'), c + ' without -LiteralPath: ' + l.trim());
        }
      }
    }
  });

  test('no PowerShell 7-only syntax', () => {
    const bad = [
      [/&&|\|\|/, 'pipeline chain operator'],
      [/\?\?/, 'null-coalescing operator'],
      [/\s\?\s[^\n]*\s:\s/, 'ternary operator'],
      [/-AsHashtable/, 'ConvertFrom-Json -AsHashtable'],
      [/ConvertFrom-Json\s+-Depth/, 'ConvertFrom-Json -Depth'],
      [/-Parallel/, 'ForEach-Object -Parallel'],
      [/utf8NoBOM/i, '-Encoding utf8NoBOM'],
      [/\$PSStyle|Test-Json|-AdditionalChildPath|Get-Error\b/, 'PS 7 cmdlet or variable'],
      [/\?\.|\?\[/, 'null-conditional member access'],
    ];
    for (const [re, what] of bad) {
      const hit = codeLines.find((l) => re.test(l.replace(/"[^"]*"|'[^']*'/g, '""')));
      assert.ok(!hit, what + ': ' + (hit || '').trim());
    }
  });

  test('every native call goes through Invoke-Native or a local Continue scope', () => {
    // Under $ErrorActionPreference = "Stop", PS 5.1 turns native stderr
    // into a terminating error when it is redirected.
    assert.match(code, /function Invoke-Native[\s\S]*?\$ErrorActionPreference = "Continue"/);
    assert.ok(code.includes('Invoke-Native $tmpDir $curl $curlArgs'));
    assert.ok(code.includes('"-o", $archive, $url'), 'curl must write by relative name inside the temp folder');
    assert.ok(code.includes('Invoke-Native $newDir $tar @("-xf", $archivePath, $member)'));
    assert.match(code, /\$ErrorActionPreference = "Continue"\s*\n\s*\$smokeOut = & \$newExe --version 2>&1/);
  });

  test('cleanup lives in a finally block around the whole run', () => {
    assert.match(code, /\} finally \{[^}]*?Remove-Tree \$tmpDir[\s\S]*?if \(-not \$script:keepNew\) \{ Remove-Tree \$newDir \}\s*\n\}\s*$/);
    assert.match(code, /if \(\$StageOnly\) \{\s*\n\s*\$script:keepNew = \$true/);
    assert.match(code, /\[System\.IO\.Directory\]::Move\(\$newDir, \$runtimeDir\)[\s\S]*?\$script:keepNew = \$true/);
    // Exit-Fail itself no longer deletes anything: the finally block does.
    const exitFail = code.slice(code.indexOf('function Exit-Fail'), code.indexOf('function Get-StampSize'));
    assert.ok(!exitFail.includes('Remove-Tree'), 'Exit-Fail must leave cleanup to finally');
  });

  test('runtime.old is restored only after its size check and deleted only while runtime exists', () => {
    assert.ok(code.includes('$oldStamp = Get-StampSize $oldDir'));
    assert.match(code, /\$oldOk = \(\[string\] \(Get-Item -LiteralPath \$oldExe\)\.Length\) -eq \$oldStamp/);
    assert.match(code, /if \(\$oldOk\) \{\s*\n\s*try \{\s*\n\s*\[System\.IO\.Directory\]::Move\(\$oldDir, \$runtimeDir\)/);
    // Every Remove-Tree $oldDir is guarded by a runtime check on its line or
    // sits in the swap block after the runtime check.
    assert.ok(code.includes('if ((Test-Path -LiteralPath $oldDir) -and (Test-Path -LiteralPath $runtimeDir)) {\n        Remove-Tree $oldDir'));
  });

  test('system proxy fallback after curl, like update.ps1', () => {
    for (const s of ['function Get-ViaSystemProxy', '[System.Net.SecurityProtocolType]::Tls12',
      '[System.Net.WebRequest]::DefaultWebProxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials',
      '$req.Timeout = 20000', '$req -is [System.Net.HttpWebRequest]', 'download exceeded its 600 s budget',
      'Get-ViaSystemProxy $url $archivePath $testMode', '$skipCurl = ($testMode -and $env:GAFFER_FETCH_NO_CURL -eq "1")',
      'refusing a non-https URL', 'redirected to a non-https URL']) {
      assert.ok(code.includes(s), 'missing ' + s);
    }
    // The fallback runs before the hash check of the same source.
    assert.ok(code.indexOf('Get-ViaSystemProxy $url') < code.indexOf('$gotSha = Get-Sha256 $archivePath'));
  });

  test('no Move-Item -Destination (wildcards in paths)', () => {
    assert.ok(!/Move-Item/.test(code));
    assert.ok(code.includes('[System.IO.File]::Move($tarOut, $newExe)'));
  });

  test('the placeholder binary hash skips only the hash check', () => {
    assert.ok(code.includes("$binarySha -notmatch '^[0-9a-f]{64}$'"));
  });

  test('parses under pwsh when it is installed', (t) => {
    const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', windowsHide: true });
    if (probe.error || probe.status !== 0) { t.skip('pwsh not installed; the Windows VM run is the parse check'); return; }
    const cmd = "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('" +
      scriptPath.replace(/'/g, "''") + "', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.ToString() }; exit 1 }";
    const r = spawnSync('pwsh', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

// ---------------------------------------------------------------------------
// Behaviour on Windows
// ---------------------------------------------------------------------------
const onWindows = process.platform === 'win32';
const skipReason = onWindows ? false : 'Windows only: fetch-runtime.ps1 needs powershell.exe, curl.exe, tar.exe and Authenticode';

describe('fetch-runtime.ps1 on Windows', { skip: skipReason }, () => {
  const version = process.version;
  const plat = 'win-x64';
  const top = 'node-' + version + '-win-x64';
  const member = top + '/node.exe';
  const archiveName = top + '.zip';
  let root, srcDir, goodZip, binBytes, binSha, archiveSha;

  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

  before(() => {
    // The fixture and the served archives live under an ASCII path (curl
    // decodes file:// URLs in the ANSI code page); the daemon dir and TEMP
    // of every case carry spaces and an accent.
    root = mkdtempSync(join(tmpdir(), 'gaffer-fetch-ps1-'));
    srcDir = join(root, 'src');
    mkdirSync(join(srcDir, top), { recursive: true });
    copyFileSync(process.execPath, join(srcDir, top, 'node.exe'));
    binBytes = statSync(process.execPath).size;
    binSha = sha(process.execPath);
    goodZip = join(root, 'good.zip');
    const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const r = spawnSync(tar, ['-a', '-cf', goodZip, '-C', srcDir, member], { windowsHide: true, encoding: 'utf8' });
    assert.equal(r.status, 0, 'could not build the fixture zip: ' + r.stderr);
    archiveSha = sha(goodZip);
  });

  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  let caseNo = 0;
  // Builds one case: its own daemon dir, temp dir, pins and source dirs.
  function setup({ official = 'good', mirror = 'good', pins = {} } = {}) {
    const dir = join(root, 'case ' + (++caseNo));
    const into = join(dir, 'ext dir \u00e9', 'daemon');
    const temp = join(dir, 'temp \u00e9');
    mkdirSync(into, { recursive: true });
    mkdirSync(temp, { recursive: true });
    const serve = (kind, name) => {
      const d = join(dir, name);
      mkdirSync(d, { recursive: true });
      const out = join(d, archiveName);
      if (kind === 'good') copyFileSync(goodZip, out);
      else if (kind === 'badhash') writeFileSync(out, Buffer.alloc(4096, 7));
      else if (kind === 'truncated') { copyFileSync(goodZip, out); truncateSync(out, Math.floor(statSync(goodZip).size / 2)); }
      else if (kind === 'html') writeFileSync(out, '<!DOCTYPE html><html><body>404 Not Found</body></html>');
      // 'missing': no file at all, curl fails
      return pathToFileURL(d).href + '/';
    };
    const pinsObj = {
      node: {
        version, codename: 'Test',
        official: 'https://example.invalid/official/', mirror: 'https://example.invalid/mirror/',
        platforms: {
          [plat]: { archive: archiveName, archiveSha256: archiveSha, member, binaryBytes: binBytes, binarySha256: binSha, ...pins },
        },
        signing: { darwinTeamId: 'HX7739G8FX', windowsSigner: 'OpenJS Foundation' },
      },
    };
    const pinsPath = join(dir, 'pins.json');
    writeFileSync(pinsPath, JSON.stringify(pinsObj, null, 2));
    const env = {
      ...process.env, TEMP: temp, TMP: temp,
      GAFFER_FETCH_TEST: '1', GAFFER_FETCH_PINS: pinsPath, GAFFER_FETCH_SKIP_CODESIGN: '1',
      GAFFER_FETCH_PLATFORM: plat,
      GAFFER_FETCH_BASE_OFFICIAL: serve(official, 'official'),
      GAFFER_FETCH_BASE_MIRROR: serve(mirror, 'mirror'),
    };
    return { dir, into, temp, env };
  }

  function run(c, args = [], extraEnv = {}) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath, '-Into', c.into, ...args],
    { env: { ...c.env, ...extraEnv }, encoding: 'utf8', windowsHide: true, timeout: 240000 });
    const lines = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return { status: r.status, out: r.stdout + r.stderr, last: lines[lines.length - 1] };
  }

  const tree = (d) => (existsSync(d) ? readdirSync(d, { recursive: true }).map(String).sort() : []);

  function assertInstalled(c) {
    const rt = join(c.into, 'runtime');
    assert.deepEqual(readdirSync(rt).sort(), ['VERIFIED', 'VERSION', 'node.exe']);
    assert.equal(sha(join(rt, 'node.exe')), binSha);
    assert.equal(readFileSync(join(rt, 'VERSION'), 'utf8'), version + ' ' + plat + '\n');
    assert.equal(readFileSync(join(rt, 'VERIFIED'), 'utf8'), binBytes + ' ' + binSha + '\n');
    assert.ok(!existsSync(join(c.into, 'runtime.new')), 'runtime.new left behind');
    assert.ok(!existsSync(join(c.into, 'runtime.old')), 'runtime.old left behind');
    assert.deepEqual(tree(c.temp), [], 'temp folder not cleaned');
  }

  test('good path installs, stamps and cleans up', () => {
    const c = setup();
    const r = run(c);
    assert.equal(r.last, 'runtime:installed ' + version + ' ' + plat, r.out);
    assert.equal(r.status, 0, r.out);
    assertInstalled(c);
    // Nothing written anywhere else under the case folder.
    assert.deepEqual(readdirSync(join(c.dir, 'ext dir \u00e9')), ['daemon']);
    assert.deepEqual(readdirSync(c.dir).sort(), ['ext dir \u00e9', 'mirror', 'official', 'pins.json', 'temp \u00e9']);
    assert.deepEqual(readdirSync(c.into), ['runtime']);
  });

  test('skip when current: runtime:current and the binary is not touched', () => {
    const c = setup();
    assert.equal(run(c).last, 'runtime:installed ' + version + ' ' + plat);
    const exe = join(c.into, 'runtime', 'node.exe');
    const before = statSync(exe).mtimeMs;
    const r = run(c, [], { GAFFER_FETCH_BASE_OFFICIAL: 'file:///nonexistent/', GAFFER_FETCH_BASE_MIRROR: 'file:///nonexistent/' });
    assert.equal(r.last, 'runtime:current', r.out);
    assert.equal(r.status, 0);
    assert.equal(statSync(exe).mtimeMs, before);
    assert.deepEqual(tree(c.temp), []);
  });

  test('a VERIFIED size mismatch re-provisions', () => {
    const c = setup();
    run(c);
    writeFileSync(join(c.into, 'runtime', 'VERIFIED'), '123 abc\n');
    const r = run(c);
    assert.equal(r.last, 'runtime:installed ' + version + ' ' + plat, r.out);
    assertInstalled(c);
  });

  test('wrong official hash, mirror succeeds', () => {
    const c = setup({ official: 'badhash' });
    const r = run(c);
    assert.match(r.out, /runtime: official download failed, using the mirror/);
    assert.equal(r.last, 'runtime:installed ' + version + ' ' + plat, r.out);
    assertInstalled(c);
  });

  test('official download fails (no file), mirror succeeds', () => {
    const c = setup({ official: 'missing' });
    const r = run(c);
    assert.match(r.out, /runtime: official download failed, using the mirror/);
    assert.equal(r.last, 'runtime:installed ' + version + ' ' + plat, r.out);
  });

  for (const kind of ['badhash', 'truncated', 'html', 'missing']) {
    test('both sources ' + kind + ': err:runtime and runtime/ untouched', () => {
      const c = setup({ official: kind, mirror: kind });
      const rt = join(c.into, 'runtime');
      mkdirSync(rt);
      writeFileSync(join(rt, 'node.exe'), 'old');
      writeFileSync(join(rt, 'VERSION'), 'v0.0.1 win-x64\n');
      const r = run(c);
      assert.equal(r.last, 'err:runtime', r.out);
      assert.equal(r.status, 1);
      assert.match(r.out, /runtime: ERROR: /);
      assert.equal(readFileSync(join(rt, 'node.exe'), 'utf8'), 'old');
      assert.deepEqual(readdirSync(c.into), ['runtime']);
      assert.deepEqual(tree(c.temp), []);
    });
  }

  test('-StageOnly leaves a stamped runtime.new and does not swap', () => {
    const c = setup();
    const rt = join(c.into, 'runtime');
    mkdirSync(rt);
    writeFileSync(join(rt, 'node.exe'), 'old');
    const r = run(c, ['-StageOnly']);
    assert.equal(r.last, 'runtime:installed ' + version + ' ' + plat, r.out);
    assert.equal(readFileSync(join(rt, 'node.exe'), 'utf8'), 'old');
    const nw = join(c.into, 'runtime.new');
    assert.deepEqual(readdirSync(nw).sort(), ['VERIFIED', 'VERSION', 'node.exe']);
    assert.equal(sha(join(nw, 'node.exe')), binSha);
    assert.deepEqual(tree(c.temp), []);
  });

  test('the .NET zip fallback extracts the same binary', () => {
    const c = setup();
    const r = run(c, [], { GAFFER_FETCH_NO_TAR: '1' });
    assert.match(r.out, /with the \.NET zip reader/);
    assert.equal(r.last, 'runtime:installed ' + version + ' ' + plat, r.out);
    assertInstalled(c);
  });

  test('a leftover runtime.old is removed; a lone runtime.old is restored', () => {
    const c = setup();
    run(c);
    mkdirSync(join(c.into, 'runtime.old'));
    writeFileSync(join(c.into, 'runtime.old', 'node.exe'), 'stale');
    let r = run(c);
    assert.equal(r.last, 'runtime:current', r.out);
    assert.ok(!existsSync(join(c.into, 'runtime.old')));
    // An updater killed between the renames: runtime.old, no runtime.
    renameSync(join(c.into, 'runtime'), join(c.into, 'runtime.old'));
    r = run(c);
    assert.match(r.out, /restored runtime from runtime\.old/);
    assert.equal(r.last, 'runtime:current', r.out);
  });

  test('runtime.old failing its size check is neither restored nor deleted', () => {
    const c = setup({ official: 'missing', mirror: 'missing' });
    const old = join(c.into, 'runtime.old');
    mkdirSync(old);
    writeFileSync(join(old, 'node.exe'), 'truncated');
    writeFileSync(join(old, 'VERIFIED'), '999 abc\n');
    const r = run(c);
    assert.match(r.out, /runtime\.old does not pass its size check, leaving it in place/);
    assert.equal(r.last, 'err:runtime', r.out);
    assert.ok(!existsSync(join(c.into, 'runtime')));
    assert.equal(readFileSync(join(old, 'node.exe'), 'utf8'), 'truncated');
    assert.equal(readFileSync(join(old, 'VERIFIED'), 'utf8'), '999 abc\n');
  });

  test('curl failing falls back to the system proxy path (FileWebRequest in test mode)', () => {
    const c = setup();
    const r = run(c, [], { GAFFER_FETCH_NO_CURL: '1' });
    assert.match(r.out, /trying the system proxy path/);
    assert.match(r.out, /downloaded through the system proxy path/);
    assert.equal(r.last, 'runtime:installed ' + version + ' ' + plat, r.out);
    assertInstalled(c);
  });

  test('curl and the system proxy path both failing: mirror, then err:runtime', () => {
    const c = setup({ official: 'missing', mirror: 'missing' });
    const r = run(c, [], { GAFFER_FETCH_NO_CURL: '1' });
    assert.match(r.out, /runtime: official download failed, using the mirror/);
    assert.equal(r.last, 'err:runtime', r.out);
    assert.deepEqual(tree(c.temp), []);
    assert.deepEqual(readdirSync(c.into), []);
  });

  test('binary size or hash mismatch fails; the placeholder skips only the hash', () => {
    let c = setup({ pins: { binaryBytes: binBytes + 1 } });
    let r = run(c);
    assert.equal(r.last, 'err:runtime', r.out);
    assert.ok(!existsSync(join(c.into, 'runtime.new')));
    c = setup({ pins: { binarySha256: '0'.repeat(64) } });
    r = run(c);
    assert.equal(r.last, 'err:runtime', r.out);
    c = setup({ pins: { binarySha256: 'PENDING-FIRST-ACCEPTANCE-RUN' } });
    r = run(c);
    assert.match(r.out, /binary SHA-256 not pinned yet/);
    assert.equal(r.last, 'runtime:installed ' + version + ' ' + plat, r.out);
  });

  test('the signature check rejects an unsigned binary when not skipped', () => {
    // The fixture binary may well be OpenJS-signed (official node.exe), so
    // flip the expected signer instead of relying on it being unsigned.
    const c = setup();
    const pins = JSON.parse(readFileSync(c.env.GAFFER_FETCH_PINS, 'utf8'));
    pins.node.signing.windowsSigner = 'Nobody Signs This Inc';
    writeFileSync(c.env.GAFFER_FETCH_PINS, JSON.stringify(pins));
    const r = run(c, [], { GAFFER_FETCH_SKIP_CODESIGN: '' });
    assert.equal(r.last, 'err:runtime', r.out);
    assert.match(r.out, /signature could not be verified/);
  });

  test('an unknown platform key fails cleanly', () => {
    const c = setup();
    const r = run(c, [], { GAFFER_FETCH_PLATFORM: 'win-arm64' });
    assert.equal(r.last, 'err:runtime', r.out);
    assert.equal(r.status, 1);
  });
});

