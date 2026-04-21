# Gaffer + Claude Hub Setup

## Prerequisites

- Gaffer daemon running (`cd daemon && node index.js`)
- Gaffer panel loaded in After Effects
- Gaffer MCP server registered: `claude mcp add --transport http -s user gaffer http://127.0.0.1:9824/mcp`
- Claude Hub running on port 3000

## Step 1: Add Gaffer tools to Claude Hub's allowedTools

In `server.js`, find the `allowedTools` construction (~line 337):

```javascript
let allowedTools = 'Read,Grep,Glob,Bash(git *),Bash(gh *),...';
if (config.writeAccess) {
  allowedTools = 'Read,Write,Edit,Grep,Glob,Bash(*),WebFetch,WebSearch';
}
```

Add Gaffer tools to **both** branches:

```javascript
// Read-only rooms: inspection only
let allowedTools = 'Read,Grep,Glob,Bash(git *),Bash(gh *),...,mcp__gaffer__getProjectSummary,mcp__gaffer__listEffectMatchNames';

// Write-access rooms: full Gaffer control
if (config.writeAccess) {
  allowedTools = 'Read,Write,Edit,Grep,Glob,Bash(*),WebFetch,WebSearch,mcp__gaffer__runJSX,mcp__gaffer__getProjectSummary,mcp__gaffer__listEffectMatchNames';
}
```

This gates `runJSX` behind `writeAccess` — read-only rooms can inspect AE but not mutate it.

## Step 2: Create a room

1. Open Claude Hub at `http://localhost:3000`
2. Create a new room
3. Set `projectDir` to your AE project directory
4. Enable `writeAccess` if agents should modify the AE project
5. Add agents (see [agent templates](claude-hub-agent-templates.md))
6. Add Gaffer system prompt to room `notes` (paste contents of `prompts/gaffer.md`)

## Step 3: Add agents

Use the agent templates in [claude-hub-agent-templates.md](claude-hub-agent-templates.md).
At minimum, add the **Gaffer (Operator)** agent.

## How tool gating works

Claude Hub's `allowedTools` is **room-level**, not per-agent. All agents in a room share the same tool access. Per-agent tool scoping is enforced via the agent's `role` field — agents are instructed which tools they should and shouldn't use.

| Room type | `runJSX` | `getProjectSummary` | `listEffectMatchNames` |
|-----------|----------|---------------------|------------------------|
| writeAccess: true | All agents | All agents | All agents |
| writeAccess: false | Blocked | All agents | All agents |

## Verifying it works

1. Create a room with writeAccess enabled and a Gaffer Operator agent
2. Send: "What's the active comp in AE?"
3. Agent should call `getProjectSummary` and respond with comp details
4. Send: "Add a wiggle(2,30) to the selected layer's position"
5. Agent should call `runJSX` with correct ExtendScript

## Notes

- MCP tools are per-invocation — they don't persist in Claude Code sessions. Claude Hub's session resumption (`--resume`) re-discovers tools on each turn automatically.
- The Gaffer daemon must be running before any agent turn that uses Gaffer tools. If it's not running, agents get a clean error message.
- Agent turns that call `runJSX` are serialized by the daemon's queue, even when multiple agents fire in quick succession.
