import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type ScenarioResult = {
  name: string;
  ok: boolean;
  durationMs: number;
  detail: string;
  diagnostics?: Record<string, unknown>;
  artifacts?: string[];
  failures?: string[];
  fixes?: string[];
};

type ReleaseReport = {
  runId: string;
  startedAt: string;
  provider: string;
  model?: string;
  dataDir: string;
  results: ScenarioResult[];
};

type Criterion = {
  id: string;
  title: string;
  status: "passed" | "failed";
  evidence: string[];
  missing: string[];
};

type RequiredCapability = {
  id: string;
  title: string;
  scenario: string;
  implemented: boolean;
  evidence: Array<{
    description: string;
    test: (result: ScenarioResult) => boolean;
    missing: string;
  }>;
};

const ROOT = resolve(".");
const PARITY_DIR = resolve(".forge-coding-parity");
const RELEASE_DATA_DIR = resolve(process.env.CODING_PARITY_RELEASE_DATA_DIR ?? join(PARITY_DIR, "release-e2e"));
const REPORT_DIR = resolve(process.env.CODING_PARITY_REPORT_DIR ?? join(PARITY_DIR, "reports"));
const RUN_ID = `coding_parity_${new Date().toISOString().replace(/[:.]/g, "-")}`;

const implementedBehaviorScenarios = [
  "agent_coding_workspace",
  "agent_implementation_subagent",
  "agent_background_subagents",
  "agent_subagent_worktree_merge",
  "agent_python_code_index",
  "agent_persistent_multilanguage_lsp",
  "agent_lsp_unavailable_recovery",
  "agent_notebook_edit",
  "agent_artifact_continuation",
  "agent_multifile_refactor",
  "agent_frontend_workspace",
  "agent_package_install_permission",
  "agent_dynamic_skill_use",
  "agent_destructive_command_denied",
  "agent_compaction_coding_continuity",
  "agent_restart_coding_continuity",
  "ui_review_work_activity",
] as const;

