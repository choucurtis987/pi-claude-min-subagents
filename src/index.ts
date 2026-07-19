import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents } from "./agents.ts";
import { resolveEffectiveAgentConfig } from "./compat.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { runSubagent } from "./runner.ts";
import { getResultSummaryText } from "./runner-events.js";
import { resolveSettings } from "./settings.ts";
import {
  type ParentRuntime,
  type SubagentDetails,
  type SubagentResult,
  emptyUsage,
  isResultError,
} from "./types.ts";

const SubagentParams = Type.Object({
  agent: Type.String({
    description: "Name of the configured agent to run. Agents are loaded from ~/.pi/agent/agents/*.md and project .pi/agents/*.md files.",
  }),
  task: Type.String({
    description: "The focused task for the subagent. Include the expected scope, decision boundary, and return shape.",
  }),
});

function makeDetails(results: SubagentResult[], extra?: Omit<SubagentDetails, "results">): SubagentDetails {
  return { results, ...extra };
}

function diagnosticSuffix(result: SubagentResult): string {
  const count = result.diagnostics?.length ?? 0;
  return count === 0 ? "" : `\nCompatibility warning${count === 1 ? "" : "s"}: ${count}.`;
}

export function extractParentRuntime(
  ctx: { model?: { provider: string; id: string } | null },
  thinking: string,
): ParentRuntime {
  return {
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    thinking,
  };
}

function failedResult(agent: string, task: string, message: string): SubagentResult {
  return {
    agent,
    agentSource: "unknown",
    task,
    exitCode: 1,
    messages: [],
    response: "",
    stderr: message,
    usage: emptyUsage(),
    stopReason: "error",
    errorMessage: message,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Run one named subagent on one focused task in an isolated Pi subprocess. The tool accepts only an agent name and a task. For parallel work, call this tool multiple times in the same turn.",
    parameters: SubagentParams,
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const discovery = discoverAgents(ctx.cwd);
      const agent = discovery.agents.find((candidate) => candidate.name === params.agent);

      if (!agent) {
        const availableAgents = discovery.agents.map((candidate) => candidate.name);
        const message = availableAgents.length > 0
          ? `Unknown subagent "${params.agent}". Available agents: ${availableAgents.join(", ")}.`
          : "No subagents found. Add agent markdown files to ~/.pi/agent/agents or .pi/agents.";
        const result = failedResult(params.agent, params.task, message);
        return {
          content: [{ type: "text" as const, text: message }],
          details: makeDetails([result], {
            availableAgents,
            projectAgentsDir: discovery.projectAgentsDir,
          }),
          isError: true,
        };
      }

      const settings = resolveSettings(ctx.cwd);
      const parent = extractParentRuntime(ctx, pi.getThinkingLevel());
      const effective = resolveEffectiveAgentConfig({
        agent,
        settings,
        parent,
        cwd: ctx.cwd,
      });
      const result = await runSubagent({
        cwd: ctx.cwd,
        effective,
        task: params.task,
        settings,
        signal,
        onUpdate,
        makeDetails: (results) => makeDetails(results, {
          projectAgentsDir: discovery.projectAgentsDir,
        }),
      });

      if (isResultError(result)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Subagent ${result.stopReason || "failed"}: ${getResultSummaryText(result)}${diagnosticSuffix(result)}`,
            },
          ],
          details: makeDetails([result], {
            projectAgentsDir: discovery.projectAgentsDir,
          }),
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `${getResultSummaryText(result)}${diagnosticSuffix(result)}` }],
        details: makeDetails([result], {
          projectAgentsDir: discovery.projectAgentsDir,
        }),
      };
    },
  });
}
