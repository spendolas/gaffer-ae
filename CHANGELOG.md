# Changelog

## v0.10.6 - 2026-09-25

**The version picker is simpler, and Gaffer now defaults to the latest Opus instead of an older pinned one.**

- Removed the 1M context toggle. It was mostly there already: every current model uses its full context window automatically, so the toggle was just confusing without doing anything. Picking a specific older model version still works exactly as before.
- Changed the default model from a pinned older Opus version to the latest one. Pinning turned out not to save any money, so there was no reason to hold back. Effort stays on Medium.
- Usage sharing now also records which Gaffer version, After Effects version, and OS sent each report, and chat messages are timestamped going forward.

## v0.10.5 - 2026-09-25

**Every button now reads in the right font, and the sign-in screen is pixel-checked against the real design.**

- **Buttons across the whole panel were rendering in the browser's fallback font instead of Source Sans.** All 26 of them now use the correct font.
- **The sign-in screen's card background is gone**, matching the design, which turns it off on purpose — the panel was drawing a dark card behind the sign-in message that was never meant to be there. Two minor alignment fixes on the same screen.
- The design-parity check tool can now actually check the sign-in screen at all — it had no way to capture it before, so it was silently skipped every time.

## v0.10.4 - 2026-09-24

**The reply tray, update banner, and attachment preview now always stack in the right order above the chat input.**

- Fixed the stack above the chat input being backwards: the attachment preview could end up sitting closest to the input, and the reply-quote tray furthest away, the opposite of the intended order (quotes closest, then the update banner, then attachments). The order is now pinned directly, so a future change can't flip it again by accident.

## v0.10.3 - 2026-09-24

**Two AE windows no longer share one conversation, and Gaffer stops guessing wrong about Figma.**

- **Two open AE instances now get their own separate conversations.** Previously every connected AE window shared one chat behind the scenes, so a fresh conversation in one window could pick up another window's history, Stop could cancel the wrong window's turn, and one window's usage could reset the other's chat early. Each AE instance now keeps its own conversation, process, and reset timing, fully separate.
- **Gaffer now knows Grip is your live Figma connection.** With both Grip and another Figma connector enabled, Gaffer could reach for the other one, find it not signed in, and wrongly tell you it had no Figma access at all, even though Grip was connected the whole time. Gaffer now knows Grip is the one that sees your actual open file and prefers it, and if a connector genuinely needs signing in, it points you at Settings instead of a command that does not exist in the panel.

## v0.10.2 - 2026-09-14

**Signing out for good no longer looks like Gaffer stuck loading forever.**

- **An expired sign-in now correctly asks you to sign in again**, instead of leaving the panel stuck on a loading screen with no way out. Previously, once a session genuinely expired, Gaffer could mistake that for "still checking" and wait forever instead of showing the sign-in screen.
- **The panel now gives up gracefully after a few seconds if it truly cannot tell whether you are signed in**, rather than waiting indefinitely. Clicking sign in always recovers a working session.

## v0.10.1 - 2026-09-13

**Your chat never quietly changes model, and the panel never shows a chat you cannot actually use.**

- **A chat is only ever summarized by the model you picked for it.** When a chat reset itself, it could previously hand the summarizing job to a different model, which quietly changed the model behind your conversation and cost noticeably more to do. Now the chat's own model always writes the summary, and if it genuinely cannot, the reset is skipped rather than switching models behind your back.
- **Chats on the large 1M context run a little longer before resetting**, so you keep more history in one go.
- **The panel no longer briefly shows a working chat before it knows you are signed in.** On a machine without Claude Code installed, or before sign-in finished, the panel could paint a full chat window for a moment and then replace it with the sign-in screen. It now waits until it knows, so what you see is always real.
- Clearer wording on two messages that appear when a conversation is reset or a previous session has expired.

## v0.10.0 - 2026-09-09

**Long chats now cost far less, and stay fast, because they finally reset themselves.**

