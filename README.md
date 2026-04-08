# progressive-context

OpenClaw plugin for progressive context injection. Injects full shared context files into agent prompts on the first turn, and a compact reminder on subsequent turns to save tokens. Also registers a `workspace_context` tool so agents can query reference files on demand.

## Features

- **Progressive injection** — First turn gets full file contents; subsequent turns get a compact summary with pointers to `workspace_context`.
- **`workspace_context` tool** — Agents can query any configured reference file by ID, with optional section filtering.
- **Per-agent configuration** — Different agents can receive different files and bootstrap behavior.
- **Bootstrap file filtering** — On `agent:bootstrap`, replaces non-essential files with compact stubs and deduplicates same-name files.
- **Fully configuration-driven** — No hardcoded paths, agent names, or file lists.

## Installation

1. Copy or clone this plugin into your OpenClaw plugins directory.
2. Build the plugin:

```bash
npm run build
```

3. Enable it in your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "progressive-context": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

## Configuration

All configuration goes under `plugins.entries.progressive-context.config` in `openclaw.json`.

### Minimal config

A minimal setup that injects one file on first turn for all agents:

```json
{
  "config": {
    "sharedDir": "agents",
    "globalFiles": {
      "global": "GLOBAL.md"
    },
    "agents": {
      "*": {
        "firstTurnFiles": ["GLOBAL.md"]
      }
    }
  }
}
```

### Full config example

```json
{
  "config": {
    "sharedDir": "agents",
    "globalFiles": {
      "global": "GLOBAL.md",
      "global-ref": "GLOBAL-REF.md",
      "shared-tools": "SHARED-TOOLS.md",
      "business": "BUSINESS.md",
      "personal": "PERSONAL.md"
    },
    "agentFiles": {
      "tools": "TOOLS.md",
      "memory": "MEMORY.md",
      "heartbeat": "HEARTBEAT.md",
      "soul": "SOUL.md"
    },
    "compactReminderFile": "COMPACT-REMINDER.md",
    "contextRoutingIndexFile": "CONTEXT-ROUTING.md",
    "agents": {
      "*": {
        "firstTurnFiles": ["GLOBAL.md", "SHARED-TOOLS.md"],
        "bootstrapKeep": ["AGENTS.md", "SOUL.md", "USER.md", "HEARTBEAT.md", "TOOLS.md"],
        "bootstrapCompact": {
          "MEMORY.md": "Long-term memory available on demand via workspace_context.",
          "IDENTITY.md": "Identity details available on demand.",
          "BOOTSTRAP.md": "Bootstrap details available on demand."
        }
      },
      "main": {
        "firstTurnFiles": ["SHARED-TOOLS.md"],
        "injectRoutingIndex": true,
        "bootstrapKeep": ["AGENTS.md", "SOUL.md", "USER.md", "HEARTBEAT.md"]
      },
      "researcher": {
        "firstTurnFiles": ["GLOBAL.md", "SHARED-TOOLS.md", "BUSINESS.md"]
      }
    },
    "skipAgents": ["helper-bot"],
    "bootstrapDedup": true
  }
}
```

### Configuration reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `sharedDir` | `string` | `"agents"` if it exists, else `"."` | Directory containing shared context files, relative to workspace root. |
| `globalFiles` | `Record<string, string>` | `{}` | Map of file IDs to filenames for global reference files (resolved relative to `sharedDir`). These IDs become available in the `workspace_context` tool. |
| `agentFiles` | `Record<string, string>` | `{}` | Map of file IDs to filenames for per-agent files. Resolved as `sharedDir/{agentId}/{filename}`, falling back to workspace root. |
| `compactReminder` | `string` | — | Inline text for the compact reminder on turn 2+. |
| `compactReminderFile` | `string` | — | Path to compact reminder file (relative to workspace root). Used if `compactReminder` is not set. |
| `contextRoutingIndex` | `string` | — | Inline routing index text injected on first turn for agents with `injectRoutingIndex: true`. |
| `contextRoutingIndexFile` | `string` | — | Path to routing index file (relative to workspace root). Used if `contextRoutingIndex` is not set. |
| `agents` | `Record<string, AgentConfig>` | `{}` | Per-agent configuration. `"*"` is the wildcard/default. Agent-specific keys override the wildcard. |
| `skipAgents` | `string[]` | `[]` | Agent IDs to skip entirely. |
| `bootstrapDedup` | `boolean` | `true` | Deduplicate same-name files during bootstrap, preferring agent-level files over workspace-root files. |

