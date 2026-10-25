// Tunable look and motion values. Every value is a number or a string.
// Runs unchanged in Node (tests) and the browser; no DOM access at load.

export const defaults = {
  color: {
    stage: '#121212',
    dockFill: '#232323',
    button: '#4475C0',
    buttonText: '#FFFFFF',
    secondaryFill: 'transparent', // the Copy button at rest (no fill); hover uses secondaryHover
    secondaryHover: 'rgba(255, 255, 255, 0.125)', // layered over the dock
    text: '#E0E0E0',
    headline: '#E0E0E0', // the page headline (title line)
    headlineSub: '#AAAAAA', // the headline's second line
    fader: '#121212', // the fader ellipse; the stage colour so it blends in
    textMuted: '#AAAAAA',
    toastFill: '#E0E0E0',
    toastText: '#121212',
  },
  grid: {
    tile: 400, gap: 16, radius: 32, columns: 5,
    columnsCompact: 2, // minimum columns across on phones (viewport <= 600px); columns applies above
    rowGap: 16, // px between rows; gap is between tiles in a row
    aspectMode: 'native', // 'native': each tile keeps its clip's shape; 'square': all 1:1
    aspectMin: 0.5, // native aspect clamp (width / height)
    aspectMax: 2.4,
    rowShift: 0.5, // static row stagger, fraction of the row's average tile width
    shiftMode: 'alternate', // 'alternate' | 'step' | 'random'
    rowSpeed: 0.26, // parallax: rows pan at 1 +- up to this fraction of the drag
    seed: 1, // integer 0..9999; Reshuffle bumps it
  },
  motion: {
    bow: 0.01, // resting dome strength
    bowVelocity: 0.5, // extra bow at full pan speed (0 = off)
    coast: 0.9, // after a drag release the grid keeps going: share of the fling speed kept each frame (0 = stops dead, 0.98 = long glide)
    idleMode: 'alternate', // idle drift direction per row: 'same' | 'alternate' | 'random'
    idle: 7, // px/s of sideways drift while untouched, spread per row by rowSpeed like a scroll; 0 = off
    bowSmooth: 0.12, // damping rate of the speed signal behind bowVelocity
    bulge: 0, reach: 0.5, glide: 0.12, vignette: 0, shade: 0, edge: 1,
  },
  glass: { blur: 16, fillOpacity: 0.7, borderOpacity: 0.1 },
  shadow: { strength: 0, blur: 24 }, // cards only; the dock and toast have their own
  type: {
    ui: '"Source Sans 3", "Segoe UI", sans-serif',
    mono: '"JetBrains Mono", ui-monospace, monospace',
    size: 16, // base px; dock, note and toast text scale from it
    monoSize: 14, // prompt px
    weight: 400, // button and toast (200 to 900, Source Sans 3 variable)
    monoWeight: 400, // prompt (100 to 800, JetBrains Mono variable)
    codeLigatures: 1, // 0/1: the prompt's font ligatures (JetBrains Mono's // and friends)
  },
  toast: { radius: 210, shadowStrength: 0.5, shadowBlur: 28, shadowY: 10, duration: 2000 },
  dock: { radius: 999, gap: 24, padding: 4, shadowStrength: 0.85, shadowBlur: 45, ctaGap: 4, ctaPadding: 0, notePadding: 8, noteGap: 6, iconRevertMs: 2000, iconAnimMs: 280 }, // ctaGap/ctaPadding: spacing between the two buttons, and around them inside the pill; iconRevertMs: how long the Copy button shows its check after a successful copy; iconAnimMs: the copy/check swap duration
  // The page headline (the h1) is two lines. `headline` is the title line ("Gaffer"): size and
  // sizeCompact are px (compact applies at <= 600px wide), tracking is em, dockGap and dockGapCompact are the
  // px space between the bottom of the two-line block and the top of the dock. The headline and the dock are
  // one bottom-anchored column (.bottom-stack), so they reflow together whatever the dock's height; gap is the space between the lines in em of the
  // title size, ligatures is 0/1 (forced on or off; browsers drop ligatures at non-zero tracking otherwise).
  headline: { size: 64, sizeCompact: 72, weight: 500, tracking: -0.03, lineHeight: 0.8, dockGap: 24, dockGapCompact: 24, opacity: 1, shadowStrength: 0, gap: 0.12, ligatures: 1 },
  // The second line ("your AI crew in After Effects"); same units as the title, inherits its ligatures switch.
  subline: { size: 24, sizeCompact: 24, weight: 400, tracking: 0, lineHeight: 1.25, opacity: 1, shadowStrength: 0.2 },
  // The fader: a big soft ellipse in the stage colour, fixed to the bottom centre of the viewport behind
  // the headline and dock and above the grid, so the text reads over the moving clips. width and height are px, fixed (never viewport-relative, so the effect keeps its shape),
  // offset is px (how far the ellipse CENTRE sits above the viewport bottom, so it stays pinned to the page bottom whatever the height; negative sinks it below the edge; offsetCompact, widthCompact and heightCompact apply at <= 600px), softness 0..1 is
  // the fraction of the ellipse that stays solid before it feathers out (0 = feathered from the centre,
  // 1 = hard edge), opacity scales the whole thing, and grain is the noise baked into the ellipse's alpha before it is
  // rounded to 8 bits, in levels of that alpha (0 = none; about 1.5 breaks the banding of a soft edge). The
  // ellipse is a single canvas drawn by fader.js, so the noise adds no layer to composite.
  // mode picks the effect: 'ellipse' (the overlay above), 'rows' (row fade: tiles whose rows cross the
  // headline or dock band are dimmed by grid.js), 'both', or 'off'. Row fade: rowOpacity 0..1 is the
  // opacity of a tile fully inside a band, and a tile is dimmed in proportion to the share of its height
  // inside the band; rowSpread is the px beyond each band over which that share eases out
  // (0 = hard band; see rowFadeWeight in math.js), headlineStrength and dockStrength 0..1 scale each band. All five are JS-only.
  fader: {
    opacity: 1, grain: 1.5, width: 6050, height: 1830, offset: -284, softness: 0,
    widthCompact: 1560, heightCompact: 980, offsetCompact: 0, // phones (<= 600px wide): a tighter ellipse that sits on the headline and dock
    mode: 'ellipse', rowOpacity: 0, rowSpread: 320, headlineStrength: 0.15, dockStrength: 0.6,
  },
  // Wording. Read by dock.js at use time and set with textContent only; never a CSS variable.
  copy: {
    linkDesktop: 'Install with Claude', // the primary button, first in the group
    buttonCompact: 'Copy install prompt', // the Copy button's label (hidden on a phone that also has the app link, where it is icon-only)
    toastOk: 'Copied. Paste it in Claude Code.',
    toastError: 'Copy failed. Select the text and copy it.',
    headlineTitle: 'Gaffer', // the h1's first line; dock.js applyHeadline, textContent only
    headlineSub: 'your AI crew in After Effects', // the h1's second line
    note: 'A panel extension for AE 2022+\u2022Rides your Claude Code subscription', // the small line (split on the bullet) under the dock; dock.js applyNote, textContent only
  },
};

