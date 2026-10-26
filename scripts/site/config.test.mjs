import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaults, cloneConfig, configToCssVars, applyConfig, FADER_MODES, faderShowsEllipse, faderShowsRows,
} from '../../site/js/config.js';

const sortedKeys = (o) => Object.keys(o).sort();

test('cloneConfigIsDeepAndIndependent', () => {
  const c = cloneConfig(defaults);
  assert.deepEqual(c, defaults);
  c.grid.gap = 99;
  assert.equal(defaults.grid.gap, 16);
});

test('fontStacksAreQuotedValidCss', () => {
  // A family name with whitespace (e.g. "Source Sans 3") must be quoted, or the
  // declaration is invalid CSS and silently falls back.
  for (const [name, preset] of [['defaults', defaults]]) {
    const vars = configToCssVars(preset);
    for (const key of ['--type-ui', '--type-mono']) {
      assert.equal(vars[key], preset.type[key === '--type-ui' ? 'ui' : 'mono'], name);
      for (const family of vars[key].split(',').map((f) => f.trim())) {
        assert.ok(!/\s/.test(family) || /^".*"$/.test(family), `${name} ${key}: ${family}`);
      }
    }
  }
});

test('cssVarNamesAreStable', () => {
  const vars = configToCssVars(defaults);
  assert.equal(vars['--color-dock-fill'], defaults.color.dockFill);
  assert.equal(vars['--glass-blur'], `${defaults.glass.blur}px`);
  assert.equal(vars['--glass-border-opacity'], String(defaults.glass.borderOpacity));
});

test('applyConfigSetsEveryVar', () => {
  const set = {};
  applyConfig({ style: { setProperty: (k, v) => { set[k] = v; } } }, defaults);
  assert.deepEqual(set, configToCssVars(defaults));
  // Grid keys read only by grid.js (row-ring shape, stagger, parallax, seed) are not CSS vars.
  const jsOnly = ['tile', 'gap', 'columns', 'rowGap', 'columnsCompact', 'aspectMode', 'aspectMin', 'aspectMax', 'rowShift', 'shiftMode', 'rowSpeed', 'seed'];
  // Whole-group and per-key JS-only values (no stylesheet reads a variable for them).
  const otherJsOnly = ['motion', 'toast.duration', 'dock.iconRevertMs', 'color.fader'];
  // Row-fade keys read only by grid.js and main.js are not CSS vars either.
  const faderJsOnly = ['mode', 'rowOpacity', 'rowSpread', 'headlineStrength', 'dockStrength', 'width', 'widthCompact', 'height', 'heightCompact', 'offset', 'offsetCompact', 'softness', 'grain'];
  const count = Object.entries(defaults).reduce((n, [g, v]) => n + (g === 'copy' ? 0
    : Object.keys(v).filter((k) => !(g === 'grid' && jsOnly.includes(k)) && !(g === 'fader' && faderJsOnly.includes(k))
      && !otherJsOnly.includes(g) && !otherJsOnly.includes(`${g}.${k}`)).length), 0);
  assert.equal(Object.keys(set).length, count);
  assert.equal('--dock-links' in set, false, 'the links switch is gone');
  assert.equal(count, 58); // 12 colour + 1 grid + 0 motion + 3 glass + 2 shadow + 7 type + 4 toast + 10 dock + 11 headline + 7 subline + 1 fader + 0 copy
  assert.equal(set['--color-secondary-fill'], 'transparent'); // no resting fill on Copy
  assert.equal(set['--color-secondary-hover'], 'rgba(255, 255, 255, 0.125)');
  assert.equal(set['--dock-cta-gap'], '4px');
  assert.equal(set['--dock-cta-padding'], '0px');
});

test('copyGroupIsNeverACssVar', () => {
  assert.deepEqual(sortedKeys(defaults.copy), ['buttonCompact', 'headlineSub', 'headlineTitle', 'linkCli', 'linkDesktop', 'note', 'toastError', 'toastOk']);
  assert.equal(defaults.copy.buttonCompact, 'Copy install prompt');
  assert.equal(defaults.grid.columnsCompact, 2);
  assert.equal('--grid-columns-compact' in configToCssVars(defaults), false, 'JS-only key');
  assert.equal(defaults.copy.linkDesktop, 'Install with Claude');
  assert.equal(defaults.copy.linkCli, 'Install with CLI');
  assert.equal('links' in defaults.dock, false);
  assert.equal(defaults.dock.ctaGap, 4);
  assert.equal(defaults.dock.ctaPadding, 0);
  assert.equal(defaults.copy.toastOk, 'Copied. Paste it in Claude Code.');
  assert.equal(defaults.copy.toastError, 'Copy failed. Select the text and copy it.');
  const names = Object.keys(configToCssVars(defaults));
  assert.equal(names.some((n) => n.startsWith('--copy-')), false);
});