### AgentConfig keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `firstTurnFiles` | `string[]` | `[]` | Filenames in `sharedDir` to inject on the first conversation turn. |
| `injectRoutingIndex` | `boolean` | `false` | Inject the context routing index on first turn. |
| `bootstrapKeep` | `string[]` | `[]` | Filenames to keep in full during `agent:bootstrap`. |
| `bootstrapCompact` | `Record<string, string>` | `{}` | Filenames to replace with compact stubs during bootstrap. Key = filename, value = stub text. |

## File resolution

1. **Global files** (`globalFiles`): resolved as `{workspaceRoot}/{sharedDir}/{filename}`.
2. **Agent files** (`agentFiles`): resolved as `{workspaceRoot}/{sharedDir}/{agentId}/{filename}`. If not found, falls back to `{workspaceRoot}/{filename}`.
3. **Compact reminder / routing index files**: resolved relative to `{workspaceRoot}`.
4. **Workspace root**: auto-detected from the OpenClaw API (`api.getWorkspaceRoot()`), falling back to `process.cwd()`.

## How it works

### Turn 1 (first message)

For each agent (unless in `skipAgents`), the plugin looks up the agent's config (falling back to `"*"`). It reads all `firstTurnFiles` from `sharedDir` and appends their contents to the system prompt. If `injectRoutingIndex` is true, the routing index is prepended.

### Turn 2+ (subsequent messages)

Instead of re-injecting full files, the plugin appends a compact reminder (from `compactReminder` or `compactReminderFile`) with pointers to the `workspace_context` tool.

### Bootstrap filtering

On `agent:bootstrap`, the plugin filters the bootstrap file list:
- Files in `bootstrapKeep` are kept in full (with agent-level deduplication if enabled).
- Files in `bootstrapCompact` are replaced with a short stub.
- All other files are removed.

### workspace_context tool

Agents can call `workspace_context({ id: "global" })` to retrieve any configured reference file. Supports:
- `section` — fuzzy-match a heading to return only that section.
- `list_sections` — return all headings in the file.

## Migration from v1

v1 had all agent names, file paths, and rules hardcoded. v2 moves everything to `openclaw.json` config.

### Steps

1. **Update plugin files**: Replace `index.ts`, `openclaw.plugin.json`, and `package.json` with the v2 versions. Run `npm run build`.
2. **Delete `index.mjs`**: No longer needed.
3. **Add config to `openclaw.json`**: Move your agent-specific file lists into the `agents` map. Move your compact reminder text into `compactReminder` or a `compactReminderFile`. Move your routing index into `contextRoutingIndex` or `contextRoutingIndexFile`.
4. **Set `sharedDir`**: Point to the directory containing your shared `.md` files.
5. **Set `globalFiles`**: Map IDs like `"global"`, `"shared-tools"` to their filenames.
6. **Set `agentFiles`**: Map IDs like `"tools"`, `"memory"`, `"soul"` to their filenames.
7. **Set `skipAgents`**: List any agents that should be skipped entirely.

### Key differences

| v1 | v2 |
|----|-----|
| Hardcoded absolute paths | `sharedDir` config + auto-detected workspace root |
| Hardcoded agent lists (`GLOBAL_CORE_AGENTS`, etc.) | `agents` config map with `"*"` wildcard |
| Hardcoded `CORE_RULES_SUMMARY` | `compactReminder` / `compactReminderFile` |
| Hardcoded routing index | `contextRoutingIndex` / `contextRoutingIndexFile` |
| Hardcoded `SKIP_AGENTS` | `skipAgents` config |
| No `configSchema` | Full JSON Schema validation |

## License

MIT
