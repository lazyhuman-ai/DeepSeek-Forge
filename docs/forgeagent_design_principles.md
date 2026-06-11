# ForgeAgent Design Principles

ForgeAgent is a local-first workspace agent. It is not a pure coding CLI, not a browser-only agent, and not a collection of disconnected runtimes. The durable Core thread remains the source of truth; Web, macOS, Android, CLI, REPL, and extensions are different views and control surfaces over the same facts.

## Core Commitments

- Code capability is a high-density workspace scenario, not a separate product line.
- Do not add a second AgentLoop, permission system, project store, native UI, or runtime taxonomy for coding.
- Add specialized capability through composable workspace adapters and durable events.
- Ordinary tool errors, permission denials, and sandbox blocks return readable `tool_result isError=true` text to the Agent.
- `blocked` is only for Core, provider, runtime, or protocol failures that the Agent cannot continue through.
- Permissions should interrupt only for dangerous or meaningfully irreversible actions.
- MCP, browser, files, terminal, skills, memory, artifacts, usage, Blender, research, and automation must all compose through the same workspace activity model.

## Implementation Discipline

Large capability upgrades should move the product across multiple core dimensions before a test round. Do not spend expensive verification cycles on tiny isolated fragments when the agreed target is a deep capability jump.

When a plan explicitly says the implementation round must not run tests, do not run tests, builds, release gates, or benchmark commands in that round. Use static inspection and code review only; the user will open a separate verification round.

If Reasonix, Claude Code, opencode, OpenClaw, Hermes, or another referenced implementation already has a mature mechanism for the target capability, adapt that mechanism directly into ForgeAgent's architecture instead of rebuilding a lower-quality substitute from scratch.

New capability should be final-shape design. Avoid temporary names, fake gates, prompt-only substitutes for host guarantees, or MVP behavior that is known to require replacement.

## WorkspaceActivity

`WorkspaceActivity` is a state-recording layer, not an executor. It records plans, todos, changed files, structured diffs, diagnostics, verification results, background tasks, worktree facts, permission grants, recent failures, and artifacts for `projectId + sessionId + branchId`.

Tools still execute through the existing tool runtime and permission broker. Activity events are extra durable facts beside `tool_result`; they do not replace provider tool-call/result pairing.

## Coding Without A Coding Runtime

ForgeAgent should reach Claude Code-level engineering loops by strengthening general workspace primitives:

- scoped read/edit state
- atomic multi-file/file edits
- structured diff events
- diagnostics and verification events
- workspace review before finalizing changed work
- read-only subagent tasks for independent verify/explore/plan signals
- safe background tasks
- worktree facts
- grouped permission grants

These capabilities also benefit documents, reports, browser tasks, MCP tools, Blender scenes, and research workflows. They belong in the general workspace layer rather than a coding-only runtime.

Completion is evidence-based. After changing workspace files or artifacts, the Agent should use durable activity facts and `workspace_review` to check for open todos, unverified diffs, failed checks, stale diagnostics, and still-running tasks before claiming the work is done.

Final readiness is host-owned. `workspace_review` remains a useful explicit tool, but AgentLoop must also run a final readiness gate before sending a final assistant answer. If durable activity facts show open work, stale checks, missing evidence, required host checks, running tasks, or failed diagnostics, the host writes a readable event back into the thread and the Agent continues. This cannot be delegated to prompt discipline alone.

Todo completion is receipt-based. A todo is not complete just because the model says it is; newly completed todos need a `complete_step` evidence receipt tied to real diff, verification, diagnostics, subagent verdict, files, or manual user confirmation facts.

Project host checks are durable constraints. A project may declare safe `verify: <command>` checks in its guidance files. These checks are part of readiness after workspace changes and should not be injected as large mutable prompt text.

Deep code intelligence should use CodeGraph-class semantic tools when available. Lightweight `code_map` and `dependency_graph` are fallback maps; cross-file call graph, impact analysis, symbol context, and architecture trace belong to CodeGraph plus LSP.

DeepSeek cache stability is a product constraint. System prompts, tool schemas, memory manifests, skills, extensions, and MCP catalogs should remain prefix-stable where possible. Usage events should expose cache hit/miss and prefix-change reasons so cache churn is diagnosable rather than mysterious.

Subagents are workspace primitives, not a second product line. `agent_task` can ask the current model to verify, explore, plan, or handle a bounded implementation subtask from durable thread facts and constrained workspace tools. Implementation subagents may edit only through the same ForgeAgent read/edit/todo/diff/verification/worktree tools, PermissionBroker, and PathSandbox as the main Agent. They do not get their own permission system, project store, runtime, browser/MCP/extension authority, user-prompt channel, or hidden workspace authority. Isolated implementation should stay in the explicit workspace tool chain: `enter_worktree`, bounded edits, `verify_workspace`, `git_diff`, `workspace_review`, `commit_worktree`, then `merge_worktree`.

Verification subagents should be skeptical. Missing, stale, narrow, or intention-only evidence is not proof. A `PASS` verdict requires current task-relevant evidence; otherwise the result should be `PARTIAL` or `FAIL` with concrete next actions.

Search and navigation tools are safety-critical coding tools. They should pass patterns and paths as argv, not shell fragments, and should support bounded paging so large repositories do not force the Agent into blind guessing or excessive context use.

Editing tools preserve bytes unless the Agent explicitly asks for formatting. They should maintain encoding, BOM, line endings, and intentional whitespace; formatter-driven changes must be visible as ordinary workspace diffs and verification facts.

## Permission Philosophy

Use the existing `ToolPolicyManager` and `PermissionBroker`. Add grants and grouped approvals there instead of creating another policy engine.

Default allow:

- workspace reads/writes/edits that pass sandbox checks
- read-only MCP/browser/resource tools
- safe git inspection
- common check commands such as test, typecheck, lint, and build

Default ask:

- package install
- project-external paths
- sensitive paths or secrets
- destructive shell/git/fs commands
- unknown external runtime launch
- network writes and high-risk MCP capabilities

Default deny:

- path/symlink escape
- system destructive paths
- secret exfiltration
- high-risk pipe-to-shell patterns unless explicitly requested and separately confirmed

`Danger free` remains session-level full approval bypass, but a safer `Workspace autopilot` should cover normal workspace edits and checks without bypassing hard sandbox rules.

Leaving plan mode may create `workspace_edits` and `safe_commands` grants as safe workspace autopilot. This is a grouped approval for normal execution, not a blanket bypass: package installs, external runtimes, network writes, destructive actions, explicit deny rules, and PathSandbox hard blocks still interrupt or fail visibly.