const requiredCapabilities: RequiredCapability[] = [
  {
    id: "typescript_fix_loop",
    title: "Real TypeScript repair loop uses plan, diagnostics, bounded edit, verification, git diff, subagent verify, and workspace review",
    scenario: "agent_coding_workspace",
    implemented: true,
    evidence: [
      {
        description: "scenario passed",
        test: (result) => result.ok,
        missing: "agent_coding_workspace did not pass.",
      },
      {
        description: "detail includes tool trace with planning, LSP diagnostics, verification, git diff, subagent, and workspace review",
        test: (result) => containsAll(result.detail, ["todo_write", "lsp_diagnostics", "verify_workspace", "git_diff", "agent_task", "workspace_review"]),
        missing: "TypeScript scenario did not prove the full coding loop tool sequence.",
      },
      {
        description: "diagnostics include workspace activity with changed files",
        test: (result) => hasActivityChanges(result),
        missing: "TypeScript scenario did not include workspace activity changes in diagnostics.",
      },
    ],
  },
  {
    id: "implementation_subagent",
    title: "Implementation subagent can make bounded workspace edits and hand off to main Agent verification",
    scenario: "agent_implementation_subagent",
    implemented: true,
    evidence: [
      {
        description: "scenario passed",
        test: (result) => result.ok,
        missing: "agent_implementation_subagent did not pass.",
      },
      {
        description: "detail proves agent_task implement, verify_workspace, git_diff, workspace_review, and bounded edit payload",
        test: (result) => containsAll(result.detail, ["agent_task", "verify_workspace", "git_diff", "workspace_review", "workspace_write"]) &&
          containsAny(result.detail, ["edit_file", "multi_edit_file", "apply_patch_file"]),
        missing: "Implementation subagent scenario did not prove delegated bounded edit plus main Agent verification handoff.",
      },
      {
        description: "diagnostics include workspace activity for changed file",
        test: (result) => hasActivityChanges(result) && JSON.stringify(result.diagnostics ?? {}).includes("math.ts"),
        missing: "Implementation subagent scenario did not include activity changes for the edited source file.",
      },
    ],
  },
  {
    id: "background_subagent_pool",
    title: "Background subagent pool can start multiple subagents, join outputs, and record activity",
    scenario: "agent_background_subagents",
    implemented: true,
    evidence: [
      {
        description: "scenario passed",
        test: (result) => result.ok,
        missing: "agent_background_subagents did not pass.",
      },
      {
        description: "detail proves background agent_task launch and agent_task_output join",
        test: (result) => containsAll(result.detail, ["backgroundTasks=", "agent_task", "agent_task_output", "completed=3"]),
        missing: "Background subagent scenario did not prove launch plus completed output join.",
      },
      {
        description: "diagnostics include background subagent activity state",
        test: (result) => JSON.stringify(result.diagnostics ?? {}).includes("Background subagent"),
        missing: "Background subagent scenario did not include activity evidence.",
      },
    ],
  },
  {
    id: "python_generic_code_index",
    title: "Non-TypeScript project uses generic multi-language code navigation and test repair",
    scenario: "agent_python_code_index",
    implemented: true,
    evidence: [
      {
        description: "scenario passed",
        test: (result) => result.ok,
        missing: "agent_python_code_index did not pass.",
      },
      {
        description: "detail includes lsp_query, bounded edit, verify_workspace, and git_diff",
        test: (result) => containsAll(result.detail, ["lsp_query", "verify_workspace", "git_diff"]) && containsAny(result.detail, ["edit_file", "multi_edit_file", "apply_patch_file"]),
        missing: "Python scenario did not prove generic navigation plus bounded edit and verification.",
      },
      {
        description: "diagnostics include changed Python source",
        test: (result) => JSON.stringify(result.diagnostics ?? {}).includes("pricing.py"),
        missing: "Python scenario diagnostics did not identify the changed source file.",
      },
    ],
  },
  {
    id: "multifile_refactor",
    title: "Multi-file refactor uses references before bounded edits and passes verification",
    scenario: "agent_multifile_refactor",
    implemented: true,
    evidence: [
      {
        description: "scenario passed",
        test: (result) => result.ok,
        missing: "agent_multifile_refactor did not pass.",
      },
      {
        description: "detail includes lsp_query references, bounded edits, verify_workspace, and git_diff",
        test: (result) => containsAll(result.detail, ["lsp_query", "verify_workspace", "git_diff"]) && containsAny(result.detail, ["edit_file", "multi_edit_file", "apply_patch_file"]),
        missing: "Refactor scenario did not prove references-driven bounded editing and verification.",
      },
      {
        description: "diagnostics include three changed files",
        test: (result) => (result.diagnostics?.changedFiles as unknown[] | undefined)?.length === 3,
        missing: "Refactor scenario did not report all expected changed files.",
      },
    ],
  },
  {
    id: "frontend_browser_verification",
    title: "Frontend work uses bounded edits, TypeScript verification, and rendered browser inspection",
    scenario: "agent_frontend_workspace",
    implemented: true,
    evidence: [
      {
        description: "scenario passed",
        test: (result) => result.ok,
        missing: "agent_frontend_workspace did not pass.",
      },
      {
        description: "detail includes bounded edit, verification, and git diff",
        test: (result) => containsAll(result.detail, ["verify_workspace", "git_diff"]) && containsAny(result.detail, ["edit_file", "multi_edit_file", "apply_patch_file"]),
        missing: "Frontend scenario did not prove bounded edit plus verification.",
      },
      {
        description: "diagnostics include three frontend changed files",
        test: (result) => (result.diagnostics?.changedFiles as unknown[] | undefined)?.length === 3,
        missing: "Frontend scenario did not report all expected changed files.",
      },
    ],
  },
  {
    id: "subagent_worktree_implementation",
    title: "Subagent can implement in an isolated worktree, return reviewable diff, and merge or discard",
    scenario: "agent_subagent_worktree_merge",
    implemented: true,
    evidence: [
      {
        description: "scenario passed",
        test: (result) => result.ok,
        missing: "agent_subagent_worktree_merge did not pass.",
      },
      {
        description: "detail proves commit and merge",
        test: (result) => containsAll(result.detail, ["worktree=", "committed=", "merged="]),
        missing: "Worktree scenario did not prove commit plus merge.",
      },
      {
        description: "diagnostics include activity state",
        test: (result) => Boolean(result.diagnostics?.activity),
        missing: "Worktree scenario did not report workspace activity state.",
      },
    ],
  },
  {
    id: "persistent_multilanguage_lsp",
    title: "Persistent semantic LSP works for TypeScript plus at least one of Rust/Go/Python beyond lexical fallback",
    scenario: "agent_persistent_multilanguage_lsp",
    implemented: true,
    evidence: [
      {
        description: "scenario passed",
        test: (result) => result.ok,
        missing: "agent_persistent_multilanguage_lsp did not pass.",
      },
      {
        description: "detail proves Pyright semantic LSP and coding tools",
        test: (result) => containsAll(result.detail, ["pyright=true", "lsp_diagnostics", "lsp_query", "verify_workspace", "git_diff"]),
        missing: "Multi-language LSP scenario did not prove Pyright diagnostics plus semantic lsp_query and verification.",
      },
      {
        description: "diagnostics include changed Python source",
        test: (result) => JSON.stringify(result.diagnostics ?? {}).includes("pricing.py"),
        missing: "Multi-language LSP scenario did not report changed Python source.",
      },
    ],
  },
  {
    id: "notebook_editing",
    title: "Notebook cell-level editing preserves valid ipynb JSON and passes verification",
    scenario: "agent_notebook_edit",
    implemented: true,
    evidence: [
      {
        description: "scenario passed",
        test: (result) => result.ok,
        missing: "agent_notebook_edit did not pass.",
      },
      {
        description: "detail proves notebook_edit, verification, and git diff",
        test: (result) => containsAll(result.detail, ["notebook_edit=true", "verify_workspace", "git_diff"]),
        missing: "Notebook scenario did not prove structural notebook_edit plus verification.",
      },
      {
        description: "diagnostics include notebook path",
        test: (result) => JSON.stringify(result.diagnostics ?? {}).includes("analysis.ipynb"),
        missing: "Notebook scenario diagnostics did not include the edited notebook.",
      },
    ],
  },
  {
    id: "dynamic_skill_install_use",
    title: "Dynamic skill install/activation/use is preserved through the coding loop",
    scenario: "agent_dynamic_skill_use",
    implemented: true,
    evidence: [
      {
        description: "scenario passed",
        test: (result) => result.ok,
        missing: "agent_dynamic_skill_use did not pass.",
      },
      {
        description: "detail proves extension search/install, activation, and read_file skill use",
        test: (result) => containsAll(result.detail, ["dynamicSkill=code-reviewer", "extension_search", "extension_install", "read_file"]) &&
          containsAny(result.detail, ["enabled=install_active", "extension_enable"]),
        missing: "Dynamic skill scenario did not prove natural-language extension install, activation, and SKILL.md use.",
      },
      {
        description: "diagnostics include skill_used event",
        test: (result) => JSON.stringify(result.diagnostics ?? {}).includes("skill_used"),
        missing: "Dynamic skill scenario did not record skill_used evidence.",
      },
    ],
  },
  {
    id: "package_install_permission",
    title: "Package install asks once through grouped permission and then verifies safely",
    scenario: "agent_package_install_permission",
    implemented: true,
    evidence: [
      {
        description: "scenario passed",
        test: (result) => result.ok,
        missing: "agent_package_install_permission did not pass.",
      },
      {
        description: "detail proves one install request and package_install grant",
        test: (result) => containsAll(result.detail, ["installRequests=1", "grants=package_install", "checks="]),
        missing: "Package install scenario did not prove grouped permission and verification.",
      },
      {
        description: "diagnostics include permission request evidence",
        test: (result) => JSON.stringify(result.diagnostics ?? {}).includes("permission_request"),
        missing: "Package install scenario did not include permission request diagnostics.",
      },
    ],
  },
  {
    id: "destructive_command_denied",
    title: "Destructive shell command is denied with readable recovery and does not block the session",
    scenario: "agent_destructive_command_denied",
    implemented: true,
    evidence: [
      {
        description: "scenario passed",
        test: (result) => result.ok,
        missing: "agent_destructive_command_denied did not pass.",
      },
      {
        description: "detail proves denial without permission request",
        test: (result) => containsAll(result.detail, ["deniedTool=bash", "permissionRequests=0"]),
        missing: "Destructive command scenario did not prove hard denial without approval prompt.",
      },
      {
        description: "diagnostics include readable denial reason",
        test: (result) => JSON.stringify(result.diagnostics ?? {}).includes("recursive forced delete"),
        missing: "Destructive command scenario did not include concrete denial text.",
      },
    ],
  },
  {
    id: "lsp_unavailable_recovery",
    title: "LSP unavailable path returns readable error and Agent recovers through alternate evidence",
    scenario: "agent_lsp_unavailable_recovery",
    implemented: true,
    evidence: [
      {
        description: "scenario passed",
        test: (result) => result.ok,
        missing: "agent_lsp_unavailable_recovery did not pass.",
      },
      {
        description: "detail proves LSP fallback and verification",
        test: (result) => containsAll(result.detail, ["lspFallback=true", "checks=", "tools="]),
        missing: "LSP unavailable scenario did not prove fallback plus verification.",
      },
      {
        description: "diagnostics include activity state",
        test: (result) => Boolean(result.diagnostics?.activity),
        missing: "LSP unavailable scenario did not report workspace activity state.",
      },
    ],
  },
  {
    id: "artifact_continuation",
    title: "Large verification output is artifacted and Agent continues by reading the artifact",
    scenario: "agent_artifact_continuation",
    implemented: true,
    evidence: [
      {
        description: "scenario passed",
        test: (result) => result.ok,
        missing: "agent_artifact_continuation did not pass.",
      },
      {
        description: "detail proves artifact and read_artifact continuation",
        test: (result) => containsAll(result.detail, ["artifacts=", "read_artifact", "ARTIFACT_CONTINUATION_NEEDLE_"]),
        missing: "Artifact continuation scenario did not prove artifact readback.",
      },
      {
        description: "artifacts are reported",
        test: (result) => (result.artifacts?.length ?? 0) > 0,
        missing: "Artifact continuation scenario did not report artifact ids.",
      },
    ],
  },
  {
    id: "compaction_continuity",
    title: "Compaction preserves activity, invoked skills, current plan, and lets Agent continue coding",
    scenario: "agent_compaction_coding_continuity",
    implemented: true,
    evidence: [
      {
        description: "scenario passed",
        test: (result) => result.ok,
        missing: "agent_compaction_coding_continuity did not pass.",
      },
      {
        description: "detail proves compaction plus post-compaction coding loop",
        test: (result) => containsAll(result.detail, ["compaction=true", "todo_write", "verify_workspace", "git_diff", "workspace_review"]),
        missing: "Compaction continuity scenario did not prove coding continued after compaction.",
      },
      {
        description: "diagnostics include compaction count and activity",
        test: (result) => Boolean(result.diagnostics?.activity) && Number(result.diagnostics?.compactions ?? 0) > 0,
        missing: "Compaction continuity scenario did not report compaction and activity diagnostics.",
      },
    ],
  },
  {
    id: "restart_continuity",
    title: "Process restart repairs dangling tool calls and preserves workspace activity for retry",
    scenario: "agent_restart_coding_continuity",
    implemented: true,
    evidence: [
      {
        description: "scenario passed",
        test: (result) => result.ok,
        missing: "agent_restart_coding_continuity did not pass.",
      },
      {
        description: "detail proves dangling tool repair, startup blocked state, retry, and verification",
        test: (result) => containsAll(result.detail, ["restartRepaired=true", "startupBlocked=true", "verify_workspace", "git_diff"]),
        missing: "Restart continuity scenario did not prove repair, blocked handoff, retry, and verification.",
      },
      {
        description: "diagnostics include startup report and activity",
        test: (result) => Boolean(result.diagnostics?.startupReport) && Boolean(result.diagnostics?.activity),
        missing: "Restart continuity scenario did not report startup repair and activity diagnostics.",
      },
    ],
  },
  {
    id: "review_work_ui",
    title: "Web/macOS/Android Review Work surface shows plan, diffs, diagnostics, checks, tasks, artifacts, and permissions",
    scenario: "ui_review_work_activity",
    implemented: true,
    evidence: [
      {
        description: "scenario passed",
        test: (result) => result.ok,
        missing: "ui_review_work_activity did not pass.",
      },
      {
        description: "detail proves browser UI review work surface",
        test: (result) => containsAll(result.detail, ["uiReviewWork=true"]),
        missing: "Review Work UI scenario did not prove browser interaction.",
      },
      {
        description: "diagnostics include drawer text with every required activity class",
        test: (result) => containsAll(JSON.stringify(result.diagnostics ?? {}), ["Open todos", "Changed files", "Diagnostics", "Checks", "Tasks", "Artifacts", "Permission grants"]),
        missing: "Review Work UI scenario did not show every required activity class.",
      },
    ],
  },
];

