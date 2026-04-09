import { readFileSync, existsSync } from "fs";
import { basename, join } from "path";

// ---------------------------------------------------------------------------
// Types — v3 Agent-Workspace-First Architecture
// ---------------------------------------------------------------------------

/** Stable semantic names -> filenames for standard agent workspace files. */
interface StandardWorkspaceFiles {
  [key: string]: string;
}

/** A shared context definition. */
interface SharedContextConfig {
  path: string;
  description?: string;
  label?: string;
  sections?: string[];
  compactText?: string;
  routeTable?: Record<string, string>;
}

/** Per-agent configuration in the new schema. */
interface AgentConfig {
  workspaceRoot?: string;
  workspaceFiles?: string[];
  extraWorkspaceFiles?: Record<string, string>;
  injectSharedOnFirstTurn?: string[];
  availableSharedContexts?: string[];
  bootstrapKeep?: string[];
  bootstrapCompact?: BootstrapCompactMap;
  routeTable?: Record<string, string>;
  // Legacy fields
  firstTurnFiles?: string[];
  injectRoutingIndex?: boolean;
}

interface BootstrapCompactMap {
  [filename: string]: string;
}

/** Full plugin config — supports both v2 (legacy) and v3 schemas. */
interface PluginConfig {
  // v3 fields
  standardWorkspaceFiles?: StandardWorkspaceFiles;
  sharedContexts?: Record<string, SharedContextConfig>;
  agents?: Record<string, AgentConfig>;
  skipAgents?: string[];
  bootstrapDedup?: boolean;
  // v2 legacy fields
  sharedDir?: string;
  globalFiles?: Record<string, string>;
  agentFiles?: Record<string, string>;
  compactReminder?: string;
  compactReminderFile?: string;
  contextRoutingIndex?: string;
  contextRoutingIndexFile?: string;
}

interface BootstrapFile {
  path?: string;
  name?: string;
  content?: string;
  [key: string]: unknown;
}

interface BootstrapEvent {
  context?: {
    agentId?: string;
    bootstrapFiles?: BootstrapFile[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface PromptEvent {
  messages?: unknown[];
  [key: string]: unknown;
}

interface EventContext {
  agentId?: string;
  [key: string]: unknown;
}

interface ToolParams {
  id: string;
  section?: string;
  list_sections?: boolean;
}

interface ToolContext {
  agentId?: string;
  [key: string]: unknown;
}

interface OpenClawApi {
  on(event: string, handler: (...args: unknown[]) => unknown, opts?: { priority: number }): void;
  registerTool(def: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (params: unknown, ctx: unknown) => Promise<unknown>;
  }): void;
  getWorkspaceRoot?(): string;
  getConfig?(): PluginConfig;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_STANDARD_WORKSPACE_FILES: StandardWorkspaceFiles = {
  agents: "AGENTS.md",
  soul: "SOUL.md",
  user: "USER.md",
  tools: "TOOLS.md",
  memory: "MEMORY.md",
  heartbeat: "HEARTBEAT.md",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fileCache = new Map<string, string>();

function readFileCached(filePath: string): string {
  if (fileCache.has(filePath)) return fileCache.get(filePath)!;
  try {
    const content = readFileSync(filePath, "utf-8");
    fileCache.set(filePath, content);
    return content;
  } catch {
    return "";
  }
}

function extractSection(content: string, section: string): string | null {
  const lines = content.split("\n");
  const needle = section.toLowerCase();
  let startIdx = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,4}) (.+)/);
    if (m && m[2].toLowerCase().includes(needle)) {
      startIdx = i;
      startLevel = m[1].length;
      break;
    }
  }
  if (startIdx === -1) return null;
  const result: string[] = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,4}) /);
    if (m && m[1].length <= startLevel) break;
    result.push(lines[i]);
  }
  return result.join("\n");
}

function warn(msg: string): void {
  console.log(`[progressive-context] WARN: ${msg}`);
}

