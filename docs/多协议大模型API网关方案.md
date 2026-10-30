# 多协议大模型 API 转换网关方案

## 一、方案背景与解决的核心诉求

在多环境开发中，开发者常常希望：
> **在本地电脑上使用官方的 Claude Code CLI（`claude`），但请求能指向自己的私有服务器，通过服务器中转使用 Google Gemini、DeepSeek 或其他模型。**

本地 Claude Code 依赖设置环境变量：
```bash
export ANTHROPIC_BASE_URL="http://japan.bleem.site:3001"
export ANTHROPIC_API_KEY="your-key"
```
此时，客户端会严格按照 Anthropic 的标准规范向服务器发送 `POST /v1/messages` 请求。

为了满足这一需求，本项目提出了**在当前 CloudCLI 内部直接扩展多协议 API 转换网关（Multi-Protocol API Gateway）**的方案。

---

## 二、系统总体拓扑

网关直接集成在 CloudCLI 的 Express 服务端（共用 `3001` 端口，无需额外开放防火墙端口）：

```
[外部客户端]
 ├── 本地 Claude Code CLI    ──>  POST /v1/messages (Anthropic 规范)
 ├── Cursor / NextChat / IDE ──>  POST /v1/chat/completions (OpenAI 规范)
 └── Google SDK 客户端       ──>  POST /v1beta/models/... (Gemini 规范)
               │
               ▼
[CloudCLI 统一 API 网关 (端口 3001)]
 ├── 统一鉴权模块 (直接复用 CloudCLI 的 ck_... API Key)
 └── 双向协议适配转换引擎 (Protocol Converter)
               │
               ▼
[底层模型执行目标]
 ├── 路径 A：直连 Google Gemini API (稳定、极速流式)
 └── 路径 B：调用服务器本地已集成的 agy 进程执行
```

---

## 三、三方标准协议的转换逻辑

### 1. Anthropic 协议层 (`/v1/messages`)
- **适用场景**：专门对接本地电脑的 Claude Code CLI。
- **输入转换**：
  - 将 Anthropic 的 `messages`（包含 `system`、`user`、`assistant` 以及 `tool_use` / `tool_result` 内容块）映射为目标模型（如 Gemini 或 OpenAI）的格式。
  - 将 Anthropic 的 `tools` 模式映射为标准的 Function Calling 描述。
- **输出流式转换（SSE）**：
  - 监听底层大模型的流式块，按照 Anthropic SSE 格式实时构造事件帧：
    - `event: message_start`
    - `event: content_block_start`
    - `event: content_block_delta`（包含文本增量或思考链增量 `thinking_delta`）
    - `event: message_delta`
    - `event: message_stop`

### 2. OpenAI 协议层 (`/v1/chat/completions` 与 `/v1/models`)
- **适用场景**：对接 Cursor、VSCode Continue、Cherry Studio、NextChat 等主流客户端。
- **格式映射**：标准 OpenAI JSON 请求与 `data: { choices: [...] }` 流式输出。
- **模型列表**：`/v1/models` 暴露当前平台可供使用的所有模型 ID。

### 3. Google Gemini 协议层 (`/v1beta/models/...`)
- **适用场景**：对接使用 Google Generative AI SDK 的应用。

---

## 四、底层对接的两种实现方式比对

| 维度 | 选项 A：直连 Google Gemini API | 选项 B：桥接本地 agy 进程引擎 |
| :--- | :--- | :--- |
| **工作原理** | 网关持有 Gemini API Key，直接向 Google 发起 REST 请求 | 网关通过子进程运行 `agy -p ... --output-format stream-json` |
| **首字延迟 (TTFT)** | **极低**（直接云端接口交互） | 稍高（有子进程启动与 CLI 初始化开销） |
| **流式稳定性** | **极高**（官方原生流式响应） | 依赖 CLI 的 NDJSON 管道传输 |
| **依赖凭证** | 需要配置一个 Google AI Studio API Key | **零配置**，直接复用服务器本地已登录的 Antigravity 环境 |
| **适用场景** | 推荐主力方案，体验与官方 API 无异 | 作为免配置备用方案 |

---

## 五、使用指引（以本地 Claude Code 为例）

1. 在 CloudCLI 界面进入 **Settings -> API & Tokens**，创建并获取您的 API Key（如 `ck_xxxxxxxx`）。
2. 在您的本地电脑终端配置：
   ```bash
   # 指向当前云服务器网关
   export ANTHROPIC_BASE_URL="http://japan.bleem.site:3001"
   export ANTHROPIC_API_KEY="ck_xxxxxxxx"

   # 启动 Claude Code
   claude
   ```
3. 本地终端的所有提问、代码修改、工具调用均会自动经由该网关转发至指定的底层模型执行并实时回传。
