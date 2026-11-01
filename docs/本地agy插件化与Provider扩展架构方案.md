# 本地 agy 插件化与 Provider 扩展架构方案

## 1. 概述与背景

在前期工作中，系统成功完成了 **Google Antigravity (`agy` CLI)** 与本地 API 网关的深度适配，实现了：
- LiteLLM 式多协议统一网关（兼容 OpenAI、Anthropic、Gemini 协议）；
- `agy` 本地进程的参数映射、元数据与内部 Harness 提示词清洗；
- 会话连续性追踪（Session Continuity Manager）以及连续 10 轮擬人化上下文无缝交互。

目前，该功能是以**系统内置（Built-in Core）**的方式硬编码在 `server/modules/gateway/` 和 `server/modules/providers/list/agy/` 中。为了提升系统的解耦性、降低主干代码的维护成本，并方便将此项能力独立分发给其他 CloudCLI / Cloud-Agent 用户，本文档提出了**将本地 `agy CLI` 对接能力重构为独立插件**的技术落地全景方案。

---

## 2. 现有插件体系机制与边界分析

通过对项目源码（`server/modules/plugins/` 和 `src/modules/plugins/`）的深度审查，当前 Cloud-Agent 的插件架构具备以下特征与约束：

```mermaid
flowchart TD
    subgraph Host["Cloud-Agent 宿主环境"]
        Frontend["Web 前端 (React)"]
        PluginTab["PluginTabContent (Blob URL 动态 import)"]
        Server["Express 宿主网关 (:3001)"]
        PluginService["PluginService (~/.claude-code-ui/plugins)"]
        ProxyRouter["RPC 代理 (/api/plugins/:name/rpc) & WS 代理 (/plugin-ws/:name)"]
    end

    subgraph Plugin["独立插件 (Git Repo / 独立进程)"]
        Manifest["manifest.json"]
        UI["前端 ESM (mount / unmount)"]
        Process["后端独立子进程 (Node.js)"]
    end

    Frontend -->|点击 Tab| PluginTab
    PluginTab -->|拉取产物并执行| UI
    UI -->|hostApi.rpc()| ProxyRouter
    ProxyRouter -->|内部转发| Process
    Frontend -->|WebSocket 连接| ProxyRouter
    ProxyRouter -->|ws://127.0.0.1:port/ws| Process
    Server -->|进程管理与握手检测| Process
```

### 2.1 现有插件机制的核心能力
1. **沙箱式目录结构**：插件独立存放在 `~/.claude-code-ui/plugins/<plugin-name>/`，配置持久化于 `~/.claude-code-ui/plugins.json`。
2. **前端 ESM 动态装载**：宿主通过 Blob URL 原生 `import()` 载入插件前端产物，提供 `mount(container, hostApi)` 和 `unmount(container)` 契约。
3. **子进程生命周期与 10 秒握手**：
   - 宿主使用 `cross-spawn` 运行插件的 `server` 入口；
   - 插件进程必须在 10 秒内向 `stdout` 输出单行 JSON：`{"ready": true, "port": <port>}`；
   - 宿主动态捕获端口，实现进程自动拉起与崩溃自愈。
4. **透明网络转发**：
   - **HTTP RPC**：自动将 `/api/plugins/:name/rpc/*` 转发到 `http://127.0.0.1:<port>/*`，并自动注入配置好的 Header 密钥（`x-plugin-secret-<key>`）；
   - **WebSocket**：将 `/plugin-ws/:name` 双向透明桥接至 `ws://127.0.0.1:<port>/ws`；
   - **Skills 自动分发**：插件根目录若包含 `skills/` 或 `commands/`，宿主会自动加载其中的 Markdown 定义并注册为 Slash Commands。

### 2.2 现有插件机制的局限性
- **UI 插槽单一**：当前 `manifest.json` 仅支持 `"slot": "tab"`，即只能以工作区主标签页形式呈现，**无法直接将自身注入为主聊天界面的原生 Provider 下拉选项**（目前 Provider 由 `provider.registry.ts` 静态注册）。
- **顶级路由受限**：插件的 HTTP 请求被限制在宿主的 `/api/plugins/:name/rpc/*` 前缀下，无法直接劫持顶级的 `/v1/chat/completions` 或 `/v1/messages`。

