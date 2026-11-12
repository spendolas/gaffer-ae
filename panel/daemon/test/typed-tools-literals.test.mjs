// Every typed MCP tool builds ExtendScript from arguments. This test registers
// all of them against a stub server and a stub queue, feeds awkward strings
// into every string parameter (and awkward numbers into every number
// parameter), parses each script that would be sent to After Effects, and
// checks that the data only ever ended up inside string and number literals:
// no call to a restricted primitive may appear that the tool does not make with
// benign input too. The scripts are only parsed, never run.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import * as acorn from 'acorn';

var here = dirname(fileURLToPath(import.meta.url));
var daemonDir = join(here, '..');

// The capture tools pick their temp folder when they load and tidy it up
// afterwards, so give them a scratch one.
// Where the filesystem allows it the folder name itself holds a quote, a
// backslash and a line separator, so a path written into a script unescaped
// would end its string early.
var scratchPrefix = process.platform === 'win32' ? 'gaffer-literals-' : 'gaffer-literals-"q\\b\u2028-';
var scratch = mkdtempSync(join(tmpdir(), scratchPrefix));
process.env.TMPDIR = scratch;
process.env.TEMP = scratch;
process.env.TMP = scratch;
after(() => { rmSync(scratch, { recursive: true, force: true }); });

var { wrapInSafety, wrapSlice } = await import(pathToFileURL(join(daemonDir, 'safety.js')).href);
var { translateToJSX } = await import(pathToFileURL(join(daemonDir, 'tools', 'figma-translator.js')).href);

// ── awkward input ──

var MARK = 'gaffer-literal-test';
var PAYLOADS = {
  doubleQuote: '");system.callSystem("touch ' + MARK + '");//',
  singleQuote: "');system.callSystem('touch " + MARK + "');//",
  backslash: '\\");system.callSystem("touch ' + MARK + '");//',
  lineFeed: 'x\nsystem.callSystem("touch ' + MARK + '");//',
  carriageReturn: 'x\rsystem.callSystem("touch ' + MARK + '");//',
  crlf: 'x\r\nsystem.callSystem("touch ' + MARK + '");//',
  lineSeparator: 'x\u2028system.callSystem("touch ' + MARK + '");//',
  paragraphSeparator: 'x\u2029system.callSystem("touch ' + MARK + '");//',
  blockComment: '*/system.callSystem("touch ' + MARK + '");/*',
  template: '${system.callSystem("touch ' + MARK + '")}',
  backtick: '`;system.callSystem("touch ' + MARK + '");`',
  nul: 'x\u0000");system.callSystem("touch ' + MARK + '");//',
  jsonText: JSON.stringify({ a: 1, b: ['");system.callSystem("x");//'] }),
  windowsPath: 'C:\\Users\\me\\captures\\frame "1".png',
  long: 'A'.repeat(200000) + '");system.callSystem("touch ' + MARK + '");//',
  lonelySurrogate: '\ud800");system.callSystem("touch ' + MARK + '");//',
  htmlish: '</script><script>system.callSystem("touch ' + MARK + '")</script>',
  empty: '',
};
var NUMS = [1, -1.5, 1e21, 0];
var VARIANTS = 4; // enum / union / number choices rotate through these

// ── which calls are restricted ──

var RESTRICTED_IDENTS = ['eval', 'Function', 'Socket', 'ExternalObject', 'BridgeTalk'];
var RESTRICTED_PROPS = ['callSystem', 'evalFile', 'execute', 'executeCommand'];

function parseScript(code) {
  var opts = { allowReserved: true, allowReturnOutsideFunction: true };
  try {
    return { ast: acorn.parse(code, Object.assign({ ecmaVersion: 3 }, opts)), strict: true };
  } catch (e3) {
    try {
      return { ast: acorn.parse(code, Object.assign({ ecmaVersion: 'latest' }, opts)), strict: false, why: e3.message };
    } catch (e) {
      return { ast: null, strict: false, why: e.message };
    }
  }
}