function containsAll(value: string, needles: string[]): boolean {
  return needles.every((needle) => value.includes(needle));
}

function containsAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function hasActivityChanges(result: ScenarioResult): boolean {
  const activity = result.diagnostics?.activity;
  return typeof activity === "object" &&
    activity !== null &&
    Array.isArray((activity as { changes?: unknown }).changes) &&
    ((activity as { changes: unknown[] }).changes.length > 0);
}

function latestJsonReport(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const reports = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return reports[0];
}

function readReleaseReport(path: string): ReleaseReport {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as ReleaseReport;
  if (!Array.isArray(parsed.results)) {
    throw new Error(`Invalid release E2E report: ${path}`);
  }
  return parsed;
}

function runReleaseE2E(): { reportPath?: string; exitCode: number | null; stdout: string; stderr: string } {
  const existingReport = process.env.CODING_PARITY_RELEASE_REPORT;
  if (existingReport) {
    return { reportPath: resolve(existingReport), exitCode: 0, stdout: `[coding-parity] using existing report ${existingReport}`, stderr: "" };
  }

  const selectedScenarios = process.env.CODING_PARITY_SCENARIOS
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean) ?? [...implementedBehaviorScenarios];

  const child = spawnSync("npx", ["tsx", "scripts/release-e2e.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      RELEASE_E2E_DATA_DIR: RELEASE_DATA_DIR,
      RELEASE_E2E_SCENARIOS: selectedScenarios.join(","),
      RELEASE_E2E_CONTINUE_ON_FAILURE: "1",
    },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);

  const reportPathFromStdout = child.stdout.match(/\[release-e2e\]\s+report=([^\n]+)/)?.[1]?.trim();
  const reportPath = reportPathFromStdout ? resolve(reportPathFromStdout) : latestJsonReport(join(RELEASE_DATA_DIR, "reports"));
  return {
    ...(reportPath !== undefined ? { reportPath } : {}),
    exitCode: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
  };
}

