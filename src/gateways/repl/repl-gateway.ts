import * as readline from "node:readline";
import type { Gateway } from "../gateway.js";
import type { CoreAPI } from "../../core/core-api.js";
import type { SessionEvent, Session, SystemEvent } from "../../streams/event-types.js";
import type { Unsubscribe } from "../../core/notification-hub.js";
import { createLogger } from "../../core/logger.js";
import { validateSchedule } from "../../core/cron-parser.js";

const logger = createLogger("repl-gateway");

const R = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const RED = "\x1b[31m";
const GRN = "\x1b[32m";
const YLW = "\x1b[33m";
const MAG = "\x1b[35m";
const CYN = "\x1b[36m";

const STATUS_COLOR: Record<string, string> = {
  idle: GRN,
  running: YLW,
  waiting_user: YLW,
  sleeping: CYN,
  blocked: RED,
  archived: D,
};

export function parseScheduleCommandArg(
  arg: string,
): { schedule: string; prompt: string } | null {
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;

  if (parts.length >= 6) {
    const cronSchedule = parts.slice(0, 5).join(" ");
    if (validateSchedule(cronSchedule) === null) {
      return {
        schedule: cronSchedule,
        prompt: parts.slice(5).join(" "),
      };
    }
  }

  const first = parts[0]!;
  const msInterval = parseInt(first, 10);
  if (!isNaN(msInterval) && String(msInterval) === first && msInterval > 0) {
    return {
      schedule: first,
      prompt: parts.slice(1).join(" "),
    };
  }

  return null;
}

export class ReplGateway implements Gateway {
  readonly name = "repl";

  #api: CoreAPI;
  #selectedSessionId: string | null = null;
  #rl: readline.Interface;
  #unsubscribes: Unsubscribe[] = [];
  #streaming = false;