function argKind(node) { return node && node.type ? node.type : 'none'; }

// Returns the signatures of every call or `new` of a restricted primitive.
function restrictedCalls(ast) {
  var found = [];
  (function walk(n) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' || n.type === 'NewExpression') {
      var c = n.callee;
      if (c.type === 'Identifier' && RESTRICTED_IDENTS.indexOf(c.name) !== -1) {
        found.push(c.name + '(' + argKind(n.arguments[0]) + ')');
      } else if (c.type === 'MemberExpression') {
        var prop = c.computed ? (c.property.type === 'Literal' ? String(c.property.value) : null) : c.property.name;
        if (prop === null) found.push('computedCall');
        else if (RESTRICTED_PROPS.indexOf(prop) !== -1) found.push('.' + prop);
        else if (RESTRICTED_IDENTS.indexOf(prop) !== -1) found.push('.' + prop + '(' + argKind(n.arguments[0]) + ')');
      }
    }
    Object.keys(n).forEach(function (k) {
      if (k === 'loc' || k === 'range') return;
      var v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    });
  })(ast);
  return found.sort();
}

// The tools' own scripts never use any of these. The safety wrapper evaluates
// the script text it is handed (one string literal) and its JSON stand-in
// evaluates text with a concatenation; nothing else is allowed.
var ALLOWED_TOOL = [];
var ALLOWED_WRAPPER = ['eval(BinaryExpression)', 'eval(Literal)'];
var ALLOWED_SLICE_WRAPPER = ['eval(BinaryExpression)'];

function check(what, code, allowed, problems) {
  var p = parseScript(code);
  if (!p.ast) { problems.push(what + ': does not parse (' + p.why + ')'); return; }
  if (!p.strict) problems.push(what + ': does not parse as ES3 (' + p.why + ')');
  var calls = restrictedCalls(p.ast);
  if (JSON.stringify(calls) !== JSON.stringify(allowed.slice().sort())) {
    problems.push(what + ': restricted calls ' + JSON.stringify(calls) + ', allowed ' + JSON.stringify(allowed));
  }
}

// ── stub server and queue ──

function makeQueue(log) {
  var plain = JSON.stringify({ ok: true, result: JSON.stringify({ ok: true }) });
  var sliced = JSON.stringify({ ok: true, cursor: null, done: true, processed: 1 });
  return {
    enqueue(code, label, readOnly) {
      log.push({ kind: 'code', code: code, label: label, readOnly: readOnly });
      return Promise.resolve(plain);
    },
    enqueuePreWrapped(wrapped) {
      log.push({ kind: 'wrapped', wrapped: wrapped });
      return Promise.resolve(sliced);
    },
  };
}

// ── register every tool the daemon registers ──

var mcpSource = readFileSync(join(daemonDir, 'mcp-server.js'), 'utf8');
var toolModules = [];
mcpSource.replace(/import \{ register as \w+ \} from '\.\/tools\/(\w+)\.js';/g, function (_, name) { toolModules.push(name); return _; });

var TOOLS = {}; // tool name -> { def, handler, log, module }
for (var m of toolModules) {
  var mod = await import(pathToFileURL(join(daemonDir, 'tools', m + '.js')).href);
  var log = [];
  var server = {
    registerTool(name, def, handler) {
      assert.ok(!TOOLS[name], 'tool registered twice: ' + name);
      TOOLS[name] = { def: def, handler: handler, log: log, module: m };
    },
  };
  mod.register(server, makeQueue(log), z, { isCancelled: function () { return false; } });
}

// ── arguments from each tool's own schema ──

