#!/bin/bash
# Gaffer CLI — invokes Claude with the Gaffer system prompt.
# Usage: ./gaffer-cli.sh "add a wiggle to the selected layer"
#        ./gaffer-cli.sh  (interactive mode)

GAFFER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT_FILE="$GAFFER_DIR/panel/prompts/gaffer.md"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "Error: gaffer.md not found at $PROMPT_FILE" >&2
  exit 1
fi

GAFFER_TOOLS="mcp__gaffer__runJSX,mcp__gaffer__getProjectSummary,mcp__gaffer__listEffectMatchNames,mcp__gaffer__captureActiveComp"

if [ $# -gt 0 ]; then
  echo "$*" | claude -p --append-system-prompt "$(cat "$PROMPT_FILE")" --allowedTools "$GAFFER_TOOLS"
else
  claude --append-system-prompt "$(cat "$PROMPT_FILE")" --allowedTools "$GAFFER_TOOLS"
fi
