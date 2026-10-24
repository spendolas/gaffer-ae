// Builds site/install.md, the page the install prompt points agents at
// ("Install Gaffer by following https://gafferae.com/install.md"), from the
// "Install Instructions for Claude" section of README.md, so the two can never drift.
//   node scripts/site/build-install-md.mjs          (write site/install.md)
//   node scripts/site/build-install-md.mjs --check  (exit 1 when it is out of date)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const START = '## Install Instructions for Claude';
const END = '</details>';

const INTRO = `# Install Gaffer

<!-- Generated from README.md by scripts/site/build-install-md.mjs. Do not edit by hand. -->

Gaffer is an After Effects automation agent: a panel inside After Effects where Claude controls the
project by writing ExtendScript through MCP tools. Source and releases: https://github.com/spendolas/gaffer-ae

This page is the install procedure, written for Claude to carry out for a user who asked it to
"Install Gaffer by following https://gafferae.com/install.md". The Gaffer package is always the
latest GitHub release. Gaffer brings its own Node.js runtime: the steps below download the official
runtime from nodejs.org into Gaffer's own folder and verify its checksum and code signature, so
nothing has to be installed on the computer first.

## Requirements

- After Effects 2022 or later (macOS or Windows)
- Claude: either the [Claude desktop app](https://claude.com/download) (it bundles Claude Code, no separate install needed) or the standalone [Claude Code](https://claude.ai/code) CLI. On Windows use the desktop app or the native installer, not \`npm install -g\` (the daemon can't launch npm's script shims)
- No git required

## First: confirm you are running on the user's own computer

Gaffer installs into After Effects on the user's own computer, so these steps only work when you run directly on that computer, with its real file system. They do not work from a sandbox, a virtual machine or a cloud session: for example Claude Cowork (it runs commands in a Linux virtual machine), Claude Code on the web, or a container.

Check and report it before anything else:

- macOS: \`uname -s\` prints \`Darwin\`.
- Windows (PowerShell): \`$env:OS\` prints \`Windows_NT\`.

If it prints \`Linux\` or anything else, or you know you are in a sandbox, STOP. Do not install anything and do not try to work around it. Tell the user: "I'm running in a sandbox, not on your computer, so I can't install Gaffer from here. Open Claude Code on your Mac or PC (the Code tab in the Claude desktop app, or \`claude\` in a terminal) and give it the same prompt."

`;

// The section between START and the closing </details>, with the <details>/<summary> wrapper
// removed and its ### headings promoted to ##.
export function extractInstall(readme) {
  const start = readme.indexOf(START);
  if (start === -1) throw new Error(`README.md has no "${START}" section`);
  const end = readme.indexOf(END, start);
  if (end === -1) throw new Error('README.md install section has no closing </details>');
  const body = readme.slice(start + START.length, end)
    .replace(/<details>\s*\n?/, '')
    .replace(/<summary>[\s\S]*?<\/summary>\s*\n?/, '')
    .replace(/^### /gm, '## ')
    .trim();
  return `${body}\n`;
}

export function renderInstallMd(readme) {
  return INTRO + extractInstall(readme);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readmePath = join(root, 'README.md');
const outPath = join(root, 'site', 'install.md');

function main() {
  const wanted = renderInstallMd(readFileSync(readmePath, 'utf8'));
  if (process.argv.includes('--check')) {
    if (!existsSync(outPath) || readFileSync(outPath, 'utf8') !== wanted) {
      console.error('site/install.md is out of date; run: node scripts/site/build-install-md.mjs');
      process.exit(1);
    }
    console.log('site/install.md is up to date');
    return;
  }
  writeFileSync(outPath, wanted);
  console.log(`wrote ${outPath} (${wanted.length} bytes)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