var OMIT = Symbol('omit');
function gen(s, payload, v, depth) {
  var def = s._zod.def;
  switch (def.type) {
    case 'string': return payload;
    case 'number': case 'int': return NUMS[v % NUMS.length];
    case 'boolean': return v % 2 === 0;
    case 'enum': var vals = Object.values(def.entries); return vals[v % vals.length];
    case 'literal': return def.values[0];
    case 'array':
      if (depth > 9) return [];
      var el = gen(def.element, payload, v, depth + 1);
      return el === OMIT ? [] : [el];
    case 'object':
      var out = {};
      Object.keys(def.shape).forEach(function (k) {
        var val = gen(def.shape[k], payload, v, depth + 1);
        if (val !== OMIT) out[k] = val;
      });
      return out;
    case 'optional': case 'nullable': case 'default': case 'readonly': case 'prefault':
      return gen(def.innerType, payload, v, depth + 1);
    case 'union': return gen(def.options[v % def.options.length], payload, v, depth + 1);
    case 'lazy': return depth > 9 ? OMIT : gen(def.getter(), payload, v, depth + 1);
    default: throw new Error('test needs updating: unhandled schema type ' + def.type);
  }
}

// Arguments that are code by design stay benign: the script text of runJSXLoop.
var BENIGN_OVERRIDES = {
  runJSXLoop: { step: 'function (cursor) { return { cursor: null, done: true }; }' },
};

// ── the tests ──

test('detector: flags every restricted call it is meant to catch and passes benign scripts', () => {
  var comment = parseScript('// layer\nsystem.callSystem("x");').ast;
  assert.deepEqual(restrictedCalls(comment), ['.callSystem']);
  assert.deepEqual(restrictedCalls(parseScript('var f = new File("a"); f.exists;').ast), []);
  assert.deepEqual(restrictedCalls(parseScript('new Socket(); $.evalFile(f); f.execute(); eval(x); new Function("a"); new BridgeTalk(); new ExternalObject("lib:x");').ast),
    ['.evalFile', '.execute', 'BridgeTalk(none)', 'ExternalObject(Literal)', 'Function(Literal)', 'Socket(none)', 'eval(Identifier)']);
  assert.deepEqual(restrictedCalls(parseScript('this["system"]["callSystem"]("x"); a[b]();').ast), ['.callSystem', 'computedCall']);
  // a literal that merely contains the text is not a call
  assert.deepEqual(restrictedCalls(parseScript('var s = "system.callSystem(1)";').ast), []);
});

test('every tool module in mcp-server.js registered one tool', () => {
  assert.ok(toolModules.length >= 24, 'found the tool modules in mcp-server.js: ' + toolModules.length);
  assert.equal(Object.keys(TOOLS).length, toolModules.length, 'each tool module registers exactly one tool');
});

var exercisedTools = {};