function buildCriteria(report: ReleaseReport | undefined, releaseRun: ReturnType<typeof runReleaseE2E>): Criterion[] {
  const byName = new Map((report?.results ?? []).map((result) => [result.name, result]));
  const criteria: Criterion[] = [];

  criteria.push({
    id: "release_e2e_executed",
    title: "Coding parity gate executed real release E2E scenarios instead of static source scans",
    status: report !== undefined && releaseRun.exitCode === 0 ? "passed" : "failed",
    evidence: [
      releaseRun.reportPath ? `release report: ${releaseRun.reportPath}` : "release report: missing",
      `release exit code: ${releaseRun.exitCode ?? "null"}`,
    ],
    missing: [
      ...(report === undefined ? ["No release E2E JSON report was produced."] : []),
      ...(releaseRun.exitCode !== 0 ? ["Real release E2E scenarios failed or could not run; this cannot be treated as Claude Code parity."] : []),
    ],
  });

  for (const capability of requiredCapabilities) {
    const result = byName.get(capability.scenario);
    const evidence: string[] = [];
    const missing: string[] = [];

    if (!capability.implemented) {
      missing.push(`No behavioral release E2E scenario exists yet: ${capability.scenario}.`);
      missing.push("This capability remains incomplete; do not claim Claude Code parity.");
    } else if (!result) {
      missing.push(`Required implemented scenario was not executed: ${capability.scenario}.`);
    } else {
      evidence.push(`scenario ${capability.scenario}: ${result.ok ? "PASS" : "FAIL"} (${result.durationMs}ms)`);
      evidence.push(`detail: ${result.detail.split("\n")[0] ?? ""}`);
      for (const check of capability.evidence) {
        if (check.test(result)) evidence.push(check.description);
        else missing.push(check.missing);
      }
    }

    criteria.push({
      id: capability.id,
      title: capability.title,
      status: missing.length === 0 ? "passed" : "failed",
      evidence,
      missing,
    });
  }

  return criteria;
}

