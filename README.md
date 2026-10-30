<div align="center">
  <img src="public/logo.svg" alt="Cloud-Agent" width="64" height="64">
  <h1>Cloud-Agent</h1>
  <p><strong>Next-Generation AI Agent Web & Mobile IDE and Multi-Protocol LLM API Gateway</strong><br>
  Seamlessly bridges <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>, <a href="https://docs.cursor.com/en/cli/overview">Cursor CLI</a>, <a href="https://developers.openai.com/codex">Codex</a>, and Google Antigravity (<code>agy</code>).<br>
  Use it locally or remotely to manage active projects, persistent sessions, and unify multi-model API access.</p>
</div>

<p align="center">
  <a href="https://github.com/solshevik/cloud-agent">GitHub Repository</a> · 
  <a href="./docs/LiteLLM式多协议大模型网关设计与落地方案.md">网关设计方案</a> · 
  <a href="./docs/API网关与本地agy适配优化深度方案.md">agy 适配与会话深度方案</a> · 
  <a href="https://github.com/solshevik/cloud-agent/issues">Bug Reports</a>
</p>

<p align="center">
  <a href="https://github.com/solshevik/cloud-agent"><img src="https://img.shields.io/badge/GitHub-Cloud--Agent-0066FF?style=for-the-badge&logo=github&logoColor=white" alt="Cloud-Agent GitHub"></a>
  <a href="https://github.com/solshevik/cloud-agent/releases"><img src="https://img.shields.io/badge/Release-v1.37.6-brightgreen?style=for-the-badge" alt="Release v1.37.6"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-orange?style=for-the-badge" alt="AGPL-3.0 License"></a>
</p>

<div align="right"><i><b>English</b> · <a href="./docs/README.zh-CN.md">简体中文</a> · <a href="./docs/README.ru.md">Русский</a> · <a href="./docs/README.de.md">Deutsch</a> · <a href="./docs/README.ko.md">한국어</a> · <a href="./docs/README.ja.md">日本語</a></i></div>

---

## 🌟 Highlights & New Architecture

**Cloud-Agent** combines a modern, responsive web/mobile AI agent IDE with an enterprise-grade, **LiteLLM-style Multi-Protocol API Gateway**.

```
┌────────────────────────────────────────────────────────────────────────┐
│                   External Clients & Developer Tools                   │
│   Claude Code CLI  │  Cursor IDE  │  OpenAI SDK  │  Web / Mobile UI    │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ HTTP / SSE / WebSocket
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│               Cloud-Agent Multi-Protocol Gateway (:3001)               │
│                                                                        │
│  • Protocol Ingress:                                                   │
│    - POST /v1/messages              (Anthropic Messages API)           │
│    - POST /v1/chat/completions      (OpenAI Chat Completions API)      │
│    - POST /v1beta/models/*          (Google Gemini API)                │
│    - GET  /v1/models                (Unified Model Registry)           │
│                                                                        │
│  • Adapters & Sanitizers:                                              │
│    - Function Calling Mapper        (Anthropic ↔ OpenAI ↔ Gemini)      │
│    - Strict Schema Sanitizer        (Strips $schema, draft-07 errors)  │
│    - Vendor Identity Scrubber       (Cleans brand confusion)           │
│    - Environmental Metadata Cleaner (Strips time/timezone/location/OS) │
│    - Client Harness Sanitizer       (Strips <guidelines>, <tools> etc) │
│    - Session Continuity Manager     (conversation_id state machine)    │
│    - Non-hanging Stream Controller  (finally { res.end(); })           │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ Intelligent Routing
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
│ Google Gemini   │        │ OpenAI/DeepSeek │        │ Antigravity CLI │
│ REST API        │        │ Compatible APIs │        │ (agy Engine)    │
│ (2.5-pro/flash) │        │ (chat/gpt-4o)   │        │ (local agent)   │
└─────────────────┘        └─────────────────┘        └─────────────────┘
```

---

## 🚀 Key Features

### 1. LiteLLM-Style Multi-Protocol Gateway
- **Multi-Protocol Translation**: Ingest Anthropic `/v1/messages`, OpenAI `/v1/chat/completions`, or Gemini `/v1beta/models/*` and route to any target model.
- **Autonomous Provider Routing**: Explicit prefixes (e.g. `agy/gemini-3.8-flash-low`, `gemini/gemini-2.5-pro`, `deepseek/deepseek-chat`) or smart fallback based on configured keys and engines.
- **Native Local `agy` CLI Integration**: Bridge HTTP requests to local Google Antigravity (`agy`) CLI with zero latency overhead.
- **Bidirectional Tool Calling**: Full support for tool/function definitions, tool arguments, and tool results mapped seamlessly across Anthropic, OpenAI, and Gemini formats.
- **Prompt & Privacy Scrubbing**: Automatically removes vendor identity conflicts (Claude vs OpenAI vs Gemini), irrelevant client environment noise (timestamps, timezones like `Asia/Tokyo`, physical locations, OS versions), and foreign client harness tags.
- **Session Continuity Manager**: Maintains multi-turn state across HTTP requests by caching `conversation_id`, reducing incremental prompt tokens by **80%+**, and verified for **10+ consecutive turns** of seamless context memory.
- **Zero-Downtime Non-Hanging Streaming**: Guaranteed HTTP pipe closing on event stream completion without client timeouts.

