# Gaffer Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Gaffer landing page: a fullscreen infinite domed grid of looping clips with a persistent install-prompt dock, deployed to GitHub Pages at gafferae.com, with the look decided live through a dev-only tweak panel.

**Architecture:** Plain HTML, CSS and JS modules in `site/`, no build step, no dependencies. Pure logic (grid math, item assignment, config, copy) lives in small modules with Node tests; DOM code (grid, media, dock, tweak) sits on top and is checked in the browser. A Node script builds `items.json` and any missing first-frame posters; GitHub Actions publishes only `site/`.

**Tech Stack:** Vanilla JS (ES modules), CSS custom properties, Node (`node --test`, no packages), ffmpeg/ffprobe, GitHub Actions + Pages.

**Spec:** `docs/superpowers/specs/2026-10-07-landing-page-design.md`. Grid technique reference: the `no-gl-grid` skill (`anthropic-skills:no-gl-grid`); read it before Task 3 and Task 5.

## Global Constraints

- Install prompt (one constant in the source): `Install Gaffer by following https://gafferae.com/install.md`
- Domain `gafferae.com` via `site/CNAME`. No framework, no bundler, no dependencies, no analytics, no cookies, no third-party requests; fonts self-hosted.
- Tiles keep each clip's own shape in rows of one shared height (row rings; square mode makes them 1:1); clips keep the source height capped at 800px (never upscaled) at their native aspect clamped to 0.5..2.4 by centre crop (`add-sample.sh --square` crops square, same cap); H.264 CRF 20 (`-tune animation`) plus an HEVC `<slug>.hevc.mp4` at CRF 23 (`hvc1`), BT.709 tagged, no audio, faststart; the page picks HEVC via canPlayType with H.264 fallback; warn above ~6 MB per file.
- Posters: a hand-made `site/media/<slug>.jpg` wins; otherwise the first frame is generated into `site/media/_generated/<slug>.jpg` (gitignored). A missing poster never fails the build.
- At most 12 videos playing at once; others stay on poster. Videos are `muted playsinline loop`, paused when off-screen or tab hidden.
- Cards have no hover state (hover scale removed in the styling pass); the cursor bulge on the dome is the only pointer reaction. No click behaviour on cards, no flip panel, no lightbox, no "How it works" link.
- Dock note: "Requires Claude Code" with two links (desktop app, CLI); targets verified against Anthropic's live pages, not written from memory.
- Copy confirmation is a toast of about 2 s plus an `aria-live` announcement; a failed copy says so and leaves the prompt text selected.
- Sliders in the tweak panel are custom pointer-driven controls (not native range). The tweak panel loads only on dev hosts (loopback, tailnet 100.64.0.0/10, `*.ts.net`, dotless machine names; `site/js/devhost.js`) and both files are deleted at launch.
- `prefers-reduced-motion`: posters only, no dome animation or cursor bulge; drag still works.
- User-facing copy uses commas and periods, never em-dashes.
- Commits to this public repo use `spendolas@users.noreply.github.com` as the author email. Work on branch `feat/landing-page`.

## Review Focus

- Zero clips in `site/media/`: page still renders the dock and an empty stage, no crash. (Task 2, Task 5)
- Exactly one clip: grid tiles it everywhere without looping forever in the shuffle. (Task 3)
- Clipboard blocked or unavailable (insecure context, denied permission): fallback copy, then a visible failure toast. (Task 6)
- Window resize or phone rotation mid-drag: stale geometry must not overwrite fresh geometry. (Task 5)
- Clip filenames with spaces, capitals or unicode: ids and URLs stay valid. (Task 2)

---

## File Structure