test('dockIconTimingKeysAreMsVarsWithTheirDefaults', () => {
  const v = configToCssVars(defaults);
  assert.equal(defaults.dock.iconRevertMs, 2000);
  assert.equal(defaults.dock.iconAnimMs, 280);
  assert.equal('--dock-icon-revert-ms' in v, false, 'JS-only: dock.js reads the hold from the config');
  assert.equal(v['--dock-icon-anim-ms'], '280ms');
});

test('newDockToastTypeVarsGetTheRightUnits', () => {
  const vars = configToCssVars(defaults);
  for (const name of ['--toast-radius', '--toast-shadow-blur', '--toast-shadow-y', '--dock-radius',
    '--dock-shadow-blur']) {
    assert.match(vars[name], /^-?[\d.]+px$/, name);
  }
  assert.equal('--toast-duration' in vars, false, 'JS-only');
  assert.equal(vars['--type-weight'], '400');
  assert.equal(vars['--type-mono-weight'], '400', 'unitless');
  assert.equal(vars['--toast-shadow-strength'], '0.5');
  assert.equal(vars['--dock-shadow-strength'], '0.85');
  assert.equal(vars['--dock-radius'], '999px');
});

test('remKeysEmitRemEqualToTheConfiguredPixelsAtA16pxRoot', () => {
  const vars = configToCssVars(defaults);
  assert.equal(vars['--type-size'], '1rem');
  assert.equal(vars['--type-mono-size'], '0.875rem');
  assert.equal(vars['--dock-gap'], '1.5rem');
  assert.equal(vars['--dock-padding'], '0.25rem');
  for (const [name, px] of [['--type-size', 16], ['--type-mono-size', 14], ['--dock-gap', 24], ['--dock-padding', 4]]) {
    assert.equal(parseFloat(vars[name]) * 16, px, name);
  }
  assert.equal(configToCssVars({ ...defaults, type: { ...defaults.type, size: 20 } })['--type-size'], '1.25rem');
});

test('cardsHaveNoHoverScale', () => {
  assert.deepEqual(sortedKeys(defaults.motion), ['bow', 'bowSmooth', 'bowVelocity', 'bulge', 'coast', 'edge', 'glide', 'idle', 'idleMode', 'reach', 'shade', 'vignette']);
  assert.equal('--motion-hover-scale' in configToCssVars(defaults), false);
});

test('radiusAndGapGetPx', () => {
  const vars = configToCssVars(defaults);
  assert.equal(vars['--grid-radius'], '32px');
  for (const name of ['--grid-gap', '--grid-tile', '--grid-columns']) assert.equal(name in vars, false, `${name} is JS-only`);
  assert.equal(vars['--glass-blur'], '16px');
  assert.equal(vars['--shadow-blur'], '24px');
  assert.equal(vars['--shadow-strength'], '0');
  assert.equal(Object.keys(vars).some((n) => n.startsWith('--motion-')), false, 'the motion group is JS-only');
});

test('gridRowRingDefaultsFollowTheUsersSettings', () => {
  const g = defaults.grid;
  assert.equal(g.aspectMode, 'native');
  assert.equal(g.aspectMin, 0.5);
  assert.equal(g.aspectMax, 2.4);
  assert.equal(g.rowGap, 16); // its own default (matches gap so rows and columns space alike); does not follow gap
  assert.equal(g.rowShift, 0.5);
  assert.equal(g.shiftMode, 'alternate');
  assert.equal(g.rowSpeed, 0.26);
  assert.equal(g.seed, 1);
});

test('gridEnumsSeedAndRowGapAreNeverCssVars', () => {
  const vars = configToCssVars(defaults);
  for (const name of ['--grid-row-gap', '--grid-aspect-mode', '--grid-shift-mode', '--grid-seed', '--grid-aspect-min',
    '--grid-aspect-max', '--grid-row-shift', '--grid-row-speed']) {
    assert.equal(name in vars, false, name);
  }
});

test('bakedDefaultsFollowTheUsersLatestSettings', () => {
  assert.equal(defaults.grid.gap, 16);
  assert.equal(defaults.motion.glide, 0.12);
  assert.equal(defaults.motion.bulge, 0, 'bulge zeroed');
  assert.equal(defaults.type.mono, '"JetBrains Mono", ui-monospace, monospace');
  const vars = configToCssVars(defaults);
  assert.equal(vars['--type-mono'], '"JetBrains Mono", ui-monospace, monospace');
});

test('velocityBowDefaultsFollowTheUsersSettings', () => {
  assert.equal(defaults.motion.bowVelocity, 0.5);
  assert.equal(defaults.motion.bowSmooth, 0.12);
});

