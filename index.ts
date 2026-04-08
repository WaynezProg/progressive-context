import { readFileSync, existsSync } from "fs";
import { basename, join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BootstrapCompactMap {
  [filename: string]: string;
}

interface AgentConfig {
  firstTurnFiles?: string[];
  injectRoutingIndex?: boolean;
  bootstrapKeep?: string[];
  bootstrapCompact?: BootstrapCompactMap;
}

interface PluginConfig {
  sharedDir?: string;
  globalFiles?: Record<string, string>;
  agentFiles?: Record<string, string>;
  compactReminder?: string;
  compactReminderFile?: string;
  contextRoutingIndex?: string;
  contextRoutingIndexFile?: string;
  agents?: Record<string, AgentConfig>;
  skipAgents?: string[];
  bootstrapDedup?: boolean;
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

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default function register(api: OpenClawApi) {
  // Resolve config
  const config: PluginConfig = (api.getConfig?.() as PluginConfig) ?? {};
  const workspaceRoot: string = api.getWorkspaceRoot?.() ?? process.cwd();

  // Resolve sharedDir
  const sharedDirRel = config.sharedDir ?? (existsSync(join(workspaceRoot, "agents")) ? "agents" : ".");
  const sharedDir = join(workspaceRoot, sharedDirRel);

  const skipAgents = new Set(config.skipAgents ?? []);
  const bootstrapDedup = config.bootstrapDedup !== false; // default true

  // Global file map: id -> absolute path
  const globalFiles: Record<string, string> = {};
  if (config.globalFiles) {
    for (const [id, filename] of Object.entries(config.globalFiles)) {
      globalFiles[id] = join(sharedDir, filename);
    }
  }

  // Agent file templates: id -> filename
  const agentFileTemplates: Record<string, string> = config.agentFiles ?? {};

  /** Get merged agent config (specific agent merged over wildcard defaults). */
  function getAgentConfig(agentId: string): AgentConfig | null {
    const agents = config.agents;
    if (!agents) return null;
    const wildcard = agents["*"];
    const specific = agents[agentId];
    if (!wildcard && !specific) return null;
    return { ...wildcard, ...specific };
  }

  /** Resolve a file path relative to sharedDir. */
  function resolveSharedFile(filename: string): string {
    return join(sharedDir, filename);
  }

  /** Resolve an agent-specific file: check sharedDir/{agentId}/ first, then workspace root. */
  function resolveAgentFile(agentId: string, filename: string): string {
    const agentPath = join(sharedDir, agentId, filename);
    if (existsSync(agentPath)) return agentPath;
    return join(workspaceRoot, filename);
  }

  /** Load file content from sharedDir by filename. */
  function loadSharedFile(filename: string): string {
    return readFileCached(resolveSharedFile(filename));
  }

  /** Build system context sections from a list of filenames. */
  function buildSections(files: string[]): string[] {
    return files
      .map((f) => {
        const content = loadSharedFile(f);
        if (!content) return "";
        return `## ${f}\n${content}`;
      })
      .filter(Boolean);
  }

  /** Load compact reminder text from config. */
  function loadCompactReminder(): string {
    if (config.compactReminder) return config.compactReminder;
    if (config.compactReminderFile) {
      const filePath = join(workspaceRoot, config.compactReminderFile);
      const content = readFileCached(filePath);
      if (content) return content;
    }
    return "";
  }

  /** Load context routing index from config. */
  function loadContextRoutingIndex(): string {
    if (config.contextRoutingIndex) return config.contextRoutingIndex;
    if (config.contextRoutingIndexFile) {
      const filePath = join(workspaceRoot, config.contextRoutingIndexFile);
      const content = readFileCached(filePath);
      if (content) return content;
    }
    return "";
  }

  /** Build compact reminder for turn 2+. */
  function getCompactReminder(agentId: string): string {
    const reminder = loadCompactReminder();
    if (!reminder) return "";

    const agentCfg = getAgentConfig(agentId);
    const firstTurnFiles = agentCfg?.firstTurnFiles ?? [];

    const lines: string[] = [
      "## Shared context (full text injected on first turn; summary below. Use workspace_context for full content.)",
      "",
      reminder,
    ];

    if (firstTurnFiles.length > 0) {
      lines.push("", "### Available files");
      for (const [id] of Object.entries(globalFiles)) {
        lines.push(`- \`workspace_context({id:"${id}"})\``);
      }
    }

    return lines.join("\n");
  }

  // -------------------------------------------------------------------------
  // Hook: agent:bootstrap
  // -------------------------------------------------------------------------
  api.on(
    "agent:bootstrap",
    (event: unknown, ctx: unknown) => {
      const ev = event as BootstrapEvent;
      const cx = ctx as EventContext;
      const agentId = ev?.context?.agentId ?? cx?.agentId;
      const files = ev?.context?.bootstrapFiles;
      if (!agentId || !Array.isArray(files)) return;

      const agentCfg = getAgentConfig(agentId);
      if (!agentCfg) return; // no config = no-op

      const keepSet = new Set(agentCfg.bootstrapKeep ?? []);
      const compactMap = agentCfg.bootstrapCompact ?? {};
      const agentDir = join(sharedDir, agentId);

      function tryAgentOverride(name: string, file: BootstrapFile): BootstrapFile {
        if (!bootstrapDedup) return file;
        if (!keepSet.has(name)) return file;
        const agentPath = join(agentDir, name);
        const filePath = file?.path ?? "";
        if (filePath.includes(`/${agentId}/`)) return file;
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

        // Files not in keepSet or compactMap are dropped (replaced with nothing)
      }

      ev.context!.bootstrapFiles = nextFiles.filter(Boolean) as BootstrapFile[];
    },
    { priority: 100 },
  );

  // -------------------------------------------------------------------------
  // Hook: before_prompt_build
  // -------------------------------------------------------------------------
  api.on(
    "before_prompt_build",
    (event: unknown, ctx: unknown) => {
      const ev = event as PromptEvent;
      const cx = ctx as EventContext;
      const agentId = cx?.agentId;
      if (!agentId || skipAgents.has(agentId)) return;

      const agentCfg = getAgentConfig(agentId);
      if (!agentCfg) return;

      const firstTurnFiles = agentCfg.firstTurnFiles ?? [];
      const isFirstTurn = !ev.messages || ev.messages.length <= 1;
      const sections: string[] = [];

      // Inject context routing index on first turn if configured
      if (agentCfg.injectRoutingIndex && isFirstTurn) {
        const routingIndex = loadContextRoutingIndex();
        if (routingIndex) {
          sections.push(routingIndex);
        }
      }

      if (isFirstTurn) {
        sections.push(...buildSections(firstTurnFiles));
      } else {
        const reminder = getCompactReminder(agentId);
        if (reminder) sections.push(reminder);
      }

      if (sections.length === 0) return;

      return {
        appendSystemContext: sections.join("\n\n"),
      };
    },
    { priority: 10 },
  );

  // -------------------------------------------------------------------------
  // Tool: workspace_context
  // -------------------------------------------------------------------------
  try {
    // Build valid IDs description from config
    const globalIds = Object.keys(globalFiles);
    const agentFileIds = Object.keys(agentFileTemplates);
    const allIds = [...globalIds, ...agentFileIds];
    const idsDesc = allIds.length > 0 ? allIds.join(", ") : "none configured";

    api.registerTool({
      name: "workspace_context",
      description: `Query workspace reference files. Supports section filtering and section listing. Available IDs: ${idsDesc}`,
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: `File ID. Global: ${globalIds.join(", ") || "none"}. Per-agent: ${agentFileIds.join(", ") || "none"}`,
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

        // Check global files first
        let filePath: string | undefined = globalFiles[id];

        // Check agent-specific files
        if (!filePath && agentFileTemplates[id]) {
          const filename = agentFileTemplates[id];
          filePath = resolveAgentFile(agentId, filename);
        }

        if (!filePath) {
          return { error: `Unknown id: ${id}. Valid IDs: ${idsDesc}` };
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
    console.log("[progressive-context] workspace_context tool registered");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[progressive-context] registerTool not available:", msg);
  }
}