---

## 3. 双轨演进落地架构

针对上述现状，设计两种演进路径：
- **方案 A（即刻可用，零内核侵入）**：基于现有规范实现「Agy Gateway & Control Panel 插件」；
- **方案 B（长期演进，官方规范升级）**：扩展 CloudCLI 核心，支持「Provider 插件动态扩展规范」。

---

### 方案 A：基于现有规范的独立 Agy 插件（零内核侵入）

该方案不修改 Cloud-Agent 任何核心代码，完全作为外部插件分发与运行。

#### 3.1 插件目录结构
```text
cloudcli-plugin-agy/
├── manifest.json                 # 插件描述清单
├── package.json                  # 依赖与自动构建声明
├── vite.config.ts                # 前端 Vite 库模式打包配置
├── src/                          # 前端控制台源码
│   ├── index.tsx                 # 导出 mount / unmount
│   └── components/
│       ├── Dashboard.tsx         # Agy 运行状态与配额监控
│       ├── ModelSelector.tsx     # 底层模型切换与调试
│       └── LogViewer.tsx         # 基于 WebSocket 的实时流式日志
├── server/                       # 后端子进程源码
│   ├── index.js                  # 子进程入口与握手监听
│   ├── agy-engine.js             # agy CLI 调用与并发控制
│   ├── prompt-scrubber.js        # 环境元数据与 XML Harness 清洗
│   └── session-manager.js        # 上下文连续性映射器
└── skills/                       # 随插件分发的 Agent 技能
    └── agy.md                    # 注册 /agy 命令
```

#### 3.2 插件描述清单 (`manifest.json`)
```json
{
  "name": "cloudcli-plugin-agy",
  "displayName": "Google Antigravity (agy) Gateway",
  "version": "1.0.0",
  "description": "本地 agy CLI 适配桥接器，提供多协议 LLM 网关与控制面板",
  "icon": "Cpu",
  "type": "module",
  "slot": "tab",
  "entry": "dist/index.js",
  "server": "server/index.js",
  "permissions": ["network", "storage"],
  "repository": "https://github.com/your-username/cloudcli-plugin-agy"
}
```

#### 3.3 后端核心握手与双服务架构 (`server/index.js`)
插件后端在启动时建立两个服务通道：
1. **内部 RPC 通道**：响应宿主 Tab 的状态查询与配置修改；
2. **外部独立网关端口（如 3002）**：提供标准的 `/v1/chat/completions` 与 `/v1/messages`，供 Claude Code、Cursor、OpenAI SDK 直接连接。

```javascript
import http from 'http';
import { WebSocketServer } from 'ws';
import { executeAgyTurn } from './agy-engine.js';

// 1. 创建内部 RPC HTTP 服务
const rpcServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  
  // 状态检查
  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      installed: true,
      models: ['gemini-3.8-flash-low', 'gemini-3.8-flash-high', 'claude-sonnet-4-6'],
      activeSessions: 1,
    }));
    return;
  }

  // 多协议网关代理入口（也可直接挂载于此）
  if (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/messages') {
    handleGatewayRequest(req, res);
    return;
  }

  res.writeHead(404);
  res.end();
});

// 2. 绑定内部 WebSocket（供前端实时日志监听）
const wss = new WebSocketServer({ noServer: true });
rpcServer.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'connected', time: Date.now() }));
    });
  }
});

// 3. 监听随机端口并向宿主触发握手信号
rpcServer.listen(0, '127.0.0.1', () => {
  const port = rpcServer.address().port;
  // 【关键契约】：10 秒内向 stdout 输出单行 JSON 宣告就绪
  console.log(JSON.stringify({ ready: true, port: port }));
});
```

#### 3.4 前端生命周期契约实现 (`src/index.tsx`)
```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Dashboard } from './components/Dashboard';

let root: ReactDOM.Root | null = null;

export async function mount(container: HTMLElement, hostApi: any): Promise<void> {
  const { theme, project } = hostApi.context;
  
  root = ReactDOM.createRoot(container);
  root.render(
    <React.StrictMode>
      <Dashboard hostApi={hostApi} initialTheme={theme} currentProject={project} />
    </React.StrictMode>
  );

  // 监听主题与工程变更
  hostApi.onContextChange((newCtx: any) => {
    // 动态同步更新 UI 主题与工程状态
  });
}

export function unmount(container: HTMLElement): void {
  if (root) {
    root.unmount();
    root = null;
  }
}
```

