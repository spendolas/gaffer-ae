#!/usr/bin/env node
// Figma parity audit — Phase A extractor.
// Connects to the grip MCP bridge directly (stdio client) and dumps full node
// trees, tokens, styles, annotations, and PNG/SVG exports to design/refs/.
// Everything lands on disk so no data is sampled or summarized away.
//
// Usage: node design/scripts/figma-extract.mjs [--skip-exports]

import { Client } from '../../panel/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../panel/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFS = join(__dirname, '..', 'refs');
const GRIP = '/Volumes/Origami/Users/spendolas/Library/CloudStorage/Dropbox/Tools/Figma Plugins/Grip/bridge/dist/index.js';
const CALL_TIMEOUT = 180000;
const SKIP_EXPORTS = process.argv.includes('--skip-exports');

// In-scope walk roots (page "Gaffer" 173:2). MCP_IGNORE (174:843) excluded.
const ROOTS = [
  { id: '187:1205', slug: 'atoms' },
  { id: '185:1091', slug: 'molecules' },
  { id: '188:1206', slug: 'organisms' },
  { id: '188:1207', slug: 'template' },
  { id: '173:292', slug: 'states-board' },
  { id: '284:2052', slug: 'panel-template-instance' },
];

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

async function main() {
  manifest.startedAt = new Date().toISOString();
  // Pass full env: the SDK sanitizes it by default, dropping TMPDIR — which
  // the grip shim needs to find the leader daemon's IPC socket.
  const transport = new StdioClientTransport({ command: 'node', args: [GRIP], env: { ...process.env } });
  const client = new Client({ name: 'gaffer-audit', version: '1.0.0' });
  await client.connect(transport);

  // Simple globals
  for (const [tool, file] of [
    ['get_variables', 'variables.json'],
    ['get_styles', 'styles.json'],
    ['get_annotations', 'annotations.json'],
    ['get_measurements', 'measurements.json'],
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
      const data = await call(client, 'get_node', {
        nodeId: root.id,
        depth: -1,
        maxNodes: 0,
        includeBoundVariables: true,
      });
      writeFileSync(join(REFS, 'json', 'walk-' + root.slug + '.json'), JSON.stringify(data, null, 2));
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
        const png = await call(client, 'export_node', {
          nodeId: t.id, format: 'PNG', constraint: { type: 'SCALE', value: 2 },
        });
        const b64 = typeof png === 'string' ? png : (png.data || png.base64 || png.bytes);
        if (!b64 || typeof b64 !== 'string') throw new Error('no base64 in export result: ' + JSON.stringify(png).slice(0, 120));
        writeFileSync(join(REFS, 'png', base + '.png'), Buffer.from(b64, 'base64'));
        manifest.exports.push({ id: t.id, name: t.name, file: 'png/' + base + '.png' });
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
