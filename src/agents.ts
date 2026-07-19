import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { resolveConfiguredPath } from "./settings.ts";
import type { AgentConfig, AgentDiagnostic, AgentSource, PiAgentOverrides } from "./types.ts";

const SUPPORTED_CLAUDE_FIELDS = new Set([
  "name",
  "description",
  "model",
  "tools",
  "disallowedTools",
  "skills",
]);
const UNSUPPORTED_CLAUDE_FIELDS = new Set([
  "permissionMode",
  "hooks",
  "mcpServers",
  "memory",
  "maxTurns",
  "effort",
  "background",
  "isolation",
  "color",
  "initialPrompt",
]);
const SIDECAR_FIELDS = new Set([
  "model",
  "thinking",
  "tools",
  "disallowedTools",
  "skills",
  "extensions",
]);

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

export interface DiscoverAgentsOptions {
  userAgentsDir?: string;
}

interface SidecarLoadResult {
  overrides?: PiAgentOverrides;
  error?: string;
  diagnostics: AgentDiagnostic[];
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isSafeAgentName(name: string): boolean {
  return /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(name);
}

function invalidSidecar(sidecarPath: string, reason: string): SidecarLoadResult {
  return {
    error: `Invalid Pi agent sidecar ${sidecarPath}: ${reason}`,
    diagnostics: [],
  };
}

function parseSidecarList(value: unknown, field: string, sidecarPath: string): string[] | SidecarLoadResult {
  if (typeof value === "string") return parseStringList(value) ?? [];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return parseStringList(value) ?? [];
  }
  return invalidSidecar(sidecarPath, `${field} must be a string or an array of strings.`);
}

function loadSidecar(sidecarPath: string): SidecarLoadResult {
  if (!fs.existsSync(sidecarPath)) return { diagnostics: [] };

  let frontmatter: Record<string, unknown>;
  try {
    const yaml = fs.readFileSync(sidecarPath, "utf-8");
    const parsed = parseFrontmatter<Record<string, unknown>>(`---\n${yaml}\n---`).frontmatter as unknown;
    if (!isMapping(parsed)) {
      return invalidSidecar(sidecarPath, "YAML document must be a mapping.");
    }
    frontmatter = parsed;
  } catch {
    return invalidSidecar(sidecarPath, "malformed YAML.");
  }

  const diagnostics: AgentDiagnostic[] = [];
  for (const key of Object.keys(frontmatter)) {
    if (!SIDECAR_FIELDS.has(key)) {
      diagnostics.push({
        code: "unknown-sidecar-field",
        message: `Unknown Pi sidecar field "${key}".`,
      });
    }
  }

  const overrides: PiAgentOverrides = {};
  for (const field of ["model", "thinking"] as const) {
    if (frontmatter[field] === undefined) continue;
    const value = firstString(frontmatter[field]);
    if (!value) return invalidSidecar(sidecarPath, `${field} must be a non-empty string.`);
    overrides[field] = value;
  }

  for (const field of ["tools", "disallowedTools", "skills"] as const) {
    if (frontmatter[field] === undefined) continue;
    const value = parseSidecarList(frontmatter[field], field, sidecarPath);
    if (!Array.isArray(value)) return value;
    overrides[field] = value;
  }

  if (frontmatter.extensions !== undefined) {
    if (frontmatter.extensions === null) {
      overrides.extensions = null;
    } else {
      const value = parseSidecarList(frontmatter.extensions, "extensions", sidecarPath);
      if (!Array.isArray(value)) return value;
      overrides.extensions = value.map((extension) => resolveConfiguredPath(extension, path.dirname(sidecarPath)));
    }
  }

  return { overrides, diagnostics };
}

function claudeDiagnostics(frontmatter: Record<string, unknown>): AgentDiagnostic[] {
  const diagnostics: AgentDiagnostic[] = [];
  for (const key of Object.keys(frontmatter)) {
    if (SUPPORTED_CLAUDE_FIELDS.has(key)) continue;
    diagnostics.push({
      code: UNSUPPORTED_CLAUDE_FIELDS.has(key) ? "unsupported-claude-field" : "unknown-claude-field",
      message: UNSUPPORTED_CLAUDE_FIELDS.has(key)
        ? `Claude field "${key}" is not supported by Pi.`
        : `Unknown Claude agent field "${key}".`,
    });
  }
  return diagnostics;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    let parsed: { frontmatter: Record<string, unknown>; body: string };
    try {
      parsed = parseFrontmatter<Record<string, unknown>>(content);
    } catch {
      continue;
    }

    const { frontmatter, body } = parsed;
    const name = firstString(frontmatter.name);
    const description = firstString(frontmatter.description);
    if (!name || !description || !isSafeAgentName(name)) continue;

    const sidecarPath = path.join(path.dirname(dir), "agent-overrides", `${name}.yaml`);
    const sidecar = loadSidecar(sidecarPath);
    agents.push({
      name,
      description,
      systemPrompt: body.trim(),
      source,
      filePath,
      scopeDir: dir,
      sidecarPath,
      claudeModel: firstString(frontmatter.model),
      claudeTools: parseStringList(frontmatter.tools),
      claudeDisallowedTools: parseStringList(frontmatter.disallowedTools),
      claudeSkills: parseStringList(frontmatter.skills),
      sidecar: sidecar.overrides,
      sidecarError: sidecar.error,
      diagnostics: [...claudeDiagnostics(frontmatter), ...sidecar.diagnostics],
    });
  }

  return agents;
}

function findProjectAgentsDir(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, ".pi", "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // keep walking upward
    }

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function discoverAgents(cwd: string, options: DiscoverAgentsOptions = {}): AgentDiscoveryResult {
  const userDir = options.userAgentsDir ?? path.join(getAgentDir(), "agents");
  const projectAgentsDir = findProjectAgentsDir(cwd);

  const userAgents = loadAgentsFromDir(userDir, "user");
  const projectAgents = projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : [];

  const byName = new Map<string, AgentConfig>();
  for (const agent of userAgents) byName.set(agent.name, agent);
  for (const agent of projectAgents) byName.set(agent.name, agent);

  return {
    agents: Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name)),
    projectAgentsDir,
  };
}