- **The conversation reset that was supposed to keep chats affordable now actually works.** It was silently broken and had never once fired, so a single chat could stay alive for days and quietly re-read its entire history on every message, running up real cost. Chats now summarize themselves and start genuinely fresh once they grow large, keeping the running cost bounded.
- **The reset point is sized to your context window, and summaries are cheaper to make.** Chats on the large 1M context run much longer before resetting, so you keep more continuous history, while standard chats reset earlier to stay under their smaller window. The reset summary is now written by the same model the chat was already using when its window allows, which is faster and cheaper than spinning up a different one.
- **Chats no longer reset far too early.** The check that decides when a chat is large enough to summarize was over-counting any turn that used several tools at once, so a chat could reset after a single question while it was still small. It now measures the true size of the conversation, so a chat resets only when it is genuinely large.
- **"Save tokens (beta)" has been removed.** The optional setting that automatically re-routed simpler prompts to cheaper models is gone. Chats now always run on exactly the model and effort you pick. If you had it turned on, your chats will simply run on your chosen model from now on.
- **"Clear chat" now truly starts over.** Clearing the chat used to wipe only the window while the assistant quietly kept the old conversation in memory and picked it back up on your next message. It now starts a genuinely fresh conversation.
- **Runaway scripts can no longer freeze After Effects.** A script that loops without end is stopped early, and AE stays responsive.
- **On Windows, Gaffer now finds Claude Code installed the normal way.** A Claude Code installed with the official installer lands in a spot Gaffer did not check, so a correct install could still read as "Claude CLI not found." Gaffer now looks there too, so it works without any extra setup.
- **The update prompt never offers an older version.** The check that decides whether an update is available now compares versions properly, so a newer install is never told to "update" to an older release.
- The "conversation compacted" notice now describes what actually happens, instead of implying a hard limit was hit.

## v0.9.9 — 2026-09-01

**Windows daemon stop is forceful from the start, plus a self-serve fix for a stuck update.**

- **Windows updates stop the daemon reliably.** The updater used to try a graceful close first, but a plain background daemon process often doesn't respond to that at all on Windows — it now force-stops immediately, removing a second way an update could stall.
- **A stuck update now offers Force stop & retry**, right in the update banner, instead of just failing with a note to check a log file.

## v0.9.8 — 2026-09-01

**Windows updates no longer abort partway through.**

- **Updates finish reliably on Windows.** A single background process that resisted being closed, or an ordinary `npm` warning during dependency install, could previously abort the whole update script mid-run and leave files half-replaced. The updater now rides through both cases and completes normally; a real `npm install` failure still stops the update and reports it.

## v0.9.7 — 2026-09-01

**Big operations keep After Effects responsive, plus chat polish.**

- **Long and bulk operations no longer freeze After Effects.** Work that touches many layers, keyframes, or precomps now runs in small time-sliced chunks so AE stays responsive throughout, with progress shown and the ability to cancel partway. Previously a single long script could lock AE up until it finished.
- **The chat caret tells the truth about focus.** It shows only when the panel actually has the keyboard. After you switch to another app and back, AE keeps the keyboard until you click the panel, so the caret now stays hidden (a "click to type" cue) instead of looking ready when typing would land in AE. It returns the moment you click in.
- **The chat opens at your latest message, even with images.** Conversations with images no longer open scrolled part-way up while the images finish loading.
- **Assistant messages use a bit more width.**
- **The text-size reset now reads "Reset text."**

## v0.9.6 — 2026-08-31

**Settings polish: model, account, and dialog surfaces.**

- **Settings open faster and work offline.** Gaffer remembers your available models for a day and reads your account details locally, so Settings opens right away, without a spinner or a network round-trip, and keeps working during brief login-token gaps. It refreshes quietly after a chat and re-checks when you sign in or out.
- **Models without effort levels read clearly.** A model that offers no effort setting now shows a "Not offered" control the same size as the normal effort slider, instead of a blank or missing one.
- **The account panel no longer flashes "signed out."** While Gaffer checks your Claude Code login it shows a brief spinner, then fades in your account, instead of briefly showing the signed-out state first.
- **No phantom "Update" button.** After a reload the Update control no longer appears for a moment when nothing is available; it shows only once a check confirms a newer version.
- **Clearer sign-out explanation**, and dialog text no longer leaves a single word stranded on its own line.
- **Tidier dialogs.** Some dialogs can be dismissed from a header, a "don't show again" option is available, and there is a way to reset dialogs you have hidden.
- **Activity summary.** The details toggle now clearly reads Show / Hide MCPs.

