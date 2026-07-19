import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const renderSource = fs.readFileSync(new URL("./render.ts", import.meta.url), "utf-8");

test("collapsed subagent result uses the configured expand keybinding hint", () => {
  assert.match(
    renderSource,
    /keyHint\(\s*["']app\.tools\.expand["']\s*,\s*["']to expand["']\s*\)/,
  );
  assert.doesNotMatch(renderSource, /Ctrl\+x to expand/);
});

test("expanded results render a compatibility warnings section", () => {
  assert.match(renderSource, /─── Compatibility warnings ───/);
});

test("collapsed results summarize diagnostics without exposing sidecar contents", () => {
  assert.match(renderSource, /compatibility warning/);
  assert.doesNotMatch(renderSource, /sidecar YAML/);
});
