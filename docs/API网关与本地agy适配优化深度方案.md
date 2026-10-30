# API 网关与本地 agy CLI 桥接适配优化深度方案

## 一、方案背景与目标

在 CloudCLI 多协议 API 网关的实际运行中，外部客户端（如 Claude Code CLI、Cursor、OpenAI SDK 等）通过标准协议与网关交互，而网关在无公网 API Key 时将底层请求桥接调度给本地已登录的 Antigravity `agy` CLI 引擎。

为了彻底解决实际使用中暴露的**参数失衡、系统提示词环境噪声、流式响应挂起不结束、会话不连续断裂**四大痛点，本文档展开深度根因分析，并制定完整系统的最佳实践与落地技术方案。

---

## 二、问题深度剖析与最佳解决方案

### 1. agy CLI 请求参数结构深度解析与网关平衡点

#### 1.1 agy CLI 核心参数能力剖析
通过深入分析 `agy` 的运行参数体系，其关键能力分为四大维度：

| 参数 | 核心作用 | 对 API 网关的价值与意义 |
| :--- | :--- | :--- |
| **`--conversation <id>`** | 恢复/继续指定 ID 的既有会话 | **解决会话断裂的核心关键**。允许网关将多轮 HTTP 请求挂接到同一个持久化会话树上。 |
| **`-c, --continue`** | 继续最近一次会话 | 单会话场景下免 ID 恢复。 |
| **`--input-format stream-json`** | 从 stdin 读取 NDJSON 消息并逐轮执行 | 支持长生命周期的管道化交互，避免频繁子进程冷启动。 |
| **`--output-format stream-json`** | 以结构化 NDJSON 逐行流式输出事件帧 | 网关解析 `step_update`、`text_delta` 与 `usage` 的事件基础。 |
| **`--effort <level>`** | 调整思考强度 (`low/medium/high/xhigh/max`) | 可直接映射 Anthropic/OpenAI 的 Extended Thinking 预算。 |
| **`--disable-slash-commands`** | 禁用 CLI 内部斜杠指令与 Skill 展开 | **关键防护**：防止用户输入中包含 `/` 时触发 CLI 内置命令导致执行异常。 |
| **`--settings <json>`** | 覆盖当前会话配置（内存级，不落盘） | 允许网关动态控制是否屏蔽重量级工具，降低上下文膨胀。 |
| **`--dangerously-skip-permissions`** | 自动放行所有工具执行权限 | API 网关非交互式调用的核心前提。 |

#### 1.2 HTTP API 与本地 CLI 的架构张力分析
- **客户端期望**：无状态（Stateless）、轻量、低延迟、仅关注当前轮生成。
- **本地 agy 期望**：全智能体（Agentic）、工作区绑定、自动加载 50+ 个 MCP 工具与环境感知。
- **失衡现象**：若网关简单粗暴地将客户端每一次 HTTP 请求作为全新的 `agy -p` 执行，会导致每次冷启动加载全量工具与环境，单次请求输入上下文高达 **7200+ tokens**，首字延迟超过 **5~8 秒**。

#### 1.3 黄金平衡点设计方案
网关与 `agy` 的桥接应当实现**“三项裁剪、一项复用”**：
1. **指令降噪**：固定携带 `--disable-slash-commands`，杜绝文本指令误触发。
2. **思考强度自适应**：根据请求中的 `thinking.budget_tokens` 动态映射 `--effort`：
   - 预算 $\le 1024$ $\rightarrow$ `--effort low`
   - 预算 $1025 \sim 4096$ $\rightarrow$ `--effort medium`
   - 预算 $> 4096$ $\rightarrow$ `--effort high`
   - 无思考要求 $\rightarrow$ `--effort low`（最小化首字延迟）
3. **上下文复用**：利用 `--conversation <id>` 会话复用机制，后续轮次仅需传递增量提问，不再全量回传历史，大幅降低上下文膨胀。

---

### 2. 系统提示词环境元数据清洗（位置、时区、系统信息过滤）

#### 2.1 现象分析与泄露风险
Claude Code CLI 等现代智能体客户端在组织 `system` 提示词时，会默认采集客户端本机的环境元数据并强行拼接在 Prompt 开头，例如：
```text
The user's current time is: 2026-10-30T14:57:17Z.
The user's location is: Tokyo, Japan.
User's timezone: Asia/Tokyo.
Operating System: Linux x86_64.
Today's date is: 2026-10-30.
Current working directory: /home/yubs/project.
```
当用户向网关提问纯代码问题（如“写一个快速排序算法”）时，这些无关的环境变量：
1. **污染模型注意力**：大模型往往会过度关注时间、地点，甚至在回答开头寒暄：“在东京这个美丽的下午……”。
2. **浪费 Token 资源**：冗长的环境注入持续消耗上下文预算。
3. **隐私信息外泄**：向外部中转暴露了本地电脑的精确物理位置与系统路径。