## v0.9.5 — 2026-08-30

**Updates apply without a restart, plus cleaner chat formatting.**

- **Updates now restart the daemon.** Previously an update replaced the panel files but left the old background process running, so fixes silently did not take effect until you quit After Effects, and model settings could show "Couldn't check models." Updates now restart it cleanly, and wait for any work in progress to finish first so nothing is cut off.
- **Replies use the full width again.** A hidden line cap had crept in that squeezed long answers into a narrow column; agent replies now fill the bubble as before.
- **Checklists render right.** A task list (the `- [ ]` / `- [x]` kind) now shows a single checkbox per item, instead of a checkbox sitting next to a stray bullet.
- **List items stay put.** A list item with more than one paragraph no longer runs its paragraphs together on one line.
- **Images fit the bubble.** A wide image in a reply is capped to the chat width instead of spilling past the edge.

## v0.9.4 — 2026-08-30

**Simpler model settings.**

- **No more "Allow" step for models.** Opening Settings now goes straight to your models on every platform, with a brief spinner while it checks. The old macOS "Allow, then approve the system prompt" step is gone: Gaffer reads your Claude Code login without any system prompt (it never actually appeared), so the extra clicks and the wait-for-a-dialog message were pure friction. If a check can't complete, you get a simple Try again.

## v0.9.3 — 2026-08-30

**Model discovery survives an expired login token.**

- **Root fix for the stuck / failed model check.** The model list is fetched with your Claude Code login token, which is short-lived and only refreshes when the CLI itself makes a call (like a chat). If you opened Settings during a quiet gap, the token could be expired and the check failed. Now Gaffer notices an expired token and shows the last models it successfully loaded, instead of failing or spinning. It also refreshes that list in the background right after a chat, when the token is fresh again. (Supersedes the v0.9.2 attempt, which could reuse the expired token.)

## v0.9.2 — 2026-08-30

**Model discovery reliability on macOS.**

- **The model check no longer stalls on reopen.** The daemon now reads your Claude Code credential once and reuses it, instead of re-reading the macOS Keychain every time Settings opens. That repeated read could wedge on a background approval that never surfaced, leaving the model section stuck on the loading spinner the second time you opened Settings. It reuses the credential for the session and re-reads only if it stops working.
- **No more infinite spinner.** If a model check ever fails to come back, the section now falls to a retry state instead of spinning forever.

## v0.9.1 — 2026-08-30

**Model access, sign-in, and composer polish.**

- **Choose your models, on your terms.** Settings now asks Claude Code which models your account can use, behind a one-tap opt-in (with a first-visit explainer on macOS before the system prompt). The model, version, and per-model effort picker appear once the check succeeds; a clean spinner covers the check and a retry path covers failures.
- **The account card tells the truth.** The panel reads your Claude Code session on connect, so the Settings account row shows who you are signed in as instead of a stale "Signed out," and the model section follows the same state.
- **Sign in from Settings.** The signed-out account row now has a Sign in button, and the "Bring your API key" copy is fixed.
- **Composer feel.** The whole prompt pill is clickable to focus, with a text cursor to match, and the caret no longer hides behind the placeholder text.
- **Smoother Settings.** The model section fades between states without a size jump, and the "Allow" prompt no longer flashes when the panel is already set up.

## v0.9.0 — 2026-08-29

> **Superseded by v0.9.1.** This build shipped with known issues (stale "Signed out" account card, a flashing "Allow" prompt in Settings, and a caret rendering glitch in the composer). Update to v0.9.1.

**A calmer, more capable panel.**

