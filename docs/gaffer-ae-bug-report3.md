# Gaffer AE — `capture*` tools jam Claude session when comp dimension exceeds 2000px

**Repo:** https://github.com/spendolas/gaffer-ae
**Affected version:** current `main` (commit `53963ec`).
**Severity:** Hard-stop on any session that captures a frame of a comp larger than 2000px in either axis. Every subsequent assistant reply errors out and the session is unrecoverable from the panel — only manual jsonl surgery or starting a new session restores chat.

---

## Environment

| Field | Value |
|---|---|
| OS | macOS (Darwin 25.4.0) |
| AE version | 2026 (26.x) |
| Claude Code | 2.1.x |
| Gaffer install path | `~/Library/Application Support/Adobe/CEP/extensions/com.gaffer.panel` |
| Comp size that triggered it | 2048 × 1024 (any comp ≥2001px in either axis will trigger) |

---

## Symptom

Mid-session, after several `captureActiveComp` / `captureFrame` / `captureLayer` calls have run, the panel starts replying with the exact same error to every user message:

```
An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.
```

The error never clears. Sending "ignore that image" or "keep going" produces the same response. The only escape from the panel UI is to start a new session, which discards all working context for the task.

---

## Root cause

The `capture*` MCP tools save raw, full-resolution PNGs at native comp dimensions and pass the file path back to Claude, which embeds them into the conversation as base64 image blocks. The Anthropic API enforces a 2000px-max-edge limit on images in many-image requests; once one capture exceeds that, every subsequent turn in the conversation re-sends the entire history (including that image) and is rejected.

In our session, the offending block was:

- session jsonl: `~/.claude/projects/.../92f6cf63-55b9-4207-9c61-1ddec13e3196.jsonl`, line 3244
- produced by `Read` of `gaffer-capture-1778084148144.png` (output of `captureActiveComp`)
- 2048 × 1024 PNG, ~22 KB base64-decoded

Every capture tool has the same problem. They all use `comp.saveFrameToPng()`, which renders at full comp resolution:

- `panel/daemon/tools/captureActiveComp.js:21` — `comp.saveFrameToPng(comp.time, f).wait();`
- `panel/daemon/tools/captureFrame.js:23` — same
- `panel/daemon/tools/captureLayer.js:33` — same

None of them downscale before returning the path, and the returned `width`/`height` fields just echo `comp.width`/`comp.height`.

---

## Why panel-side image handling didn't catch this

`panel/main.js:427` (`makeThumbnail`) does cap user-pasted/dropped images at a 512px max edge, so images entering through paste/drop are safe. But `capture*` outputs don't go through that path — they're written by the daemon, the daemon returns just a file path, and Claude's `Read` tool ingests the file directly. The 512px cap only protects one of the two ingestion paths.

---

## Recovery (manual, per session)

For users already stuck with a jammed session, the working recovery is:

1. Find the offending image in the Claude session jsonl at `~/.claude/projects/<project-slug>/<sessionId>.jsonl` by scanning each `message.content[].content[]` block of `type: "image"` and decoding PNG/JPEG headers.
2. Resize that one image to ≤2000px on the longest edge (Pillow `Image.LANCZOS` works), re-encode to base64, write the line back.
3. Backup the jsonl first; the file is multi-MB and any JSON formatting drift breaks the session.

This is not something an end user should ever have to do.

---

## Suggested fix

Downscale captures to ≤2000px on the longest edge before returning the path. Two options:

**A. Cheap, mac-only:** after `comp.saveFrameToPng` returns, shell out to `sips -Z 2000 <path>` from the daemon. One line, no new deps. Windows would need a parallel branch (PowerShell `Add-Type System.Drawing`, or bundle a tiny resize helper).

**B. Cross-platform, deps:** add `sharp` (or `jimp` if you want pure-JS, no native bindings) to the daemon and resize in Node. Bigger install footprint but uniform code path.

Either way, also update the returned `width`/`height` in the tool result to reflect the post-resize dimensions, so Claude's reasoning matches what it actually sees. A safety threshold of ~1800px (not 2000) gives headroom for downstream encoders that round up.

Bonus: log a warning to `gaffer-daemon.log` when a capture is downscaled, so users can correlate "blurry capture" reports with comp size if it ever comes up.

---

## Repro

1. Open AE, create a comp at 2048 × 1024 (or any size ≥2001px on one axis).
2. Open the Gaffer panel, send a message that triggers `captureActiveComp` (e.g., "what does the active comp look like right now?").
3. Continue chatting normally. After enough turns to accumulate the image into a many-image request (typically 3–6 more turns), every reply will be replaced by the dimension-limit error.

Confirmed reproducible against `panel/daemon/tools/captureActiveComp.js@53963ec`.

---

## Related feature request — surface MCP-captured images in the assistant bubble

When the model calls `captureActiveComp` / `captureFrame` / `captureLayer`, the resulting PNG is invisible to the user in the panel UI. The model sees the image (via `Read` of the returned path), then describes what it saw in text — but the user has to take that description on faith. There's no visual confirmation, and no way to tell whether the model is hallucinating, looking at the wrong frame, or looking at a stale capture.

The panel already renders images inside *user* bubbles (paste/drop path via `makeThumbnail` at `panel/main.js:427`). Mirror that for *assistant* bubbles when a `capture*` tool runs.

**Suggested behavior:**

- After a `capture*` tool result comes back over the WebSocket, embed a thumbnail of the saved PNG in the assistant bubble that follows. Same lightbox affordance as the user-side image chip.
- Click-to-enlarge opens the full-resolution capture so the user can sanity-check details.
- Show it as part of the existing tool pill (next to the tool name, e.g., `📷 captureActiveComp`) so it's clearly tied to the tool call, not free-floating in the response text.

**Why this is worth doing beyond cosmetics:**

- Catches the bug above visually — if the user can see the capture, they immediately notice oversized comps and can ask the model to crop/scale before the conversation jams.
- Makes "what does the comp look like right now?" actually useful as a panel-side preview, not just a model-internal observation.
- Lets the user verify the model targeted the correct comp / frame / layer when multiple AE windows are open.

**Implementation sketch:**

- Daemon side: when a `capture*` tool result is forwarded to the panel via the existing `chat_chunk` / tool event stream, include the file path (already in the JSON result) and a small base64 thumbnail (downscaled to e.g. 256px max edge to keep WebSocket frames small).
- Panel side: in `_processEvent` / the tool-pill renderer (`main.js`), when the tool name matches one of the capture tools, render the thumbnail inline. Reuse the existing image-chip and lightbox CSS so it visually matches user-pasted images.
- The full-res PNG already lives at the path returned by the tool, so the lightbox can lazily load it via `file://` URL — no need to round-trip through the daemon.

Pairs naturally with the 2000px downscale fix above: the daemon already has to read/resize the PNG, so generating a 256px thumbnail in the same pass is essentially free.
