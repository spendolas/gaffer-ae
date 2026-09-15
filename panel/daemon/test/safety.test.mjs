import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapInSafety } from '../safety.js';

// Regression coverage for the 2026-09-15 "daemon executes but never returns a
// result" bug: try/catch cannot intercept a native AE alert dialog (an
// explicit alert() call, or certain engine faults AE surfaces as a dialog
// instead of a catchable JS exception). AE is single-threaded, so an
// unsuppressed dialog blocks the whole app until a human clicks it - which
// never happens on an unattended run - and the evalScript callback the daemon
// is awaiting never fires. app.beginSuppressDialogs()/endSuppressDialogs(false)
// must bracket every path so a stray dialog can never freeze the round trip.

test('wrapInSafety (read-only): suppresses dialogs around the eval, restores them even on error', () => {
  var jsx = wrapInSafety('1+1', null, true);
  assert.ok(jsx.includes('app.beginSuppressDialogs()'), 'suppression begins');
  assert.ok(jsx.includes('app.endSuppressDialogs(false)'), 'suppression ends');
  // beginSuppressDialogs must run before the risky eval, and its end call must
  // be in a finally so a thrown error still restores dialogs.
  assert.ok(jsx.indexOf('app.beginSuppressDialogs()') < jsx.indexOf('eval('), 'suppression starts before eval');
  var finallyIdx = jsx.indexOf('finally');
  assert.ok(finallyIdx > -1 && jsx.indexOf('app.endSuppressDialogs(false)') > finallyIdx,
    'endSuppressDialogs runs in the finally block');
  assert.ok(!jsx.includes('app.beginUndoGroup'), 'read-only path still skips the undo group');
});

test('wrapInSafety (mutating): suppresses dialogs around the undo group + eval', () => {
  var jsx = wrapInSafety('1+1', 'test label', false);
  assert.ok(jsx.includes('app.beginSuppressDialogs()'), 'suppression begins');
  assert.ok(jsx.includes('app.endSuppressDialogs(false)'), 'suppression ends');
  assert.ok(jsx.indexOf('app.beginSuppressDialogs()') < jsx.indexOf('app.beginUndoGroup'),
    'suppression starts before the undo group opens');
  var finallyIdx = jsx.indexOf('finally');
  assert.ok(finallyIdx > -1
    && jsx.indexOf('app.endUndoGroup()') > finallyIdx
    && jsx.indexOf('app.endSuppressDialogs(false)') > finallyIdx,
    'both endUndoGroup and endSuppressDialogs run in the finally block');
});

test('wrapInSafety: dialog suppression is unconditional (guard on/off makes no difference)', () => {
  var withoutGuard = wrapInSafety('1+1', 'x', false, { guard: false });
  var withGuard = wrapInSafety('1+1', 'x', false, { guard: true });
  assert.ok(withoutGuard.includes('app.beginSuppressDialogs()'));
  assert.ok(withGuard.includes('app.beginSuppressDialogs()'));
});

// app.beginSuppressDialogs() does NOT cover a script's own alert()/confirm()/
// prompt() calls - verified live against real AE, a raw alert() left a real
// dialog open blocking the app. Shadowing the three globals is the actual fix.
test('wrapInSafety (read-only): shadows alert/confirm/prompt before the eval, so agent code can never open a real blocking dialog', () => {
  var jsx = wrapInSafety('1+1', null, true);
  assert.ok(/var alert\s*=\s*function/.test(jsx), 'alert shadowed');
  assert.ok(/confirm\s*=\s*function/.test(jsx), 'confirm shadowed');
  assert.ok(/prompt\s*=\s*function/.test(jsx), 'prompt shadowed');
  assert.ok(jsx.indexOf('var alert') < jsx.indexOf('eval('), 'shadow declared before the eval runs');
});

test('wrapInSafety (mutating): shadows alert/confirm/prompt before the eval', () => {
  var jsx = wrapInSafety('1+1', 'x', false);
  assert.ok(/var alert\s*=\s*function/.test(jsx), 'alert shadowed');
  assert.ok(jsx.indexOf('var alert') < jsx.indexOf('eval('), 'shadow declared before the eval runs');
});

test('wrapInSafety: functionally executed, alert() inside the agent code never escapes to a real global', () => {
  // No `alert` global provided at all (Node has none either) - if the shadow
  // didn't exist, calling alert() would throw ReferenceError, caught by the
  // wrapper's own try/catch as ok:false. A working shadow means it's a real,
  // callable no-op and the script completes cleanly.
  var app = { beginSuppressDialogs: function () {}, endSuppressDialogs: function () {} };
  var jsx = wrapInSafety('alert("would have frozen AE"); 42', null, true);
  var fn = new Function('app', 'return ' + jsx);
  var out = JSON.parse(fn(app));
  assert.equal(out.ok, true, 'alert() did not throw or escape the shadow: ' + JSON.stringify(out));
  assert.equal(out.result, '42', 'execution continued past the alert() call');
});