- **Settings, rebuilt** — updates, Auto-lighten, reply sounds, account status, model family/version, and each model's supported effort levels now live in one polished full-screen settings card. The sounds picker previews every cue and grows with the A−/A+ text scale so names stay readable.
- **Model controls are honest** — Settings refreshes the installed Claude CLI on open, gates 1M context and effort by the published model-generation matrix, and never treats historical local model state as proof of account entitlement. Haiku 4.5 no longer gets an effort slider or 1M option; pinned Opus/Sonnet generations get their actual effort ranges.
- **Sign in and out safely** — signed-out users get a focused Claude sign-in screen, missing-CLI installs get a useful recovery path, and signing out clearly warns that it affects Claude Code across the whole machine.
- **Better feedback** — native-looking alert modals replace browser alerts, clear-chat requires confirmation, and the new toast system stacks, dismisses, and reflows smoothly without colliding with the rest of the panel.
- **A broad visual pass** — controls, icons, spacing, colours, text scaling, the activity drawer, composer, settings rows, and effort slider now follow the shared design system throughout the panel.
- **Safer internals** — development reloads wait until the daemon is idle, Auto-lighten's local routing is more conservative, and unfinished API-key UI plus diagnostic toast shortcuts stay gated out of the end-user experience.

## v0.8.0 — 2026-08-24

**Token optimization (under the hood).**

- Panel chat now sheds replayed image payloads from the resumed transcript: frame captures and reference PNGs read earlier in a conversation are stubbed to a one-line pointer once they fall outside a recent window, cutting per-turn input tokens on image-heavy sessions by ~85% while keeping the conversation, thinking, and the most recent images intact. It rewrites the session file atomically and never touches a turn if anything looks off.
- The chat prompt now avoids re-reading an image it already has in context.
- New optional "Auto-lighten" setting (off by default): Gaffer sizes the model to the turn. Trivial turns (greetings, "what did you do?") drop to a light model, low effort, and standard context; middle-ground turns use a mid model; real build/animate/expression work is left at your full selection. It classifies each turn with a fast local check and, only for genuinely ambiguous ones, a quick lightweight call — never upshifting, never overriding a pinned model version, and decided fresh each turn (nothing is remembered).

## v0.7.1 — 2026-08-24

**Reply-quote polish.**

- The chat now reserves scroll room for the quote tray, so a message the tray overlaps can be scrolled into view instead of staying hidden behind it — and staging or dismissing a quote never jumps the conversation.
- The quote tray sits flush on the input pill's straight edge (no stray corner poking past the rounded input).
- A quoted snippet reads as muted context — bold, inline code, and links are all dimmed rather than shouting like they do in live chat.
- The chat grows and shrinks smoothly in step with the tray opening and collapsing; removing a quote animates cleanly.

## v0.7.0 — 2026-08-24

**Quote a chat message and reply to it.**

- **Copy or reply on selection** — select any text in the conversation and a small floating control appears: copy it, or reply-quote it. The reply stages the snippet above the input.
- **Reply-quote tray** — staged quotes sit in a pill above the composer, each with a wavy rule marker, matched 1:1 to the Figma design. Quote several at once; the × to unstage appears on hover and every removal animates cleanly. The tray tracks the A−/A+ text size.
- **Styling preserved** — a quoted snippet keeps its original formatting (inline code, bold, links), even when the selection spans multiple messages (surrounding UI is stripped out, not carried in).
- **Carried to Gaffer** — staged quotes are sent along as tagged context so Gaffer knows exactly what you're replying to, and they're stored with the message so they re-render on reload.
- Dev footer now shows the live git HEAD rather than the frozen release commit.

_Internal:_ a node-level Figma↔panel parity pipeline (`design/scripts`) — auto-discovering extractor, `data-fig` anchoring, and a property diff with a coverage ledger — replaces the hand-authored assertion list.

## v0.6.1 — 2026-07-30

**Panel polish — chat text sizing, reply sounds, and a colour pass.**