Object.keys(TOOLS).forEach(function (name) {
  test('tool ' + name + ': arguments only ever become literals in the generated script', async () => {
    var t = TOOLS[name];
    var schema = z.object(t.def.inputSchema);
    var problems = [];
    var scripts = 0;
    var controlScripts = 0;

    // Control run: the scripts for ordinary input define what is allowed.
    for (var v = 0; v < VARIANTS; v++) {
      var benign = Object.assign(gen(schema, 'ordinary', v, 0), BENIGN_OVERRIDES[name] || {});
      var ok = schema.safeParse(benign);
      assert.ok(ok.success, name + ' accepts its generated ordinary input: ' + (ok.error && ok.error.message));
      t.log.length = 0;
      await t.handler(benign);
      controlScripts += t.log.length; // a tool that caches its answer sends nothing after the first call
      t.log.forEach(function (e) {
        var allowedInner = ALLOWED_TOOL;
        if (e.kind === 'code') {
          check(name + '/ordinary/code', e.code, allowedInner, problems);
          check(name + '/ordinary/wrapped', wrapInSafety(e.code, e.label, e.readOnly), ALLOWED_WRAPPER, problems);
        } else {
          check(name + '/ordinary/wrapped', e.wrapped, ALLOWED_SLICE_WRAPPER, problems);
        }
      });
    }
    assert.ok(controlScripts > 0, name + ' sent a script for ordinary input');
    assert.deepEqual(problems, [], 'ordinary input is clean: ' + problems.join('; '));

    for (var pname of Object.keys(PAYLOADS)) {
      for (var v2 = 0; v2 < VARIANTS; v2++) {
        var args = Object.assign(gen(schema, PAYLOADS[pname], v2, 0), BENIGN_OVERRIDES[name] || {});
        var parsedArgs = schema.safeParse(args);
        assert.ok(parsedArgs.success, name + '/' + pname + ': the awkward input passes the tool schema (else the case proves nothing): ' + (parsedArgs.error && parsedArgs.error.message));
        t.log.length = 0;
        await t.handler(parsedArgs.data);
        scripts += t.log.length;
        t.log.forEach(function (e) {
          var tag = name + '/' + pname + '#' + v2;
          if (e.kind === 'code') {
            check(tag + '/code', e.code, ALLOWED_TOOL, problems);
            check(tag + '/wrapped', wrapInSafety(e.code, e.label, e.readOnly), ALLOWED_WRAPPER, problems);
          } else {
            check(tag + '/wrapped', e.wrapped, ALLOWED_SLICE_WRAPPER, problems);
          }
        });
      }
    }
    exercisedTools[name] = scripts + controlScripts;
    assert.deepEqual(problems.slice(0, 5), [], problems.length + ' problem(s): ' + problems.slice(0, 5).join('; '));
  });
});

// importFromFigma gets hand-built layers on top of the generated ones, so every
// string field is awkward at every nesting level.
test('importFromFigma: awkward layer names, text, fonts and types at every nesting level', async () => {
  var problems = [];
  var count = 0;
  for (var pname of Object.keys(PAYLOADS)) {
    var p = PAYLOADS[pname];
    var geometry = { x: 1, y: 2, width: 30, height: 40 };
    function leaf(type, extra) { return Object.assign({ name: p, type: type }, geometry, extra || {}); }
    function textLayer(depthTag) {
      return leaf('TEXT', { name: p + depthTag, text: { content: p, fontSize: 12, font: { family: p, style: p }, justification: 'CENTER', letterSpacing: 1, lineHeight: 2 } });
    }
    var all = [
      leaf('RECTANGLE', { blendMode: p, cornerRadius: [1, 2, 3, 4] }),
      leaf('RECTANGLE', { cornerRadius: 4, cornerSmoothing: 0.6, blendMode: 'MULTIPLY' }),
      leaf('ELLIPSE', { fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 0.5 }], strokes: [{ color: { r: 0, g: 0, b: 0 }, width: 2, cap: 'ROUND', join: 'BEVEL', dashes: [1, 2, 3] }] }),
      leaf('PATH', { path: { vertices: [[0, 0], [1, 1]], inTangents: [[0, 0], [0, 0]], outTangents: [[0, 0], [0, 0]], closed: true } }),
      textLayer(' top'),
      leaf('GROUP', { children: [
        leaf('RECTANGLE'),
        textLayer(' in group'),
        leaf('FRAME', { frameMode: 'precomp', children: [
          textLayer(' in precomp'),
          leaf('GROUP', { children: [textLayer(' deep'), leaf('ELLIPSE', { effects: [{ type: 'DROP_SHADOW', radius: 2, offset: { x: 1, y: 2 }, color: { r: 0, g: 0, b: 0, a: 1 } }, { type: 'LAYER_BLUR', radius: 3 }] })] }),
        ] }),
      ] }),
      leaf('FRAME', { frameMode: 'null', children: [leaf('RECTANGLE'), textLayer(' in frame')] }),
      leaf('FRAME', { frameMode: 'precomp', children: [leaf('ELLIPSE')] }),
      // a layer type the translator does not know, straight into the translator
      leaf(p),
      leaf('FRAME', { frameMode: p, children: [leaf(p)] }),
    ];
    var artboard = { width: 100, height: 50, name: p };

    // Through the tool, exactly as the MCP client would call it.
    var t = TOOLS.importFromFigma;
    var schema = z.object(t.def.inputSchema);
    var viaTool = schema.safeParse({ layers: all.filter(function (l) { return ['RECTANGLE', 'ELLIPSE', 'PATH', 'TEXT', 'FRAME', 'GROUP'].indexOf(l.type) !== -1 && (l.frameMode === undefined || ['precomp', 'null'].indexOf(l.frameMode) !== -1); }), artboard: artboard });
    assert.ok(viaTool.success, 'tool schema accepts the hand-built layers: ' + (viaTool.error && viaTool.error.message));
    t.log.length = 0;
    await t.handler(viaTool.data);
    assert.equal(t.log.length, 1, 'one script sent');
    count++;
    check('importFromFigma/' + pname + '/tool', t.log[0].code, ALLOWED_TOOL, problems);
    check('importFromFigma/' + pname + '/tool-wrapped', wrapInSafety(t.log[0].code, t.log[0].label, false), ALLOWED_WRAPPER, problems);

    // And straight into the translator, which also sees types the schema would refuse.
    var direct = translateToJSX(all, artboard);
    check('importFromFigma/' + pname + '/translator', direct, ALLOWED_TOOL, problems);
  }
  assert.ok(count === Object.keys(PAYLOADS).length);
  assert.deepEqual(problems.slice(0, 5), [], problems.length + ' problem(s): ' + problems.slice(0, 5).join('; '));
});