#### 2.2 解决方案与清洗规则
在 [`prompt.scrubber.ts`](file:///home/yubs/claudecodeui/server/modules/gateway/adapters/prompt.scrubber.ts) 中增加**环境元数据清洗过滤器**（Metadata Cleaner）。

##### 过滤模式集：
```typescript
const METADATA_PATTERNS = [
  // 1. 时间与日期模式
  /(?:The\s+)?(?:user's\s+)?(?:current\s+)?(?:time\s+is|local\s+time\s+is|today's\s+date\s+is)[\s:][^\n,.]+[.,\n]?/gi,
  
  // 2. 时区模式
  /(?:The\s+)?(?:user's\s+)?(?:current\s+)?(?:time\s*zone|timezone)[\s:][^\n,.]+[.,\n]?/gi,
  
  // 3. 地理位置模式
  /(?:The\s+)?(?:user's\s+)?(?:geographic\s+)?(?:location\s+is|current\s+location\s+is)[\s:][^\n,.]+[.,\n]?/gi,
  
  // 4. 操作系统与环境说明
  /(?:Operating\s+System|OS\s+version|Current\s+OS)[\s:][^\n,.]+[.,\n]?/gi,
];
```

##### 边界保护设计：
- **仅作用于 `system` 提示词**，绝不扫描和过滤 `user` 发送的正文代码或用户的主动提问（例如用户显式询问“在 Python 中如何获取当前时区？”时，正则表达式不会误伤用户代码）。

---

### 3. SSE 响应挂起与长连接超时（输出结束却持续等待）

#### 3.1 现象诊断
在使用 `curl` 或 Claude Code CLI 发起流式请求时：
- 终端能够快速看到大模型输出完毕。
- 但在输出最后一个字符后，终端光标一直处于等待状态，卡顿 **60 秒 ~ 120 秒** 直到触发客户端 Socket 超时后才被迫中断。

#### 3.2 源码级根本原因追踪
在 [`server/modules/gateway/gateway.routes.ts`](file:///home/yubs/claudecodeui/server/modules/gateway/gateway.routes.ts) 中：

```typescript
// 错误代码示例
if (unifiedRequest.stream) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Connection', 'keep-alive');
  const streamHandler = AnthropicAdapter.createStreamHandler(res, rawBody.model, messageId);

  try {
    await backendRouter.executeStream(unifiedRequest, (chunk) => {
      streamHandler.handleChunk(chunk);
    });
    streamHandler.finish(); // 此处发送了 message_stop 事件
    // 致命缺陷：缺少 res.end()！
  } catch (streamErr: any) {
    res.end();
  }
}
```

#### 3.3 机制剖析
1. HTTP 协议在设置 `Connection: keep-alive` 和 `Transfer-Encoding: chunked` 时，客户端依靠 **Chunk 结束标志（0 长度块）** 或 **TCP FIN 包** 来判断响应完全终止。
2. `streamHandler.finish()` 仅仅向响应体中写入了 `event: message_stop\ndata: {"type":"message_stop"}\n\n` 的文本。
3. **由于后续从未调用 `res.end()`**，Node.js 的 HTTP 管道一直保持打开状态，客户端判定“服务端后续可能还会推送事件”，从而持续挂起等待，直到客户端配置的空闲超时强行关闭连接！

#### 3.4 最佳解决方案
在 `finish()` 调用后，或者在 `streamHandler.finish()` 内部，必须显式调用 `res.end()`：

```typescript
try {
  await backendRouter.executeStream(unifiedRequest, (chunk) => {
    streamHandler.handleChunk(chunk);
  });
  streamHandler.finish();
} finally {
  res.end(); // 确保无论正常结束还是中间中断，立即向客户端发送 HTTP 终止块并关闭管道
}
```

---

### 4. 会话不连续问题（同一终端会话被割裂为多个孤立会话）

#### 4.1 现象分析
在终端使用 Claude Code CLI 进行多轮对话时：
- 客户端终端逻辑上处于同一个交互会话中。
- 但在服务端或 `agy` 会话列表中，**每一次回车提问都生成了一个全新的独立会话 ID**（如 `3cdc160e-...`、`1793368...`），导致后端会话历史完全割裂。

#### 4.2 根本原因剖析
两大协议体系的机制不匹配导致了会话割裂：

```
[Claude Code 客户端]                           [网关 AgyBackend]                      [本地 agy CLI]
       │                                              │                                      │
       │── Turn 1 (含 message 1) ───────────────────►│── spawn: agy -p "msg1" ─────────────►│ 生成会话 A
       │◄── 回传 response 1 ─────────────────────────│◄── 完成并退出 ────────────────────────│ 会话 A 结束
       │                                              │                                      │
       │── Turn 2 (客户端打包包含 msg1, res1, msg2) ──►│── spawn: agy -p "msg1+res1+msg2" ──►│ 生成会话 B (孤立!)
       │◄── 回传 response 2 ─────────────────────────│◄── 完成并退出 ────────────────────────│ 会话 B 结束
```

1. **Anthropic 协议是无状态全量提交**：Claude Code 本地保存会话历史，第 N 轮交互时，它会把前 N-1 轮的全部 `messages` 一起打包发送。
2. **`AgyBackend` 未维护会话映射**：网关收到请求后，每次都直接运行 `crossSpawn('agy', ['-p', fullPrompt])`，从未传递 `--conversation <id>` 参数。
3. **结果**：`agy` 引擎判定每次调用都是一次全新的启动，不仅在 `~/.gemini/antigravity-cli/` 中留下了大量散碎的孤立会话文件，而且每一轮都被迫重复解析全部历史对话，造成极大的上下文浪费。

#### 4.3 最佳解决方案：网关级会话持续管理器（Session Continuity Manager）

设计并在网关层落地 **会话映射与状态机管理机制**：

```mermaid
flowchart TD
    ClientReq["客户端发起请求 (POST /v1/messages)"]
    Fingerprint["会话指纹提取器<br/>1. 检查请求头 x-session-id / session-id<br/>2. 检查 body.metadata.session_id<br/>3. 若无，提取首条 user message 内容哈希作为指纹"]
    CacheCheck{"会话映射表是否存在<br/>该指纹对应的 agyConversationId ?"}
    
    NewSession["首次启动会话<br/>1. 运行 agy -p '<首轮Prompt>'<br/>2. 从 stdout init 事件捕获返回的 conversation_id<br/>3. 将 clientFingerprint -> agyConversationId 写入内存映射表"]
    
    ResumeSession["恢复已有会话<br/>1. 提取当前轮最新 user message (增量提问)<br/>2. 运行 agy --conversation <agyId> -p '<最新增量>'<br/>3. 无需重复传输前序庞大历史"]

    ClientReq --> Fingerprint
    Fingerprint --> CacheCheck
    CacheCheck -- "否 (首次会话)" --> NewSession
    CacheCheck -- "是 (后续多轮)" --> ResumeSession
```

##### 核心优势：
1. **真正的会话连续性**：在 `agy` 侧，同一个客户端窗口的所有对话严格归属于同一个会话树，上下文深度自然递增。
2. **性能飞跃（减少 90% 输入 Token）**：后续轮次恢复时，仅需传递最新的一条用户消息，无需每次重复向模型提交数千 tokens 的历史记录，显著缩短传输耗时！

---

## 三、方案实施路线图与落地分工

### 阶段一：高优修复（立即落地）
1. **修复流式挂起 Bug**：在 `gateway.routes.ts` 的流式处理末尾严格补充 `res.end()`，彻底解决终端卡死直到超时的问题。
2. **升级环境提示词清洗器**：在 `prompt.scrubber.ts` 中集成位置、时区、日期及系统版本的正则清洗。

### 阶段二：会话状态化与 agy 平衡适配（深度优化）
1. **会话映射模块（`session.mapper.ts`）**：
   - 维护 TTL 为 24 小时的 LRU 会话映射表（`Map<ClientSessionKey, AgyConversationId>`）。
   - 优先通过 `req.headers['x-session-id']` 或对话指纹绑定 `conversation_id`。
2. **`AgyBackend` 增量恢复执行**：
   - 当探测到已有会话时，自动启用 `--conversation <id>` 并仅抽取最新增量消息作为 `-p` 提示词。
   - 动态映射 `thinking.budget_tokens` 到 `--effort` 参数。

---

## 四、总结与预期收益

通过上述针对性治理，网关与本地 `agy` 的协同将实现质的飞跃：
- **用户体验**：输出完毕即刻完成，不再有任何终端挂起等待；
- **提示词质量**：彻底消除竞品厂商标识与无关时区/地理位置噪声；
- **多轮会话**：真正做到一次会话一条线，后端日志与上下文完整贯通；
- **吞吐与延迟**：多轮会话输入 Token 削减 **70%~90%**，响应速度显著提升。
