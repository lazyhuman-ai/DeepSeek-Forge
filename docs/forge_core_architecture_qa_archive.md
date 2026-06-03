# Forge Core 架构问答归档

> 历史归档说明：本文保留架构讨论过程中的问答记录，不作为当前实现规范。当前生命周期、`blocked` 语义和 runtime 恢复流程以 `docs/forge_agent_v_2_architecture_spec.md` 与代码为准。

> 当前已替换的历史结论：
> - `running` 现在表示已排队或正在执行，不只是正在执行 turn。
> - `createSession(title)` 可以创建内存草稿并出现在 session list；没有首条用户消息时不持久化到磁盘。
> - 长期 memory 已改为 markdown-first：`instruction/profile/project/procedure/episode`，由 `memory_search` / `memory_get` 主动召回，并由后台 proposal/consolidation 自动维护。
> - 工具大输出已由 Artifact Store 自动落盘，thread 保留合法 `tool_result` 预览和 `artifact_pointer`。
> - Compaction 已改为 LLM 结构化 handoff summary；失败不做启发式 fallback，而是进入框架级 `blocked`。
> - Runtime attachment/recovery 和 runtime-blocked ownership 已使用 readable message + payload 双写，以支持进程重启 rehydration。

## 核心方向

Forge Core 被定义为：

> 一个长期运行的 OS-like agent kernel。
>
> Session 是永不自然结束的线性对话线程。
>
> Runtime 是共享基础设施。
>
> Gateway 只是显示和输入层。

系统的核心原则：

- 当前 session 的连续性只依赖线性 thread。
- 不引入隐藏状态。
- 不让 memory/snapshot 替代 session thread。
- trigger、runtime 状态、用户输入都以事件形式进入 session。
- Core 只负责调度、runtime 管理和修复，不解释 agent 语义。

---

# 第一部分：Session 与 Gateway

## 1. Session 与 Gateway 的关系

- Gateway（WebUI / Terminal / Desktop / App）只是不同显示入口。
- 所有 gateway 共用同一套 Core 和底层数据。
- 在任意 gateway 中创建的 session、操作、通知、回复，其他 gateway 都能看到。
- Gateway 类似 IM（即时通讯）客户端。

## 2. Session 选择方式

用户必须明确使用已有 session 或创建新 session。

类似：

```txt
forge continue <session-id>
forge new "帮我分析代码"
```

Core 会结合 gateway 当前上下文判断。

## 3. 多 Session

允许多个 session 同时存在。

例如：

- 一个 session 跑浏览器自动化
- 一个 session 等用户登录
- 一个 session 长期监控网站
- 一个 session 在分析代码

Session 之间逻辑独立。

## 4. Session 永不自然结束

Session 不存在 completed/finalized 概念。

只有 6 个生命状态 + 1 个终态：

```txt
idle          — 就绪等待
running       — 已排队或正在执行 turn
waiting_user  — 等待用户回复
sleeping      — 休眠等 trigger
blocked       — 框架级阻塞断路器
archived      — 终态
```

已移除 `paused`（用 `user_interrupt` 替代暂停/恢复）。
Session 会一直存在，除非用户主动删除。

Agent 输出 final 仅表示本轮回复结束，而不是 session 生命周期结束。

---

# 第二部分：Runtime 与 Core

## 5. Core 的职责

Core 是长期运行的系统内核，负责：

1. 常驻并维持 runtime 完整性
2. 处理用户输入
3. 向用户发送通知
4. 调度 session
5. 修复 runtime
6. 管理 trigger

Core 不负责解释 agent 语义。

---

## 6. Runtime 的含义

Runtime 指 session 执行所依赖的基础设施，例如：

- Browser runtime（Chrome/CDP）
- Shell runtime
- Tool runtime
- Scheduler runtime
- MCP runtime

Core 必须保证 runtime 长期在线。

例如：

- Chrome CDP 不应该在 agent 使用时才发现离线
- Core 应提前维护连接状态

---

## 7. Browser Runtime

### Chrome

允许多个 session 共用同一个 Chrome。

推荐：

- 不同 session 使用不同 tab

特殊情况下允许：

- 多个 session attach 到同一个 tab
- 一个 session 观察另一个 session 的运行

### Browser Runtime 崩溃

Core 应：

```txt
自动重连
恢复状态
通知用户
向受影响 session 写入恢复事件
唤醒相关 session
```

