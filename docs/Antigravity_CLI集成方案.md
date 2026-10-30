# Antigravity (agy) CLI 原生集成方案

## 一、方案背景与目标

CloudCLI 原生支持 Claude Code、Cursor CLI、Codex 和 OpenCode。为了在 CloudCLI 中统一支持 Google DeepMind 研发的 **Antigravity (`agy`) CLI** 编程智能体，本方案遵循 CloudCLI 官方的 **Provider Contract** 架构规范，将 `agy` 作为一等公民（First-Class Provider）接入系统。

通过本集成，用户可在 Web 界面、移动端 PWA 或桌面客户端中，无缝使用 `agy` 及其底层的 Gemini、Claude 等大模型进行对话、执行编程任务、查看思考链（Thinking Process）以及管理本地会话。

---

## 二、架构设计与 7-Facet Provider 契约实现

根据 CloudCLI 的模块化架构规范，所有 Provider 均需在 `server/modules/providers/list/<provider>/` 目录下实现 7 个核心抽象 Facet：

```
server/modules/providers/list/agy/
├── agy.provider.ts                # 主包装类，聚合所有 Facet
├── agy-runtime.provider.js        # 运行时执行器（进程调用与流式转发）
├── agy-models.provider.ts         # 模型目录管理
├── agy-auth.provider.ts           # CLI 探活与认证状态
├── agy-sessions.provider.ts       # 会话历史标准化解析
├── agy-session-synchronizer.ts    # 本地 Brain 会话自动同步
├── agy-skills.provider.ts         # 技能发现与管理
└── agy-mcp.provider.ts            # MCP 工具服务器管理
```

### 1. 运行时与流式通信 (`agy-runtime.provider.js`)
- **执行方式**：基于 `cross-spawn` 启动本地 `agy` 进程。
- **协议对接**：使用 `agy -p "<prompt>" --output-format stream-json` 获取行内 NDJSON 事件流。
- **事件映射**：
  - `init` 事件：捕获 `conversation_id`，触发前端 `session_created`。
  - `step_update.thinking_delta`：映射为前端可折叠展示的 `thinking` 思考块。
  - `step_update.text_delta`：映射为实时的打字机文本流 `stream_delta`。
  - `result` 事件：解析任务最终状态，组装 `createCompleteMessage` 终态事件。
- **参数动态传递**：
  - 会话恢复：`--conversation <id>`
  - 模型切换：`--model <model>`
  - 思考强度：`--effort <low|medium|high|xhigh|max>`
  - 权限审批：`--dangerously-skip-permissions`（免审批模式）或 `--mode plan`（计划模式）
- **进程保活与中断**：维护 `activeAgyProcesses` 字典，支持前端点击中止按钮时触发 `SIGTERM` 优雅终止进程。

### 2. 模型目录 (`agy-models.provider.ts`)
预置并支持动态获取 Antigravity 体系内模型：
- `gemini-3.8-flash-high`（默认，兼具极致性能与高阶思考推理）
- `gemini-3.8-flash-medium`
- `gemini-3.8-flash-low`
- `claude-sonnet-4-6` (Thinking)
- `claude-opus-4-6-thinking`
- `gpt-oss-120b-medium`

### 3. 会话解析与自动索引 (`agy-sessions.provider.ts` & `agy-session-synchronizer.provider.ts`)
- **存储路径**：对接 `~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`。
- **会话发现**：监听 `brain` 根目录变动，自动扫描新生成的 transcript 文件，解析第一条 `<USER_REQUEST>` 提取会话标题。
- **数据落库**：将发现的会话元数据（ID、创建时间、更新时间、标题、路径）实时入库至 CloudCLI 的 SQLite（`sessionsDb`），实现与原生 CLI 会话的双向无缝同步。

---

## 三、前端适配与呈现

1. **Antigravity 专属品牌呈现**：
   - 设计并新增矢量图标组件 `src/shared/ui/AgyLogo.tsx`（采用 DeepMind 风格的渐变色）。
   - 在 `LLMProviderLogo.tsx` 中绑定 `'agy'` 标识。
2. **选择器与空状态面板**：
   - 在新建对话界面的 `ProviderSelectionEmptyState` 中加入 Antigravity 选项。
   - 配置专属预置提示词及对应状态栏。
3. **设置与控制中心**：
   - 在 `AgentsSettingsTab` 与 `AgentSelectorSection` 中加入 Antigravity 的状态指示与配色。

---

## 四、验证与运行效果

- **全量类型安全**：服务端与客户端的 TypeScript 类型检查均已全部通过（0 Errors）。
- **生产构建验证**：前端 Vite 与服务端 tsc 打包全部成功完成。
- **自动会话同步**：服务启动后首次扫描，已自动发现并成功导入系统中已有的 7 个 Antigravity 本地会话。
