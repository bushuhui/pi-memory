# pi-memory Server & MCP 设计方案

## 1. 背景与目标

pi-memory 当前是一个 OpenClaw 插件，所有能力（memory/knowledge 检索、存储、管理）都在 OpenClaw 进程内通过插件 API 暴露。本方案为其增加 **独立 HTTP 服务** 和 **MCP Server** 两种外部调用方式，使 Hermes Agent、Claude Code 及任意第三方系统能够调用 pi-memory 的知识库查询和记忆管理能力。

### 设计原则

- **复用现有逻辑**：检索引擎、Embedder、LanceDB 存储等核心组件零改动，只做一层协议适配
- **渐进式**：HTTP Server 和 MCP Server 是两个独立入口，可单独使用
- **最小依赖**：HTTP 框架选用 Node.js 内置 `http` + 轻量路由，不引入 Express/Fastify 等重型框架
- **安全默认**：本地回环地址默认监听，远程访问需显式配置 API Key

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────┐
│                 pi-memory                        │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │          Core Components (已有)            │   │
│  │  store.ts / embedder.ts / retriever.ts   │   │
│  │  knowledge-store.ts / knowledge-tools.ts  │   │
│  │  scopes.ts / noise-filter.ts              │   │
│  └──────────────────────┬───────────────────┘   │
│                         │                       │
│  ┌──────────────────────▼────────────────────┐  │
│  │           src/server.ts                   │  │
│  │   统一 HTTP Server（单进程单端口）          │  │
│  │                                           │  │
│  │   REST API:   /health, /api/v1/*         │  │
│  │   MCP SSE:    /sse                        │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  scripts/pi-memory-server  (CLI 启动脚本)         │
└──────────────────────────────────────────────────┘

外部调用者:
  - Hermes Agent   →  HTTP API 或 MCP SSE
  - Claude Code    →  MCP SSE
  - 任意脚本/curl  →  HTTP API
```

MCP SSE 和 REST API 共用同一个 HTTP 进程和端口。`/sse` 端点由 `@modelcontextprotocol/sdk` 的 `SSEServerTransport` 挂载，REST 端点由自写路由处理，互不干扰。

### 初始化流程

```
scripts/pi-memory-server
  └→ src/server-bootstrap.ts
       1. 读取配置 (CLI 参数 + 环境变量 + openclaw.json)
       2. 创建 Embedder (复用 src/embedder.ts)
       3. 创建 MemoryStore (复用 src/store.ts)
       4. 创建 MemoryRetriever (复用 src/retriever.ts)
       5. 创建 KnowledgeStore (复用 src/knowledge-store.ts)
       6. 创建 KnowledgeIndexer (复用 src/knowledge-indexer.ts)
       7. 启动统一 HTTP Server
          ├── 注册 REST API 路由 (/health, /api/v1/*)
          └── 挂载 MCP SSE 端点 (/sse) — 默认开启
```

**关键决策**：
- 不依赖 OpenClaw 运行时。所有组件通过 `server-bootstrap.ts` 直接实例化，与 OpenClaw 的 `index.ts` register 流程并行但独立
- HTTP Server 和 MCP SSE **整合为同一进程同一端口**，无需分别管理
- 配置格式与 `openclaw.json` 中 `plugins.entries["pi-memory"].config` 完全一致，`server` 字段为扩展部分
- 默认值（模型、端点、维度等）取自线上实际配置，而非 OpenAI 默认值

---

## 3. 配置体系

### 3.1 配置来源（优先级从高到低）

1. CLI 参数（如 `--port`、`--host`）
2. 环境变量（`PI_MEMORY_*`）
3. **`~/.openclaw/openclaw.json`** 中 `plugins.entries["pi-memory"].config`

**不引入单独的配置文件**。pi-memory 的配置已经存在于 OpenClaw 主配置中，Server 直接读取即可。这样：
- 改了 OpenClaw 的 embedding 模型或 reranker，Server 自动生效
- 不需要维护两份配置的一致性
- 部署更简单：`scripts/pi-memory-server` 启动即读已有配置

### 3.2 配置项

Server 配置直接读取 `~/.openclaw/openclaw.json` 中 `plugins.entries["pi-memory"].config`，额外通过 `server` 字段扩展服务专属配置。完整结构如下：

```typescript
interface ServerConfig {
  // === 与 OpenClaw 插件完全相同的配置 ===
  embedding: {
    provider: "openai-compatible";
    apiKey: string;          // 环境变量: PI_MEMORY_EMBED_API_KEY
    model?: string;          // 默认: unsloth/Qwen3-Embedding-0.6B
    baseURL?: string;        // 环境变量: PI_MEMORY_EMBED_BASE_URL
    dimensions?: number;     // 默认: 1024
    taskQuery?: string;      // query 端点的 task 参数
    taskPassage?: string;    // passage 端点的 task 参数
    normalized?: boolean;    // 是否返回归一化向量
  };
  dbPath?: string;           // 默认: ~/.openclaw/memory/pi-memory
  retrieval?: Partial<RetrievalConfig>;  // 复用现有 RetrievalConfig
  knowledgePaths?: string[]; // 知识库索引目录（Obsidian vault 等）
  scopes?: PluginConfig["scopes"];
  enableManagementTools?: boolean;
  autoCapture?: boolean;
  autoRecall?: boolean;

  // === Server 专属配置 ===
  server: {
    http: {
      enabled: boolean;        // 默认: true
      host: string;            // 默认: "0.0.0.0"
      port: number;            // 默认: 9873
    };
    mcp: {
      enabled: boolean;        // 默认: true
      transport: "sse" | "stdio";  // 默认: "sse"
    };
    apiKey?: string;           // API Key 鉴权，环境变量: PI_MEMORY_API_KEY
    corsOrigins?: string[];    // CORS 白名单，默认: []
  };
}
```

### 3.3 配置读取方式

Server 启动时直接读取 `~/.openclaw/openclaw.json`：

```typescript
const openclawConfig = JSON.parse(
  readFileSync(join(homedir(), ".openclaw", "openclaw.json"), "utf-8")
);
const pluginConfig = openclawConfig.plugins?.entries?.["pi-memory"]?.config ?? {};
```

其中 `server` 字段是 Server 专属扩展。如果配置中没有 `server` 字段，使用默认值（HTTP 开启，MCP 开启，绑定 `0.0.0.0:9873`）。

CLI 参数只覆盖 `server` 部分，不影响 OpenClaw 已有的 embedding/retrieval 配置：

```bash
pi-memory-server --port 8888          # 覆盖 server.http.port
pi-memory-server --no-http --mcp      # 只启 MCP，不开 HTTP
pi-memory-server --api-key xxx        # 设置 server.apiKey
```

**这意味着**：
- 你不需要为 Server 单独编写一份配置——它直接复用 OpenClaw 中已有的 `pi-memory` 配置
- 未来如果调整了 embedding 模型或 reranker，只需改 `openclaw.json`，Server 自动生效
- 环境变量 `${ENV_VAR}` 替换规则与 OpenClaw 一致，在读取后自动展开

### 3.4 环境变量

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `PI_MEMORY_EMBED_API_KEY` | Embedding API Key | 必填 |
| `PI_MEMORY_EMBED_BASE_URL` | Embedding 端点 | `http://api.adv-ci.com:8090/v1` |
| `PI_MEMORY_EMBED_MODEL` | Embedding 模型 | `unsloth/Qwen3-Embedding-0.6B` |
| `PI_MEMORY_EMBED_DIMENSIONS` | 向量维度 | `1024` |
| `PI_MEMORY_DB_PATH` | LanceDB 路径 | `~/.openclaw/memory/pi-memory` |
| `PI_MEMORY_API_KEY` | Server API Key | 无（不开启鉴权） |
| `PI_MEMORY_HTTP_HOST` | HTTP 监听地址 | `0.0.0.0` |
| `PI_MEMORY_HTTP_PORT` | HTTP 监听端口 | `9873` |
| `PI_MEMORY_KNOWLEDGE_PATHS` | 知识库路径（JSON 数组） | `[]` |
| `PI_MEMORY_RERANK_API_KEY` | Reranker API Key | 无 |
| `PI_MEMORY_RERANK_PROVIDER` | Reranker 提供商 | `jina` |
| `PI_MEMORY_RERANK_MODEL` | Reranker 模型 | `Qwen/Qwen3-Reranker-0.6B` |
| `PI_MEMORY_RERANK_ENDPOINT` | Reranker 端点 | `http://api.adv-ci.com:8090/v1/rerank` |

---

## 4. HTTP Server 设计

### 4.1 技术选型

使用 Node.js 内置 `node:http` + 手写轻量路由，理由：
- 零额外依赖，安装体积小
- pi-memory 是基础设施服务，不需要 Express 的中间件生态
- 路由数量少（约 10 个），手写路由代码量 < 100 行

### 4.2 端点设计

#### 4.2.1 健康检查

```
GET /health
```

响应：
```json
{
  "status": "ok",
  "version": "1.1.1",
  "database": "~/.openclaw/memory/pi-memory",
  "embedding_model": "unsloth/Qwen3-Embedding-0.6B",
  "embedding_dimensions": 1024,
  "rerank_model": "Qwen/Qwen3-Reranker-0.6B",
  "knowledge_paths": ["/path/to/vault"],
  "uptime_seconds": 12345
}
```

#### 4.2.2 知识库搜索

```
POST /api/v1/knowledge/search
Content-Type: application/json
Authorization: Bearer <api-key>  // 如果配置了 apiKey
```

请求体：
```json
{
  "query": "什么是 RAG 架构",
  "limit": 5,
  "min_score": 0.3,
  "file_paths": ["/path/to/vault"],
  "file_types": ["md", "txt"]
}
```

响应：
```json
{
  "query": "什么是 RAG 架构",
  "results": [
    {
      "text": "RAG（Retrieval-Augmented Generation）是一种将检索与生成结合的技术...",
      "score": 0.92,
      "file_path": "/path/to/vault/RAG.md",
      "file_name": "RAG.md",
      "file_type": "md",
      "chunk_index": 3,
      "start_line": 46,
      "end_line": 62,
      "sources": {
        "vector": { "score": 0.88, "rank": 2 },
        "bm25": { "score": 0.91, "rank": 1 },
        "fused": { "score": 0.92 },
        "reranked": { "score": 0.95 }
      }
    }
  ],
  "count": 1
}
```

#### 4.2.3 记忆搜索

```
POST /api/v1/memory/search
Content-Type: application/json
```

请求体：
```json
{
  "query": "用户偏好用什么编程语言",
  "limit": 5,
  "scope": "global",
  "category": "preference",
  "min_score": 0.3
}
```

响应：
```json
{
  "query": "用户偏好用什么编程语言",
  "results": [
    {
      "id": "mem-abc123",
      "text": "用户偏好使用 TypeScript 开发，认为类型安全很重要",
      "category": "preference",
      "scope": "global",
      "importance": 0.7,
      "score": 0.85,
      "timestamp": "2026-04-28T10:30:00Z",
      "sources": {
        "vector": { "score": 0.82, "rank": 1 },
        "bm25": { "score": 0.78, "rank": 3 },
        "fused": { "score": 0.85 }
      }
    }
  ],
  "count": 1
}
```

#### 4.2.4 记忆存储

```
POST /api/v1/memory/store
Content-Type: application/json
```

请求体：
```json
{
  "text": "用户决定使用 pi-memory 作为统一记忆后端",
  "category": "decision",
  "scope": "global",
  "importance": 0.8,
  "metadata": { "source": "hermes-agent" }
}
```

响应：
```json
{
  "id": "mem-xyz789",
  "status": "created"
}
```

#### 4.2.5 记忆读取（按 ID）

```
GET /api/v1/memory/:id
```

响应：
```json
{
  "id": "mem-xyz789",
  "text": "用户决定使用 pi-memory 作为统一记忆后端",
  "category": "decision",
  "scope": "global",
  "importance": 0.8,
  "timestamp": "2026-04-29T10:00:00Z",
  "metadata": { "source": "hermes-agent" }
}
```

#### 4.2.6 记忆删除

```
DELETE /api/v1/memory/:id
```

响应：
```json
{
  "status": "deleted",
  "id": "mem-xyz789"
}
```

#### 4.2.7 知识索引管理

```
POST /api/v1/knowledge/index
```

请求体：
```json
{
  "paths": ["/path/to/vault"],
  "force": false
}
```

响应：
```json
{
  "status": "completed",
  "indexed_files": 42,
  "total_chunks": 1256,
  "new_chunks": 15,
  "updated_chunks": 3,
  "unchanged_chunks": 1238
}
```

#### 4.2.8 记忆统计

```
GET /api/v1/memory/stats?scope=global
```

响应：
```json
{
  "total": 1234,
  "by_scope": {
    "global": 800,
    "agent:hermes": 434
  },
  "by_category": {
    "preference": 200,
    "fact": 500,
    "decision": 150,
    "entity": 300,
    "other": 84
  }
}
```

#### 4.2.9 知识统计

```
GET /api/v1/knowledge/stats
```

响应：
```json
{
  "total_chunks": 1256,
  "total_files": 42,
  "by_type": {
    "md": 38,
    "txt": 4
  }
}
```

#### 4.2.10 统一搜索（同时搜索记忆+知识库）

```
POST /api/v1/search
Content-Type: application/json
```

请求体：
```json
{
  "query": "RAG 和记忆系统的关系",
  "limit": 10,
  "corpus": "all",          // "all" | "memory" | "knowledge"
  "min_score": 0.3
}
```

响应：
```json
{
  "query": "RAG 和记忆系统的关系",
  "memory_results": [ ... ],
  "knowledge_results": [ ... ],
  "total_count": 8
}
```

### 4.3 错误响应

统一格式：
```json
{
  "error": {
    "code": "invalid_request",
    "message": "query parameter is required"
  }
}
```

HTTP 状态码：
| 状态码 | 场景 |
|--------|------|
| 200 | 成功 |
| 400 | 参数错误 |
| 401 | API Key 缺失/错误 |
| 404 | 资源不存在 |
| 500 | 内部错误 |

### 4.4 鉴权

如果配置了 `server.apiKey`：
- 所有 `/api/v1/*` 端点要求 `Authorization: Bearer <api-key>` 请求头； 内部使用，如果没有提供 <api-key> 也能使用
- `/health` 端点不需要鉴权（用于容器健康检查）
- API Key 比较使用恒定时间比较（防时序攻击）

---

## 5. MCP Server 设计

### 5.1 技术选型

使用 `@modelcontextprotocol/sdk` 实现 **SSE transport**（默认）。REST API 和 MCP Server 共用同一个 HTTP 服务进程，避免每个客户端启动独立进程。

选择 SSE 而非 stdio 的原因：
- **单进程常驻**：REST API 和 MCP 共用一个进程，单进程访问 LanceDB 避免并发冲突
- **多客户端同时接入**：Claude Code、Hermes 可同时连接同一个 pi-memory 实例
- **无需子进程管理**：Hermes 本身是常驻服务，通过 HTTP 连 SSE 最自然
- stdio 仍保留作为备用方案（某些环境不支持 SSE 时）

### 5.2 工具定义

共暴露 5 个 MCP 工具：

#### 5.2.1 knowledge_search

```json
{
  "name": "knowledge_search",
  "description": "Search the indexed knowledge base using hybrid retrieval (vector + BM25). Use when you need information from indexed files like Obsidian vaults, documentation, or reference materials.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search query" },
      "limit": { "type": "integer", "description": "Max results (default: 5, max: 20)" },
      "min_score": { "type": "number", "description": "Minimum relevance score (0-1, default: 0.3)" },
      "file_type": { "type": "string", "description": "Filter by file extension (e.g. 'md', 'txt')" }
    },
    "required": ["query"]
  }
}
```

#### 5.2.2 memory_search

```json
{
  "name": "memory_search",
  "description": "Search stored memories using hybrid retrieval. Use when you need context about user preferences, past decisions, or previously discussed topics.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search query" },
      "limit": { "type": "integer", "description": "Max results (default: 5, max: 20)" },
      "scope": { "type": "string", "description": "Scope to search in (optional)" },
      "category": { "type": "string", "enum": ["preference", "fact", "decision", "entity", "other"] },
      "min_score": { "type": "number", "description": "Minimum score (0-1, default: 0.3)" }
    },
    "required": ["query"]
  }
}
```

#### 5.2.3 memory_store

```json
{
  "name": "memory_store",
  "description": "Store a new memory entry. Use when the user shares an important preference, fact, decision, or entity information worth remembering long-term.",
  "parameters": {
    "type": "object",
    "properties": {
      "text": { "type": "string", "description": "Memory content (10-500 chars)" },
      "category": { "type": "string", "enum": ["preference", "fact", "decision", "entity", "other"], "description": "Default: other" },
      "scope": { "type": "string", "description": "Default: global" },
      "importance": { "type": "number", "description": "0-1, default: 0.7" }
    },
    "required": ["text"]
  }
}
```

#### 5.2.4 knowledge_index

```json
{
  "name": "knowledge_index",
  "description": "Rebuild or update the knowledge base index. Scans configured paths for new/changed files and indexes them.",
  "parameters": {
    "type": "object",
    "properties": {
      "force": { "type": "boolean", "description": "Force reindex all files (default: false)" }
    }
  }
}
```

#### 5.2.5 memory_get

```json
{
  "name": "memory_get",
  "description": "Read a specific memory entry by its ID. Use after memory_search when you need the full content of a specific memory.",
  "parameters": {
    "type": "object",
    "properties": {
      "id": { "type": "string", "description": "Memory entry ID" }
    },
    "required": ["id"]
  }
}
```

### 5.3 工具响应格式

每个工具返回纯文本 markdown 格式，Claude Code / Hermes 可直接解析：

```markdown
Found 3 results:

1. [decision:global] 用户决定使用 pi-memory 作为统一记忆后端 (85%)
   Source: stored memory, ID: mem-xyz789

2. [fact:global] RAG 架构结合检索器和生成器 (72%)
   Source: /path/to/vault/RAG.md#L46-L62
```

### 5.4 Transport 模式

- **sse**（默认）：通过 HTTP SSE 端点提供服务，与 REST API 共用端口。客户端通过 `StreamableHTTPClientTransport` 连接。
- **stdio**（备用）：通过 stdin/stdout 通信，仅在 SSE 不可用时通过 `--transport stdio` 启用。

---

## 6. 文件结构

```
pi-memory/
├── src/
│   ├── server.ts              # 统一 HTTP Server（REST API + MCP SSE 整合）
│   │                          #   ├─ 注册 REST 路由
│   │                          #   ├─ 挂载 MCP SSE 端点 (/sse)
│   │                          #   └─ 共享鉴权中间件
│   ├── server-bootstrap.ts    # 配置加载 + 组件初始化 + 启动编排
│   ├── server-config.ts       # 配置解析（CLI 参数 + 环境变量 + openclaw.json）
│   ├── server-router.ts       # 轻量 HTTP 路由 + 请求解析
│   ├── server-middleware.ts   # 鉴权、CORS、日志中间件
│   ├── server-response.ts     # 统一响应序列化 + 错误处理
│   └── ...                    # 已有文件不变
├── scripts/
│   ├── pi-memory-server       # CLI 启动脚本
│   ├── index-knowledge.mjs    # 已有，不变
│   ├── jsonl_distill.py       # 已有，不变
│   └── smoke-openclaw.sh      # 已有，不变
├── docs/
│   └── server_mcp_design.md   # 本设计文档
├── package.json               # 新增 @modelcontextprotocol/sdk 依赖 + bin 字段
└── openclaw.plugin.json       # 不变
```

MCP 的 SSE 端点直接在 `server.ts` 中挂载，不需要独立的 `mcp-server.ts` 文件。REST 路由和 SSE 端点共用同一个 `http.Server` 实例。

---

## 7. 依赖变更

### package.json

```json
{
  "dependencies": {
    "@lancedb/lancedb": "^0.26.2",
    "@sinclair/typebox": "0.34.48",
    "openai": "^6.21.0",
    "@modelcontextprotocol/sdk": "^1.26.0"  // 新增
  },
  "bin": {
    "pi-memory-server": "./scripts/pi-memory-server"  // 新增
  }
}
```

### scripts/pi-memory-server

```bash
#!/usr/bin/env node
// 解析 CLI 参数，调用 server-bootstrap.ts
// 支持: --http, --no-http, --mcp, --port, --host, --config, --help
```

---

## 8. 与 Hermes Agent 的集成方式

### 8.1 MCP SSE 方式（推荐）

Hermes 的 MCP 客户端通过 SSE 连接到 pi-memory：

```json
// Hermes MCP 客户端配置
{
  "mcpServers": {
    "pi-memory": {
      "url": "http://127.0.0.1:9873/sse"
    }
  }
}
```

pi-memory 的 5 个 MCP 工具会自动出现在 Hermes 的 tool 列表中。由于是常驻服务，不需要管理子进程生命周期。

### 8.2 HTTP REST 方式（轻量替代）

如果 Hermes 不支持 MCP 客户端，可以直接调用 REST API：

```python
import requests

def pi_memory_knowledge_search(query: str, limit: int = 5) -> str:
    """调用 pi-memory 知识库搜索"""
    resp = requests.post(
        "http://127.0.0.1:9873/api/v1/knowledge/search",
        json={"query": query, "limit": limit},
        timeout=30,
    )
    data = resp.json()
    # 格式化为 Hermes 期望的字符串格式
    ...
```

---

## 9. 与 Claude Code 的集成方式

### 9.1 MCP SSE 方式（推荐）

在 Claude Code 的 `.mcp.json` 中配置：

```json
{
  "mcpServers": {
    "pi-memory": {
      "url": "http://127.0.0.1:9873/sse"
    }
  }
}
```

Claude Code 启动时会自动连接 pi-memory SSE 端点，Agent 即可使用 `knowledge_search`、`memory_search` 等工具。

### 9.2 stdio 方式（备用）

如果 SSE 不可用，也可以走 stdio：

```json
{
  "mcpServers": {
    "pi-memory": {
      "command": "node",
      "args": ["~/.openclaw/extensions/pi-memory/scripts/pi-memory-server", "--mcp", "--no-http", "--transport", "stdio"]
    }
  }
}
```

注意：stdio 会为每个 Claude Code 会话启动独立进程，存在多进程并发访问 LanceDB 的风险（见 §12.1）。

---

## 10. 并发与安全

### 10.1 并发模型

- HTTP Server 使用 Node.js 事件循环，天然支持并发请求
- LanceDB 读操作支持并发，写入操作串行化（LanceDB 单写者模型）
- Embedder 已有 LRU 缓存（256 条目，30 分钟 TTL），并发安全

### 10.2 安全考虑

- 默认绑定 `0.0.0.0`，在内网使用，不暴露到外网
- API Key 可选，启用后使用恒定时间比较
- 请求体大小限制：1MB（防 DoS）
- 请求超时：30 秒（embedding 调用可能较慢）
- 输入校验：query 非空、limit 范围 1-20

### 10.3 日志

- HTTP 访问日志：`[server] POST /api/v1/knowledge/search 200 45ms`
- 错误日志：stderr，包含堆栈
- 不记录请求内容（隐私保护），仅记录路径和状态码

---

## 11. 实现步骤

### Phase 1：基础设施（最小可用）

1. **src/server-config.ts** — 配置解析模块
2. **src/server-bootstrap.ts** — 组件初始化编排
3. **src/server-router.ts** — 轻量 HTTP 路由
4. **src/server-response.ts** — 响应序列化
5. **scripts/pi-memory-server** — CLI 启动脚本
6. 实现 `/health` + `/api/v1/knowledge/search` + `/api/v1/memory/search`

### Phase 2：完整 API 覆盖

7. **src/server-middleware.ts** — 鉴权、CORS
8. `/api/v1/memory/store`、`/api/v1/memory/:id`、`/api/v1/memory/:id`（DELETE）
9. `/api/v1/knowledge/index`、`/api/v1/memory/stats`、`/api/v1/knowledge/stats`
10. `/api/v1/search`（统一搜索）

### Phase 3：MCP SSE 集成

11. 在 `server.ts` 中挂载 `/sse` 端点，复用已有组件实例
12. 注册 5 个 MCP 工具（knowledge_search, memory_search, memory_store, knowledge_index, memory_get）
13. stdio transport 备用方案

### Phase 4：文档与测试

14. README 更新（Server & MCP 使用说明）
15. API 示例脚本（curl / Python requests）
16. 基础集成测试

---

## 12. 风险与注意事项

### 12.1 LanceDB 并发

SSE 模式下所有请求通过单进程处理，LanceDB 读写不存在多进程竞争。如果通过 stdio 模式运行多个实例，则需要：
- 写入操作使用文件锁串行化
- 索引操作（knowledge_index）应确保单实例运行

### 12.2 Embedding API 延迟

每次搜索都需要调用 embedding API（Qwen3-Embedding-0.6B，自部署端点约 50-200ms），HTTP Server 需要设置合理的超时（30s）。已有 LRU 缓存可缓解重复查询场景。如果 rerank 也启用（Qwen3-Reranker-0.6B），额外增加一次 rerank API 调用。

### 12.3 与 OpenClaw 插件共存

HTTP/MCP Server 和 OpenClaw 插件**可以同时运行**，共享同一个 LanceDB 数据目录。但需要注意：
- 不要在两个进程中同时执行 `knowledge_index`（文件索引），通过文件锁避免冲突
- 写入操作（memory_store/forget/update）通过 LanceDB 的事务机制串行化
- 读操作（search/recall）天然并发安全

### 12.4 @modelcontextprotocol/sdk 兼容性

该 SDK 要求 Node.js >= 18，pi-memory 当前运行环境需确认 Node 版本。OpenClaw 本身已要求 Node.js 18+，所以应该没问题。
