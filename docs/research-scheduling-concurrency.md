# 调度与并发：三个参考系统的设计模式（研究归档）

> ⚠️ 本文档为 2026-05-29 调研归档，当前实现已与调研时不同。
> 本文只作为竞品研究材料，不作为 ForgeAgent 当前实现计划或规范。
> 当前架构请参考 `forge_agent_v_2_architecture_spec.md`。

当前 ForgeAgent 已落地的相关结论：

- 不新增 `queued` session 状态，`running` 明确表示已排队或正在执行。
- `appendUserMessage()` 默认自动 dispatch；HTTP message endpoint 不要求客户端额外调用 `/run`。
- Supervisor 负责并发队列，但队列不单独持久化；进程重启后由 `running` session meta 和 thread-first rehydration 重新调度。
- Scheduler 持久化 trigger，并通过 `trigger_scheduled` / `triggers_empty` 同步 `idle` / `sleeping`。
- `interrupt` 对 queued/active turn 执行 dequeue/abort，并补写中断 `tool_result` 防止悬空 tool call。
- Runtime attachment/recovery 以 durable `runtime_event` 写入 thread，并通过 payload 支撑重启恢复。

## 1. Claude Code

### 1.1 调度系统 (CronCreate / CronList / CronDelete)

**设计模式：工具驱动，内存常驻，session 生命周期绑定**

```
CronCreate Tool (Agent 可调用)
  ↓
内存 Map<cronJobId, {cron, prompt, recurring}>
  ↓
setTimeout 单定时器循环
  ↓
触发时：注入 trigger_event → 排队到 message queue → 在下个空闲时刻执行
```

核心特点：
- **工具暴露给 Agent**：Agent 自己决定何时创建/取消定时任务
- **纯内存**：不持久化到 disk（除非 `durable: true`，写入 `.claude/scheduled_tasks.json`）
- **仅空闲时触发**：只在 REPL idle 时 fire；正在运行的 turn 不会被打断
- **7 天自动过期**：recurring job 7 天后自动删除，防止泄漏
- **jitter 防惊群**：recurring 任务最多延迟 10% 周期（max 15min）；one-shot 任务最多提前 90s
- **限制 50 个任务/session**

**关键实现细节：**
```typescript
// 伪代码
class CronScheduler {
  #jobs = new Map<string, CronJob>()
  #timer?: NodeJS.Timeout

  schedule(cron: string, prompt: string, recurring: boolean): string {
    const id = generateId()
    this.#jobs.set(id, { cron, prompt, recurring, nextFire: calcNextFire(cron) })
    this.#rearm()  // 重新计算最近的触发时间
    return id
  }

  #rearm() {
    clearTimeout(this.#timer)
    const next = minNextFire(this.#jobs.values())
    if (next) this.#timer = setTimeout(() => this.#fire(next.id), next.time - Date.now())
  }

  async #fire(id: string) {
    const job = this.#jobs.get(id)
    // 注入 trigger event 到 session thread
    appendToThread({ type: "trigger_event", triggerKind: "time", ... })
    // 如果是 recurring，计算下次触发时间
    if (job.recurring) job.nextFire = calcNextFire(job.cron)
    else this.#jobs.delete(id)
    this.#rearm()
  }
}
```

### 1.2 会话并发 (Task Framework)

**设计模式：状态机 + AgentContext + backgroundable queries**

核心抽象：
```
Task (通用任务状态机)
  ├─ LocalShellTask (shell 命令后台运行)
  ├─ LocalAgentTask (子 agent session，有自己独立的消息历史)
  ├─ RemoteAgentTask (远程 agent)
  ├─ LocalMainSessionTask (主 session 被 background)
  └─ LocalWorkflowTask (workflow 编排)
```

任务状态：
```
pending → running → finished / failed / stopped
                   ↘ (可被 background / foreground)
```

**并发模型关键点：**