const PX_VARS = new Set([
  'grid.radius', 'glass.blur', 'shadow.blur',
  'toast.radius', 'toast.shadowBlur', 'toast.shadowY',
  'dock.radius', 'dock.shadowBlur', 'dock.ctaGap', 'dock.ctaPadding', 'dock.notePadding', 'dock.noteGap',
  'headline.dockGap', 'headline.dockGapCompact',
  'headline.size', 'headline.sizeCompact', 'subline.size', 'subline.sizeCompact',
]);

const MS_VARS = new Set(['dock.iconAnimMs']);
const EM_VARS = new Set(['headline.tracking', 'headline.gap', 'subline.tracking']);

// Config values stay in px for the panel sliders; these keys were rem in the
// stylesheet, so they are emitted as rem (value / 16) and follow the visitor's
// browser font size. At a 16px root the pixels are unchanged.
const REM_VARS = new Set(['dock.gap', 'dock.padding', 'type.size', 'type.monoSize']);

// Groups and keys that are data for JS, not styling: no stylesheet reads a variable for them (grid.js,
// dock.js and main.js take them from the config object), so none is written.
const NOT_CSS = new Set(['copy']);
const NOT_CSS_KEYS = new Set([
  'grid.tile', 'grid.gap', 'grid.columns', 'grid.rowGap',
  'grid.columnsCompact', 'grid.aspectMode', 'grid.aspectMin', 'grid.aspectMax', 'grid.rowShift', 'grid.shiftMode', 'grid.rowSpeed', 'grid.seed',
  'motion.bow', 'motion.bowVelocity', 'motion.bowSmooth', 'motion.coast', 'motion.idle', 'motion.idleMode', 'motion.bulge', 'motion.reach', 'motion.glide', 'motion.vignette', 'motion.shade', 'motion.edge',
  'toast.duration', 'dock.iconRevertMs',
  // The fader is drawn into a canvas by fader.js (the ellipse, its colour and the baked-in grain); only its
  // opacity is a CSS variable.
  'color.fader', 'fader.width', 'fader.widthCompact', 'fader.height', 'fader.heightCompact', 'fader.offset', 'fader.offsetCompact',
  'fader.softness', 'fader.grain',
  'fader.mode', 'fader.rowOpacity', 'fader.rowSpread', 'fader.headlineStrength', 'fader.dockStrength',
]);

// fader.mode values, in panel order. An unknown mode behaves like the default ('ellipse').
export const FADER_MODES = ['ellipse', 'rows', 'both', 'off'];
export const faderShowsEllipse = (mode) => mode !== 'rows' && mode !== 'off';
export const faderShowsRows = (mode) => mode === 'rows' || mode === 'both';

const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

export function configToCssVars(config) {
  const vars = {};
  for (const [group, values] of Object.entries(config)) {
    if (NOT_CSS.has(group)) continue;
    for (const [key, value] of Object.entries(values)) {
      const id = `${group}.${key}`;
      if (NOT_CSS_KEYS.has(id)) continue;
      const unit = PX_VARS.has(id) ? 'px' : EM_VARS.has(id) ? 'em' : MS_VARS.has(id) ? 'ms' : '';
      vars[`--${kebab(group)}-${kebab(key)}`] = REM_VARS.has(id) ? `${value / 16}rem` : `${value}${unit}`;
    }
  }
  return vars;
}

export function applyConfig(root, config) {
  for (const [name, value] of Object.entries(configToCssVars(config))) {
    root.style.setProperty(name, value);
  }
}

// Independent deep copy, so a caller can edit its config without touching the defaults.
export function cloneConfig(config) {
  return structuredClone(config);
}
