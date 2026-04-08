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
function register(api) {
  const config = api.getConfig?.() ?? {};
  const workspaceRoot = api.getWorkspaceRoot?.() ?? process.cwd();
  const sharedDirRel = config.sharedDir ?? ((0, import_fs.existsSync)((0, import_path.join)(workspaceRoot, "agents")) ? "agents" : ".");
  const sharedDir = (0, import_path.join)(workspaceRoot, sharedDirRel);
  const skipAgents = new Set(config.skipAgents ?? []);
  const bootstrapDedup = config.bootstrapDedup !== false;
  const globalFiles = {};
  if (config.globalFiles) {
    for (const [id, filename] of Object.entries(config.globalFiles)) {
      globalFiles[id] = (0, import_path.join)(sharedDir, filename);
    }
  }
  const agentFileTemplates = config.agentFiles ?? {};
  function getAgentConfig(agentId) {
    const agents = config.agents;
    if (!agents) return null;
    const wildcard = agents["*"];
    const specific = agents[agentId];
    if (!wildcard && !specific) return null;
    return { ...wildcard, ...specific };
  }
  function resolveSharedFile(filename) {
    return (0, import_path.join)(sharedDir, filename);
  }
  function resolveAgentFile(agentId, filename) {
    const agentPath = (0, import_path.join)(sharedDir, agentId, filename);
    if ((0, import_fs.existsSync)(agentPath)) return agentPath;
    return (0, import_path.join)(workspaceRoot, filename);
  }
  function loadSharedFile(filename) {
    return readFileCached(resolveSharedFile(filename));
  }
  function buildSections(files) {
    return files.map((f) => {
      const content = loadSharedFile(f);
      if (!content) return "";
      return `## ${f}
${content}`;
    }).filter(Boolean);
  }
  function loadCompactReminder() {
    if (config.compactReminder) return config.compactReminder;
    if (config.compactReminderFile) {
      const filePath = (0, import_path.join)(workspaceRoot, config.compactReminderFile);
      const content = readFileCached(filePath);
      if (content) return content;
    }
    return "";
  }
  function loadContextRoutingIndex() {
    if (config.contextRoutingIndex) return config.contextRoutingIndex;
    if (config.contextRoutingIndexFile) {
      const filePath = (0, import_path.join)(workspaceRoot, config.contextRoutingIndexFile);
      const content = readFileCached(filePath);
      if (content) return content;
    }
    return "";
  }
  function getCompactReminder(agentId) {
    const reminder = loadCompactReminder();
    if (!reminder) return "";
    const agentCfg = getAgentConfig(agentId);
    const firstTurnFiles = agentCfg?.firstTurnFiles ?? [];
    const lines = [
      "## Shared context (full text injected on first turn; summary below. Use workspace_context for full content.)",
      "",
      reminder
    ];
    if (firstTurnFiles.length > 0) {
      lines.push("", "### Available files");
      for (const [id] of Object.entries(globalFiles)) {
        lines.push(`- \`workspace_context({id:"${id}"})\``);
      }
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
      const agentDir = (0, import_path.join)(sharedDir, agentId);
      function tryAgentOverride(name, file) {
        if (!bootstrapDedup) return file;
        if (!keepSet.has(name)) return file;
        const agentPath = (0, import_path.join)(agentDir, name);
        const filePath = file?.path ?? "";
        if (filePath.includes(`/${agentId}/`)) return file;
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
      const firstTurnFiles = agentCfg.firstTurnFiles ?? [];
      const isFirstTurn = !ev.messages || ev.messages.length <= 1;
      const sections = [];
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
        appendSystemContext: sections.join("\n\n")
      };
    },
    { priority: 10 }
  );
  try {
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
            description: `File ID. Global: ${globalIds.join(", ") || "none"}. Per-agent: ${agentFileIds.join(", ") || "none"}`
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
        let filePath = globalFiles[id];
        if (!filePath && agentFileTemplates[id]) {
          const filename = agentFileTemplates[id];
          filePath = resolveAgentFile(agentId, filename);
        }
        if (!filePath) {
          return { error: `Unknown id: ${id}. Valid IDs: ${idsDesc}` };
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
    console.log("[progressive-context] workspace_context tool registered");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[progressive-context] registerTool not available:", msg);
  }
}
