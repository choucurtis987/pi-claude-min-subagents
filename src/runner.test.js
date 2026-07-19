import assert from "node:assert/strict";
import test from "node:test";
import { buildPiArgs, runSubagent } from "./runner.ts";

const base = (overrides = {}) => ({
  task: "inspect",
  systemPromptPath: "/tmp/prompt.md",
  effective: {
    agent: {
      name: "scout",
      source: "project",
      filePath: "/repo/.pi/agents/scout.md",
      systemPrompt: "Inspect.",
      description: "Scout",
    },
    extensions: null,
    diagnostics: [],
    ...overrides,
  },
});

test("passes explicit inherited model, thinking, tool flags, and repeated skills", () => {
  const args = buildPiArgs(base({
    model: "openai/gpt-5.4",
    thinking: "high",
    tools: ["read", "grep"],
    disallowedTools: ["bash"],
    skills: ["/one/SKILL.md", "/two/SKILL.md"],
  }));
  assert.deepEqual(args, [
    "--mode", "json", "-p", "--no-session",
    "--model", "openai/gpt-5.4", "--thinking", "high",
    "--tools", "read,grep", "--exclude-tools", "bash",
    "--skill", "/one/SKILL.md", "--skill", "/two/SKILL.md",
    "--append-system-prompt", "/tmp/prompt.md", "inspect",
  ]);
});

test("uses no-tools for an explicit empty allowlist and sidecar extension policy", () => {
  const args = buildPiArgs(base({ tools: [], extensions: ["npm:only-this"] }));
  assert.deepEqual(args.slice(0, 8), [
    "--mode", "json", "-p", "--no-session", "--no-extensions", "--extension", "npm:only-this", "--no-tools",
  ]);
});

test("does not pass a model when no Pi model resolves", () => {
  const args = buildPiArgs(base());
  assert.equal(args.includes("--model"), false);
});

test("does not invoke the child spawner for a sidecar configuration error", async () => {
  let spawnCalls = 0;
  const result = await runSubagent({
    spawnProcess: () => {
      spawnCalls += 1;
      throw new Error("child process must not start");
    },
    cwd: process.cwd(),
    task: "inspect",
    settings: { model: null, extensions: null, environment: {} },
    effective: base({
      configurationError: "Invalid Pi agent sidecar /repo/.pi/agent-overrides/scout.yaml: bad YAML",
    }).effective,
    makeDetails: (results) => ({ results }),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.errorMessage ?? "", /Invalid Pi agent sidecar/);
  assert.equal(result.artifactDir, undefined);
  assert.equal(spawnCalls, 0);
});