test('capture tools write the temp path they chose as one string literal', async () => {
  var names = ['captureFrame', 'captureLayer', 'captureActiveComp'];
  for (var name of names) {
    var t = TOOLS[name];
    assert.ok(t, name + ' is registered');
    t.log.length = 0;
    await t.handler({ layerIndex: 1 });
    assert.equal(t.log.length, 1);
    var ast = parseScript(t.log[0].code).ast;
    var files = [];
    (function walk(n) {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'NewExpression' && n.callee.name === 'File') files.push(n.arguments);
      Object.keys(n).forEach(function (k) {
        var v = n[k];
        if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v);
      });
    })(ast);
    assert.equal(files.length, 1, name + ' makes one File');
    assert.equal(files[0].length, 1);
    assert.equal(files[0][0].type, 'Literal', name + ': the path is a plain string literal');
    assert.ok(files[0][0].value.startsWith(scratch), name + ': the literal means the exact temp path');
    assert.ok(files[0][0].value.endsWith('.png'));
  }
});

test('the safety wrapper keeps awkward script text, labels and cursors inside literals', () => {
  var problems = [];
  var benignStep = 'function (cursor) { return { cursor: null, done: true }; }';
  Object.keys(PAYLOADS).forEach(function (pname) {
    var p = PAYLOADS[pname];
    [true, false].forEach(function (readOnly) {
      // The agent's own script text is code by design, but it must stay inside the one eval literal.
      check('wrapInSafety/' + pname + '/code/' + readOnly, wrapInSafety(p, 'label', readOnly), ALLOWED_WRAPPER, problems);
      // The undo label is data.
      check('wrapInSafety/' + pname + '/label/' + readOnly, wrapInSafety('1+1', p, readOnly), ALLOWED_WRAPPER, problems);
    });
    check('wrapSlice/' + pname + '/label', wrapSlice(benignStep, 'null', p, 300, 1), ALLOWED_SLICE_WRAPPER, problems);
  });
  assert.deepEqual(problems.slice(0, 5), [], problems.length + ' problem(s): ' + problems.slice(0, 5).join('; '));
});

test('every registered tool produced scripts in this run', () => {
  assert.deepEqual(Object.keys(exercisedTools).sort(), Object.keys(TOOLS).sort(), 'exercised set equals the registered set');
  Object.keys(TOOLS).forEach(function (n) { assert.ok(exercisedTools[n] > 0, n + ' produced scripts'); });
});
