#!/usr/bin/env node
// Figma parity audit — Phase A extractor.
// Connects to the grip MCP bridge directly (stdio client) and dumps full node
// trees, tokens, styles, annotations, and PNG/SVG exports to design/refs/.
// Everything lands on disk so no data is sampled or summarized away.
//
// Usage: node design/scripts/figma-extract.mjs [--skip-exports]

import { Client } from '../../panel/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../panel/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFS = join(__dirname, '..', 'refs');
const GRIP = '/Volumes/Origami/Users/spendolas/Library/CloudStorage/Dropbox/Tools/Figma Plugins/Grip/bridge/dist/index.js';
const CALL_TIMEOUT = 180000;
const SKIP_EXPORTS = process.argv.includes('--skip-exports');

// Walk roots are DISCOVERED, not frozen — see discoverRoots(). The page moves
// (new boards/components land as top-level frames); a hardcoded list silently
// drops them and forces eyeballing. We enumerate the "Gaffer" page (173:2) and
// the "Components" section every run, and hard-fail on any unrecognised
// top-level surface so nothing can be added to the design without the audit
// seeing it.
const PAGE = '173:2';
const COMPONENTS_SECTION = '217:3664';
// Explicitly in-scope even though they live inside groups the walker skips.
const EXTRA_ROOTS = [
  { id: '173:292', slug: 'states-board' },
  { id: '427:3058', slug: 'input-area' },
  { id: '428:3200', slug: 'reply-quote' }, // canonical Reply Quote COMPONENT (427:3102 is a stale draft)
  { id: '284:2052', slug: 'panel-template-instance' }, // inside MCP_IGNORE group
];
// Documentation / reference art on the page — real design, but not a panel
// surface to diff against the DOM. Exported as PNG refs, never walked-for-parity.
// Keyed by id so a rename can't smuggle one back into scope.
const NON_SURFACE = new Set([
  '174:843', // MCP_IGNORE group (archive)
  '278:2228', // loose "placeholder" text
  '302:4035', // empty "Text"
  '302:4143', // Markdown exemplar — native (reference)
  '303:12339', // Text Styles — Contact Sheet (reference)
  '384:1634', // Palette swatches (reference)
]);

for (const d of ['json', 'png', 'svg']) mkdirSync(join(REFS, d), { recursive: true });

const manifest = { startedAt: null, walks: [], exports: [], truncatedNodes: [], errors: [] };

function slugify(name) {
  return name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60);
}

function firstText(result) {
  if (!result || !Array.isArray(result.content)) return null;
  for (const c of result.content) if (c.type === 'text') return c.text;
  return null;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args || {} }, undefined, { timeout: CALL_TIMEOUT });
  const text = firstText(result);
  if (result.isError) throw new Error(name + ' failed: ' + String(text).slice(0, 300));
  try { return JSON.parse(text); } catch { return text; }
}

// grip enforces a 120KB MCP read cap; full walks blow past it. export_node with
// a `path` streams the same tree to disk with no token limit — the only way to
// get a zero-truncation walk now. Returns the parsed tree (read back from disk).
async function exportJsonToDisk(client, nodeId, outPath) {
  const r = await client.callTool({
    name: 'export_node',
    arguments: { nodeId, format: 'JSON', path: outPath, depth: -1, maxNodes: 0, includeBoundVariables: true },
  }, undefined, { timeout: CALL_TIMEOUT });
  if (r.isError) throw new Error('export_node JSON failed: ' + String(firstText(r)).slice(0, 200));
  return JSON.parse(readFileSync(outPath, 'utf8'));
}

// Depth-first scan for truncation markers and export candidates.
function scan(node, out, path) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n, i) => scan(n, out, path)); return; }
  const p = path + '/' + (node.name || node.id || '?');
  if (node.truncated === true) out.truncated.push({ id: node.id, path: p });
  if (node.id && node.type) {
    const isComponentish = node.type === 'COMPONENT' || node.type === 'COMPONENT_SET';
    const isStateCell = node.type === 'FRAME' && /^(cell|group)[:\s]/i.test(node.name || '');
    if (isComponentish || isStateCell) {
      out.candidates.push({ id: node.id, name: node.name, type: node.type, path: p });
    }
    if (node.type === 'COMPONENT' && /icon/i.test(node.name || '')) {
      out.icons.push({ id: node.id, name: node.name });
    }
  }
  if (Array.isArray(node.children)) node.children.forEach((c) => scan(c, out, p));
}

function slugForRoot(name, id) {
  const s = slugify(name);
  return s || 'node-' + id.replace(/[:;]/g, '_');
}

