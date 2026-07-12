#!/usr/bin/env node
// Figma parity audit — Phase B static extraction.
// Parses panel/index.html <style> into rule objects and scans panel/main.js
// for runtime style assignments + color/size literals, with line numbers.
// Output: design/refs/panel/css-inventory.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUT = join(__dirname, '..', 'refs', 'panel');
mkdirSync(OUT, { recursive: true });

const html = readFileSync(join(ROOT, 'panel', 'index.html'), 'utf8');
const js = readFileSync(join(ROOT, 'panel', 'main.js'), 'utf8');

// ── CSS rules from <style> ──
const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
const css = styleMatch ? styleMatch[1] : '';
const cssStartLine = html.slice(0, html.indexOf('<style>')).split('\n').length;

const rules = [];
// strip comments, then match selector { body } including simple @media wrap
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = ruleRe.exec(stripped))) {
  const selector = m[1].trim().replace(/\s+/g, ' ');
  if (selector.startsWith('@')) continue; // @keyframes headers etc. handled below
  const body = m[2].trim();
  if (!body) continue;
  const line = cssStartLine + stripped.slice(0, m.index).split('\n').length - 1;
  const props = {};
  for (const decl of body.split(';')) {
    const i = decl.indexOf(':');
    if (i === -1) continue;
    props[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  rules.push({ selector, line, props });
}

// @keyframes blocks (nested braces defeat the flat regex above)
const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((k) => k[1]);

// ── Inline style styling in main.js ──
const jsAssignments = [];
const jsLines = js.split('\n');
jsLines.forEach((lineText, i) => {
  const assignRe = /\.style\.([a-zA-Z]+)\s*=\s*(['"`])(.*?)\2/g;
  let a;
  while ((a = assignRe.exec(lineText))) {
    jsAssignments.push({ line: i + 1, prop: a[1], value: a[3], src: lineText.trim().slice(0, 120) });
  }
  const cssTextRe = /\.cssText\s*=\s*(['"`])(.*?)\1/g;
  while ((a = cssTextRe.exec(lineText))) {
    jsAssignments.push({ line: i + 1, prop: 'cssText', value: a[2], src: lineText.trim().slice(0, 120) });
  }
});

// ── Color + px literal census across both files ──
function census(text, file) {
  const out = {};
  const colorRe = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
  let c;
  const lines = text.split('\n');
  lines.forEach((lineText, i) => {
    while ((c = colorRe.exec(lineText))) {
      const key = c[0].toLowerCase();
      (out[key] = out[key] || []).push(file + ':' + (i + 1));
    }
  });
  return out;
}

const inventory = {
  generatedAt: new Date().toISOString(),
  cssRules: rules,
  keyframes,
  jsStyleAssignments: jsAssignments,
  colorCensus: {
    'index.html': census(html, 'panel/index.html'),
    'main.js': census(js, 'panel/main.js'),
  },
};

writeFileSync(join(OUT, 'css-inventory.json'), JSON.stringify(inventory, null, 2));

const colorCount = new Set([
  ...Object.keys(inventory.colorCensus['index.html']),
  ...Object.keys(inventory.colorCensus['main.js']),
]).size;
console.log(JSON.stringify({
  cssRules: rules.length,
  keyframes: keyframes.length,
  jsStyleAssignments: jsAssignments.length,
  distinctColorLiterals: colorCount,
}));