1. **主 session 可被 background** (Ctrl+B 两次)：
   - 当前查询继续在后台跑
   - UI 清空到新 prompt
   - 完成后发送桌面通知
   - 每个 background task 有自己的 transcript 文件（隔离），不污染主 session

2. **子 Agent 并行**：
   - `Agent` tool 调用时 spawn 新的 LocalAgentTask
   - 每个子 agent 有独立 session、context、workspace
   - 通过 `maxConcurrent` 限制并行数
   - 子 agent 之间通过 thread 通信

3. **AsyncLocalStorage 隔离**：
   - 用 `runWithAgentContext()` 包裹每个 task
   - 使 skills、hooks 等自动路由到正确的 agent
   - 同一个 Node.js 进程中多个异步 task 不会互相污染

4. **Task Framework (`framework.ts`)**：
   ```
   registerTask(state, setAppState) → 注册到全局 AppState.tasks
   updateTaskState(id, setAppState, updater) → 原子更新
   ```
   所有 task 都在同一个 React state tree 中，通过 `setAppState` 更新。

---

## 2. Hermes Agent (Nous Research)

### 2.1 调度系统

**设计模式：cron 表达式 + 自然语言 prompt + 多平台分发**

```
用户创建 cron job（通过 CLI 或 REST API）
  ↓
cron 表达式 + 自然语言描述 + 目标平台
  ↓
内置 cron scheduler（Python schedule 库或类似）
  ↓
触发时：创建新 session → 注入 prompt → 执行 agent loop → 结果推送到目标平台
```

核心特点：
- **cron job 是独立 session**：每次触发创建新 session 或复用 session lineage
- **平台路由**：job 结果可分发到 Telegram、Discord、Slack 等
- **REST API**：`/api/jobs` 端点支持程序化管理
- **手动触发**：可随时手动触发任何 job，实时流式输出
- **持久化**：job 配置存储在 SQLite 中

### 2.2 会话并发

**设计模式：单进程多 session，每 session 独立 agent loop**

核心特点：
- **SQLite 持久化**：所有 session 跨重启保持
- **session lineage**：`parent_session_id` 链保持对话历史在 context compression 后仍可追溯
- **context compression**：自动 LLM 摘要（默认 50% context window 阈值）
- **多个独立 profile**：每个 profile 有隔离的 sessions/config/memory

---

## 3. OpenClaw

### 3.1 调度系统

**设计模式：工具暴露 + 平台级定时**

```
ScheduleReminder / ListReminders / CancelReminder 工具
  ↓
Agent 可调用的内置工具
  ↓
平台级定时器管理
```

### 3.2 会话并发（核心优势）

**设计模式：Gateway → Agent → Session 三层隔离 + 子 Agent spawn**

```
Gateway (daemon，维持长连接)
  ├─ Agent A (独立 workspace、auth、skills)
  │   ├─ Session 1 (main)
  │   ├─ Session 2 (sub-agent)
  │   └─ Session 3 (sub-agent)
  ├─ Agent B
  │   └─ Session 1 (main)
  └─ Agent C
      ├─ Session 1 (main)
      └─ Session 2 (sub-agent)
```

**子 Agent 并发模型 (sessions_spawn)：**

```
Agent 调用 sessions_spawn(prompt, count=1)
  ↓
立即返回 runId（非阻塞）
  ↓
后台创建 N 个独立 sub-agent session
  ↓
每个 sub-agent：
  - 独立 session（新 context）
  - 可选独立 model（更便宜）
  - 可选独立 thinking level（更低）
  - 默认 maxConcurrent: 8
  - 默认 60 分钟 auto-archive
  ↓
结果推送回 parent session（逐个推送，不等全部完成）
```