// Enumerate the page + Components section into a de-duped root list, and fail
// loudly on any top-level surface we don't already know — that failure is the
// whole point: it forces new design work into the audit instead of letting it
// hide from a frozen list.
async function discoverRoots(client) {
  const roots = [];
  const seen = new Set();
  const add = (id, slug) => { if (!seen.has(id)) { seen.add(id); roots.push({ id, slug }); } };

  // Components section → each child is a root (Atoms/Molecules/Organisms/Template…).
  const section = await call(client, 'get_node', { nodeId: COMPONENTS_SECTION, depth: 1 });
  for (const c of section.children || []) add(c.id, slugForRoot(c.name, c.id));

  for (const r of EXTRA_ROOTS) add(r.id, r.slug);

  // Sweep the page's top level for anything unaccounted-for.
  const page = await call(client, 'get_node', { nodeId: PAGE, depth: 1 });
  const known = new Set([COMPONENTS_SECTION, ...seen, ...NON_SURFACE]);
  const surprises = [];
  for (const c of page.children || []) {
    if (known.has(c.id)) continue;
    // Only structural nodes are candidate surfaces; loose text/vectors are noise.
    if (['FRAME', 'SECTION', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(c.type)) {
      surprises.push({ id: c.id, name: c.name, type: c.type });
    }
  }
  if (surprises.length) {
    manifest.errors.push({ discovery: 'unrecognised top-level surfaces', surprises });
    throw new Error(
      'Unrecognised top-level surface(s) on page ' + PAGE + ':\n' +
      surprises.map((s) => `  ${s.id}  ${s.type}  "${s.name}"`).join('\n') +
      '\nAdd each to EXTRA_ROOTS (a panel surface to diff) or NON_SURFACE (reference art) in figma-extract.mjs, then re-run.'
    );
  }
  console.log('discovered roots:', roots.map((r) => r.slug + '(' + r.id + ')').join(', '));
  return roots;
}

async function main() {
  manifest.startedAt = new Date().toISOString();
  // Pass full env: the SDK sanitizes it by default, dropping TMPDIR — which
  // the grip shim needs to find the leader daemon's IPC socket.
  const transport = new StdioClientTransport({ command: 'node', args: [GRIP], env: { ...process.env } });
  const client = new Client({ name: 'gaffer-audit', version: '1.0.0' });
  await client.connect(transport);

  // Pin the Plugin Dev file — grip routes fresh sessions to the focused
  // Figma tab, which may be a different file.
  await call(client, 'set_active_file', { target: 'tc5ASMCGihXdPgtaMxub8t' });

  const ROOTS = await discoverRoots(client);
  manifest.roots = ROOTS;

  // Simple globals
  // (get_annotations now requires a nodeId and the file carries none;
  // get_measurements was removed from grip — both dropped as dead globals.)
  for (const [tool, file] of [
    ['get_variables', 'variables.json'],
    ['get_styles', 'styles.json'],
    ['get_document', 'document.json'],
  ]) {
    try {
      const data = await call(client, tool, {});
      writeFileSync(join(REFS, 'json', file), JSON.stringify(data, null, 2));
      console.log('saved', file);
    } catch (e) {
      manifest.errors.push({ tool, error: e.message });
      console.error('ERR', tool, e.message.slice(0, 200));
    }
  }

  // Full walks
  const found = { truncated: [], candidates: [], icons: [] };
  for (const root of ROOTS) {
    try {
      const data = await exportJsonToDisk(client, root.id, join(REFS, 'json', 'walk-' + root.slug + '.json'));
      const before = found.candidates.length;
      scan(data, found, root.slug);
      manifest.walks.push({ root: root.id, slug: root.slug, candidates: found.candidates.length - before });
      console.log('walked', root.slug, '(candidates so far: ' + found.candidates.length + ')');
    } catch (e) {
      manifest.errors.push({ root: root.id, error: e.message });
      console.error('ERR walk', root.slug, e.message.slice(0, 200));
    }
  }
  manifest.truncatedNodes = found.truncated;

  // Dedupe export candidates by id; also export the six walk roots themselves.
  const seen = new Set();
  const targets = [];
  for (const root of ROOTS) { seen.add(root.id); targets.push({ id: root.id, name: root.slug, type: 'ROOT' }); }
  for (const c of found.candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    targets.push(c);
  }

  if (!SKIP_EXPORTS) {
    for (const t of targets) {
      const base = slugify(t.name) + '.' + t.id.replace(/[:;]/g, '_');
      try {
        // grip writes PNG/JPG/PDF bytes to `path` and returns metadata, not base64.
        const outPath = join(REFS, 'png', base + '.png');
        const res = await call(client, 'export_node', {
          nodeId: t.id, format: 'PNG', constraint: { type: 'SCALE', value: 2 }, path: outPath,
        });
        if (!res || !res.bytes) throw new Error('export wrote no bytes: ' + JSON.stringify(res).slice(0, 120));
        manifest.exports.push({ id: t.id, name: t.name, file: 'png/' + base + '.png', bytes: res.bytes });
      } catch (e) {
        manifest.errors.push({ export: t.id, name: t.name, error: e.message.slice(0, 200) });
        console.error('ERR export', t.name, e.message.slice(0, 120));
      }
    }
    for (const icon of found.icons) {
      const base = slugify(icon.name) + '.' + icon.id.replace(/[:;]/g, '_');
      try {
        const svg = await call(client, 'export_node', { nodeId: icon.id, format: 'SVG' });
        const text = typeof svg === 'string' ? svg : (svg.data || svg.svg || '');
        const body = text.trim().startsWith('<') ? text : Buffer.from(text, 'base64').toString('utf8');
        writeFileSync(join(REFS, 'svg', base + '.svg'), body);
        manifest.exports.push({ id: icon.id, name: icon.name, file: 'svg/' + base + '.svg' });
      } catch (e) {
        manifest.errors.push({ export: icon.id, name: icon.name, error: e.message.slice(0, 200) });
      }
    }
  }

  writeFileSync(join(REFS, 'json', 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({
    walks: manifest.walks.length,
    exports: manifest.exports.length,
    truncated: manifest.truncatedNodes.length,
    errors: manifest.errors.length,
  }));
  await client.close();
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