  constructor(api: CoreAPI) {
    this.#api = api;

    this.#unsubscribes.push(api.onSessionEvent((sid, ev) => this.onSessionEvent(sid, ev)));
    this.#unsubscribes.push(api.onSystemEvent((ev) => this.onSystemEvent(ev)));
    this.#unsubscribes.push(api.onSessionListChanged(() => this.onSessionListChanged()));

    this.#rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this.#buildPrompt(),
    });

    this.#rl.on("line", (line) => { void this.#handleInput(line); });
    this.#rl.on("SIGINT", () => this.#handleQuit());
  }

  // ── Gateway interface ──

  onSessionEvent(sessionId: string, event: SessionEvent): void {
    if (sessionId !== this.#selectedSessionId) return;
    this.#displayEvent(event);
  }

  onSystemEvent(event: SystemEvent): void {
    this.#writeLine(`\n${D}[system: ${event.category}/${event.detail}] ${event.message}${R}`);
    this.#rl.prompt(true);
  }

  onSessionListChanged(): void {
    // no-op for REPL — user uses !list explicitly
  }

  // ── Lifecycle ──

  start(): void {
    logger.info("ForgeAgent REPL started");
    console.log(`\n${B}ForgeAgent REPL${R}\n`);
    console.log(`${D}Type a message to chat, or !help for commands.${R}\n`);
    this.#rl.prompt();
  }

  destroy(): void {
    this.#rl.close();
    for (const unsub of this.#unsubscribes) {
      unsub();
    }
    this.#api.flush();
  }

  // ── Input handling ──

  async #handleInput(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      this.#rl.prompt();
      return;
    }

    if (trimmed.startsWith("!")) {
      await this.#handleCommand(trimmed);
    } else {
      await this.#handleUserMessage(trimmed);
    }
  }

  async #handleCommand(input: string): Promise<void> {
    const parts = input.split(/\s+/);
    const cmd = parts[0]!;
    const arg = parts.slice(1).join(" ");

    try {
      switch (cmd) {
        case "!create":
          if (!arg) { this.#writeLine(`${RED}Usage: !create <title>${R}`); break; }
          {
            const session = this.#api.createSession(arg);
            this.#selectedSessionId = session.id;
            this.#rl.setPrompt(this.#buildPrompt());
            this.#writeLine(`${GRN}Created: ${session.id} — "${session.title}"${R}`);
          }
          break;

        case "!list":
          this.#displaySessions();
          break;

        case "!projects":
          this.#displayProjects();
          break;

        case "!project":
          if (!arg) { this.#writeLine(`${RED}Usage: !project <id-prefix|path>${R}`); break; }
          this.#selectProject(arg);
          break;

        case "!select":
          if (!arg) { this.#writeLine(`${RED}Usage: !select <id-prefix|title>${R}`); break; }
          this.#selectSession(arg);
          break;

        case "!thread":
          this.#displayThread();
          break;

        case "!delete":
          if (!arg) { this.#writeLine(`${RED}Usage: !delete <id-prefix>${R}`); break; }
          this.#deleteSession(arg);
          break;

        case "!mute":
          if (!arg) { this.#writeLine(`${RED}Usage: !mute <id-prefix>${R}`); break; }
          this.#toggleMute(arg);
          break;

        case "!status":
          this.#displayStatus();
          break;

        case "!interrupt":
          if (!this.#selectedSessionId) { this.#writeLine(`${RED}No session selected.${R}`); break; }
          try {
            const updated = this.#api.interruptSession(this.#selectedSessionId);
            this.#writeLine(`${GRN}Interrupted — now ${updated.status}.${R}`);
          } catch (err) {
            this.#writeLine(`${RED}Error: ${String(err)}${R}`);
          }
          break;

        case "!retry":
          if (!this.#selectedSessionId) { this.#writeLine(`${RED}No session selected.${R}`); break; }
          try {
            const updated = this.#api.retryBlockedSession(this.#selectedSessionId);
            this.#writeLine(`${GRN}Retrying — now ${updated.status}.${R}`);
          } catch (err) {
            this.#writeLine(`${RED}Error: ${String(err)}${R}`);
          }
          break;

        case "!schedule":
          if (!arg) { this.#writeLine(`${RED}Usage: !schedule <cron> <prompt>${R}`); break; }
          if (!this.#selectedSessionId) { this.#writeLine(`${RED}No session selected.${R}`); break; }
          {
            const parsed = parseScheduleCommandArg(arg);
            if (!parsed) {
              this.#writeLine(`${RED}Usage: !schedule <cron> <prompt>${R}`);
              break;
            }
            try {
              const id = crypto.randomUUID();
              this.#api.scheduleTrigger({
                id,
                sessionId: this.#selectedSessionId!,
                kind: "time",
                schedule: parsed.schedule,
                payload: { prompt: parsed.prompt },
                enabled: true,
                recurring: true,
              });
              this.#writeLine(`${GRN}Scheduled: ${id.slice(0, 8)} (${parsed.schedule})${R}`);
            } catch (err) {
              this.#writeLine(`${RED}Error: ${String(err)}${R}`);
            }
          }
          break;

        case "!triggers":
          if (!this.#selectedSessionId) { this.#writeLine(`${RED}No session selected.${R}`); break; }
          try {
            const triggers = this.#api.listTriggers(this.#selectedSessionId);
            if (triggers.length === 0) {
              this.#writeLine(`${D}No scheduled triggers.${R}`);
            } else {
              this.#writeLine(`\n${B}Triggers:${R}`);
              for (const t of triggers) {
                const next = t.nextFire ? new Date(t.nextFire).toISOString() : "N/A";
                this.#writeLine(`  ${t.id.slice(0, 8)}  ${t.kind}  ${t.enabled ? "enabled" : "disabled"}  schedule=${t.schedule || "manual"}  next=${next}`);
              }
              this.#writeLine("");
            }
          } catch (err) {
            this.#writeLine(`${RED}Error: ${String(err)}${R}`);
          }
          break;

        case "!cancel":
          if (!arg) { this.#writeLine(`${RED}Usage: !cancel <trigger-id-prefix>${R}`); break; }
          if (!this.#selectedSessionId) { this.#writeLine(`${RED}No session selected.${R}`); break; }
          try {
            const triggers = this.#api.listTriggers(this.#selectedSessionId);
            const match = triggers.find((t) => t.id.startsWith(arg));
            if (!match) {
              this.#writeLine(`${RED}No trigger matching "${arg}".${R}`);
            } else {
              this.#api.deleteTrigger(match.id);
              this.#writeLine(`${GRN}Deleted trigger ${match.id.slice(0, 8)}.${R}`);
            }
          } catch (err) {
            this.#writeLine(`${RED}Error: ${String(err)}${R}`);
          }
          break;

        case "!help":
          this.#displayHelp();
          break;

        case "!quit":
          this.#handleQuit();
          return;

        default:
          this.#writeLine(`${RED}Unknown command: ${cmd}. Type !help for commands.${R}`);
      }
    } catch (err) {
      this.#writeLine(`${RED}Error: ${String(err)}${R}`);
    }

    this.#rl.prompt();
  }

  async #handleUserMessage(text: string): Promise<void> {
    const sessionId = this.#selectedSessionId;
    if (!sessionId) {
      this.#writeLine(`${RED}No session selected. Use !create or !select first.${R}`);
      return;
    }

    const session = this.#api.getSession(sessionId);
    if (!session) {
      this.#writeLine(`${RED}Session not found.${R}`);
      this.#selectedSessionId = null;
      this.#rl.setPrompt(this.#buildPrompt());
      return;
    }

    if (session.status !== "idle" && session.status !== "waiting_user" && session.status !== "sleeping") {
      this.#writeLine(`${RED}Cannot send message — session is ${session.status}.${R}`);
      return;
    }

    this.#writeLine(`\n${CYN}${B}You:${R} ${text}`);

    try {
      this.#api.appendUserMessage(sessionId, text);
      this.#writeLine(`  ${D}[Thinking...]${R}`);
    } catch (err) {
      this.#writeLine(`${RED}Turn failed: ${String(err)}${R}`);
    }
  }

  // ── Session utilities ──

  #selectSession(prefix: string): void {
    const s = this.#findSessionByPrefix(prefix);
    if (!s) {
      this.#writeLine(`${RED}No session matching "${prefix}".${R}`);
      return;
    }
    this.#selectedSessionId = s.id;
    this.#rl.setPrompt(this.#buildPrompt());
    this.#writeLine(`${GRN}Selected: ${s.id} — "${s.title}" (${s.status})${R}`);
  }

  #deleteSession(prefix: string): void {
    const s = this.#findSessionByPrefix(prefix);
    if (!s) { this.#writeLine(`${RED}No session matching "${prefix}".${R}`); return; }
    this.#api.deleteSession(s.id);
    if (this.#selectedSessionId === s.id) {
      this.#selectedSessionId = null;
      this.#rl.setPrompt(this.#buildPrompt());
    }
    this.#writeLine(`${GRN}Archived: ${s.id} — "${s.title}"${R}`);
  }

  #toggleMute(prefix: string): void {
    const s = this.#findSessionByPrefix(prefix);
    if (!s) { this.#writeLine(`${RED}No session matching "${prefix}".${R}`); return; }
    const updated = this.#api.muteSession(s.id, !s.muted);
    this.#writeLine(`${GRN}${updated.id} muted=${updated.muted}${R}`);
  }

  #findSessionByPrefix(prefix: string): Session | null {
    const sessions = this.#api.listSessions();
    const byId = sessions.filter((s) => s.id.startsWith(prefix));
    if (byId.length === 1) return byId[0]!;
    if (byId.length > 1) return byId[0]!;
    const lower = prefix.toLowerCase();
    const byTitle = sessions.filter((s) => s.title.toLowerCase().includes(lower));
    if (byTitle.length >= 1) return byTitle[0]!;
    return null;
  }

  #handleQuit(): void {
    this.#writeLine(`\n${D}Bye.${R}`);
    this.destroy();
    process.exit(0);
  }

  // ── Display helpers ──

  #writeLine(text: string): void {
    process.stdout.write(text + "\n");
  }

  #displayEvent(event: SessionEvent): void {
    switch (event.type) {
      case "user_message":
        // Already printed before sending
        break;
      case "assistant_delta":
        if (!this.#streaming) {
          this.#writeLine(`\n${GRN}${B}Assistant:${R} `);
          this.#streaming = true;
        }
        process.stdout.write(`${GRN}${event.text}${R}`);
        break;
      case "assistant_message":
        if (this.#streaming) {
          this.#writeLine("");
          this.#streaming = false;
        } else if (event.text) {
          this.#writeLine(`\n${GRN}${B}Assistant:${R} ${GRN}${event.text}${R}\n`);
        }
        break;
      case "usage_event":
        this.#writeLine(`  ${D}${event.message}${R}`);
        break;
      case "context_usage_event":
        this.#writeLine(`  ${D}${event.message}${R}`);
        break;
      case "tool_call":
        this.#writeLine(
          `  ${YLW}▶ ${event.toolName}(${truncate(JSON.stringify(event.args), 80)})${R}`,
        );
        break;
      case "tool_result":
        if (event.isError) {
          this.#writeLine(
            `  ${RED}✗ ${event.toolName}: ${truncate(String(event.result), 200)}${R}`,
          );
        } else {
          this.#writeLine(
            `  ${D}✓ ${event.toolName}: ${truncate(String(event.result), 200)}${R}`,
          );
        }
        break;
      case "compaction_block":
        this.#writeLine(`  ${D}[compacted #${event.coversEvents[0]}–#${event.coversEvents[1]}]${R}`);
        break;
      case "runtime_event":
        this.#writeLine(`  ${MAG}[runtime: ${event.runtimeKind} ${event.detail}] ${event.message}${R}`);
        break;
      case "trigger_event":
        this.#writeLine(`  ${MAG}[trigger: ${event.triggerKind}]${R}`);
        break;
      case "artifact_pointer":
        this.#writeLine(`  ${D}[artifact: ${event.artifactId}] ${event.mimeType}${R}`);
        break;
    }
  }

  #displaySessions(): void {
    const sessions = this.#api.listSessions();
    if (sessions.length === 0) {
      this.#writeLine(`${D}No sessions.${R}`);
      return;
    }
    this.#writeLine(`\n${B}Sessions:${R}`);
    for (const s of sessions) {
      const marker = s.id === this.#selectedSessionId ? `${GRN}*` : " ";
      const sc = STATUS_COLOR[s.status] ?? R;
      const project = s.projectId ? this.#api.getProject(s.projectId) : null;
      this.#writeLine(
        ` ${marker}${R} ${s.id.slice(0, 8)} ${sc}[${s.status}]${R} ${D}"${s.title}"${R} ${D}${project?.name ?? "No project"}${R}${s.muted ? ` ${YLW}muted${R}` : ""}`,
      );
    }
    this.#writeLine("");
  }

  #displayProjects(): void {
    const current = this.#api.getCurrentProject();
    const projects = this.#api.listProjects().filter((project) => project.status !== "archived");
    this.#writeLine(`\n${B}Projects:${R}`);
    for (const project of projects) {
      const marker = project.id === current.id ? `${GRN}*` : " ";
      this.#writeLine(
        ` ${marker}${R} ${project.id.slice(0, 12)} [${project.status}] ${D}${project.name}${R} ${project.path}`,
      );
    }
    this.#writeLine("");
  }

  #selectProject(query: string): void {
    const trimmed = query.trim();
    const projects = this.#api.listProjects();
    const existing = projects.find((project) => (
      project.id.startsWith(trimmed) ||
      project.path === trimmed ||
      project.name.toLowerCase() === trimmed.toLowerCase()
    ));
    const project = existing
      ? this.#api.selectProject(existing.id)
      : this.#api.ensureProjectForPath(trimmed, { current: true });
    this.#selectedSessionId = null;
    this.#writeLine(`${GRN}Selected project:${R} ${project.name} ${D}${project.path}${R}`);
  }

  #displayThread(): void {
    const sessionId = this.#selectedSessionId;
    if (!sessionId) { this.#writeLine(`${RED}No session selected.${R}`); return; }
    const events = this.#api.getThread(sessionId);
    if (events.length === 0) { this.#writeLine(`${D}Thread is empty.${R}`); return; }
    this.#writeLine(`\n${B}Thread (${events.length} events):${R}`);
    for (const e of events) {
      const label = eventLabel(e);
      const content = eventContent(e, 120);
      this.#writeLine(`  ${D}#${e.seq}${R} ${label} ${content}`);
    }
    this.#writeLine("");
  }

  #displayStatus(): void {
    const sessionId = this.#selectedSessionId;
    if (!sessionId) { this.#writeLine(`${RED}No session selected.${R}`); return; }
    const s = this.#api.getSession(sessionId);
    if (!s) { this.#writeLine(`${RED}Session not found.${R}`); return; }
    const sc = STATUS_COLOR[s.status] ?? R;
    this.#writeLine(`\n${B}Session:${R} ${s.id}`);
    this.#writeLine(`  Title: ${s.title}`);
    this.#writeLine(`  Status: ${sc}${s.status}${R}`);
    this.#writeLine(`  Muted: ${s.muted}`);
    this.#writeLine(`  Created: ${s.createdAt}`);
    this.#writeLine(`  Updated: ${s.updatedAt}`);
    const events = this.#api.getThread(sessionId);
    this.#writeLine(`  Events: ${events.length}`);
    this.#writeLine(`  Usage: ${formatUsageSummary(this.#api.getSessionUsage(sessionId))}`);
    this.#writeLine("");
  }

  #displayHelp(): void {
    this.#writeLine(`\n${B}Commands:${R}
  ${CYN}!create <title>${R}    Create a new session
  ${CYN}!list${R}              List all sessions
  ${CYN}!select <prefix>${R}   Select session by ID prefix or title
  ${CYN}!thread${R}            Show current session thread
  ${CYN}!delete <prefix>${R}   Archive a session
  ${CYN}!mute <prefix>${R}     Toggle mute on a session
  ${CYN}!status${R}            Show current session details
  ${CYN}!interrupt${R}         Interrupt session → back to idle
  ${CYN}!retry${R}             Retry a blocked session
  ${CYN}!schedule <c> <p>${R}  Schedule a cron trigger
  ${CYN}!triggers${R}          List triggers for this session
  ${CYN}!cancel <prefix>${R}   Cancel a scheduled trigger
  ${CYN}!help${R}              Show this help
  ${CYN}!quit${R}              Exit

  ${D}Anything else is sent as a chat message.${R}
`);
  }

  #buildPrompt(): string {
    const sid = this.#selectedSessionId;
    if (!sid) return `${D}(no session)${R}> `;
    const s = this.#api.getSession(sid);
    const idPart = sid.slice(0, 8);
    const sc = s ? (STATUS_COLOR[s.status] ?? R) : RED;
    const status = s ? s.status : "?";

    // Add contextual hint based on status
    const hint = s ? this.#statusHint(s.status) : "";

    const usage = this.#api.getSessionUsage(sid);
    const usageHint = formatPromptUsage(usage);
    return `${idPart} ${sc}[${status}]${R}${usageHint}${hint}> `;
  }

  #statusHint(status: string): string {
    switch (status) {
      case "sleeping": return ` ${D}(type to wake)${R}`;
      case "blocked": return ` ${RED}(!retry or !interrupt)${R}`;
      case "waiting_user": return ` ${YLW}(reply to continue)${R}`;
      default: return "";
    }
  }
}

// ── Helpers ──

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

function eventLabel(e: SessionEvent): string {
  switch (e.type) {
    case "user_message": return `${CYN}YOU  ${R}`;
    case "assistant_message": return `${GRN}ASST ${R}`;
    case "assistant_delta": return `${GRN}DLTA ${R}`;
    case "usage_event": return `${D}USGE ${R}`;
    case "context_usage_event": return `${D}CTX  ${R}`;
    case "evidence_event": return `${D}EVID ${R}`;
    case "tool_call": return `${YLW}TOOL ${R}`;
    case "tool_result": return e.isError ? `${RED}RSLT ${R}` : `${D}RSLT ${R}`;
    case "compaction_block": return `${D}CMPT ${R}`;
    case "trigger_event": return `${MAG}TRIG ${R}`;
    case "runtime_event": return `${MAG}RUNT ${R}`;
    case "branch_event": return `${MAG}BRCH ${R}`;
    case "permission_request": return `${MAG}PERM ${R}`;
    case "permission_response": return `${MAG}PERM ${R}`;
    case "skill_used": return `${MAG}SKIL ${R}`;
    case "skill_event": return `${MAG}SKIL ${R}`;
    case "mcp_elicitation_request": return `${MAG}MCP? ${R}`;
    case "mcp_elicitation_response": return `${MAG}MCP! ${R}`;
    case "artifact_pointer": return `${D}ARTF ${R}`;
    default: return `${D}EVNT ${R}`;
  }
}

function eventContent(e: SessionEvent, max: number): string {
  switch (e.type) {
    case "user_message": return truncate(e.text, max);
    case "assistant_message": return truncate(e.text || "(empty)", max);
    case "assistant_delta": return truncate(e.text, max);
    case "usage_event": return truncate(e.message, max);
    case "context_usage_event": return truncate(e.message, max);
    case "evidence_event": return `${e.status} ${e.step}: ${truncate(e.message, max)}`;
    case "tool_call": return `${e.toolName}(${truncate(JSON.stringify(e.args), max - e.toolName.length - 2)})`;
    case "tool_result": return truncate(String(e.result), max);
    case "compaction_block": return `covers #${e.coversEvents[0]}–#${e.coversEvents[1]}: ${truncate(e.summary, max - 20)}`;
    case "trigger_event": return `${e.triggerKind}: ${truncate(JSON.stringify(e.payload), max)}`;
    case "runtime_event": return `${e.runtimeKind} ${e.detail}: ${e.message}`;
    case "branch_event": return truncate(e.message, max);
    case "permission_request": return `${e.toolName} ${e.status}: ${truncate(e.message, max)}`;
    case "permission_response": return `${e.toolName} ${e.status}: ${truncate(e.message, max)}`;
    case "skill_used": return `${e.skillName}: ${truncate(e.message, max)}`;
    case "skill_event": return `${e.action}: ${truncate(e.message, max)}`;
    case "mcp_elicitation_request": return `${e.serverName}: ${truncate(e.message, max)}`;
    case "mcp_elicitation_response": return `${e.serverName}: ${truncate(e.message, max)}`;
    case "artifact_pointer": return `${e.artifactId} (${e.mimeType}, ${e.sizeBytes} bytes)`;
    default: return truncate("message" in e && typeof e.message === "string" ? e.message : e.type, max);
  }
}

