<div align="center">
  <img src="../public/logo.svg" alt="Cloud-Agent" width="64" height="64">
  <h1>Cloud-Agent</h1>
  <p><strong>新一代 AI 智能体 Web/移动端 IDE 与 LiteLLM 式多协议大模型 API 网关</strong><br>
  无缝桥接 <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>、<a href="https://docs.cursor.com/en/cli/overview">Cursor CLI</a>、<a href="https://developers.openai.com/codex">Codex</a> 与 Google Antigravity (<code>agy</code>)。<br>
  可在本地或远程使用，随时随地管理活跃项目、持久化会话并统一多协议大模型路由调度。</p>
</div>

<p align="center">
  <a href="https://github.com/solshevik/cloud-agent">GitHub 仓库</a> · 
  <a href="./LiteLLM式多协议大模型网关设计与落地方案.md">网关设计方案</a> · 
  <a href="./API网关与本地agy适配优化深度方案.md">agy 适配与会话深度方案</a> · 
  <a href="https://github.com/solshevik/cloud-agent/issues">问题反馈</a>
</p>

<p align="center">
  <a href="https://github.com/solshevik/cloud-agent"><img src="https://img.shields.io/badge/GitHub-Cloud--Agent-0066FF?style=for-the-badge&logo=github&logoColor=white" alt="Cloud-Agent GitHub"></a>
  <a href="https://github.com/solshevik/cloud-agent/releases"><img src="https://img.shields.io/badge/Release-v1.37.6-brightgreen?style=for-the-badge" alt="Release v1.37.6"></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-orange?style=for-the-badge" alt="AGPL-3.0 License"></a>
</p>

<div align="right"><i><a href="../README.md">English</a> · <b>简体中文</b> · <a href="./README.ru.md">Русский</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.ja.md">日本語</a></i></div>

---

## 🌟 核心特性与架构升级

**Cloud-Agent** 将全功能响应式 Web/移动端 AI 智能体 IDE 与企业级 **LiteLLM 式多协议 API 网关**完美融为一体。

```
┌────────────────────────────────────────────────────────────────────────┐
│                   外部客户端与开发者工具体系                           │
│   Claude Code CLI  │  Cursor IDE  │  OpenAI SDK  │  Web / 移动端 UI    │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ HTTP / SSE / WebSocket
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│               Cloud-Agent 多协议大模型网关 (:3001)                     │
│                                                                        │
│  • 统一协议入口:                                                       │
│    - POST /v1/messages              (Anthropic Messages API 兼容)      │
│    - POST /v1/chat/completions      (OpenAI Chat Completions API 兼容) │
│    - POST /v1beta/models/*          (Google Gemini API 兼容)           │
│    - GET  /v1/models                (统一模型清单注册表)               │
│                                                                        │
│  • 智能适配与治理层:                                                   │
│    - 函数调用转换器                 (Anthropic ↔ OpenAI ↔ Gemini)      │
│    - 严格 Schema 清洗器             (剥离 $schema、draft-07 冲突定义)  │
│    - 厂商身份净化器                 (洗净 Claude/OpenAI/Gemini 混淆)   │
│    - 环境噪声过滤器                 (过滤时间/时区/地理位置/OS 元数据) │
│    - 客户端脚手架过滤               (剥离 <guidelines>, <tools> 标签)  │
│    - 会话持续状态机                 (conversation_id 状态树复用)       │
│    - 防挂起流式生命周期             (finally { res.end(); } 立即终止)  │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ 智能自愈路由
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
│ Google Gemini   │        │ OpenAI/DeepSeek │        │ 本地 Antigravity│
│ 原生 REST API   │        │ 兼容大模型 API  │        │ (agy CLI 引擎)  │
│ (2.5-pro/flash) │        │ (chat/gpt-4o)   │        │ (免 Key 本地运行)│
└─────────────────┘        └─────────────────┘        └─────────────────┘
```

---

## 🚀 主要功能特色

### 1. LiteLLM 式多协议大模型网关
- **多协议全双工转换**：支持 Anthropic `/v1/messages`、OpenAI `/v1/chat/completions` 与 Gemini `/v1beta/models/*` 协议输入，可自动转换为任意目标模型协议并回传对应标准格式。
- **智能提供商路由**：支持显式前缀（如 `agy/gemini-3.8-flash-low`、`gemini/gemini-2.5-pro`、`deepseek/deepseek-chat`）及基于可用 API Key 与本地引擎的自愈回退机制。
- **本地 `agy` 引擎无缝桥接**：在无外部公网 API Key 时，自动调度本地登录的 Antigravity CLI 引擎，零配置即享强大的代码智能能力。
- **双向 Function Calling 映射**：跨协议精准转换工具定义（Tool Definition）、工具入参（Tool Calls）及执行结果（Tool Results）。
- **提示词与隐私深度清洗**：自动剔除竞品身份标识，过滤客户端时间、时区（如 `Asia/Tokyo`）、物理地理位置、操作系统版本与私有脚手架标签，100% 完整保留用户正文代码。
- **会话持续状态机（Session Continuity Manager）**：在网关层维护会话树映射，多轮对话输入 Token 削减 **80% 以上**，实测完美支持 **连续 10 轮以上** 的深度上下文记忆推演。
- **防挂起平滑流式传输**：彻底解决流式输出完毕时光标挂起等待超时的缺陷，事件流一结束即刻关闭管道。

