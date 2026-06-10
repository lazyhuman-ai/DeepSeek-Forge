# ForgeAgent

<p align="center">
  <img src="assets/forge-agent-img.png" alt="ForgeAgent 本地 Agent 工作台" width="100%" />
</p>

<p align="center">
  <strong>面向 DeepSeek、MCP、Chrome 和多端协同的本地优先 Agent 工作台。</strong>
</p>

<p align="center">
  <a href="README.md">English</a>
</p>

ForgeAgent 在你的 Mac 上运行 Forge Core，让 Agent 拥有真实工作区：项目文件、工具、浏览器、MCP server、长期记忆和可持久化的消息流。界面是一套本地 Web Console，浏览器、macOS App、iPhone/iPad Safari 和 Android App 都使用同一套状态和交互。

它适合想要 Codex / Claude Code 风格本地 Agent 的用户，同时对 DeepSeek 的真实 usage、context、cache 和 reasoning token 有更完整的适配。

> **原创项目**
> ForgeAgent 是由 ForgeAgent contributors 开发的原创本地优先 Agent 工作台。本项目使用 MIT License 发布，欢迎 fork、修改和商业使用。如果你基于 ForgeAgent 构建产品或公开展示相关成果，欢迎在合适的显著位置注明 ForgeAgent。

## 为什么做 ForgeAgent

- **Mac 是本体。** 会话、文件、工具结果、artifact、密钥和设备状态都留在本机。
- **项目就是文件夹。** 每个项目对应一个 workspace，文件工具和沙盒边界围绕项目目录展开。
- **消息流是事实源。** 工具调用、错误、权限、浏览器事件、usage、artifact 和最终回答都会写回 session。
- **错误要让 Agent 看懂。** 权限拒绝、沙盒拦截、运行时失败、工具错误都会以可读文本返回，Agent 可以继续尝试修正。
- **DeepSeek 不是普通兼容端点。** ForgeAgent 会读取 DeepSeek 提供的真实 usage、context、cache 和 reasoning token 信息。

## 主要功能

- 本地 Web Console：Markdown、代码块、受限 HTML 预览、文件上传、消息分叉、权限审批。
- macOS App：启动或复用本机 Forge Core，通过 LaunchAgent 保持后台运行，并使用原生 power helper 允许屏幕熄灭但 Core 继续在线。
- iPhone/iPad：通过 Safari/PWA 使用同一套 Web Console。
- Android App：扫码配对 Mac，多连接管理、后台连接监控和通知。
- DeepSeek token usage、context usage、prefix cache hit/miss、reasoning token 和成本记录。
- Workspace sandbox、session 级 Danger Free、正常工作区任务减少审批打断。
- ForgeWebridge Chrome 扩展：使用你本机 Chrome profile 中已有的登录态。
- MCP client：支持 stdio、streamable HTTP 和 legacy SSE。
- Local-first extension：skills、MCP servers、bundles。
- 大输出 artifact 自动落盘，消息流里保留预览和指针。
- 长期记忆、skills、scheduler、runtime recovery 和进程重启恢复。

## 快速开始

### 环境要求

- macOS 作为主运行环境。
- Node.js 20+。
- DeepSeek API Key，或其他已配置 provider。

安装依赖并启动本地产品：

```sh
npm install
npm run product:build
npm run install:local
```

`install:local` 会构建 Web Console，安装本机 LaunchAgent，启动 Forge Core，并打开：

```text
http://127.0.0.1:3000
```

首次打开时，在界面里配置 provider。DeepSeek 默认 Base URL：

```text
https://api.deepseek.com
```

`.env` 仍可用于开发兼容，但普通使用推荐直接在 Web Console 里配置。

## macOS App

从源码打包并打开桌面 App：

```sh
npm run macos:build
npm run macos:package
open apps/macos/ForgeAgentMac/dist/ForgeAgent.app
```

macOS App 不是另一套聊天 UI。它是同一个 Forge Core 和 Web Console 的桌面壳：

- 启动或复用本地 Core 服务；
- 安装 `com.forgeagent.gateway` LaunchAgent；
- 监听 `0.0.0.0:3000`，方便私网设备访问；
- 数据目录为 `~/Library/Application Support/ForgeAgent/data`；
- 使用 `ForgeAgentPowerHelper` 持有 macOS 原生 idle-system-sleep assertion。

屏幕可以熄灭，Core 仍可继续运行。真正系统睡眠、合盖断网、断电或网络断开仍会中断远程访问。