function deprecationWarn(field: string, replacement: string): void {
  console.log(
    `[progressive-context] DEPRECATED: '${field}' is deprecated. Use '${replacement}' instead.`,
  );
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default function register(api: OpenClawApi) {
  const config: PluginConfig = (api.getConfig?.() as PluginConfig) ?? {};
  const workspaceRoot: string = api.getWorkspaceRoot?.() ?? process.cwd();

  // -----------------------------------------------------------------------
  // Detect legacy config and log deprecation warnings
  // -----------------------------------------------------------------------
  const hasLegacyConfig =
    config.sharedDir !== undefined ||
    config.globalFiles !== undefined ||
    config.agentFiles !== undefined ||
    config.compactReminder !== undefined ||
    config.compactReminderFile !== undefined ||
    config.contextRoutingIndex !== undefined ||
    config.contextRoutingIndexFile !== undefined;

  if (hasLegacyConfig) {
    if (config.sharedDir !== undefined) deprecationWarn("sharedDir", "agents[*].workspaceRoot");
    if (config.globalFiles !== undefined) deprecationWarn("globalFiles", "sharedContexts");
    if (config.agentFiles !== undefined) deprecationWarn("agentFiles", "standardWorkspaceFiles + agents[].workspaceFiles");
    if (config.compactReminder !== undefined) deprecationWarn("compactReminder", "sharedContexts[].compactText + dynamic generation");
    if (config.compactReminderFile !== undefined) deprecationWarn("compactReminderFile", "sharedContexts[].compactText + dynamic generation");
    if (config.contextRoutingIndex !== undefined) deprecationWarn("contextRoutingIndex", "agents[].routeTable");
    if (config.contextRoutingIndexFile !== undefined) deprecationWarn("contextRoutingIndexFile", "agents[].routeTable");
  }

  // Check if new-style agents have workspaceRoot (distinguishes v3 from v2)
  const hasV3Config =
    config.sharedContexts !== undefined ||
    config.standardWorkspaceFiles !== undefined ||
    (config.agents !== undefined &&
      Object.values(config.agents).some((a) => a.workspaceRoot !== undefined));

  // -----------------------------------------------------------------------
  // Resolve standard workspace files map
  // -----------------------------------------------------------------------
  const stdFiles: StandardWorkspaceFiles = {
    ...DEFAULT_STANDARD_WORKSPACE_FILES,
    ...(config.standardWorkspaceFiles ?? {}),
  };

  // -----------------------------------------------------------------------
  // Resolve shared contexts
  // -----------------------------------------------------------------------
  const sharedContexts: Record<string, SharedContextConfig> = config.sharedContexts ?? {};

  // -----------------------------------------------------------------------
  // Build legacy compat layer (translate old config into v3 internal model)
  // -----------------------------------------------------------------------
  let legacySharedDir: string | undefined;
  let legacyGlobalFiles: Record<string, string> | undefined;
  let legacyAgentFileTemplates: Record<string, string> | undefined;

  if (hasLegacyConfig && !hasV3Config) {
    const sharedDirRel =
      config.sharedDir ?? (existsSync(join(workspaceRoot, "agents")) ? "agents" : ".");
    legacySharedDir = join(workspaceRoot, sharedDirRel);

    if (config.globalFiles) {
      legacyGlobalFiles = {};
      for (const [id, filename] of Object.entries(config.globalFiles)) {
        legacyGlobalFiles[id] = join(legacySharedDir, filename);
      }
    }

    legacyAgentFileTemplates = config.agentFiles;
  }

  const skipAgents = new Set(config.skipAgents ?? []);
  const bootstrapDedup = config.bootstrapDedup !== false;

  // -----------------------------------------------------------------------
  // Agent config resolution
  // -----------------------------------------------------------------------

  /** Merge wildcard + specific agent config. */
  function getAgentConfig(agentId: string): AgentConfig | null {
    const agents = config.agents;
    if (!agents) return null;
    const wildcard = agents["*"];
    const specific = agents[agentId];
    if (!wildcard && !specific) return null;
    // Deep merge: specific overrides wildcard, but only defined fields
    return { ...wildcard, ...specific };
  }

  /** Resolve {agentId} template in a path string. */
  function resolveTemplate(path: string, agentId: string): string {
    return path.replace(/\{agentId\}/g, agentId);
  }

  /** Get absolute workspace root for an agent. */
  function getAgentWorkspaceRoot(agentId: string): string {
    const agentCfg = getAgentConfig(agentId);
    if (agentCfg?.workspaceRoot !== undefined) {
      const resolved = resolveTemplate(agentCfg.workspaceRoot, agentId);
      if (resolved === ".") return workspaceRoot;
      return join(workspaceRoot, resolved);
    }
    // Legacy fallback
    if (legacySharedDir) {
      const agentPath = join(legacySharedDir, agentId);
      if (existsSync(agentPath)) return agentPath;
    }
    return workspaceRoot;
  }

  /** Resolve a workspace file for an agent by slot key. */
  function resolveWorkspaceFile(agentId: string, slotKey: string): string | null {
    const agentCfg = getAgentConfig(agentId);
    const agentRoot = getAgentWorkspaceRoot(agentId);

    // Check extra workspace files first
    if (agentCfg?.extraWorkspaceFiles?.[slotKey]) {
      const p = join(agentRoot, agentCfg.extraWorkspaceFiles[slotKey]);
      return existsSync(p) ? p : null;
    }

    // Standard workspace file
    const filename = stdFiles[slotKey];
    if (!filename) {
      warn(`Unknown workspace file slot: '${slotKey}'`);
      return null;
    }

    const p = join(agentRoot, filename);
    return existsSync(p) ? p : null;
  }

  /** Resolve a shared context by name to absolute path. */
  function resolveSharedContext(name: string): string | null {
    const ctx = sharedContexts[name];
    if (!ctx) {
      warn(`Unknown shared context: '${name}'`);
      return null;
    }
    const p = join(workspaceRoot, ctx.path);
    if (!existsSync(p)) {
      warn(`Shared context file missing: '${ctx.path}'`);
      return null;
    }
    return p;
  }

  /** Get all workspace file slot keys for an agent. */
  function getAgentWorkspaceFileKeys(agentId: string): string[] {
    const agentCfg = getAgentConfig(agentId);
    return agentCfg?.workspaceFiles ?? Object.keys(stdFiles);
  }

  /** Get all shared context names available to an agent (injected + available). */
  function getAgentSharedContextNames(agentId: string): string[] {
    const agentCfg = getAgentConfig(agentId);
    const injected = agentCfg?.injectSharedOnFirstTurn ?? [];
    const available = agentCfg?.availableSharedContexts ?? [];
    const all = new Set([...injected, ...available]);
    return [...all];
  }

  // -----------------------------------------------------------------------
  // Legacy helpers (only used when hasLegacyConfig && !hasV3Config)
  // -----------------------------------------------------------------------

  function legacyResolveAgentFile(agentId: string, filename: string): string {
    if (legacySharedDir) {
      const agentPath = join(legacySharedDir, agentId, filename);
      if (existsSync(agentPath)) return agentPath;
    }
    return join(workspaceRoot, filename);
  }

  function legacyLoadSharedFile(filename: string): string {
    if (!legacySharedDir) return "";
    return readFileCached(join(legacySharedDir, filename));
  }

  function legacyBuildSections(files: string[]): string[] {
    return files
      .map((f) => {
        const content = legacyLoadSharedFile(f);
        if (!content) return "";
        return `## ${f}\n${content}`;
      })
      .filter(Boolean);
  }

  function legacyLoadCompactReminder(): string {
    if (config.compactReminder) return config.compactReminder;
    if (config.compactReminderFile) {
      const filePath = join(workspaceRoot, config.compactReminderFile);
      const content = readFileCached(filePath);
      if (content) return content;
    }
    return "";
  }

  function legacyLoadContextRoutingIndex(): string {
    if (config.contextRoutingIndex) return config.contextRoutingIndex;
    if (config.contextRoutingIndexFile) {
      const filePath = join(workspaceRoot, config.contextRoutingIndexFile);
      const content = readFileCached(filePath);
      if (content) return content;
    }
    return "";
  }

  function legacyGetCompactReminder(agentId: string): string {
    const reminder = legacyLoadCompactReminder();
    if (!reminder) return "";
    const lines: string[] = [
      "## Shared context (full text injected on first turn; summary below. Use workspace_context for full content.)",
      "",
      reminder,
    ];
    if (legacyGlobalFiles) {
      lines.push("", "### Available files");
      for (const id of Object.keys(legacyGlobalFiles)) {
        lines.push(`- \`workspace_context({id:"${id}"})\``);
      }
    }
    return lines.join("\n");
  }

  // -----------------------------------------------------------------------
  // v3 first-turn and compact-turn builders
  // -----------------------------------------------------------------------

  /** Build first-turn injection content for v3 config. */
  function buildFirstTurnContent(agentId: string): string[] {
    const agentCfg = getAgentConfig(agentId);
    if (!agentCfg) return [];
    const sections: string[] = [];

    // 1. Workspace files
    const wsKeys = agentCfg.workspaceFiles ?? [];
    for (const key of wsKeys) {
      const filePath = resolveWorkspaceFile(agentId, key);
      if (filePath) {
        const content = readFileCached(filePath);
        if (content) {
          const filename = stdFiles[key] ?? key;
          sections.push(`## ${filename}\n${content}`);
        }
      }
    }

    // 2. Shared contexts for first turn
    const sharedNames = agentCfg.injectSharedOnFirstTurn ?? [];
    for (const name of sharedNames) {
      const filePath = resolveSharedContext(name);
      if (filePath) {
        const content = readFileCached(filePath);
        if (content) {
          const ctx = sharedContexts[name];
          const label = ctx?.label ?? ctx?.description ?? name;
          sections.push(`## Shared: ${label}\n${content}`);
        }
      }
    }

    // 3. Route table hint
    const routeTable = agentCfg.routeTable;
    if (routeTable && Object.keys(routeTable).length > 0) {
      const routeLines = ["## Context Route Table", ""];
      for (const [topic, target] of Object.entries(routeTable)) {
        routeLines.push(`- **${topic}** → \`workspace_context({id:"${target}"})\``);
      }
      sections.push(routeLines.join("\n"));
    }

    return sections;
  }

  /** Build compact reminder for v3 config on turn 2+. */
  function buildCompactReminder(agentId: string): string {
    const agentCfg = getAgentConfig(agentId);
    if (!agentCfg) return "";

    const lines: string[] = [
      "## Progressive Context Reminder",
      "",
      "Full context was injected on the first turn. Use `workspace_context` to retrieve files on demand.",
      "",
    ];

    // Workspace files
    const wsKeys = agentCfg.workspaceFiles ?? [];
    if (wsKeys.length > 0) {
      lines.push("### Agent workspace files");
      for (const key of wsKeys) {
        const filePath = resolveWorkspaceFile(agentId, key);
        const status = filePath ? "available" : "missing";
        lines.push(`- \`workspace:${key}\` (${status})`);
      }
      lines.push("");
    }

    // Shared contexts
    const injected = agentCfg.injectSharedOnFirstTurn ?? [];
    const available = agentCfg.availableSharedContexts ?? [];
    const allShared = [...new Set([...injected, ...available])];
    if (allShared.length > 0) {
      lines.push("### Shared contexts");
      for (const name of allShared) {
        const ctx = sharedContexts[name];
        const desc = ctx?.description ? ` — ${ctx.description}` : "";
        const compact = ctx?.compactText;
        if (compact) {
          lines.push(`- \`shared:${name}\`${desc}: ${compact}`);
        } else {
          lines.push(`- \`shared:${name}\`${desc}`);
        }
      }
      lines.push("");
    }

    // Route table hints
    const routeTable = agentCfg.routeTable;
    if (routeTable && Object.keys(routeTable).length > 0) {
      lines.push("### Route hints");
      for (const [topic, target] of Object.entries(routeTable)) {
        lines.push(`- ${topic} → \`${target}\``);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  // -----------------------------------------------------------------------
  // Hook: agent:bootstrap
  // -----------------------------------------------------------------------
  api.on(
    "agent:bootstrap",
    (event: unknown, ctx: unknown) => {
      const ev = event as BootstrapEvent;
      const cx = ctx as EventContext;
      const agentId = ev?.context?.agentId ?? cx?.agentId;
      const files = ev?.context?.bootstrapFiles;
      if (!agentId || !Array.isArray(files)) return;

      const agentCfg = getAgentConfig(agentId);
      if (!agentCfg) return;

      const keepSet = new Set(agentCfg.bootstrapKeep ?? []);
      const compactMap = agentCfg.bootstrapCompact ?? {};
      const agentRoot = getAgentWorkspaceRoot(agentId);

      function tryAgentOverride(name: string, file: BootstrapFile): BootstrapFile {
        if (!bootstrapDedup) return file;
        if (!keepSet.has(name)) return file;
        const agentPath = join(agentRoot, name);
        const filePath = file?.path ?? "";
        // Skip if the file already comes from this agent's workspace
        if (filePath.startsWith(agentRoot + "/")) return file;
        try {
          if (!existsSync(agentPath)) return file;
          const content = readFileSync(agentPath, "utf-8");
          return { ...file, content, path: agentPath, name };
        } catch {
          return file;
        }
      }

      const seen = new Map<string, number>();
      const nextFiles: (BootstrapFile | null)[] = [];

      for (const file of files) {
        const name = basename(file?.path ?? file?.name ?? "");
        if (!name) continue;

        if (keepSet.has(name)) {
          const overridden = tryAgentOverride(name, file);
          if (bootstrapDedup && seen.has(name)) {
            nextFiles[seen.get(name)!] = overridden;
          } else {
            seen.set(name, nextFiles.length);
            nextFiles.push(overridden);
          }
          continue;
        }

        if (compactMap[name]) {
          if (!seen.has(name)) {
            seen.set(name, nextFiles.length);
            nextFiles.push({
              ...file,
              content: `## ${name}\n\n${compactMap[name]}`,
              path: file?.path ?? name,
              name,
            });
          }
          continue;
        }

        // Files not in keepSet or compactMap are dropped
      }

      ev.context!.bootstrapFiles = nextFiles.filter(Boolean) as BootstrapFile[];
    },
    { priority: 100 },
  );

  // -----------------------------------------------------------------------
  // Hook: before_prompt_build
  // -----------------------------------------------------------------------
  api.on(
    "before_prompt_build",
    (event: unknown, ctx: unknown) => {
      const ev = event as PromptEvent;
      const cx = ctx as EventContext;
      const agentId = cx?.agentId;
      if (!agentId || skipAgents.has(agentId)) return;

      const agentCfg = getAgentConfig(agentId);
      if (!agentCfg) return;

      const isFirstTurn = !ev.messages || ev.messages.length <= 1;
      const sections: string[] = [];

      if (hasV3Config) {
        // v3 path
        if (isFirstTurn) {
          sections.push(...buildFirstTurnContent(agentId));
        } else {
          const reminder = buildCompactReminder(agentId);
          if (reminder) sections.push(reminder);
        }
      } else {
        // Legacy path
        const firstTurnFiles = agentCfg.firstTurnFiles ?? [];

        if (agentCfg.injectRoutingIndex && isFirstTurn) {
          const routingIndex = legacyLoadContextRoutingIndex();
          if (routingIndex) sections.push(routingIndex);
        }

        if (isFirstTurn) {
          sections.push(...legacyBuildSections(firstTurnFiles));
        } else {
          const reminder = legacyGetCompactReminder(agentId);
          if (reminder) sections.push(reminder);
        }
      }

      if (sections.length === 0) return;

      return {
        appendSystemContext: sections.join("\n\n"),
      };
    },
    { priority: 10 },
  );

  // -----------------------------------------------------------------------
  // Tool: workspace_context
  // -----------------------------------------------------------------------
  try {
    // Build description from config
    const wsSlotKeys = Object.keys(stdFiles);
    const sharedNames = Object.keys(sharedContexts);
    // Legacy IDs for backward compat
    const legacyGlobalIds = legacyGlobalFiles ? Object.keys(legacyGlobalFiles) : [];
    const legacyAgentIds = legacyAgentFileTemplates ? Object.keys(legacyAgentFileTemplates) : [];

    const idExamples: string[] = [];
    if (wsSlotKeys.length > 0) {
      idExamples.push(`workspace:{${wsSlotKeys.join("|")}}`);
    }
    if (sharedNames.length > 0) {
      idExamples.push(`shared:{${sharedNames.join("|")}}`);
    }
    if (legacyGlobalIds.length > 0 || legacyAgentIds.length > 0) {
      idExamples.push(`legacy bare IDs: ${[...legacyGlobalIds, ...legacyAgentIds].join(", ")}`);
    }
    const idsDesc = idExamples.length > 0 ? idExamples.join("; ") : "none configured";

    api.registerTool({
      name: "workspace_context",
      description: `Query workspace reference files. Use 'workspace:<key>' for agent workspace files, 'shared:<name>' for shared contexts. Supports section filtering and listing. Available: ${idsDesc}`,
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: `File ID. Use 'workspace:<key>' or 'shared:<name>'. ${idsDesc}`,
          },
          section: {
            type: "string",
            description: "Section name (fuzzy match heading). Omit for full content.",
          },
          list_sections: {
            type: "boolean",
            description: "Return section headings only.",
          },
        },
        required: ["id"],
      },
      execute: async (params: unknown, toolCtx: unknown) => {
        const { id, section, list_sections } = params as ToolParams;
        const agentId = (toolCtx as ToolContext)?.agentId ?? "unknown";
        let filePath: string | null = null;

        // Parse namespace
        if (id.startsWith("workspace:")) {
          const key = id.slice("workspace:".length);
          filePath = resolveWorkspaceFile(agentId, key);
          if (!filePath) {
            return { error: `Workspace file not found for slot '${key}' (agent: ${agentId})` };
          }
        } else if (id.startsWith("shared:")) {
          const name = id.slice("shared:".length);
          // Support section in target: "shared:business-core#Pricing"
          const hashIdx = name.indexOf("#");
          const contextName = hashIdx >= 0 ? name.slice(0, hashIdx) : name;
          const hashSection = hashIdx >= 0 ? name.slice(hashIdx + 1) : undefined;
          filePath = resolveSharedContext(contextName);
          if (!filePath) {
            return { error: `Shared context not found: '${contextName}'` };
          }
          // If section from hash and no explicit section param, use hash section
          if (hashSection && !section) {
            const content = readFileCached(filePath);
            const extracted = extractSection(content, hashSection);
            if (!extracted) return { error: `Section not found: "${hashSection}" in shared:${contextName}` };
            return { content: extracted };
          }
        } else {
          // Backward compat: bare filename lookup
          // Try legacy global files
          if (legacyGlobalFiles && legacyGlobalFiles[id]) {
            filePath = legacyGlobalFiles[id];
          }
          // Try legacy agent files
          if (!filePath && legacyAgentFileTemplates && legacyAgentFileTemplates[id]) {
            const filename = legacyAgentFileTemplates[id];
            filePath = legacyResolveAgentFile(agentId, filename);
          }
          // Try as workspace slot key (convenience)
          if (!filePath && stdFiles[id]) {
            filePath = resolveWorkspaceFile(agentId, id);
          }
          // Try as shared context name (convenience)
          if (!filePath && sharedContexts[id]) {
            filePath = resolveSharedContext(id);
          }

          if (!filePath) {
            return {
              error: `Unknown id: '${id}'. Use 'workspace:<key>' or 'shared:<name>'. Available: ${idsDesc}`,
            };
          }
        }

        let content: string;
        try {
          content = readFileSync(filePath, "utf-8");
        } catch {
          return { error: `File not found: ${filePath}` };
        }

        if (list_sections) {
          const headings = content.match(/^#{1,4} .+/gm) ?? [];
          return { sections: headings };
        }

        if (section) {
          const extracted = extractSection(content, section);
          if (!extracted) return { error: `Section not found: "${section}"` };
          return { content: extracted };
        }

        return { content };
      },
    });
    console.log("[progressive-context] workspace_context tool registered (v3)");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[progressive-context] registerTool not available:", msg);
  }
}
