import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveEffectiveAgentConfig, translateClaudeTools } from "./compat.ts";

const settings = { model: null, extensions: null, environment: {} };
const agent = (overrides = {}) => ({
  name: "scout", description: "Scout", systemPrompt: "Inspect.",
  source: "project", filePath: "/repo/.pi/agents/scout.md",
  scopeDir: "/repo/.pi/agents", claudeTools: undefined,
  claudeDisallowedTools: undefined, claudeSkills: undefined,
  diagnostics: [], ...overrides,
});

test("maps Claude tools and reports unknown names once", () => {
  const { tools, diagnostics } = translateClaudeTools(["Read", "Glob", "Read", "Browser"]);
  assert.deepEqual(tools, ["read", "find", "read"]);
  assert.deepEqual(diagnostics.map((d) => d.message), ['Unsupported Claude tool "Browser".']);
});

test("sidecar model and thinking override settings and parent runtime", () => {
  const effective = resolveEffectiveAgentConfig({
    agent: agent({ sidecar: { model: "openai/gpt-5.4", thinking: "high" } }),
    settings: { ...settings, model: "google/gemini-3" },
    parent: { model: "anthropic/sonnet", thinking: "low" }, cwd: "/repo", homeDir: "/home/test",
  });
  assert.equal(effective.model, "openai/gpt-5.4");
  assert.equal(effective.thinking, "high");
});

test("inherits parent Pi model and thinking while ignoring Claude model", () => {
  const effective = resolveEffectiveAgentConfig({
    agent: agent({ claudeModel: "sonnet", diagnostics: [] }), settings,
    parent: { model: "openai/gpt-5.4", thinking: "medium" }, cwd: "/repo", homeDir: "/home/test",
  });
  assert.equal(effective.model, "openai/gpt-5.4");
  assert.equal(effective.thinking, "medium");
});

test("settings model wins over parent model when no sidecar model exists", () => {
  const effective = resolveEffectiveAgentConfig({
    agent: agent(), settings: { ...settings, model: "google/gemini-3" },
    parent: { model: "anthropic/sonnet" }, cwd: "/repo", homeDir: "/home/test",
  });
  assert.equal(effective.model, "google/gemini-3");
});

test("sidecar lists replace translated lists and empty tools disable all tools", () => {
  const effective = resolveEffectiveAgentConfig({
    agent: agent({ claudeTools: ["Read", "Bash"], sidecar: { tools: [], skills: [] } }),
    settings, parent: {}, cwd: "/repo", homeDir: "/home/test",
  });
  assert.deepEqual(effective.tools, []);
  assert.deepEqual(effective.skills, []);
});

