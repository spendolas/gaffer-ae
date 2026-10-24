#!/usr/bin/env bash
# Writes the title, description and copyright into a published clip, in place, with no re-encode (a remux).
# Usage: scripts/site/tag-clip.sh <file.mp4> [holder] [title] [description]   (holder defaults to spendolas)
# Copyright is "(c) YEAR HOLDER. All rights reserved."; the encoder tag stays. Empty title/description are skipped.
# scripts/site/tag-clips.mjs applies every clip from clip-meta.json.
set -euo pipefail
file="${1:?usage: tag-clip.sh <file.mp4> [holder] [title] [description]}"
holder="${2:-spendolas}"
title="${3:-}"
desc="${4:-}"
year="${CLIP_YEAR:-$(date +%Y)}"
tmp="$(mktemp "${file%.mp4}.tag.XXXXXX.mp4")"
trap 'rm -f "$tmp"' EXIT
meta=(-metadata copyright="© $year $holder. All rights reserved.")
[ -n "$title" ] && meta+=(-metadata title="$title")
[ -n "$desc" ] && meta+=(-metadata description="$desc")
ffmpeg -y -loglevel error -i "$file" -map 0 -c copy -movflags +faststart "${meta[@]}" "$tmp"
mv "$tmp" "$file"
trap - EXIT