## 手机访问

ForgeAgent 是 local-first：手机连接的是正在运行 Forge Core 的那台 Mac。

如果想离开家后继续使用，最简单的免费方式是 [Tailscale](https://tailscale.com/)：Mac 和手机都安装 Tailscale，登录同一个 tailnet，然后从 ForgeAgent 配对手机。

### iPhone / iPad

iOS 使用 Safari 或添加到主屏幕的 PWA。

1. 在 Web Console 右侧栏打开 **Pair Mobile**。
2. 切换到 **iPhone**。
3. 用相机扫描二维码。
4. Safari 会打开 ForgeAgent Web Console 并完成配对。
5. 可选：通过 **添加到主屏幕** 获得类似 App 的入口。

如果检测到 Tailscale，二维码会优先使用 Tailscale URL。否则会使用局域网 URL，并提示只能在当前网络内访问。

### Android

构建 Android APK：

```sh
npm run android:build
```

APK 路径：

```text
apps/android/ForgeAgentAndroid/app/build/outputs/apk/debug/app-debug.apk
```

Android 配对流程：

1. 在 Mac 打开 **Pair Mobile**。
2. 切换到 **Android**。
3. 在 ForgeAgent Android App 里扫码。
4. Android 会保存 Mac identity、LAN URLs、Tailscale URLs、自定义 remote URLs 和 device token。
5. 配对完成后，手机加载和桌面一致的 Web Console。

Android App 有前台连接服务，用于连接状态和业务通知。它不运行 Forge Core。

## Chrome 浏览器能力

ForgeAgent 通过 ForgeWebridge Chrome 扩展连接浏览器。Agent 使用的是你当前 Chrome profile 里的可见登录态页面。

打包并打开扩展目录：

```sh
npm run webridge:package
npm run webridge:open
```

Chrome 中：

1. 打开 `chrome://extensions`。
2. 开启 **Developer mode**。
3. 点击 **Load unpacked**。
4. 选择 ForgeWebridge 扩展目录。
5. 如果已经安装，点击 **Reload** 或 **Refresh connection**。

扩展会自动发现本机 ForgeAgent gateway 并保持 heartbeat。离线时，浏览器工具会把可读错误返回给 Agent，而不是一直卡住。

## MCP

ForgeAgent 是 MCP client。MCP 工具会进入同一套工具运行时、权限、沙盒、artifact 和 thread 机制。

常用命令：

```sh
npm run mcp -- list
npm run mcp -- add
npm run mcp -- status
npm run mcp -- doctor
```

真实端到端例子：

- [ForgeAgent + Blender MCP Quick Start](docs/blender-mcp-quickstart.md)

项目里的 `.mcp.json` 会被发现，但不会被盲目信任。启用前应确认 transport、command、URL、环境变量和鉴权需求。

如果某个 server 不在内置 catalog 中，可以从 **Extensions** 页面安装，也可以显式注册：

```sh
DATA_DIR="$HOME/Library/Application Support/ForgeAgent/data"

npm run mcp -- add \
  --data-dir "$DATA_DIR" \
  --name my-server \
  --transport stdio \
  --command npx \
  --args "-y,@example/mcp-server,arg1,arg2" \
  --env '{"EXAMPLE_API_KEY":"your-key"}' \
  --trust untrusted \
  --enabled
```

HTTP / SSE server：

```sh
npm run mcp -- add \
  --transport streamable-http \
  --url https://example.com/mcp \
  --headers '{"Authorization":"Bearer ..."}'
```

如果通过 CLI 修改 macOS App 的数据目录配置，记得重启 Forge Core。

## Extensions

ForgeAgent 有 local-first 扩展系统，用来管理 skills、MCP servers 和 bundles。macOS App / Web Console 里的 **Extensions** 页面包含：

- 随 App 发布的推荐 registry；
- 已安装扩展；
- setup required；
- warning / blocked 状态；
- registry sources；
- 安装、启用和 audit 事件。

也可以直接在对话里说：

```text
安装 filesystem MCP
安装这个 GitHub skill：https://github.com/owner/repo/tree/main/skills/my-skill
安装 code review workspace bundle，并用它检查当前项目
找一个适合分析 PDF 的扩展，安装后用在这个文件上
```

ForgeAgent 会把 GitHub skill 作为完整 package 安装。如果 `SKILL.md` 在一个目录中，`references/`、`scripts/`、`templates/`、`assets/`、`tests/` 等支持文件会一起安装，不会只下载一个裸 `SKILL.md`。

CLI 示例：

```sh
npm run extensions -- status
npm run extensions -- search filesystem
npm run extensions -- install-skill-github https://github.com/owner/repo/tree/main/skills/my-skill
npm run extensions -- install-bundle code-review-workspace
npm run extensions -- install-mcp-catalog modelcontextprotocol-filesystem
npm run extensions -- enable mcp_server filesystem
npm run extensions -- doctor
```

当前内置推荐：

- MCP：Filesystem、Everything、Memory、Sequential Thinking、GitHub、Brave Search、Puppeteer、Postgres、PDF、Map、Three.js、Blender。
- Skills：Serenity Invest、Code Reviewer、Frontend Design。
- Bundles：Code Review Workspace、Design Reference、Investor Research、PDF Research。

## DeepSeek Telemetry

ForgeAgent 对 DeepSeek 做了专门适配：

- `prompt_tokens`、`completion_tokens`、`total_tokens`；
- prefix cache hit/miss；
- reasoning tokens；
- 成本和 usage record；
- 真实 context-window 使用比例；
- provider usage 可用时，compaction 以真实 usage 为准。

compaction 后，ForgeAgent 会先显示本地估算的压缩后 context，占位到下一次模型调用返回真实 telemetry。

## 数据和安全模型

ForgeAgent 面向单用户、多个人设备。

- 源码运行数据目录：`.forge/`
- macOS App 数据目录：`~/Library/Application Support/ForgeAgent/data`
- API Key 保存在本机，状态和诊断接口只返回 masked key。
- 业务 HTTP API 需要 device token。
- Pairing code 短时有效且只能用一次。
- Workspace sandbox 限制在项目目录和 session scratch 空间内。
- 权限拒绝和沙盒拦截会作为可读 `tool_result` 返回给 Agent。
- Danger Free 是 session 级开关，会减少当前 session 的审批，但不能绕过硬沙盒边界。

ForgeAgent 不是 SaaS，也不应该直接暴露到公网。手机远程访问推荐 Tailscale、ZeroTier、可信私网或谨慎配置的 HTTPS 反向代理。

## 常用命令

```sh
npm run status
npm run doctor
npm run logs
npm run start
npm run stop
npm run forgeagent -- restart
npm run check
npm run native:build    # macOS App 打包/冒烟 + Android App 构建 + Android 连接单测
npm run coding:e2e      # 真实 provider 下的编码 agent 发布场景
npm run release:gate    # 完整发布门：check、native build、extensions e2e、release e2e
npm run release:bundle  # 在 .forge-release/dist 生成本地 beta 发布产物
```

发布准备请看 [docs/release-checklist.md](docs/release-checklist.md)。

## 常见问题

### Web Console 打不开

```sh
npm run status
npm run doctor
npm run logs
```

重启服务：

```sh
npm run forgeagent -- restart
```

### 手机连不上 Mac

检查：

- Mac 上 Forge Core 正常运行。
- 手机能访问界面显示的 LAN 或 Tailscale URL。
- 手机上用的不是 `127.0.0.1`。
- 离开家时，Mac 和手机的 Tailscale / ZeroTier 都在线。
- Mac 没有真正睡眠。屏幕熄灭可以，系统睡眠不行。
- macOS 防火墙或网络隔离没有阻止 3000 端口。

### Agent 不能访问文件

检查当前项目。文件工具会围绕项目文件夹做 sandbox。把文件移动到项目内，或为目标文件夹创建一个项目。

## 文档

- [开发指南](docs/development.md)
- [架构规范](docs/forge_agent_v_2_architecture_spec.md)
- [原生 App](docs/native-apps.md)
- [Blender MCP Quick Start](docs/blender-mcp-quickstart.md)

## 许可证

ForgeAgent 使用 [MIT License](LICENSE) 发布，欢迎 fork、修改、私有使用和商业使用。如果你基于 ForgeAgent 构建产品或公开展示相关成果，欢迎注明 ForgeAgent。

## 项目状态

ForgeAgent 目前是早期 local-first 产品。它已经能用于真实本地工作流，但表面积很大：macOS App、Web Console、Android App、Chrome 扩展、MCP、skills、浏览器自动化、memory 和 runtime recovery 都在快速变化。

欢迎提交 issue、bug report 和真实工作流反馈。
