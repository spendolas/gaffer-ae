import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { connectorPromptAdditions } from '../chat-handler.js';
import { register as registerImportFromFigma } from '../tools/importFromFigma.js';

// Fix 1 + 3: the system-prompt additions that tell the model what its enabled
// connectors are for, so it stops reaching for an unauthenticated REST Figma
// connector over the live Grip one and stops giving /mcp advice inside the panel.
// Tool names are deliberately NOT hardcoded (they can change) — the prompt marks
// Grip as the preferred live Figma connection and the agent discovers its tools.
const KNOWN_TOOL_NAMES = /get_document|get_page|get_selection|get_node|search_nodes|get_design_context/;

test('connectorPromptAdditions: marks Grip as THE preferred live Figma connection when grip is enabled', () => {
  const out = connectorPromptAdditions(['grip']);
  assert.match(out, /## Figma/);
  assert.match(out, /Grip is the live connection/);
  assert.match(out, /preferred/, 'marks Grip as preferred');
  assert.match(out, /cannot write/, 'contrasts REST (published-only, read-only)');
  assert.match(out, /run the Grip plugin/, 'no-plugin is reported as such, not as no-Figma-access');
  assert.doesNotMatch(out, KNOWN_TOOL_NAMES, 'no hardcoded connector tool names — the agent discovers tools itself');
});

test('connectorPromptAdditions: always warns against /mcp advice when any connector is enabled', () => {
  const out = connectorPromptAdditions(['grip']);
  assert.match(out, /## Connectors/);
  assert.match(out, /Gaffer Settings/, 'points at Settings');
  assert.match(out, /Do NOT suggest running \/mcp/, 'explicitly forbids the CLI advice');
});

test('connectorPromptAdditions: a non-Grip connector gets the /mcp warning but NOT the Grip block', () => {
  const out = connectorPromptAdditions(['some-rest-figma']);
  assert.doesNotMatch(out, /Grip is the live connection/, 'no Grip block without grip enabled');
  assert.match(out, /## Connectors/, 'still gets the connector guidance');
});

test('connectorPromptAdditions: no enabled connectors -> no additions; null-safe', () => {
  assert.equal(connectorPromptAdditions([]), '');
  assert.equal(connectorPromptAdditions(null), '');
  assert.equal(connectorPromptAdditions(undefined), '');
  assert.equal(connectorPromptAdditions([null, false, '']), '', 'falsy ids filtered out');
});

// Fix 2: the description the MODEL sees (the registerTool `description` field, not
// the JSDoc) must name Grip as the source, not the old REST-style get_design_context.
test('importFromFigma tool description points at Grip as the source, with no hardcoded tool names', () => {
  let captured = null;
  const fakeServer = { registerTool(name, def) { if (name === 'importFromFigma') captured = def; } };
  registerImportFromFigma(fakeServer, {}, z);
  assert.ok(captured && captured.description, 'importFromFigma registered a description');
  const d = captured.description;
  assert.match(d, /Grip/, 'names Grip as the source');
  assert.doesNotMatch(d, KNOWN_TOOL_NAMES, 'no hardcoded tool names (not the old REST get_design_context, nor Grip tool names)');
});
