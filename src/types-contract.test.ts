import type { AgentConfig } from "./types.ts";

// @ts-expect-error Discovery metadata is required after Task 2.
const taskOneTransitionalAgent: AgentConfig = {
  name: "scout",
  description: "Scout",
  systemPrompt: "Inspect.",
  source: "project",
  filePath: "/repo/.pi/agents/scout.md",
};

void taskOneTransitionalAgent;
