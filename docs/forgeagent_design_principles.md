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

Subagents are workspace primitives, not a second product line. A read-only `agent_task` can ask the current model to verify, explore, or plan from durable thread facts and constrained read/search/LSP/git-diff/verification tools, but it does not get its own permission system, project store, runtime, editing authority, or hidden workspace authority.

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
