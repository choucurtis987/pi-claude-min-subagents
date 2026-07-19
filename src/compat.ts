import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentConfig,
  AgentDiagnostic,
  EffectiveAgentConfig,
  ParentRuntime,
  Settings,
} from "./types.ts";

export const CLAUDE_TOOL_MAP: Readonly<Record<string, string>> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  Bash: "bash",
  Grep: "grep",
  Glob: "find",
  Agent: "subagent",
};

export function translateClaudeTools(names: string[] | undefined): {
  tools: string[] | undefined;
  diagnostics: AgentDiagnostic[];
} {
  if (!names) return { tools: undefined, diagnostics: [] };

  const tools: string[] = [];
  const diagnostics: AgentDiagnostic[] = [];
  const unsupported = new Set<string>();

  for (const name of names) {
    if (name === "Skill") continue;
    const tool = CLAUDE_TOOL_MAP[name];
    if (tool) {
      tools.push(tool);
      continue;
    }
    if (!unsupported.has(name)) {
      unsupported.add(name);
      diagnostics.push({
        code: "unsupported-tool",
        message: `Unsupported Claude tool "${name}".`,
      });
    }
  }

  return { tools, diagnostics };
}

export function capDiagnostics(items: AgentDiagnostic[]): AgentDiagnostic[] {
  const unique: AgentDiagnostic[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.code}\0${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  if (unique.length <= 20) return unique;
  return [
    ...unique.slice(0, 19),
    {
      code: "diagnostics-truncated",
      message: `${unique.length - 19} additional compatibility diagnostics were omitted.`,
    },
  ];
}

function isSafeNamedSkillName(name: string): boolean {
  return name.length > 0
    && name !== "."
    && name !== ".."
    && !path.isAbsolute(name)
    && !/[\\/]/.test(name);
}

function isContainedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && !path.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`);
}

function findNamedSkill(cwd: string, homeDir: string, name: string): string | undefined {
  let dir = path.resolve(cwd);
  while (true) {
    const skillRoot = path.join(dir, ".claude", "skills");
    const candidate = path.join(skillRoot, name, "SKILL.md");
    if (fs.existsSync(candidate)) {
      try {
        const canonicalProjectRoot = fs.realpathSync(dir);
        const canonicalRoot = fs.realpathSync(skillRoot);
        const canonicalCandidate = fs.realpathSync(candidate);
        if (isContainedBy(canonicalProjectRoot, canonicalRoot)
          && isContainedBy(canonicalRoot, canonicalCandidate)
          && fs.statSync(canonicalCandidate).isFile()) return candidate;
      } catch {
        // Treat realpath failures as unresolved candidates.
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const skillRoot = path.join(homeDir, ".claude", "skills");
  const globalCandidate = path.join(skillRoot, name, "SKILL.md");
  if (!fs.existsSync(globalCandidate)) return undefined;
  try {
    const canonicalHome = fs.realpathSync(homeDir);
    const canonicalRoot = fs.realpathSync(skillRoot);
    const canonicalCandidate = fs.realpathSync(globalCandidate);
    return isContainedBy(canonicalHome, canonicalRoot)
      && isContainedBy(canonicalRoot, canonicalCandidate)
      && fs.statSync(canonicalCandidate).isFile() ? globalCandidate : undefined;
  } catch {
    return undefined;
  }
}

function resolveSkills(
  agent: AgentConfig,
  cwd: string,
  homeDir: string,
): { skills: string[] | undefined; diagnostics: AgentDiagnostic[]; configurationError?: string } {
  if (agent.sidecar?.skills !== undefined) {
    if (agent.sidecar.skills.length === 0) return { skills: [], diagnostics: [] };
    if (!agent.sidecarPath && agent.sidecar.skills.some((skill) => !path.isAbsolute(skill))) {
      return {
        skills: undefined,
        diagnostics: [],
        configurationError: "Cannot resolve relative sidecar skills because the sidecar path is missing.",
      };
    }
    const baseDir = agent.sidecarPath ? path.dirname(agent.sidecarPath) : undefined;
    return {
      skills: agent.sidecar.skills.map((skill) => path.isAbsolute(skill) ? skill : path.resolve(baseDir!, skill)),
      diagnostics: [],
    };
  }

  if (!agent.claudeSkills) return { skills: undefined, diagnostics: [] };

  const diagnostics: AgentDiagnostic[] = [];
  const skills: string[] = [];
  for (const name of agent.claudeSkills) {
    if (!isSafeNamedSkillName(name)) {
      diagnostics.push({
        code: "invalid-skill-name",
        message: "Invalid Claude skill name; skipped.",
      });
      continue;
    }

    const skillPath = findNamedSkill(cwd, homeDir, name);
    if (skillPath) {
      skills.push(skillPath);
    } else {
      diagnostics.push({
        code: "missing-skill",
        message: `Claude skill "${name}" was not found.`,
      });
    }
  }

  return { skills, diagnostics };
}

export function resolveEffectiveAgentConfig(options: {
  agent: AgentConfig;
  settings: Settings;
  parent: ParentRuntime;
  cwd: string;
  homeDir?: string;
}): EffectiveAgentConfig {
  const { agent, settings, parent, cwd } = options;
  const homeDir = options.homeDir ?? os.homedir();
  const diagnostics = [...(agent.diagnostics ?? [])];

  if (agent.sidecarError) {
    return {
      agent,
      extensions: settings.extensions,
      diagnostics: capDiagnostics(diagnostics),
      configurationError: agent.sidecarError,
    };
  }

  const translatedTools = translateClaudeTools(agent.claudeTools);
  const translatedDisallowedTools = translateClaudeTools(agent.claudeDisallowedTools);
  const resolvedSkills = resolveSkills(agent, cwd, homeDir);
  diagnostics.push(
    ...translatedTools.diagnostics,
    ...translatedDisallowedTools.diagnostics,
    ...resolvedSkills.diagnostics,
  );

  const model = agent.sidecar?.model ?? settings.model ?? parent.model;
  const thinking = agent.sidecar?.thinking ?? parent.thinking;
  const tools = agent.sidecar?.tools ?? translatedTools.tools;
  const disallowedTools = agent.sidecar?.disallowedTools ?? translatedDisallowedTools.tools;
  const extensions = agent.sidecar && Object.hasOwn(agent.sidecar, "extensions")
    ? agent.sidecar.extensions ?? null
    : settings.extensions;

  return {
    agent,
    model: model ?? undefined,
    thinking,
    tools,
    disallowedTools,
    skills: resolvedSkills.skills,
    extensions,
    diagnostics: capDiagnostics(diagnostics),
    configurationError: resolvedSkills.configurationError,
  };
}