---

### 方案 B：增强 Cloud-Agent 核心，支持「Provider 插件规范」（终极演进）

如果希望插件能够**像原生内置 Provider 一样无缝出现在聊天输入框的下拉菜单中**，建议向 Cloud-Agent 核心提出扩展规范。

#### 4.1 规范扩展点
在 `manifest.json` 中扩展 `capabilities` 字段：
```json
{
  "name": "cloudcli-plugin-agy",
  "displayName": "Google Antigravity",
  "capabilities": ["provider", "gateway-backend"],
  "provider": {
    "id": "agy",
    "name": "Antigravity (agy)",
    "models": [
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-high",
      "claude-sonnet-4-6"
    ]
  }
}
```

#### 4.2 宿主内核动态注册设计 (`server/modules/providers/provider.registry.ts`)
在现有 `providerRegistry` 中增加动态注册与注销机制：

```typescript
export interface IDynamicPluginProvider extends IProvider {
  pluginName: string;
}

export const providerRegistry = {
  // 原生内置 providers
  builtInProviders: { ... },
  // 插件动态注册的 providers
  pluginProviders: new Map<string, IDynamicPluginProvider>(),

  registerDynamicProvider(provider: IDynamicPluginProvider) {
    this.pluginProviders.set(provider.id, provider);
  },

  unregisterDynamicProvider(providerId: string) {
    this.pluginProviders.delete(providerId);
  },

  listProviders(): IProvider[] {
    return [
      ...Object.values(this.builtInProviders),
      ...Array.from(this.pluginProviders.values()),
    ];
  },
};
```

当插件安装或启用时，宿主检测其 `capabilities`，将插件后端的代理包装为 `DynamicProvider` 实例注入主系统的 `providerRegistry`。此模式将彻底打通插件与主聊天窗口的界限，并可作为未来接入 Ollama、vLLM、LocalAI 的通用标准。

---

## 4. 开发、测试与安装全流程

### 4.1 本地开发与调试
无需发布 Git，本地开发时直接使用软链接接入：
```bash
# 1. 创建本地插件目录并拉取/编写插件
git clone https://github.com/your-username/cloudcli-plugin-agy.git /home/yubs/cloudcli-plugin-agy

# 2. 软链至 Cloud-Agent 插件目录
mkdir -p ~/.claude-code-ui/plugins
ln -s /home/yubs/cloudcli-plugin-agy ~/.claude-code-ui/plugins/cloudcli-plugin-agy

# 3. 本地构建测试
cd /home/yubs/cloudcli-plugin-agy
npm install
npm run build
```

### 4.2 宿主界面安装与使用
1. 打开 Cloud-Agent Web 界面：`http://localhost:3001`；
2. 导航至 **Settings ➔ Plugins** 标签页；
3. 点击 **Refresh**，系统自动扫描并识别 `cloudcli-plugin-agy`；
4. 点击开启，系统子进程将自动运行并完成握手；
5. 工作区顶部将新增 **Google Antigravity** 专属管理 Tab。

### 4.3 外部客户端接入验证
配置终端环境变量指向插件暴露的网关端口：
```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3002"
export ANTHROPIC_API_KEY="sk-any-token"

# 直接使用 Claude Code 进行无缝问答
claude
```

---

## 5. 选型建议与总结

1. **当前开发模式建议**：
   - **对于当前服务器生产运行**：建议继续保留在主系统内的**内置实现（Built-in）**，因为当前内置方案已实现端到端优化、自动化单元测试全通、Systemd 守护以及极致的流式低延迟，生产使用最稳定。
2. **对于开源分发与生态贡献**：
   - 采用**方案 A**将核心逻辑抽取为独立的开源插件仓库 `cloudcli-plugin-agy`，方便任何原版 CloudCLI 用户免侵入安装使用。
   - 长期可协同社区推进**方案 B**，使 CloudCLI 具备开放的 Provider 扩展生态。