```
site/
  index.html, css/site.css
  js/main.js        boot: load manifest, apply config, start grid + dock, localhost-only tweak
  js/math.js        pure grid math + item assignment
  js/config.js      defaults object, configToCssVars, applyConfig
  js/presets.js     three starting looks
  js/grid.js        DOM grid: layout, wrap, warp, input, hover, rAF
  js/media.js       manifest load, card media, video pool
  js/dock.js        INSTALL_PROMPT, copyText, createToast, dock wiring
  js/tweak.js       dev-only panel (localhost), custom sliders, presets, copy settings
  media/            compressed clips; media/_generated/ (gitignored)
scripts/site/
  add-sample.sh, build-manifest.mjs
  math.test.mjs, config.test.mjs, build-manifest.test.mjs, dock.test.mjs
.github/workflows/pages.yml
```

Tests live in `scripts/site/` (not `site/`) so they are never published. Run all: `node --test scripts/site/`.

---

### Task 1: Branch, ignore rules, `add-sample.sh`, first clips

**Files:**
- Create: `scripts/site/add-sample.sh`, `site/media/*.mp4` (from the three `_v2` ProRes clips)
- Modify: `.gitignore` (add `site/media/_generated/` and `site/items.json`)

**Interfaces:**
- Produces: `scripts/site/add-sample.sh <input> [slug]` writes `site/media/<slug>.mp4` (480x480, H.264, no audio, faststart, CRF 28, centre-cropped); exits non-zero if `ffmpeg` is missing; prints a warning above 4 MB and the `git add` line. Slug defaults to the lowercased input basename with non-alphanumerics turned to `-`.

- [ ] **Step 1:** `git switch -c feat/landing-page`; confirm `git config user.email` is the noreply address, else set it for this repo. Commit the spec and this plan.
- [ ] **Step 2:** Write `add-sample.sh` (bash, `set -euo pipefail`, crop filter `crop='min(iw,ih)':'min(iw,ih)',scale=480:480:flags=lanczos`).
- [ ] **Step 3:** Run it on `exports/prores/lego_brick_v2.mov`, `menu-hover_v2.mov`, `spinners_loop_v2.mov`.
- [ ] **Step 4:** Verify: `ffprobe` on each output reports `h264`, `480x480`, no audio stream; each file is under 4 MB. Run the script with `PATH` stripped of ffmpeg and confirm the non-zero exit and message.
- [ ] **Step 5:** Commit (`git add scripts/site/add-sample.sh site/media .gitignore`).

### Task 2: `build-manifest.mjs`

**Files:**
- Create: `scripts/site/build-manifest.mjs`, `scripts/site/build-manifest.test.mjs`

**Interfaces:**
- Produces: `buildManifest({ mediaDir: string, outFile: string, ffmpegBin?: string, ffprobeBin?: string }): Promise<Item[]>` where `Item = { id: string, video: string, poster: string, webm?: string, width: number, height: number }`. Paths are site-relative and URL-safe (`media/<file>`, `media/_generated/<id>.jpg`), items sorted by filename. Also runnable as `node scripts/site/build-manifest.mjs` (defaults `site/media` and `site/items.json`).

- [ ] **Step 1:** Write failing tests using a temp dir and tiny clips made with `ffmpeg -f lavfi -i testsrc`: `ordersByFilename`, `generatesPosterWhenMissing` (file exists in `_generated`, manifest points to it), `handMadePosterWins` (no `_generated` file is created), `emptyDirGivesEmptyArray` (writes `[]`), `idIsUrlSafeForSpacesAndCapitals` (`My Clip 2.mp4` gives id `my-clip-2` and a video path that survives `encodeURI` unchanged), `webmIsOptional`, `missingFfmpegThrowsClearError`.
- [ ] **Step 2:** Run `node --test scripts/site/build-manifest.test.mjs`; expect FAIL (module missing).
- [ ] **Step 3:** Implement. Poster frame via `ffmpeg -i <mp4> -frames:v 1 -q:v 3`; dimensions via `ffprobe`; throw only when a video cannot be read or ffmpeg is absent.
- [ ] **Step 4:** Run tests; expect PASS. Run the script for real and open `site/items.json` to confirm three items.
- [ ] **Step 5:** Commit.

### Task 3: Grid math and item assignment (`math.js`)

**Files:**
- Create: `site/js/math.js`, `scripts/site/math.test.mjs`