test("resolves the nearest named project skill before global fallback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compat-"));
  try {
    const nested = path.join(root, "packages", "app");
    const nearestSkill = path.join(root, "packages", ".claude", "skills", "research", "SKILL.md");
    const globalSkill = path.join(root, "home", ".claude", "skills", "research", "SKILL.md");
    fs.mkdirSync(path.dirname(nearestSkill), { recursive: true });
    fs.mkdirSync(path.dirname(globalSkill), { recursive: true });
    fs.writeFileSync(nearestSkill, "# Project research");
    fs.writeFileSync(globalSkill, "# Global research");

    const effective = resolveEffectiveAgentConfig({
      agent: agent({ claudeSkills: ["research"] }), settings, parent: {}, cwd: nested, homeDir: path.join(root, "home"),
    });
    assert.deepEqual(effective.skills, [nearestSkill]);

    fs.rmSync(nearestSkill, { force: true });
    const fallback = resolveEffectiveAgentConfig({
      agent: agent({ claudeSkills: ["research"] }), settings, parent: {}, cwd: nested, homeDir: path.join(root, "home"),
    });
    assert.deepEqual(fallback.skills, [globalSkill]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects named skills when the project skill root symlink escapes the project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compat-skill-root-link-"));
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compat-external-skills-"));
  try {
    const externalSkills = path.join(externalRoot, "skills");
    const externalSkill = path.join(externalSkills, "research", "SKILL.md");
    const skillRoot = path.join(root, ".claude", "skills");
    fs.mkdirSync(path.dirname(externalSkill), { recursive: true });
    fs.writeFileSync(externalSkill, "# Must not be loaded");
    fs.mkdirSync(path.dirname(skillRoot), { recursive: true });
    fs.symlinkSync(externalSkills, skillRoot, "dir");

    const effective = resolveEffectiveAgentConfig({
      agent: agent({ claudeSkills: ["research"] }), settings, parent: {}, cwd: root, homeDir: path.join(root, "home"),
    });
    assert.deepEqual(effective.skills, []);
    assert.equal(effective.diagnostics.at(-1)?.code, "missing-skill");
    assert.ok(effective.diagnostics.length <= 20);
    assert.ok(!effective.diagnostics.some((diagnostic) => diagnostic.message.includes(externalSkills)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("rejects named skills whose directory symlink escapes the project skill root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compat-skill-dir-link-"));
  try {
    const skillsRoot = path.join(root, ".claude", "skills");
    const outsideSkill = path.join(root, "outside", "research", "SKILL.md");
    fs.mkdirSync(path.dirname(outsideSkill), { recursive: true });
    fs.writeFileSync(outsideSkill, "# Must not be loaded");
    fs.mkdirSync(skillsRoot, { recursive: true });
    fs.symlinkSync(path.dirname(outsideSkill), path.join(skillsRoot, "research"), "dir");

    const effective = resolveEffectiveAgentConfig({
      agent: agent({ claudeSkills: ["research"] }), settings, parent: {}, cwd: root, homeDir: path.join(root, "home"),
    });
    assert.deepEqual(effective.skills, []);
    assert.equal(effective.diagnostics.at(-1)?.code, "missing-skill");
    assert.ok(!effective.skills?.includes(outsideSkill));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects named skills whose SKILL.md symlink escapes the project skill root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compat-skill-file-link-"));
  try {
    const skillRoot = path.join(root, ".claude", "skills", "research");
    const outsideSkill = path.join(root, "outside", "SKILL.md");
    fs.mkdirSync(path.dirname(outsideSkill), { recursive: true });
    fs.writeFileSync(outsideSkill, "# Must not be loaded");
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.symlinkSync(outsideSkill, path.join(skillRoot, "SKILL.md"));

    const effective = resolveEffectiveAgentConfig({
      agent: agent({ claudeSkills: ["research"] }), settings, parent: {}, cwd: root, homeDir: path.join(root, "home"),
    });
    assert.deepEqual(effective.skills, []);
    assert.equal(effective.diagnostics.at(-1)?.code, "missing-skill");
    assert.ok(!effective.skills?.includes(outsideSkill));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a directory named SKILL.md with the bounded missing-skill diagnostic", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compat-skill-directory-file-"));
  try {
    const candidate = path.join(root, ".claude", "skills", "research", "SKILL.md");
    fs.mkdirSync(candidate, { recursive: true });

    const effective = resolveEffectiveAgentConfig({
      agent: agent({ claudeSkills: ["research"] }), settings, parent: {}, cwd: root, homeDir: path.join(root, "home"),
    });
    assert.deepEqual(effective.skills, []);
    assert.equal(effective.diagnostics.at(-1)?.code, "missing-skill");
    assert.ok(effective.diagnostics.length <= 20);
    assert.ok(!effective.diagnostics.some((diagnostic) => diagnostic.message.includes(candidate)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("accepts a named skill whose SKILL.md symlink targets a file inside the skill root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compat-safe-skill-file-link-"));
  try {
    const skillRoot = path.join(root, ".claude", "skills");
    const target = path.join(skillRoot, "shared", "research.md");
    const candidate = path.join(skillRoot, "research", "SKILL.md");
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "# Safe research");
    fs.symlinkSync(target, candidate);

    const effective = resolveEffectiveAgentConfig({
      agent: agent({ claudeSkills: ["research"] }), settings, parent: {}, cwd: root, homeDir: path.join(root, "home"),
    });
    assert.deepEqual(effective.skills, [candidate]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("accepts a .claude/skills symlink targeting a root inside the project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compat-safe-skill-root-link-"));
  try {
    const actualRoot = path.join(root, "shared", "skills");
    const skillRoot = path.join(root, ".claude", "skills");
    const candidate = path.join(skillRoot, "research", "SKILL.md");
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.mkdirSync(path.join(actualRoot, "research"), { recursive: true });
    fs.writeFileSync(path.join(actualRoot, "research", "SKILL.md"), "# Safe research");
    fs.rmSync(skillRoot, { recursive: true, force: true });
    fs.symlinkSync(actualRoot, skillRoot, "dir");

    const effective = resolveEffectiveAgentConfig({
      agent: agent({ claudeSkills: ["research"] }), settings, parent: {}, cwd: root, homeDir: path.join(root, "home"),
    });
    assert.deepEqual(effective.skills, [candidate]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skips unsafe named skills without resolving or exposing skill paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compat-unsafe-skill-"));
  try {
    const escapeSkill = path.join(root, "escape", "SKILL.md");
    const absoluteSkill = path.join(root, "absolute", "SKILL.md");
    fs.mkdirSync(path.dirname(escapeSkill), { recursive: true });
    fs.mkdirSync(path.dirname(absoluteSkill), { recursive: true });
    fs.writeFileSync(escapeSkill, "# Must not be loaded");
    fs.writeFileSync(absoluteSkill, "# Must not be loaded");

    const effective = resolveEffectiveAgentConfig({
      agent: agent({ claudeSkills: ["../../escape", "/absolute", "..\\escape"] }),
      settings, parent: {}, cwd: path.join(root, "nested"), homeDir: path.join(root, "home"),
    });
    assert.deepEqual(effective.skills, []);
    assert.equal(effective.diagnostics.length, 1);
    assert.ok(effective.diagnostics.every((diagnostic) => diagnostic.code === "invalid-skill-name"));
    assert.ok(effective.diagnostics.every((diagnostic) => !diagnostic.message.includes("SKILL.md")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects relative sidecar skills without their sidecar path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compat-sidecar-"));
  try {
    const fallbackSkill = path.join(root, "relative", "SKILL.md");
    fs.mkdirSync(path.dirname(fallbackSkill), { recursive: true });
    fs.writeFileSync(fallbackSkill, "# Must not be used");
    const effective = resolveEffectiveAgentConfig({
      agent: agent({ filePath: path.join(root, "agent.md"), sidecar: { skills: ["relative/SKILL.md"] } }),
      settings, parent: {}, cwd: "/repo", homeDir: "/home/test",
    });
    assert.match(effective.configurationError ?? "", /sidecar path/i);
    assert.equal(effective.skills, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("caps and deduplicates compatibility diagnostics", () => {
  const duplicate = { code: "unknown-claude-field", message: "duplicate" };
  const diagnostics = [duplicate, duplicate, ...Array.from({ length: 20 }, (_, i) => ({
    code: "unknown-claude-field", message: `field-${i}`,
  }))];
  const effective = resolveEffectiveAgentConfig({
    agent: agent({ diagnostics }), settings, parent: {}, cwd: "/repo", homeDir: "/home/test",
  });
  assert.equal(effective.diagnostics.length, 20);
  assert.equal(effective.diagnostics.filter((d) => d.message === "duplicate").length, 1);
  assert.equal(effective.diagnostics.at(-1)?.code, "diagnostics-truncated");
});

test("preserves extension tri-state between inherited, null, and empty", () => {
  const inherited = resolveEffectiveAgentConfig({
    agent: agent(), settings: { ...settings, extensions: ["/repo/extension.ts"] },
    parent: {}, cwd: "/repo", homeDir: "/home/test",
  });
  const disabled = resolveEffectiveAgentConfig({
    agent: agent({ sidecar: { extensions: null } }), settings,
    parent: {}, cwd: "/repo", homeDir: "/home/test",
  });
  const empty = resolveEffectiveAgentConfig({
    agent: agent({ sidecar: { extensions: [] } }), settings: { ...settings, extensions: ["/repo/extension.ts"] },
    parent: {}, cwd: "/repo", homeDir: "/home/test",
  });
  assert.deepEqual(inherited.extensions, ["/repo/extension.ts"]);
  assert.equal(disabled.extensions, null);
  assert.deepEqual(empty.extensions, []);
});