test('headlineVarsGetTheRightUnitsAndTheCopyIsNotAVar', () => {
  const v = configToCssVars(defaults);
  assert.equal(v['--headline-size'], '64px');
  assert.equal(v['--headline-size-compact'], '72px');
  assert.equal(v['--headline-weight'], '500');
  assert.equal(v['--headline-tracking'], '-0.03em');
  assert.equal(v['--headline-line-height'], '0.8');
  assert.equal(v['--headline-dock-gap'], '24px');
  assert.equal(v['--headline-dock-gap-compact'], '24px');
  assert.equal('--headline-y' in v, false, 'y is gone');
  assert.equal(v['--headline-opacity'], '1');
  assert.equal(v['--headline-shadow-strength'], '0');
  assert.equal(v['--color-headline'], '#E0E0E0');
  assert.equal(v['--headline-gap'], '0.12em');
  assert.equal(v['--headline-ligatures'], '1');
  assert.equal(v['--color-headline-sub'], '#AAAAAA');
  assert.equal(v['--type-code-ligatures'], '1');
  assert.equal(defaults.copy.headlineTitle, 'Gaffer');
  assert.equal(defaults.copy.headlineSub, 'your AI crew in After Effects');
  assert.ok(defaults.copy.headlineTitle.length <= 80 && defaults.copy.headlineSub.length <= 80);
  assert.equal('headline' in defaults.copy, false, 'the old one-line key is gone');
  assert.equal('--copy-headline-title' in v, false);
  assert.equal('--copy-headline-sub' in v, false);
});

test('sublineVarsGetTheRightUnitsAndDefaults', () => {
  const v = configToCssVars(defaults);
  assert.deepEqual(sortedKeys(defaults.subline), ['lineHeight', 'opacity', 'shadowStrength', 'size', 'sizeCompact', 'tracking', 'weight']);
  assert.equal(v['--subline-size'], '24px');
  assert.equal(v['--subline-size-compact'], '24px');
  assert.equal(v['--subline-weight'], '400');
  assert.equal(v['--subline-tracking'], '0em');
  assert.equal(v['--subline-line-height'], '1.25');
  assert.equal(v['--subline-opacity'], '1');
  assert.equal(v['--subline-shadow-strength'], '0.2');
});

test('faderVarsGetTheRightUnitsAndDefaults', () => {
  const v = configToCssVars(defaults);
  assert.deepEqual(sortedKeys(defaults.fader), [
    'dockStrength', 'grain', 'headlineStrength', 'height', 'heightCompact', 'mode', 'offset', 'offsetCompact', 'opacity', 'rowOpacity', 'rowSpread', 'softness', 'width', 'widthCompact',
  ]);
  assert.equal(v['--fader-opacity'], '1');
  // The ellipse is drawn by fader.js from the config object: only the opacity is a CSS variable.
  for (const name of ['--fader-width', '--fader-height', '--fader-offset', '--fader-width-compact', '--fader-height-compact',
    '--fader-offset-compact', '--fader-softness', '--fader-grain', '--fader-dither', '--color-fader']) {
    assert.equal(name in v, false, name);
  }
  assert.equal(defaults.fader.grain, 1.5);
  assert.equal(defaults.color.fader, '#121212');
});

test('bakedHeadlineDefaults', () => {
  assert.equal(defaults.headline.weight, 500);
  assert.equal(defaults.headline.lineHeight, 0.8);
  assert.equal(defaults.headline.dockGap, 24);
  assert.equal(defaults.headline.dockGapCompact, 24);
});

test('rowFadeDefaultsKeepTheEllipseLookAndAreNeverCssVars', () => {
  assert.equal(defaults.fader.mode, 'ellipse');
  assert.equal(defaults.fader.rowOpacity, 0);
  assert.equal(defaults.fader.rowSpread, 320);
  assert.equal(defaults.fader.headlineStrength, 0.15);
  assert.equal(defaults.fader.dockStrength, 0.6);
  const vars = configToCssVars(defaults);
  for (const name of ['--fader-mode', '--fader-row-opacity', '--fader-row-spread', '--fader-headline-strength', '--fader-dock-strength']) {
    assert.equal(name in vars, false, name);
  }
  });

test('faderModesSayWhichEffectShows', () => {
  assert.deepEqual(FADER_MODES, ['ellipse', 'rows', 'both', 'off']);
  assert.deepEqual(FADER_MODES.map(faderShowsEllipse), [true, false, true, false]);
  assert.deepEqual(FADER_MODES.map(faderShowsRows), [false, true, true, false]);
  assert.equal(faderShowsEllipse('bogus'), true, 'an unknown mode falls back to the default look');
  assert.equal(faderShowsRows('bogus'), false);
});
