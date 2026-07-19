import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverAgents } from "./agents.ts";

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-claude-agents-"));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeAgent(filePath, frontmatter, body = "Only this body") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}\n`);
}

test("project definition overrides a same-named user definition and uses only its project sidecar", () => {
  withTempDir((root) => {
    const userAgentsDir = path.join(root, "user", "agents");
    const projectAgentsDir = path.join(root, ".pi", "agents");
    writeAgent(path.join(userAgentsDir, "reviewer.md"), "name: reviewer\ndescription: User reviewer");
    writeAgent(path.join(projectAgentsDir, "reviewer.md"), "name: reviewer\ndescription: Project reviewer");
    fs.mkdirSync(path.join(root, "user", "agent-overrides"), { recursive: true });
    fs.mkdirSync(path.join(root, ".pi", "agent-overrides"), { recursive: true });
    fs.writeFileSync(path.join(root, "user", "agent-overrides", "reviewer.yaml"), "model: user/model\n");
    fs.writeFileSync(path.join(root, ".pi", "agent-overrides", "reviewer.yaml"), "model: project/model\n");

    const [reviewer] = discoverAgents(root, { userAgentsDir }).agents;
    assert.equal(reviewer.source, "project");
    assert.equal(reviewer.description, "Project reviewer");
    assert.equal(reviewer.sidecar?.model, "project/model");
    assert.equal(reviewer.sidecarPath, path.join(root, ".pi", "agent-overrides", "reviewer.yaml"));
  });
});

test("discovers a symlinked Markdown agent through .pi/agents", () => {
  withTempDir((root) => {
    const sharedAgentsDir = path.join(root, "agents");
    writeAgent(path.join(sharedAgentsDir, "scout.md"), "name: scout\ndescription: Shared scout");
    fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
    fs.symlinkSync("../agents", path.join(root, ".pi", "agents"), "dir");

    const [scout] = discoverAgents(root, { userAgentsDir: path.join(root, "no-user-agents") }).agents;
    assert.equal(scout.name, "scout");
    assert.equal(scout.filePath, path.join(root, ".pi", "agents", "scout.md"));
    assert.equal(scout.scopeDir, path.join(root, ".pi", "agents"));
    assert.equal(scout.sidecarPath, path.join(root, ".pi", "agent-overrides", "scout.yaml"));
    assert.deepEqual(scout.diagnostics, []);
  });
});

test("resolves sidecar extension paths from the sidecar directory", () => {
  withTempDir((root) => {
    writeAgent(path.join(root, ".pi", "agents", "scout.md"), "name: scout\ndescription: Scout");
    const sidecarPath = path.join(root, ".pi", "agent-overrides", "scout.yaml");
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    fs.writeFileSync(sidecarPath, "extensions: ../../extensions/scout.ts\n");

    const [scout] = discoverAgents(root, { userAgentsDir: path.join(root, "no-user-agents") }).agents;
    assert.deepEqual(scout.sidecar?.extensions, [path.join(root, "extensions", "scout.ts")]);
  });
});

test("keeps an agent discoverable when its sidecar YAML is invalid", () => {
  withTempDir((root) => {
    writeAgent(path.join(root, ".pi", "agents", "scout.md"), "name: scout\ndescription: Scout");
    const sidecarPath = path.join(root, ".pi", "agent-overrides", "scout.yaml");
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    const secretSentinel = "UNIQUE_SIDECAR_SECRET_SENTINEL";
    fs.writeFileSync(sidecarPath, `tools: [${secretSentinel}\n`);

    const [scout] = discoverAgents(root, { userAgentsDir: path.join(root, "no-user-agents") }).agents;
    assert.equal(scout.name, "scout");
    assert.equal(scout.sidecarError, `Invalid Pi agent sidecar ${sidecarPath}: malformed YAML.`);
    assert.equal(scout.sidecarError?.includes(secretSentinel), false);
  });
});

test("rejects a sidecar whose YAML document is not a mapping", () => {
  withTempDir((root) => {
    writeAgent(path.join(root, ".pi", "agents", "scout.md"), "name: scout\ndescription: Scout");
    const sidecarPath = path.join(root, ".pi", "agent-overrides", "scout.yaml");
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    fs.writeFileSync(sidecarPath, "- read\n");

    const [scout] = discoverAgents(root, { userAgentsDir: path.join(root, "no-user-agents") }).agents;
    assert.match(scout.sidecarError ?? "", new RegExp(`^Invalid Pi agent sidecar ${sidecarPath.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}:`));
  });
});

test("does not discover an agent whose frontmatter name contains traversal", () => {
  withTempDir((root) => {
    writeAgent(
      path.join(root, ".pi", "agents", "escape.md"),
      "name: ../../escaped\ndescription: Unsafe agent",
    );

    const result = discoverAgents(root, { userAgentsDir: path.join(root, "no-user-agents") });
    assert.deepEqual(result.agents, []);
    assert.equal(fs.existsSync(path.join(root, "escaped.yaml")), false);
  });
});

test("reports unsupported and unknown Claude fields without including frontmatter in systemPrompt", () => {
  withTempDir((root) => {
    writeAgent(
      path.join(root, ".pi", "agents", "scout.md"),
      "name: scout\ndescription: Scout\npermissionMode: plan\nhooks: {}\nmadeUpOption: true",
    );

    const [scout] = discoverAgents(root, { userAgentsDir: path.join(root, "no-user-agents") }).agents;
    assert.equal(scout.systemPrompt, "Only this body");
    assert.deepEqual(
      scout.diagnostics?.map((diagnostic) => diagnostic.code).sort(),
      ["unknown-claude-field", "unsupported-claude-field", "unsupported-claude-field"],
    );
  });
});