function writeParityReports(input: {
  report?: ReleaseReport;
  releaseRun: ReturnType<typeof runReleaseE2E>;
  criteria: Criterion[];
}): { jsonPath: string; markdownPath: string } {
  mkdirSync(REPORT_DIR, { recursive: true });
  const passed = input.criteria.filter((item) => item.status === "passed").length;
  const failed = input.criteria.length - passed;
  const jsonPath = join(REPORT_DIR, `${RUN_ID}.json`);
  const markdownPath = join(REPORT_DIR, `${RUN_ID}.md`);
  const payload = {
    runId: RUN_ID,
    startedAt: new Date().toISOString(),
    status: failed === 0 ? "passed" : "failed",
    releaseReportPath: input.releaseRun.reportPath,
    releaseExitCode: input.releaseRun.exitCode,
    releaseProvider: input.report?.provider,
    releaseModel: input.report?.model,
    executedScenarios: input.report?.results.map((result) => result.name) ?? [],
    requiredScenarios: requiredCapabilities.map((item) => item.scenario),
    passed,
    failed,
    criteria: input.criteria,
  };
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");

  const markdown = [
    "# ForgeAgent Claude Code Coding Parity Gate",
    "",
    `Run: ${RUN_ID}`,
    `Status: ${failed === 0 ? "PASS" : "FAIL"}`,
    `Passed: ${passed}/${input.criteria.length}`,
    `Failed: ${failed}/${input.criteria.length}`,
    input.releaseRun.reportPath ? `Release E2E report: ${input.releaseRun.reportPath}` : "Release E2E report: missing",
    "",
    "This gate is intentionally behavioral. It runs real release E2E scenarios and fails while required Claude Code-level scenarios are missing.",
    "",
    ...input.criteria.flatMap((criterion) => [
      `## ${criterion.status === "passed" ? "PASS" : "FAIL"} ${criterion.id}`,
      "",
      criterion.title,
      "",
      criterion.evidence.length ? "Evidence:" : "Evidence: none",
      ...criterion.evidence.map((line) => `- ${line}`),
      criterion.missing.length ? "Missing:" : "Missing: none",
      ...criterion.missing.map((line) => `- ${line}`),
      "",
    ]),
  ].join("\n");
  writeFileSync(markdownPath, markdown, "utf-8");
  return { jsonPath, markdownPath };
}

function main(): void {
  mkdirSync(PARITY_DIR, { recursive: true });
  const releaseRun = runReleaseE2E();
  let report: ReleaseReport | undefined;
  if (releaseRun.reportPath !== undefined && existsSync(releaseRun.reportPath)) {
    report = readReleaseReport(releaseRun.reportPath);
  }
  const criteria = buildCriteria(report, releaseRun);
  const failed = criteria.filter((item) => item.status === "failed");
  const paths = writeParityReports({ report, releaseRun, criteria });
  const summary = `coding parity ${failed.length === 0 ? "PASS" : "FAIL"} pass=${criteria.length - failed.length} fail=${failed.length}`;
  console.log(`[coding-parity] ${summary}`);
  console.log(`[coding-parity] report=${paths.jsonPath}`);
  console.log(`[coding-parity] markdown=${paths.markdownPath}`);
  if (failed.length > 0) {
    for (const item of failed) {
      console.error(`[coding-parity] missing ${item.id}: ${item.missing.join(" | ")}`);
    }
    process.exitCode = 1;
  }
}

main();