### 2. Full-Featured Web & Mobile Agent IDE
- **Responsive Web & Mobile Experience**: Full touch-friendly navigation across desktop, iPad, and mobile browsers.
- **Interactive Chat Interface**: Live markdown rendering, syntax highlighting, diff visualization, and streaming outputs.
- **Integrated Shell Terminal**: Built-in xterm.js terminal with multi-tab support for running commands alongside agents.
- **File Explorer & Git Tree**: Live file browser, code editing with CodeMirror, and Git branch/staging/commit control.
- **Session Watcher & Multi-Agent History**: Automatically synchronizes and discovers sessions from Claude Code, Cursor, Codex, and Antigravity.
- **Extensible Plugin Ecosystem**: Custom tabs, telemetry, and background services.

---

## 🛠️ Quick Start

### 1. Installation & Local Startup

Prerequisites: **Node.js v22+**

```bash
# Clone the repository
git clone https://github.com/solshevik/cloud-agent.git
cd cloud-agent

# Install dependencies and build
npm install
npm run build

# Start the server (runs on port 3001 by default)
npm run server
```

Open `http://localhost:3001` in your browser. All existing local agent sessions are automatically discovered.

### 2. Connecting Claude Code CLI to Cloud-Agent Gateway

Cloud-Agent provides a seamless wrapper and environment bridge for Claude Code.

```bash
# Point Claude Code to Cloud-Agent Gateway
export ANTHROPIC_BASE_URL="http://127.0.0.1:3001"
export ANTHROPIC_API_KEY="your-gateway-api-key"

# Run Claude Code non-interactively or interactively
claude -p "Explain how a binary search tree works"

# Continue conversation with full multi-turn context
claude -c -p "Now provide the TypeScript implementation"
```

### 3. Calling the Multi-Protocol Gateway via cURL / SDKs

#### Anthropic Compatible Endpoint (`POST /v1/messages`)
```bash
curl -N -X POST http://127.0.0.1:3001/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-gateway-api-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "agy/gemini-3.8-flash-low",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Write a quicksort algorithm in Rust." }
    ]
  }'
```

#### OpenAI Compatible Endpoint (`POST /v1/chat/completions`)
```bash
curl -N -X POST http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-api-key" \
  -d '{
    "model": "gemini-2.5-pro",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Hello! What can you do?" }
    ]
  }'
```

---

## 📊 Model Mapping & Routing Matrix

| Requested Model Prefix | Target Backend | Model Resolved | Capabilities |
| :--- | :--- | :--- | :--- |
| `agy/gemini-3.8-flash-low` | Antigravity CLI Engine | `gemini-3.8-flash-low` | Streaming, Tool Calling, Ultra-Low Latency |
| `agy/gemini-3.8-flash-high` | Antigravity CLI Engine | `gemini-3.8-flash-high` | Deep Reasoning, Complex Code Analysis |
| `agy/claude-sonnet-4-6` | Antigravity CLI Engine | `claude-sonnet-4-6` | Extended Thinking, Coding Benchmarks |
| `gemini/gemini-2.5-pro` | Google Gemini REST | `gemini-2.5-pro` | Native Tool Use, Multi-Modal, 2M Context |
| `gemini/gemini-2.5-flash` | Google Gemini REST | `gemini-2.5-flash` | High Throughput, Real-Time Streaming |
| `deepseek/deepseek-chat` | OpenAI / DeepSeek | `deepseek-chat` | Cost Efficiency, Strong Coding Reasoner |
| `claude-3-7-sonnet-20250219` | Anthropic / Agy Fallback | Auto-resolved | Hybrid Fallback & Self-Healing |

---

## 📚 Deliverable & Design Documents

Comprehensive architectural and engineering design documents are available in `docs/`:

1. [LiteLLM式多协议大模型网关设计与落地方案.md](./docs/LiteLLM式多协议大模型网关设计与落地方案.md)
   - Core gateway architecture, intermediate representation (`UnifiedChatRequest`/`UnifiedChunk`), and multi-provider protocol mapping.
2. [网关实操问题排查与优化解决方案.md](./docs/网关实操问题排查与优化解决方案.md)
   - Detailed troubleshooting of Function Calling schemas, vendor branding confusions, and end-to-end latency breakdowns.
3. [API网关与本地agy适配优化深度方案.md](./docs/API网关与本地agy适配优化深度方案.md)
   - agy CLI parameter equilibrium, environmental noise scrubbing, SSE hanging termination fix, 1-token output resolution, and verified **10-turn continuous context** benchmark.

---

## 🛡️ Security & Privacy

- **Local First**: Runs on your host machine or private VPC. No telemetry or conversations are leaked to third-party tracking services.
- **Strict Permission Handling**: Integrates with client approval models (`--dangerously-skip-permissions` can be toggled per deployment).
- **Prompt Privacy**: External metadata (such as client IP, local OS version, current working directory, and local timezone) are scrubbed before reaching model backends.

---

## 🤝 Community & Contributing

- **Repository**: [https://github.com/solshevik/cloud-agent](https://github.com/solshevik/cloud-agent)
- **Issues & Discussions**: [https://github.com/solshevik/cloud-agent/issues](https://github.com/solshevik/cloud-agent/issues)
- **License**: GNU Affero General Public License v3.0 or later ([AGPL-3.0-or-later](LICENSE))

<div align="center">
  <sub>Built with care for the AI Agent community. Designed for Claude Code, Cursor, Codex, and Antigravity.</sub>
</div>