- **Adjustable chat text size** — an A−/A+ control in the activity bar scales the whole conversation *and* the composer together, 80%–160%, remembered across reloads. Tapping it never expands the drawer.
- **Reply sounds** (off by default) — an optional cue when Gaffer finishes while the panel is unfocused, chosen from a small set in the settings; a quiet radio tick when you enable/disable an MCP server; and a distinct error cue. It self-silences after a few unattended cues so nothing chirps all night.
- **Table-row hover** — hovering a markdown table row now highlights it.
- **Text colours matched to the design** — bold and headings, table header/data cells, code blocks, and the input placeholder now track their Figma tokens, with new warm `strong` / `strong-dimmed` emphasis colours (bold reads warm-and-heavy rather than glaring; bold inside a blockquote dims to suit).

## v0.6.0 — 2026-07-29

**Six new discovery tools** — the typed tool surface now covers essentially everything AE exposes for reading (mutations stay in `runJSX`, where the undo-group safety lives):

- `listMarkers` — comp + layer markers (time, duration, comment, chapter/url/cue-point)
- `listTextLayers` — text contents + type styling across the active comp or the whole project
- `getLayerEffects` — a layer's full effect stack with values, keyframe counts, and expressions
- `getShapeContents` — the shape-layer contents tree and all masks, with optional raw vertex data
- `getProjectTree` — the real project-panel hierarchy (folders, comps, footage, solids, parent ids)
- `getProjectSettings` — AE version/build, color depth and working space, expression engine, GPU acceleration, time display

All six verified end-to-end against a live AE fixture (12/12 assertions).

## v0.5.13 — 2026-07-14