**嵌套子 Agent（depth 2）：**
```
Orchestrator Agent (depth 0)
  ├─ Sub-agent A (depth 1) — 有 sessions_spawn 工具
  │   ├─ Worker 1 (depth 2) — 无 session 工具
  │   └─ Worker 2 (depth 2) — 无 session 工具
  └─ Sub-agent B (depth 1)
      └─ Worker 3 (depth 2)
```
- `maxSpawnDepth: 2` 限制嵌套层级
- `maxChildrenPerAgent: 5`（默认，范围 1-20）
- Cascade stop：kill parent → kill all children

**隔离维度：**
| 维度 | 隔离方式 |
|------|---------|
| Workspace | 每个 Agent 独立 AGENTS.md、SOUL.md、USER.md、skills |
| Auth | 每个 Agent 独立 API key |
| Tools | 每个 Agent 独立 allow/deny 列表 |
| Routing | 最具体匹配优先（peer > guild > channel > default） |
| Sandbox | `sandbox.mode: off / non-main / all` × `scope: session / agent / shared` |

**高级编排模式（社区）：**

1. **Hub-and-Spoke**：一个 Orchestrator → N 个 specialist 子 agent
2. **Dream Team**：7+ agent，每类任务用不同模型（Opus 编排、Codex 写代码、Flash 搜索）
3. **GodMode Workflows**：预定义模板（New Feature / Bug Fix / API Change / Research / Release）
4. **Blackboard**：共享文件系统 + atomic mutex，agent 间通过文件协调
5. **Octopus Orchestrator**：
   - Missions (DAG of tasks)
   - Arms (worker agents)
   - Grips (tasks with dependency ordering)
   - Claims (exclusive resource locks)
   - Leases (time-bounded ownership + heartbeats)

---

## 4. 对 ForgeAgent 的启发

### 4.1 调度系统设计要点

| 来源 | 模式 | 对 ForgeAgent 的适用性 |
|------|------|----------------------|
| Claude Code | 工具暴露 + 内存 + setTimeout | 已吸收为 `cron_create` / `cron_list` / `cron_delete` 工具和持久化 Scheduler |
| Hermes Agent | cron + 独立 session + 多平台路由 | job 作为独立 session 的思路很好，但我们已有 Trigger 模型 |
| OpenClaw | 工具暴露 + 平台级管理 | 较重量级，适合后期参考 |

**建议采纳的方案：**
- Trigger 创建通过工具暴露给 Agent（Claude Code 模式）
- Gateway 层面同时提供 REST API 管理 trigger（Hermes 模式）
- Trigger 触发时注入 trigger_event 到 thread（当前已实现）
- 用单一 setTimeout 循环管理所有 time trigger（Claude Code 模式）

### 4.2 会话并发设计要点

| 来源 | 模式 | 对 ForgeAgent 的适用性 |
|------|------|----------------------|
| Claude Code | Task Framework + backgroundable + AsyncLocalStorage | Task 状态机非常优雅，但依赖 React state tree |
| Hermes Agent | 单进程多 session + SQLite | 简单直接，适合我们当前的架构 |
| OpenClaw | Gateway→Agent→Session + sub-agent spawn | 三层隔离最完整，但当前我们只有一个 Agent 的概念 |

**建议采纳的方案（结合三者）：**

1. **Supervisor 作为调度中心**：
   - 维护一个并发队列（受 OpenClaw maxConcurrent 启发）
   - Session 不是由 Gateway 直接调用 runTurn，而是向 Supervisor 请求调度
   - Supervisor 决定何时执行（当前并发数 < maxConcurrent 时）

2. **Session run 异步化**：
   - `runTurn()` 返回 Promise，但不阻塞 Gateway
   - Gateway 通过 SSE/轮询获取结果
   - 类似 Claude Code 的 background task 模式，但更轻量

3. **并发上限**：
   - 默认 `maxConcurrentSessions: 4`
   - 超出上限的 session 排队等待
   - sleeping → running 的 trigger 唤醒同样进入队列

4. **不引入 Agent 层**：
   - 当前 ForgeAgent 的 session 就是 OpenClaw 的 agent+session 合并
   - 先保持简单，后续按需拆分
