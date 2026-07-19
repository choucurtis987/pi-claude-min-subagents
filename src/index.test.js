import assert from "node:assert/strict";
import test from "node:test";
import { extractParentRuntime } from "./index.ts";

test("extracts the provider/id model and Pi thinking level for the parent runtime", () => {
  const ctx = { model: { provider: "anthropic", id: "claude-sonnet-4" } };
  const pi = { getThinkingLevel: () => "high" };

  assert.deepEqual(extractParentRuntime(ctx, pi.getThinkingLevel()), {
    model: "anthropic/claude-sonnet-4",
    thinking: "high",
  });
});