### 2. 全功能 Web / 移动端 AI 智能体 IDE
- **响应式跨端体验**：专为移动端与平板触摸优化的触控界面，随时随地在手机上使用智能体。
- **交互式聊天界面**：支持实时 Markdown 流式渲染、代码语法高亮与 Diff 变更审查。
- **内置 Web Shell 终端**：多标签页 xterm.js 终端，无需离开浏览器即可执行系统命令。
- **文件与 Git 资源管理器**：集成本地文件树浏览、CodeMirror 实时代码编辑及 Git 分支/暂存/提交全套控制。
- **多智能体历史自动同步**：自动发现并集中管理 Claude Code、Cursor、Codex 与 Antigravity 的历史会话。
- **插件系统扩展**：支持自定义功能选项卡、遥测监控与后台自动化任务。

---

## 🛠️ 快速上手

### 1. 本地安装与启动

运行环境要求：**Node.js v22+**

```bash
# 克隆代码仓库
git clone https://github.com/solshevik/cloud-agent.git
cd cloud-agent

# 安装依赖并构建
npm install
npm run build

# 启动服务（默认监听 3001 端口）
npm run server
```

在浏览器打开 `http://localhost:3001`，所有本地会话将自动同步并展示。

### 2. 将本地 Claude Code CLI 对接到网关

Cloud-Agent 提供了全局包装器与环境集成，配置后日常直接运行 `claude` 即可无感享用网关路由：

```bash
# 配置环境变量指向网关
export ANTHROPIC_BASE_URL="http://127.0.0.1:3001"
export ANTHROPIC_API_KEY="your-gateway-api-key"

# 启动 Claude Code 执行单轮提问
claude -p "请用 Rust 实现一个经典的二叉搜索树"

# 继续会话（全上下文连续推演）
claude -c -p "现在为它编写单元测试"
```

### 3. 使用 cURL / SDK 调用网关

#### 调用 Anthropic 兼容端点 (`POST /v1/messages`)
```bash
curl -N -X POST http://127.0.0.1:3001/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-gateway-api-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "agy/gemini-3.8-flash-low",
    "stream": true,
    "messages": [
      { "role": "user", "content": "用 Python 写一个快速排序算法" }
    ]
  }'
```

#### 调用 OpenAI 兼容端点 (`POST /v1/chat/completions`)
```bash
curl -N -X POST http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-api-key" \
  -d '{
    "model": "gemini-2.5-pro",
    "stream": true,
    "messages": [
      { "role": "user", "content": "你好，请介绍一下你的核心能力" }
    ]
  }'
```

---

## 📊 模型路由映射表

| 请求模型前缀 | 实际调用后端 | 映射目标模型 | 特性与优势 |
| :--- | :--- | :--- | :--- |
| `agy/gemini-3.8-flash-low` | Antigravity 本地引擎 | `gemini-3.8-flash-low` | 流式极速出字、免 API Key、超低首字延迟 |
| `agy/gemini-3.8-flash-high` | Antigravity 本地引擎 | `gemini-3.8-flash-high` | 深度推理强化、复杂代码逻辑推导 |
| `agy/claude-sonnet-4-6` | Antigravity 本地引擎 | `claude-sonnet-4-6` | 原生 Thinking 能力、高质量编程水准 |
| `gemini/gemini-2.5-pro` | Google Gemini REST | `gemini-2.5-pro` | 原生工具调用、多模态、200 万超大上下文 |
| `gemini/gemini-2.5-flash` | Google Gemini REST | `gemini-2.5-flash` | 高并发吞吐、低成本实时推理 |
| `deepseek/deepseek-chat` | OpenAI / DeepSeek | `deepseek-chat` | 极致性价比、优秀的中文与代码推理 |
| `claude-3-7-sonnet-20250219` | Anthropic / Agy 降级 | 智能解析路由 | 混合降级与自动容灾自愈 |

---

## 📚 详细设计与交付方案文档

完整的技术设计与实操排查文档位于 `docs/` 目录下：

1. [LiteLLM式多协议大模型网关设计与落地方案.md](./LiteLLM式多协议大模型网关设计与落地方案.md)
   - 网关分层架构设计、统一中间数据结构（UnifiedChatRequest）与多协议转换引擎。
2. [网关实操问题排查与优化解决方案.md](./网关实操问题排查与优化解决方案.md)
   - 厂商标识过滤、Function Calling Schema 清洗及端到端耗时归因分析。
3. [API网关与本地agy适配优化深度方案.md](./API网关与本地agy适配优化深度方案.md)
   - agy 核心参数平衡点、环境元数据清洗、SSE 流式挂起修复、“1 Token 无内容”深度排查及**连续 10 轮上下文对话实测记录**。

---

## 🤝 社区与贡献

- **代码仓库**：[https://github.com/solshevik/cloud-agent](https://github.com/solshevik/cloud-agent)
- **问题反馈**：[https://github.com/solshevik/cloud-agent/issues](https://github.com/solshevik/cloud-agent/issues)
- **开源协议**：GNU Affero General Public License v3.0 or later ([AGPL-3.0-or-later](../LICENSE))

<div align="center">
  <sub>精心为 AI 智能体社区打造。全力支持 Claude Code、Cursor、Codex 与 Antigravity。</sub>
</div>