type UsageLike = ReturnType<import("../../core/core-api.js").CoreAPI["getSessionUsage"]>;

function formatPromptUsage(summary: UsageLike): string {
  if (!summary.latest && summary.currentContextUsedPercent === undefined) return "";
  const ctx = summary.currentContextUsedPercent !== undefined
    ? `${summary.currentContextEstimated ? "~" : ""}${formatPercent(summary.currentContextUsedPercent)}${summary.currentContextSource === "local_estimate" ? " local" : ""}`
    : "n/a";
  const cache = summary.cacheHitRateSession !== undefined
    ? ` cache ${formatPercent(summary.cacheHitRateSession)}`
    : "";
  return ` ${D}(ctx ${ctx}${cache})${R}`;
}

function formatUsageSummary(summary: UsageLike): string {
  if (!summary.latest && summary.currentContextUsedPercent === undefined) return "none";
  const parts = [
    `ctx ${formatCurrentContext(summary)}`,
  ];
  if (summary.latest) {
    parts.push(`in ${summary.latest.usage.input_tokens}`);
    parts.push(`out ${summary.latest.usage.output_tokens}`);
  }
  if (summary.latest?.usage.reasoning_tokens) parts.push(`reasoning ${summary.latest.usage.reasoning_tokens}`);
  if (summary.cacheHitRateNow !== undefined) parts.push(`cache now ${formatPercent(summary.cacheHitRateNow)}`);
  if (summary.cacheHitRateSession !== undefined) parts.push(`cache avg ${formatPercent(summary.cacheHitRateSession)}`);
  if (summary.cost !== undefined) parts.push(`${summary.currency ?? ""}${summary.cost.toFixed(4)}`);
  if (summary.estimated) parts.push("estimated");
  return parts.join(" · ");
}

function formatCurrentContext(summary: UsageLike): string {
  if (summary.currentContextUsedPercent === undefined) return "n/a";
  const prefix = summary.currentContextEstimated ? "~" : "";
  const suffix = summary.currentContextSource === "local_estimate" ? " local" : "";
  return `${prefix}${formatPercent(summary.currentContextUsedPercent)}${suffix}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}
