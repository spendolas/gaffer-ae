#!/usr/bin/env bash
# Compress a clip into a landing-page sample: site/media/<slug>.mp4 (H.264)
# plus site/media/<slug>.hevc.mp4 (HEVC, smaller, used where the browser can play it).
# Usage: [CLIP_HOLDER=name] scripts/site/add-sample.sh [--square] <input> [slug]
# H264_CRF / HEVC_CRF raise the quantiser for a noisy clip that comes out too heavy (defaults 20 / 23).
# CLIP_HOLDER is the copyright holder written into the clip (default spendolas; a clip from someone else needs theirs).
# Default keeps the clip's own shape: the source height capped at 800px (never
# upscaled), width from the aspect (even), with the aspect clamped to 0.5..2.4
# by a centre crop beyond the clamp. --square centre-crops to a square, same cap.
set -euo pipefail

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "error: ffmpeg not found on PATH (install it, e.g. brew install ffmpeg)" >&2
  exit 1
fi

square=0
args=()
for a in "$@"; do
  if [ "$a" = "--square" ]; then square=1; else args+=("$a"); fi
done
set -- ${args[@]+"${args[@]}"}

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "usage: $0 [--square] <input> [slug]" >&2
  echo "  default: native aspect, source height capped at 800px, aspect clamped to 0.5..2.4 by centre crop" >&2
  echo "  --square: centre-crop to a square, same 800px cap" >&2
  exit 2
fi

input="$1"
if [ ! -f "$input" ]; then
  echo "error: input not found: $input" >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Same slug rule as build-manifest.mjs (slugify): lowercase ASCII letters,
# digits and dashes, accents folded, 'clip' when nothing is left. Applied to a
# custom slug too, so it can never leave site/media.
slugify() {
  if command -v node >/dev/null 2>&1; then
    # Module path via env, not argv: build-manifest.mjs runs its CLI when
    # argv[1] is its own path.
    SLUG_MODULE="$root/scripts/site/build-manifest.mjs" node -e \
      'import(require("url").pathToFileURL(process.env.SLUG_MODULE)).then((m) => process.stdout.write(m.slugify(process.argv[1])))' \
      -- "$1"
  else
    local s
    s="$(printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
    printf '%s' "${s:-clip}"
  fi
}

# No slug given: the next free serial (clip-01, clip-02, ...), so the public page carries no source
# names. docs/site-clips.md maps each serial back to its source; a row is appended there.
serial=0
if [ $# -eq 2 ]; then
  raw="$2"
else
  n=0
  for f in "$root"/site/media/clip-[0-9]*.mp4; do
    [ -e "$f" ] || continue
    case "$f" in *.hevc.mp4) continue ;; esac
    k="$(basename "$f" .mp4)"; k="${k#clip-}"
    case "$k" in *[!0-9]*|"") continue ;; esac
    [ $((10#$k)) -gt "$n" ] && n=$((10#$k))
  done
  raw="$(printf 'clip-%02d' $((n + 1)))"
  serial=1
fi
slug="$(slugify "$raw")"
out_dir="$root/site/media"
out="$out_dir/$slug.mp4"
out_hevc="$out_dir/$slug.hevc.mp4"
mkdir -p "$out_dir"

# Height = min(height after the crop, 800): native resolution, never upscaled.
if [ "$square" -eq 1 ]; then
  crop="crop='min(iw,ih)':'min(iw,ih)'"
  size="'min(ih,800)':'min(ih,800)'"
else
  # Crop only what lies beyond the clamp (wider than 2.4:1 or taller than 1:2),
  # then an even width from the aspect.
  crop="crop='min(iw,ih*2.4)':'min(ih,iw*2)'"
  size="-2:'min(ih,800)'"
fi
# Colour: convert to BT.709 limited range and tag it, so every browser shows the
# same colours. The input matrix follows the source's own tag; an untagged YUV
# source decodes as BT.601 (ffmpeg's default), which matches After Effects'
# untagged ProRes exports. RGB sources (GIF) have no input matrix. setparams
# stamps the tags on the frames: an untagged source would otherwise leave the
# primaries and transfer unset despite the output flags below.
vf="$crop,scale=$size:flags=lanczos:in_color_matrix=auto:out_color_matrix=bt709:out_range=tv,format=yuv420p"
vf="$vf,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv,setsar=1"  # square pixels: a source with an odd sample aspect ratio would otherwise make a file Chrome refuses to demux
common=(-an -dn -vf "$vf" -pix_fmt yuv420p
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv
  -movflags +faststart -write_tmcd 0)
# The source frame rate is kept (no -r). CRF values were picked by measurement
# (see the landing-page spec): H.264 CRF 20 with the animation tune and HEVC
# CRF 23 look the same on flat motion graphics, with no banding or blocks.
limit=6291456 # 6 MB

report() {
  local file="$1" bytes
  bytes="$(wc -c < "$file" | tr -d ' ')"
  echo "wrote $file ($bytes bytes)"
  if [ "$bytes" -gt "$limit" ]; then
    echo "warning: $(basename "$file") is above 6 MB; trim the clip or raise CRF" >&2
  fi
}

ffmpeg -y -loglevel error -i "$input" \
  -c:v libx264 -crf "${H264_CRF:-20}" -preset slow -tune animation "${common[@]}" \
  "$out"
report "$out"
"$root/scripts/site/tag-clip.sh" "$out" "${CLIP_HOLDER:-spendolas}"

if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx265; then
  # hvc1 tag: Safari only plays HEVC in MP4 tagged hvc1 (not hev1).
  ffmpeg -y -loglevel error -i "$input" \
    -c:v libx265 -crf "${HEVC_CRF:-23}" -preset slow -tag:v hvc1 -x265-params log-level=error "${common[@]}" \
    "$out_hevc"
  report "$out_hevc"
  "$root/scripts/site/tag-clip.sh" "$out_hevc" "${CLIP_HOLDER:-spendolas}"
  echo "git add site/media/$slug.mp4 site/media/$slug.hevc.mp4"
else
  echo "note: this ffmpeg has no libx265 encoder, so no HEVC file was written;" >&2
  echo "      the page plays the H.264 file everywhere (brew install ffmpeg includes x265)" >&2
  if [ -f "$out_hevc" ]; then
    echo "note: an older $slug.hevc.mp4 exists and no longer matches; delete it" >&2
  fi
  echo "git add site/media/$slug.mp4"
fi

if [ "$serial" -eq 1 ] && [ -f "$root/docs/site-clips.md" ]; then
  printf '| %s | `%s` | %s | |\n' "$slug" "$input" "$(date +%Y-%m-%d)" >> "$root/docs/site-clips.md"
  echo "added a row for $slug to docs/site-clips.md (fix the source path and notes by hand)"
fi
