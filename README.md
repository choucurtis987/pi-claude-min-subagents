# Pi Claude Minimal Subagents

A small Pi subagent extension that runs shared, Claude-native agent definitions. Claude Code reads the definition natively; Pi translates its portable fields and applies an optional Pi-only sidecar.

## Install

Install a tested release by tag or commit:

```bash
pi install git:github.com/choucurtis987/pi-claude-min-subagents@v0.2.0
```

For local development from this checkout:

```bash
pi -e .
```

If the upstream `pi-minimal-subagent` package is also installed, disable only that package's extension for this project with `pi config -l` before loading `-e .`; otherwise both packages register `subagent`.

## Shared agent layout

Keep one source-of-truth definition and expose it to both harnesses:

```text
agents/
  recruiter.md
.claude/agents -> ../agents
.pi/agents -> ../agents
.pi/agent-overrides/
  recruiter.yaml
```

Keep `.claude/` itself as a real directory. Claude Code's discovery of a linked `agents` directory should be smoke-tested after Claude Code upgrades. If it does not traverse that link, link individual files inside `.claude/agents/` instead; Pi can continue to use the linked `.pi/agents` directory.

Project agents override same-named user agents. Pi continues to discover user agents under `~/.pi/agent/agents/` (honoring `PI_CODING_AGENT_DIR`) and project agents in `.pi/agents/` in the current directory or an ancestor.

## Canonical agent definition

`agents/recruiter.md` uses normal Claude Code frontmatter and a shared Markdown prompt:

```markdown
---
name: recruiter
description: Answers recruiting-process questions and suggests interview slots.
model: inherit
tools: [Read, Grep, Glob, Bash, Skill]
disallowedTools: [Write, Edit, Agent]
skills: [interview-slot-finder]
---

You are the recruiter. Follow repository instructions and return concise,
source-grounded answers.
```

The Markdown body is the child Pi system-prompt addition. Neither frontmatter nor sidecar YAML is appended to the child prompt.

Top-level `model` is **Claude-only**. Pi never sends values such as `sonnet` or `inherit` from the shared definition to its child process.

## Pi-only sidecar

Create `.pi/agent-overrides/<agent-name>.yaml` only when Pi needs different runtime configuration:

```yaml
model: openai/gpt-5.4
thinking: high
tools: [read, grep, find, bash]
disallowedTools: [write, edit]
skills:
  - ../../.claude/skills/interview-slot-finder/SKILL.md
extensions: []
```

Supported fields: `model`, `thinking`, `tools`, `disallowedTools`, `skills`, and `extensions`. Relative skill and extension paths resolve from the sidecar's directory.

Sidecar values replace the corresponding shared translation or Pi setting. An explicit `tools: []` passes Pi `--no-tools`. Sidecar `extensions` replaces Pi's extension policy for that child:

- `null`: normal Pi extension discovery;
- `[]`: no inherited/default child extensions;
- non-empty list: no inherited/default child extensions; load only the listed extensions.

An absent sidecar leaves shared fields and Pi settings in effect. Invalid sidecar YAML or an invalid sidecar field prevents that child from starting and names the offending file.

## Pi model and thinking selection

Pi resolves the child model in this order:

1. sidecar `model`;
2. `pi-minimal-subagent.model` from resolved Pi settings;
3. active parent Pi model as `provider/id`.

Pi resolves thinking in this order:

1. sidecar `thinking`;
2. active parent Pi thinking level;
3. Pi's normal child default if no parent thinking level is available.

Pi passes resolved values explicitly. An invalid Pi model is handled by Pi's normal CLI model resolver.

## Tools and skills

When a shared Claude `tools` or `disallowedTools` list is present, Pi maps these names:

| Claude | Pi |
| --- | --- |
| `Read` | `read` |
| `Write` | `write` |
| `Edit` | `edit` |
| `Bash` | `bash` |
| `Grep` | `grep` |
| `Glob` | `find` |
| `Agent` | `subagent` |

Unsupported Claude tool names generate a compatibility warning and are ignored; they are not added to Pi's tool allowlist. `Skill` is handled by skill loading rather than Pi's tool allowlist. Named Claude skills resolve in this order:

1. the closest ancestor `.claude/skills/<name>/SKILL.md`;
2. `~/.claude/skills/<name>/SKILL.md`.

A sidecar `skills` list replaces named-skill resolution and supplies direct Pi skill paths. Missing named skills warn and are skipped.

## Compatibility warnings

Pi warns and continues for Claude-only fields it cannot implement:

```text
permissionMode, hooks, mcpServers, memory, maxTurns,
effort, background, isolation, color, initialPrompt
```

Unknown top-level Claude or sidecar fields also warn. Diagnostics are deduplicated, capped at 20 items, summarized in the parent result, and shown in expanded tool output. Only diagnostic messages are displayed; sidecar contents are not included in the child prompt or warning UI.

## Pi settings

Global settings are normally in `~/.pi/agent/settings.json`; `.pi/settings.json` overrides them per project:

```jsonc
{
  "pi-minimal-subagent": {
    "model": null,
    "extensions": [],
    "environment": {
      "MY_EXTENSION_MODE": "subagent"
    }
  }
}
```

`extensions` is tri-state when a sidecar does not set it: `null`/omitted allows normal child extension discovery, `[]` disables it, and a non-empty list disables discovery then explicitly loads those entries. `environment` merges global and project values and overlays the inherited child environment; it is not isolated or secret-masking configuration.

## Migration from pi-minimal-subagent definitions

Version 0.2 treats top-level frontmatter as Claude-native:

- move Pi-specific `model`, `thinking`, `extensions`, and path-based `skills` into `.pi/agent-overrides/<name>.yaml`;
- use top-level `model` only for Claude Code;
- use named top-level `skills` only when the skill lives in a Claude skill directory;
- use shared Claude tool names in canonical Markdown and lower-case Pi tool names only in a sidecar.

The extension registers one tool:

```json
{ "agent": "scout", "task": "Inspect the auth flow and report risks." }
```

There are no built-in parallel, chain, pool, or orchestrator modes. The parent can issue multiple `subagent` calls in one turn when its own Pi environment permits parallel tool calls.

## Development

```bash
npm ci
npm test
npm run typecheck
pi -e .
```
