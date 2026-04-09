var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// index.ts
var index_exports = {};
__export(index_exports, {
  default: () => register
});
module.exports = __toCommonJS(index_exports);
var import_fs = require("fs");
var import_path = require("path");
var DEFAULT_STANDARD_WORKSPACE_FILES = {
  agents: "AGENTS.md",
  soul: "SOUL.md",
  user: "USER.md",
  tools: "TOOLS.md",
  memory: "MEMORY.md",
  heartbeat: "HEARTBEAT.md"
};
var fileCache = /* @__PURE__ */ new Map();
function readFileCached(filePath) {
  if (fileCache.has(filePath)) return fileCache.get(filePath);
  try {
    const content = (0, import_fs.readFileSync)(filePath, "utf-8");
    fileCache.set(filePath, content);
    return content;
  } catch {
    return "";
  }
}
function extractSection(content, section) {
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
  const result = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,4}) /);
    if (m && m[1].length <= startLevel) break;
    result.push(lines[i]);
  }
  return result.join("\n");
}
function warn(msg) {
  console.log(`[progressive-context] WARN: ${msg}`);
}
function deprecationWarn(field, replacement) {
  console.log(
    `[progressive-context] DEPRECATED: '${field}' is deprecated. Use '${replacement}' instead.`
  );
}
function register(api) {
  const config = api.getConfig?.() ?? {};
  const workspaceRoot = api.getWorkspaceRoot?.() ?? process.cwd();
  const hasLegacyConfig = config.sharedDir !== void 0 || config.globalFiles !== void 0 || config.agentFiles !== void 0 || config.compactReminder !== void 0 || config.compactReminderFile !== void 0 || config.contextRoutingIndex !== void 0 || config.contextRoutingIndexFile !== void 0;
  if (hasLegacyConfig) {
    if (config.sharedDir !== void 0) deprecationWarn("sharedDir", "agents[*].workspaceRoot");
    if (config.globalFiles !== void 0) deprecationWarn("globalFiles", "sharedContexts");
    if (config.agentFiles !== void 0) deprecationWarn("agentFiles", "standardWorkspaceFiles + agents[].workspaceFiles");
    if (config.compactReminder !== void 0) deprecationWarn("compactReminder", "sharedContexts[].compactText + dynamic generation");
    if (config.compactReminderFile !== void 0) deprecationWarn("compactReminderFile", "sharedContexts[].compactText + dynamic generation");
    if (config.contextRoutingIndex !== void 0) deprecationWarn("contextRoutingIndex", "agents[].routeTable");
    if (config.contextRoutingIndexFile !== void 0) deprecationWarn("contextRoutingIndexFile", "agents[].routeTable");
  }
  const hasV3Config = config.sharedContexts !== void 0 || config.standardWorkspaceFiles !== void 0 || config.agents !== void 0 && Object.values(config.agents).some((a) => a.workspaceRoot !== void 0);
  const stdFiles = {
    ...DEFAULT_STANDARD_WORKSPACE_FILES,
    ...config.standardWorkspaceFiles ?? {}
  };
  const sharedContexts = config.sharedContexts ?? {};
  let legacySharedDir;
  let legacyGlobalFiles;
  let legacyAgentFileTemplates;
  if (hasLegacyConfig && !hasV3Config) {
    const sharedDirRel = config.sharedDir ?? ((0, import_fs.existsSync)((0, import_path.join)(workspaceRoot, "agents")) ? "agents" : ".");
    legacySharedDir = (0, import_path.join)(workspaceRoot, sharedDirRel);
    if (config.globalFiles) {
      legacyGlobalFiles = {};
      for (const [id, filename] of Object.entries(config.globalFiles)) {
        legacyGlobalFiles[id] = (0, import_path.join)(legacySharedDir, filename);
      }
    }
    legacyAgentFileTemplates = config.agentFiles;
  }
  const skipAgents = new Set(config.skipAgents ?? []);
  const bootstrapDedup = config.bootstrapDedup !== false;
  function getAgentConfig(agentId) {
    const agents = config.agents;
    if (!agents) return null;
    const wildcard = agents["*"];
    const specific = agents[agentId];
    if (!wildcard && !specific) return null;
    return { ...wildcard, ...specific };
  }
  function resolveTemplate(path, agentId) {
    return path.replace(/\{agentId\}/g, agentId);
  }
  function getAgentWorkspaceRoot(agentId) {
    const agentCfg = getAgentConfig(agentId);
    if (agentCfg?.workspaceRoot !== void 0) {
      const resolved = resolveTemplate(agentCfg.workspaceRoot, agentId);
      if (resolved === ".") return workspaceRoot;
      return (0, import_path.join)(workspaceRoot, resolved);
    }
    if (legacySharedDir) {
      const agentPath = (0, import_path.join)(legacySharedDir, agentId);
      if ((0, import_fs.existsSync)(agentPath)) return agentPath;
    }
    return workspaceRoot;
  }
  function resolveWorkspaceFile(agentId, slotKey) {
    const agentCfg = getAgentConfig(agentId);
    const agentRoot = getAgentWorkspaceRoot(agentId);
    if (agentCfg?.extraWorkspaceFiles?.[slotKey]) {
      const p2 = (0, import_path.join)(agentRoot, agentCfg.extraWorkspaceFiles[slotKey]);
      return (0, import_fs.existsSync)(p2) ? p2 : null;
    }
    const filename = stdFiles[slotKey];
    if (!filename) {
      warn(`Unknown workspace file slot: '${slotKey}'`);
      return null;
    }
    const p = (0, import_path.join)(agentRoot, filename);
    return (0, import_fs.existsSync)(p) ? p : null;
  }
  function resolveSharedContext(name) {
    const ctx = sharedContexts[name];
    if (!ctx) {
      warn(`Unknown shared context: '${name}'`);
      return null;
    }
    const p = (0, import_path.join)(workspaceRoot, ctx.path);
    if (!(0, import_fs.existsSync)(p)) {
      warn(`Shared context file missing: '${ctx.path}'`);
      return null;
    }
    return p;
  }
  function getAgentWorkspaceFileKeys(agentId) {
    const agentCfg = getAgentConfig(agentId);
    return agentCfg?.workspaceFiles ?? Object.keys(stdFiles);
  }
  function getAgentSharedContextNames(agentId) {
    const agentCfg = getAgentConfig(agentId);
    const injected = agentCfg?.injectSharedOnFirstTurn ?? [];
    const available = agentCfg?.availableSharedContexts ?? [];
    const all = /* @__PURE__ */ new Set([...injected, ...available]);
    return [...all];
  }
  function legacyResolveAgentFile(agentId, filename) {
    if (legacySharedDir) {
      const agentPath = (0, import_path.join)(legacySharedDir, agentId, filename);
      if ((0, import_fs.existsSync)(agentPath)) return agentPath;
    }
    return (0, import_path.join)(workspaceRoot, filename);
  }
  function legacyLoadSharedFile(filename) {
    if (!legacySharedDir) return "";
    return readFileCached((0, import_path.join)(legacySharedDir, filename));
  }
  function legacyBuildSections(files) {
    return files.map((f) => {
      const content = legacyLoadSharedFile(f);
      if (!content) return "";
      return `## ${f}
${content}`;
    }).filter(Boolean);
  }
  function legacyLoadCompactReminder() {
    if (config.compactReminder) return config.compactReminder;
    if (config.compactReminderFile) {
      const filePath = (0, import_path.join)(workspaceRoot, config.compactReminderFile);
      const content = readFileCached(filePath);
      if (content) return content;
    }
    return "";
  }
  function legacyLoadContextRoutingIndex() {
    if (config.contextRoutingIndex) return config.contextRoutingIndex;
    if (config.contextRoutingIndexFile) {
      const filePath = (0, import_path.join)(workspaceRoot, config.contextRoutingIndexFile);
      const content = readFileCached(filePath);
      if (content) return content;
    }
    return "";
  }
  function legacyGetCompactReminder(agentId) {
    const reminder = legacyLoadCompactReminder();
    if (!reminder) return "";
    const lines = [
      "## Shared context (full text injected on first turn; summary below. Use workspace_context for full content.)",
      "",
      reminder
    ];
    if (legacyGlobalFiles) {
      lines.push("", "### Available files");
      for (const id of Object.keys(legacyGlobalFiles)) {
        lines.push(`- \`workspace_context({id:"${id}"})\``);
      }
    }
    return lines.join("\n");
  }
  function buildFirstTurnContent(agentId) {
    const agentCfg = getAgentConfig(agentId);
    if (!agentCfg) return [];
    const sections = [];
    const wsKeys = agentCfg.workspaceFiles ?? [];
    for (const key of wsKeys) {
      const filePath = resolveWorkspaceFile(agentId, key);
      if (filePath) {
        const content = readFileCached(filePath);
        if (content) {
          const filename = stdFiles[key] ?? key;
          sections.push(`## ${filename}
${content}`);
        }
      }
    }
    const sharedNames = agentCfg.injectSharedOnFirstTurn ?? [];
    for (const name of sharedNames) {
      const filePath = resolveSharedContext(name);
      if (filePath) {
        const content = readFileCached(filePath);
        if (content) {
          const ctx = sharedContexts[name];
          const label = ctx?.label ?? ctx?.description ?? name;
          sections.push(`## Shared: ${label}
${content}`);
        }
      }
    }
    const routeTable = agentCfg.routeTable;
    if (routeTable && Object.keys(routeTable).length > 0) {
      const routeLines = ["## Context Route Table", ""];
      for (const [topic, target] of Object.entries(routeTable)) {
        routeLines.push(`- **${topic}** \u2192 \`workspace_context({id:"${target}"})\``);
      }
      sections.push(routeLines.join("\n"));
    }
    return sections;
  }
  function buildCompactReminder(agentId) {
    const agentCfg = getAgentConfig(agentId);
    if (!agentCfg) return "";
    const lines = [
      "## Progressive Context Reminder",
      "",
      "Full context was injected on the first turn. Use `workspace_context` to retrieve files on demand.",
      ""
    ];
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
    const injected = agentCfg.injectSharedOnFirstTurn ?? [];
    const available = agentCfg.availableSharedContexts ?? [];
    const allShared = [.../* @__PURE__ */ new Set([...injected, ...available])];
    if (allShared.length > 0) {
      lines.push("### Shared contexts");
      for (const name of allShared) {
        const ctx = sharedContexts[name];
        const desc = ctx?.description ? ` \u2014 ${ctx.description}` : "";
        const compact = ctx?.compactText;
        if (compact) {
          lines.push(`- \`shared:${name}\`${desc}: ${compact}`);
        } else {
          lines.push(`- \`shared:${name}\`${desc}`);
        }
      }
      lines.push("");
    }
    const routeTable = agentCfg.routeTable;
    if (routeTable && Object.keys(routeTable).length > 0) {
      lines.push("### Route hints");
      for (const [topic, target] of Object.entries(routeTable)) {
        lines.push(`- ${topic} \u2192 \`${target}\``);
      }
      lines.push("");
    }
    return lines.join("\n");
  }
  api.on(
    "agent:bootstrap",
    (event, ctx) => {
      const ev = event;
      const cx = ctx;
      const agentId = ev?.context?.agentId ?? cx?.agentId;
      const files = ev?.context?.bootstrapFiles;
      if (!agentId || !Array.isArray(files)) return;
      const agentCfg = getAgentConfig(agentId);
      if (!agentCfg) return;
      const keepSet = new Set(agentCfg.bootstrapKeep ?? []);
      const compactMap = agentCfg.bootstrapCompact ?? {};
      const agentRoot = getAgentWorkspaceRoot(agentId);
      function tryAgentOverride(name, file) {
        if (!bootstrapDedup) return file;
        if (!keepSet.has(name)) return file;
        const agentPath = (0, import_path.join)(agentRoot, name);
        const filePath = file?.path ?? "";
        if (filePath.startsWith(agentRoot + "/")) return file;
        try {
          if (!(0, import_fs.existsSync)(agentPath)) return file;
          const content = (0, import_fs.readFileSync)(agentPath, "utf-8");
          return { ...file, content, path: agentPath, name };
        } catch {
          return file;
        }
      }
      const seen = /* @__PURE__ */ new Map();
      const nextFiles = [];
      for (const file of files) {
        const name = (0, import_path.basename)(file?.path ?? file?.name ?? "");
        if (!name) continue;
        if (keepSet.has(name)) {
          const overridden = tryAgentOverride(name, file);
          if (bootstrapDedup && seen.has(name)) {
            nextFiles[seen.get(name)] = overridden;
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
              content: `## ${name}

${compactMap[name]}`,
              path: file?.path ?? name,
              name
            });
          }
          continue;
        }
      }
      ev.context.bootstrapFiles = nextFiles.filter(Boolean);
    },
    { priority: 100 }
  );
  api.on(
    "before_prompt_build",
    (event, ctx) => {
      const ev = event;
      const cx = ctx;
      const agentId = cx?.agentId;
      if (!agentId || skipAgents.has(agentId)) return;
      const agentCfg = getAgentConfig(agentId);
      if (!agentCfg) return;
      const isFirstTurn = !ev.messages || ev.messages.length <= 1;
      const sections = [];
      if (hasV3Config) {
        if (isFirstTurn) {
          sections.push(...buildFirstTurnContent(agentId));
        } else {
          const reminder = buildCompactReminder(agentId);
          if (reminder) sections.push(reminder);
        }
      } else {
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
        appendSystemContext: sections.join("\n\n")
      };
    },
    { priority: 10 }
  );
  try {
    const wsSlotKeys = Object.keys(stdFiles);
    const sharedNames = Object.keys(sharedContexts);
    const legacyGlobalIds = legacyGlobalFiles ? Object.keys(legacyGlobalFiles) : [];
    const legacyAgentIds = legacyAgentFileTemplates ? Object.keys(legacyAgentFileTemplates) : [];
    const idExamples = [];
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
            description: `File ID. Use 'workspace:<key>' or 'shared:<name>'. ${idsDesc}`
          },
          section: {
            type: "string",
            description: "Section name (fuzzy match heading). Omit for full content."
          },
          list_sections: {
            type: "boolean",
            description: "Return section headings only."
          }
        },
        required: ["id"]
      },
      execute: async (params, toolCtx) => {
        const { id, section, list_sections } = params;
        const agentId = toolCtx?.agentId ?? "unknown";
        let filePath = null;
        if (id.startsWith("workspace:")) {
          const key = id.slice("workspace:".length);
          filePath = resolveWorkspaceFile(agentId, key);
          if (!filePath) {
            return { error: `Workspace file not found for slot '${key}' (agent: ${agentId})` };
          }
        } else if (id.startsWith("shared:")) {
          const name = id.slice("shared:".length);
          const hashIdx = name.indexOf("#");
          const contextName = hashIdx >= 0 ? name.slice(0, hashIdx) : name;
          const hashSection = hashIdx >= 0 ? name.slice(hashIdx + 1) : void 0;
          filePath = resolveSharedContext(contextName);
          if (!filePath) {
            return { error: `Shared context not found: '${contextName}'` };
          }
          if (hashSection && !section) {
            const content2 = readFileCached(filePath);
            const extracted = extractSection(content2, hashSection);
            if (!extracted) return { error: `Section not found: "${hashSection}" in shared:${contextName}` };
            return { content: extracted };
          }
        } else {
          if (legacyGlobalFiles && legacyGlobalFiles[id]) {
            filePath = legacyGlobalFiles[id];
          }
          if (!filePath && legacyAgentFileTemplates && legacyAgentFileTemplates[id]) {
            const filename = legacyAgentFileTemplates[id];
            filePath = legacyResolveAgentFile(agentId, filename);
          }
          if (!filePath && stdFiles[id]) {
            filePath = resolveWorkspaceFile(agentId, id);
          }
          if (!filePath && sharedContexts[id]) {
            filePath = resolveSharedContext(id);
          }
          if (!filePath) {
            return {
              error: `Unknown id: '${id}'. Use 'workspace:<key>' or 'shared:<name>'. Available: ${idsDesc}`
            };
          }
        }
        let content;
        try {
          content = (0, import_fs.readFileSync)(filePath, "utf-8");
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
      }
    });
    console.log("[progressive-context] workspace_context tool registered (v3)");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[progressive-context] registerTool not available:", msg);
  }
}