**Interfaces:**
- Produces (all pure, points are `{x, y}`):
  - `wrap(min: number, max: number, v: number): number`
  - `damp(from: number, to: number, rate: number, dt: number): number` (`from + (to - from) * (1 - (1 - rate) ** (dt * 60))`)
  - `warpPoint(px: number, py: number, o: { halfW: number, halfH: number, bow: number, cursor: Point, bulge: number, bulgeWeight: number, reach2: number }): Point`
  - `insetQuad(q: { tl: Point, tr: Point, bl: Point, br: Point }, gap: number): typeof q` (each corner moves `gap/2` along its two own edges)
  - `scaleQuad(q, s: number): typeof q` (about the quad's centre)
  - `homography(w: number, q: Quad): string` returning the `matrix3d(...)` string from the skill, for a card of width `w` mapped onto quad `q`
  - `itemForCell(col: number, row: number, count: number, seed?: number): number` (returns `-1` for count 0, `0` for count 1)

- [ ] **Step 1:** Write failing tests: `wrapStaysInRange` (including negatives), `dampConvergesAndIsFrameRateIndependent` (one 1/30 step equals two 1/60 steps), `warpIsIdentityAtZeroBowAndBulge`, `warpSpreadsRimByOnePlusBow`, `insetKeepsGapConstant` (two neighbouring warped period boxes, inset, leave a gap of exactly `gap` along their shared edge), `homographyMapsUnitRectToItself` (identity quad yields translate-only matrix), `homographyMapsCornersOntoQuad` (apply the matrix with a small helper and check all four corners), `itemForCellNeverRepeatsNeighbours` (over a 40x40 range for counts 2..7, never equals left or up neighbour), `itemForCellIsDeterministic`, `itemForCellCoversAllItems`, `itemForCellHandlesOneAndZero`.
- [ ] **Step 2:** Run `node --test scripts/site/math.test.mjs`; expect FAIL.
- [ ] **Step 3:** Implement from the skill's formulas. `itemForCell`: seeded hash of `(col, row)` over `count`, nudged forward until it differs from the left and up neighbours' values; the neighbour recursion must be bounded (compute neighbours with the plain hash, not recursively).
- [ ] **Step 4:** Run tests; expect PASS.
- [ ] **Step 5:** Commit.

### Task 4: Config, presets, CSS variables

**Files:**
- Create: `site/js/config.js`, `site/js/presets.js`, `scripts/site/config.test.mjs`

**Interfaces:**
- Produces:
  - `defaults: Config` with groups `color` (stage, dockFill, button, buttonText, text, textMuted), `grid` (tile, gap, radius, columns), `motion` (bow, bulge, reach, hoverScale, glide, vignette), `glass` (blur, fillOpacity, borderOpacity), `shadow` (strength, blur), `type` (ui, mono).
  - `configToCssVars(config: Config): Record<string, string>` (e.g. `grid.radius` becomes `--grid-radius: 12px`; unitless values stay unitless).
  - `applyConfig(root: { style: { setProperty(k: string, v: string): void } }, config: Config): void`
  - `presets: { nightGlass: Config, warmGraphite: Config, paper: Config }`, each a complete config.

- [ ] **Step 1:** Write failing tests: `everyPresetHasEveryDefaultKey`, `cssVarNamesAreStable` (pin three names), `applyConfigSetsEveryVar` (fake root), `radiusAndGapGetPx`.
- [ ] **Step 2:** Run `node --test scripts/site/config.test.mjs`; expect FAIL.
- [ ] **Step 3:** Implement. Start values for `nightGlass` match the Figma scaffold (stage `#0B0B0C`, tile 240, gap 16, radius 12, bow 0.15, bulge 0.25, hover 1.08); `warmGraphite` and `paper` are plausible alternates.
- [ ] **Step 4:** Run tests; expect PASS.
- [ ] **Step 5:** Commit.

### Task 5: Skeleton page: grid, media, boot

**Files:**
- Create: `site/index.html`, `site/css/site.css`, `site/js/main.js`, `site/js/grid.js`, `site/js/media.js`

**Interfaces:**
- Consumes: `math.js` (Task 3), `config.js` (Task 4), `items.json` (Task 2).
- Produces: `createGrid(stage: HTMLElement, o: { items: Item[], getConfig: () => Config }): { destroy(): void }`; `loadItems(url?: string): Promise<Item[]>` (returns `[]` on 404 or invalid JSON); `createVideoPool(o?: { max?: number }): { register(card: HTMLElement, item: Item): void, setVisible(cards: Set<HTMLElement>): void }`.

- [ ] **Step 1:** Write `index.html` (viewport meta with no zoom, hidden `<h1>Gaffer</h1>`, `#stage`, `#dock` placeholder, `<noscript>` note) and `site.css` (document lock, `touch-action: none`, `translateZ(0)` layers, tokens read from the CSS variables).
- [ ] **Step 2:** Implement `grid.js` per the skill and spec: tile `columns+2` by `ceil(vh/period)+2` (the `+2` is load-bearing), one `matrix3d` per visible card per frame only while something moves, off-screen cards get one parking write, resize guarded by a generation counter, `ResizeObserver` plus orientation change. Input: wheel, pointer drag (pointer events, `setPointerCapture`, window-level move/up/cancel), keyboard arrows/space. Hover: per-card damped scale via `scaleQuad`, raised z-index. Flashlight via mask with smoothstep stops; on touch, centred at double radius.
- [ ] **Step 3:** Implement `media.js`: card shows its poster, attaches the video source lazily on first entry to the padded visible area, plays only visible cards, cap 12, pauses on `visibilitychange`; reduced motion keeps posters only. Items come from `itemForCell`; with more items than cards, a card swaps its clip when it wraps off-screen.
- [ ] **Step 4:** Implement `main.js`: `applyConfig(document.documentElement, defaults)`, load items, start the grid, cover until posters settle (timeout cap 2 s).
- [ ] **Step 5:** Verify with `python3 -m http.server -d site 8000` and the browser pane at 1440x900, 768x1024, 390x844: drag and wheel pan infinitely in all directions with no pop at the rim, hover scales one card, videos play only in view, no console errors. Repeat with `site/media` emptied (stage renders, no errors) and with one clip (tiles fill).
- [ ] **Step 6:** Commit.

### Task 6: Dock, copy, toast (`dock.js`)

**Files:**
- Create: `site/js/dock.js`, `scripts/site/dock.test.mjs`
- Modify: `site/index.html`, `site/css/site.css`, `site/js/main.js`

**Interfaces:**
- Produces: `INSTALL_PROMPT: string`; `copyText(text: string, env: { clipboard?: { writeText(t: string): Promise<void> }, execCopy?: () => boolean }): Promise<"clipboard" | "fallback" | "failed">`; `createToast(el: HTMLElement, o?: { duration?: number }): { show(message: string, kind?: "ok" | "error"): void }` (default duration 2000 ms, writes to an `aria-live="polite"` region); `mountDock(root: HTMLElement, o: { toast, env }): void`.

- [ ] **Step 1:** Write failing tests for `copyText`: `usesClipboardWhenAvailable`, `fallsBackWhenClipboardRejects`, `fallsBackWhenClipboardMissing`, `failsWhenBothFail`; plus `INSTALL_PROMPT` equals the exact constant in Global Constraints.
- [ ] **Step 2:** Run `node --test scripts/site/dock.test.mjs`; expect FAIL.
- [ ] **Step 3:** Implement the pure parts. DOM: pill with visible selectable prompt text, **Copy install prompt** button, and the "Requires Claude Code" note with two links; compact variant under ~600 px (no visible prompt text, button still copies the full prompt); focus ring; on failure the toast says so and the prompt text is selected.
- [ ] **Step 4:** Verify the two link targets against Anthropic's live pages (desktop app download, Claude Code CLI docs) and use those URLs.
- [ ] **Step 5:** Run tests; expect PASS. In the browser, confirm copy works, the toast shows about 2 s, and with clipboard disabled (`navigator.clipboard` deleted in devtools) the fallback or the error toast appears.
- [ ] **Step 6:** Commit.

### Task 7: Tweak panel and presets (dev only)

**Files:**
- Create: `site/js/tweak.js`
- Modify: `site/js/main.js` (dynamic import only on `localhost` / `127.0.0.1`)

**Interfaces:**
- Consumes: `defaults`, `applyConfig`, `presets` (Task 4).
- Produces: `mountTweak(o: { getConfig: () => Config, setConfig: (c: Config) => void }): void`. Opens with the T key; groups for colour, grid, motion, glass, shadow, type; preset buttons (Night glass, Warm graphite, Paper); Reset; **Copy settings** (current config as JSON to the clipboard, with a toast). Values persist in `localStorage` under `gaffer-tweak` (reads and writes wrapped in try/catch; page works without it).

- [ ] **Step 1:** Implement a custom slider (a `<div>`: on `pointerdown` call `preventDefault()` and `setPointerCapture`, compute the value from `clientX` against the track rect with clamp and step snap, track move/up/cancel on `window`, `touch-action: none`) and a colour field. Do not use `<input type="range">`.
- [ ] **Step 2:** Wire controls to `setConfig` so changes show live; grid-size changes trigger the grid's resize path.
- [ ] **Step 3:** Verify in the browser: every control changes the page live; presets switch looks; Copy settings yields valid JSON that round-trips through `applyConfig`; panel absent when served from a non-localhost host (check by loading via the machine's LAN IP).
- [ ] **Step 4:** Commit.

### Task 8: Styling pass (conversation checkpoint)

This task is done with the user in the session, not by an agent alone.

- [ ] **Step 1:** Start the local server and show the page; hand the user the tweak panel and the three presets.
- [ ] **Step 2:** The user picks values; they paste the **Copy settings** JSON (or name the preset).
- [ ] **Step 3:** Bake the chosen values into `defaults` in `config.js`; update `config.test.mjs` pinned values if they changed.
- [ ] **Step 4:** Style the toast and decide whether the dock keeps a Copied state; apply.
- [ ] **Step 5:** Delete `tweak.js`, `presets.js`, and the dynamic import in `main.js`; confirm `grep -r tweak site/` finds nothing; run `node --test scripts/site/`.
- [ ] **Step 6:** Commit.

### Task 9: Ship pipeline, `install.md`, domain

**Files:**
- Create: `.github/workflows/pages.yml`, `site/CNAME` (content `gafferae.com`), `site/install.md`
- Modify: `site/index.html` (title, description, Open Graph tags; OG image is the first item's poster)

**Interfaces:**
- Consumes: `buildManifest` (Task 2).

- [ ] **Step 1:** Write `pages.yml`: on push to `main` with changes under `site/` or `scripts/site/`; steps run `node --test scripts/site/`, `node scripts/site/build-manifest.mjs` (the runner image provides ffmpeg; install it if absent), then `actions/upload-pages-artifact` with `path: site` and `actions/deploy-pages`; permissions `pages: write`, `id-token: write`.
- [ ] **Step 2:** Write `install.md` as pinned, deterministic steps an agent can follow on Mac and Windows: derive them from the README install section and `scripts/install-mac.sh` / `install-win.ps1`; use the latest GitHub Release assets (`gaffer-install-mac.tar.gz`, `gaffer-install-win.zip`) with no hard-coded version; end with a verification step. Plain commas and periods, no em-dashes.
- [ ] **Step 3:** Verify `install.md` end to end: paste the install prompt into a fresh Claude Code session on this Mac and confirm it installs and the panel loads; the Windows path is checked on the Windows test VM.
- [ ] **Step 4:** Commit and push the branch; open a PR. After merge, the user enables Pages (source: GitHub Actions), sets the custom domain, and adds the DNS records at the registrar (these steps are the user's; list the exact records in the PR description).
- [ ] **Step 5:** After the first deploy, load `https://gafferae.com`, confirm clips play, the dock copies, and `https://gafferae.com/install.md` serves raw text.