Refinements from the Windows field handoff (thanks to the reporter's isolation harness):

- **Update spawn drops `detached` on Windows** — every flag combination containing it silently kills the child on Node v24/Win11 (verified isolation table); the child survives panel reloads regardless. macOS keeps its proven behavior.
- **Desktop-app CLI version dirs sort numerically** — lexicographic order put 2.1.9 above 2.1.121; the newest CLI is now actually picked, and a vanished cached binary (the version dir churns on every CLI auto-update) triggers re-discovery instead of dead spawns.
- `start.ps1` gets the same ASCII + UTF-8 BOM treatment as the other PowerShell scripts.

## v0.5.12 — 2026-07-14

All four Windows findings from the field, upstreamed:

- **The update-mechanism regression, solved** — the updater script had picked up typographic dashes in comments; Windows PowerShell 5.1 reads BOM-less files as Windows-1252 and fails parsing on them. Both .ps1 scripts are now ASCII-only with a UTF-8 BOM (and the repo rules forbid reintroducing this).
- **Updater spawn hardened** — `detached` + `stdio: 'ignore'` silently kills the child on some Node/Windows combos; the updater now logs to a file handle like the daemon spawn always did (`%TEMP%\gaffer-update-spawn.log`).
- **CLI discovery finds desktop-app installs** — `%APPDATA%\Claude\claude-code\<version>\claude.exe` is now scanned (newest first); previously only the standalone/WinGet paths were checked.
- Console windows hidden on all CLI child processes (shipped in 0.5.11, noted here for the set).

## v0.5.11 — 2026-07-14

- **No more cmd window flashes on Windows** — every CLI child process (`claude mcp list` on drawer expand, model discovery, auth, chat itself) now runs with a hidden console. Killing the flashed window used to kill the underlying command and error the MCP row.

## v0.5.10 — 2026-07-14

- Update banner hides its buttons while an update runs — just "Updating…" until the panel reloads itself

## v0.5.9 — 2026-07-14

- **Copy button fixed on Windows** — the clipboard fallback shelled out to macOS-only `pbcopy`, popping an AE error dialog ("cannot find the file specified"). Copy now uses the browser's synchronous clipboard command — no shell, works identically on both platforms.

## v0.5.8 — 2026-07-14

- **The Windows one-click update root cause** — `update.ps1` called bare `npm`, but the panel's Update button spawns PowerShell with CEP's stripped PATH, so npm never resolved and the script died before finishing (manual terminal runs always worked, which hid it). The updater now resolves npm from the standard Node.js install locations, like the macOS script always did.

## v0.5.7 — 2026-07-14

One-click update flow, actually end-to-end:

- **Panel waits for the updater to finish** — it polls the on-disk version and reloads only when the commit moves (previously it reloaded after 2s while the updater was still downloading, showing a false "did not complete" notice and never picking up the new code)
- **No daemon respawn mid-update** — the panel paused restarting the daemon while files are being replaced (a half-copied daemon grabbed the port and could lock node_modules during npm install); both updaters also stop any straggler daemon right before finishing
- Banner shows "Updating…" with the button disabled while the update runs

## v0.5.6 — 2026-07-14

- Update banner renders above the chat fader (was washed by the gradient)
- Update-flow verification release — first one-click update expected to succeed end-to-end on Windows

## v0.5.5 — 2026-07-14

- **MCP tiles redesigned (final form)** — fixed 48×40 rounded tiles: enabled = dark inset with blue glyph, available = bare with muted glyph, needs-auth/error = amber/red with dark glyph. Attention colors only where action is needed.
- **Vector-or-monogram icons** — the favicon pipeline is gone (inconsistent, platform-fragile); tiles show flat brand vectors from the simple-icons CDN (smarter name matching recovers e.g. Zoom) or a two-letter monogram. Trademark-removed brands (Slack, Adobe) intentionally wear monograms.
- **Tooltips carry state detail** — second line shows Connected / Available / Click to authorise / Authorising… / Error with the actual error title.
- **Windows: the Update button works** — spawn failures were silent (async error event never handled) so the updater never launched; now falls back properly and uses an absolute PowerShell path.

## v0.5.4 — 2026-07-14

Windows update-flow fixes:

- **Old daemon survived updates on Windows** — the process filter matched executable paths (always `node.exe`), so the stale daemon kept running and the reloaded panel reconnected to old code. Both the updater and installer now match by command line.
- **Failed updates are no longer silent** — if the updater dies before finishing, the panel says so after reload (with the log location) instead of just re-showing the update banner
- PowerShell runs with `-NoProfile` (user profiles can break or slow the updater)

## v0.5.3 — 2026-07-14

- **Stale-session self-heal** — when the Claude CLI's session storage is wiped (CLI updates, re-auth), the panel's saved session ID pointed nowhere and chats silently hung. The daemon now detects the dead `--resume`, notifies the panel, and retries once on a fresh session automatically — history text is preserved. Failed chats can no longer end silently: any zero-output error surfaces in the chat.
- **Brand-vector icons for everyone** — MCP tiles fetch flat single-color brand icons from the simple-icons CDN first (favicon fallback stays), so end-user installs get the same crisp glyphs as dev machines
- Icon cache probe no longer aborts on the first missing extension (icons were re-fetched every daemon start)

## v0.5.2 — 2026-07-14

Windows MCP tile rendering fixes:

- **Flat-glyph masking on Windows** — mask analysis now decodes icons via an origin-clean bitmap path, dodging the CEF builds that taint `file://` canvases (masks silently never computed there, leaving raw colored favicons)
- **Correct image types** — favicons are content-sniffed (many `/favicon.ico` files are really PNG); wrong declared types could break decoding
- **No more broken-image tiles** — undecodable icons fall back to the two-letter monogram instead of a broken image with alt text

## v0.5.1 — 2026-07-14

Clean-install simulation fixes (Windows focus):

- **npm-installed CLI shims can't be spawned** — binary discovery now only accepts a real `claude.exe` on Windows and otherwise fails with an actionable error (native installer command + `.gaffer-config.json` override)
- **Chat no longer depends on the installer's MCP registration** — the gaffer server is passed inline on every chat call, so chat works even if `claude mcp add` never ran (e.g. CLI installed after the panel)
- Installer's missing-CLI error now shows the actual install command

## v0.5.0 — 2026-07-14

- **Typography ships to everyone** — Source Sans 3 + Source Code Pro (both open-license) are now bundled, so end users get the designed type instead of system-font fallbacks. Adobe Clean is retired from the stack; dev and user machines render identically.
- **Type polish** — SemiBold weight cap across headings/bold/table headers, −2% tracking on code, monogram tiles restyled, chat notices unified with the hint style, deep markdown headings (h5/h6) clamp to the h4 size instead of leaking browser defaults.
- **Windows installer fixes** — installing over an existing setup now stops the running daemon and preserves chat history; the non-symlink fallback previously deployed a daemon without its dependencies (it could never start) — fixed. Model-version discovery also no longer depends on `$HOME` (unset on Windows).
- **Updating docs** — README now covers the update path, including manual updates from v0.1.0.

## v0.4.0 — 2026-07-14

Full visual redesign — the panel now matches the Gaffer design system 1:1 (verified numerically against the Figma spec, 55/55 checks).

- **New design system** — Adobe Clean typography, 47 design tokens, SVG icon set, restyled bubbles/markdown/code, pill input with animated send, floating status star with hover descriptions (status, clear, reload)
- **Panel background follows AE** — reads the host theme (and the brightness slider) instead of a fixed color
- **Chat scrolls behind the input** — with a gradient fader masking messages as they pass under; attachments tray and update banner float above the chat without ever shifting your scroll position
- **MCP server tiles** — color-coded states (blue enabled, amber needs-auth, red failed), brand icons with automatic favicon fetch + flat single-color conversion, usage-based ordering, hover tooltips
- **Model controls, discovered from your CLI** — model, context (Latest / 1M / pinned versions like 4.6) and reasoning effort selects; options come from the installed `claude` CLI, not hardcoded lists
- **Quieter tool activity** — tool chips reduced to a line of color-coded status dashes (name on hover); thinking dots return whenever the agent goes quiet mid-turn
- **Image attachments polish** — 80px ratio-preserving paste chips in a docked tray, redesigned drop overlay and lightbox
- **Fixes** — model dropdown clipping, MCP logo flicker and filled-blob icons, mixed-font line heights, scrollbar stopping at the input edge

## v0.3.0 — 2026-05-06

- **Per-install MCP multi-select** — pick which Connected MCP servers (Grip, Notion, Figma, etc.) the chat agent has access to, via the activity bar. Persisted per install, never committed to the repo.
- **14 new MCP tools** for AE introspection, search, capture, and render-queue work:
  - Discovery: `listFonts`, `listCompositions`, `getSelectedLayers`, `listFootage`, `listExpressions`, `listExpressionControls`, `getRenderQueue`, `getLayerKeyframes`
  - Search: `findLayers` (regex/effect/expression), `whereUsed`
  - Capture: `captureFrame` (any time, any comp), `captureLayer` (auto solo/restore)
  - Modify: `relinkFootage`, `addToRenderQueue` (queues only — never starts a render)
- **Image paste/drop input** — drop images anywhere on the panel or paste in the textarea. Full-panel "Drop image here" overlay, click-to-zoom lightbox, persisted thumbnails so bubbles survive panel reload.
- **Apple Silicon / minimal-PATH fix** — daemon augments PATH on the `claude` subprocess so stdio MCP servers (e.g. grip's bare `node` command) can spawn under CEP's stripped environment.
- **Cleaner tool pills** — dedupe by tool_use_id, descriptive labels, color states (running/done/error), proper transitions.

## v0.2.0 — 2026-04-24

- **Model picker** in panel — choose between Opus (default), Sonnet, Haiku per session
- **Auto-update check** — panel detects newer commits on `main`, shows update banner, one-click update
- **Settings UI** in activity bar — model dropdown, auto-check toggle, Check now button, version display
- **`importFromFigma` MCP tool** — deterministic Figma→AE layer translation
- Figma→AE translation rules added to `gaffer.md` (text positioning, shape contents order, drop shadow direction, squircle handling, @2x rules)

**Note for v0.1.0 users:** First-time update from v0.1.0 must be done manually via Claude Code. Tell Claude: "Update Gaffer from https://github.com/spendolas/gaffer-ae". Future updates auto-check from the panel.

## v0.1.0 — 2026-04-23

- Initial public release
- CEP panel with chat UI, daemon auto-start
- MCP tools: `runJSX`, `getProjectSummary`, `listEffectMatchNames`, `captureActiveComp`
- Install scripts for macOS and Windows
- README with download-from-tarball install (no git clone needed)
- Hardened install instructions with rules for Claude, idempotency guard, verification step