如果修复失败：

```txt
session -> blocked
持续 retry
通知用户
```

---

## 8. Shell Runtime

Session 需要隔离 workspace。

建议：

```txt
.forge/workspaces/session_xxx/
```

要求：

- 简单隔离
- 不引入复杂容器机制
- 避免严重冲突

---

## 9. Runtime 恢复

Core 重启后，应尽量透明恢复：

- session thread
- runtime 状态
- browser tabs
- scheduler
- artifacts
- waiting_user 状态
- blocked 状态

目标：

> 用户可以无缝接上重启前的工作。

---

# 第三部分：Session 状态

## 10. Session 状态机

当前状态（6 个生命状态 + 1 个终态）：

```txt
idle          — 就绪等待，无进行中工作
running       — 已排队或正在执行 turn
waiting_user  — Agent 在 turn 中途等待用户回复
sleeping      — 主动休眠，有定时 trigger 等待唤醒
blocked       — 框架级阻塞断路器，等待自动恢复或人工重试
archived      — 终态，不可逆
```

已移除 `paused`：用 `user_interrupt`（任意状态→idle）替代暂停/恢复，语义更清晰。

### waiting_user

正常状态。Agent 在 turn 中途向用户提问，挂起等回复。用户回复后**继续同一个 turn**。用户也可以 interrupt 放弃等待。

### blocked

异常状态。由 Core/runtime 问题导致（API 错误、浏览器断开）。有两种恢复路径：
- 浏览器断线 → RuntimeManager 自动检测恢复 → runtime_recovered
- API 错误 → 用户手动 retryBlockedSession()

### sleeping

主动挂起等待 trigger。与 idle 的区别：sleeping 显示下次唤醒时间，用户知道这个 session「还会自己醒来」。用户也可以直接发消息提前叫醒。进入条件：turn 正常完成且存在 enabled trigger。

### idle

就绪等待。与 sleeping 的区别：idle 没有定时任务，只在等人叫它。可以通过 trigger_fired 被唤醒（如果后来加了 trigger）。

---

# 第四部分：Trigger 与 Scheduler

## 11. Trigger 统一进入 Session Thread

所有 trigger 都应追加到 session thread。

例如：

```txt
[trigger]
type: schedule
message: 每日 9 点触发
```

或：

```txt
[trigger]
type: runtime_recovered
message: Chrome reconnected
```

agent 应理解这些语义。

---

## 12. Trigger 类型

不区分 wake/context trigger。

统一语义：

```txt
trigger -> append event into thread
```

然后由 Core 调度唤醒 session。

---

## 13. Trigger 合并

如果 trigger 极其密集：

例如：

```txt
文件一分钟变化 50 次
```

Core 应允许合并事件。

---

## 14. 定时任务

系统同时支持：

### 有状态任务

唤醒已有 session：

```txt
session #123
每天 9 点继续执行
```

### 无状态任务

创建新 session 执行：

```txt
每天 9 点新建 session 生成日报
```

---

## 15. Retry / Backoff

Retry 策略由 session/agent 自己决定。

例如：

```txt
5 分钟后 retry
retry 1/3
```

Core 不内置复杂 retry 策略。

Core 只负责：

```txt
调度 trigger
按时间唤醒
```

---

## 16. 常驻任务

允许长期运行的 session。

例如：

- 长期监控网页
- 长期监控 GitHub
- 定时日报
- 持续观察浏览器状态

Session 可以存在数天、数周甚至永久。

---

## 17. 主动通知

允许 session 主动唤醒用户。

例如：

```txt
GitHub issue 更新
网页变化
任务完成
runtime 恢复
```

---

# 第五部分：Notification 与 System Stream

## 18. Notification 来源

Notification 分两类：

### Session Notification

agent 发出的内容。

例如：

```txt
请完成登录
```

### System Notification

Core/runtime 发出的内容。

例如：

```txt
Chrome runtime disconnected
Retrying...
Reconnected
```

两者必须区分。

---

## 19. 全局通知

Notification 默认推送到所有 gateway。

例如：

- Terminal
- WebUI
- Desktop
- App

全部同步收到。

用户可以：

```txt
mute 某个 session
```

但消息仍然存在。

---

## 20. Global System Stream

系统需要一个全局 system stream。

例如：

```txt
[CORE]
Chrome reconnected
Scheduler resumed
Session blocked
Memory maintenance degraded
Context compaction completed
```

该 stream：

- append-only
- 可回放
- 所有 gateway 可订阅

---

# 第六部分：Core 与 Agent 的边界

## 21. Core 不解释 Agent 语义

Core 只理解：

- session 状态
- runtime
- trigger
- notification
- 调度
- 修复

Core 不理解：

- 任务业务语义
- agent 推理
- domain logic

---

## 22. Session 状态变更

状态可以由：

### Agent 主动产生

例如：

```txt
waiting_user
sleeping
```

### Core/runtime 产生

例如：

```txt
blocked
runtime_recovered
```

但都必须写入：

```txt
session thread
或
system stream
```

---

## 23. Runtime 修复事件

Runtime 修复成功后，必须写入 session。

例如：

```txt
runtime_recovered:
Chrome CDP reconnected.
Original tab restored: true
```

让 agent 对整个系统有基础认知。

---

# 第七部分：Thread 与 Context

## 24. Session Thread 是唯一事实源

系统的核心原则：

> Session Thread 是唯一事实源。

所有内容都以 append-only 方式进入 thread。

包括：

- user messages
- assistant messages
- tool calls
- tool results
- trigger events
- runtime events
- system events
- compaction blocks
- artifact pointers

---

## 25. Context 管理原则

系统不使用复杂 hidden state。

不允许：

- memory 替代 session
- snapshot 替代 thread
- resume 魔法状态

当前 session 连续性完全依赖线性 thread。

---

## 26. Context Window Builder

Context builder 只是：

```txt
thread -> model messages
```

是纯渲染器。

它不：

- 管理状态
- 做复杂推理
- 做业务判断

---

## 27. Compaction

Compaction 是 thread 内的一条显式事件。

例如：

```txt
[compaction_block]
Covers events 001-120
...
```

不是独立 snapshot。

---

## 28. Artifact

大型 tool 输出必须 artifact 化。

例如：

```txt
artifacts/event_092.extract_links.json
```

Thread 中只保留 pointer。

---

# 第八部分：Memory 与 Skills

## 29. Memory

Memory 是跨 session 的长期知识。当前实现采用 markdown-first 存储：

包括：

- instruction
- profile
- project
- procedure
- episode

其中只有 `instruction` 可以进入 system prompt；其他类型必须由 Agent 通过 `memory_search` / `memory_get` 主动召回。后台 `MemoryManager` 会从 thread 自动提取 proposal，并在 consolidation 后写入 active markdown memory。proposal 是内部 staging，不由用户审批。

长期 Memory 不参与当前 session continuity。

当前 session 的连续性只依赖 thread。

---

## 30. Skills

Skill 是资源包，通过 `read_file` 渐进式披露：

```txt
skills/
  web-automation/
    douyin-favorites-export/
      SKILL.md
```

系统提示中列出可用技能及其路径，Agent 通过 `read_file` 按需读取。

不做 `skill_load`/`skill_list` 专用工具。如需改进技能系统，参考 Claude Code 的 SkillTool 实现。

---

## 31. Skill 自进化

Skill evolution 是独立 pipeline：

```txt
experience
-> proposal
-> eval
-> promote
```

不会污染 runtime 主循环。

---

# 第九部分：Gateway 与 UI

## 32. Gateway 是 IM 风格 UI

Gateway 应维护：

```txt
session list
selected session
unread count
muted sessions
system stream
```

---

## 33. 用户输入必须属于某个 Session

如果当前没有 selected session：

- 用户必须选择已有 session
- 或创建新 session

---

## 34. 空 Session 不持久化

允许 `createSession(title)` 创建无首条输入的内存草稿，并出现在 session list。

没有用户输入的 session 不应持久化；第一次 `appendUserMessage()` 时才创建 session 目录、写入 meta 和首条事件。

---

## 35. Gateway 只能通过 Core API

所有 gateway 必须通过统一 Core API：

```txt
createSession
appendUserMessage
subscribeStream
muteSession
deleteSession
listSessions
```

不能直接操作数据库。

---

# 最终抽象

最终系统抽象为：

> Forge Core = OS-like Agent Kernel
>
> Session = 永不自然结束的线性线程
>
> Runtime = 共享基础设施
>
> Gateway = IM 风格显示层
>
> Trigger / Runtime / User Input 全部事件化进入 thread
>
> Core 只负责调度、runtime 管理与修复，不解释 agent 语义
