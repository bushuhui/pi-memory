# pi-memory 项目架构

OpenClaw 增强型长期记忆插件，基于 LanceDB 实现混合检索（Vector + BM25 + Cross-Encoder Rerank）和多 Scope 隔离。同时提供独立 HTTP/MCP Server，供外部系统（Hermes Agent、Claude Code 等）调用。

---

## 技术栈

| 类别 | 技术 | 说明 |
|------|------|------|
| 运行时 | Node.js 18+ (ESM) | TypeScript 源码，通过 `jiti` JIT 编译运行 |
| 向量存储 | LanceDB 0.26.2 | 本地向量数据库，支持 ANN + BM25 混合检索 |
| Embedding | OpenAI 兼容 SDK | 通过 `openai` npm 包调用 OpenAI-compatible 端点 |
| MCP 协议 | `@modelcontextprotocol/sdk` 1.26 | SSE + Streamable HTTP Transport |
| Schema | `@sinclair/typebox` 0.34 | MCP 工具参数定义 |
| CLI | `commander` 14 | 命令行参数解析 |
| 构建 | 零构建，jiti 直运 | `node --import jiti/register` 直接运行 `.ts` |

---

## 目录结构

```
pi-memory/
├── index.ts                    # OpenClaw 插件入口（register 流程）
├── cli.ts                      # CLI 工具集（reembed / stats / search / forget 等）
├── package.json                # 依赖与 bin 定义
├── openclaw.plugin.json        # OpenClaw 插件元数据
├── README.md                   # 英文文档
│
├── src/
│   ├── store.ts                # LanceDB 存储层（记忆 CRUD + 表管理）
│   ├── embedder.ts             # Embedding 抽象层（OpenAI 兼容 + LRU 缓存）
│   ├── retriever.ts            # 混合检索引擎（Vector + BM25 + RRF + Rerank）
│   ├── knowledge-store.ts      # 知识库存储层
│   ├── knowledge-indexer.ts    # 知识库索引构建器
│   ├── knowledge-tools.ts      # MCP/OpenClaw 知识工具注册
│   ├── tools.ts                # MCP/OpenClaw 记忆工具注册
│   ├── scopes.ts               # Scope 隔离管理（global / agent:X / project:Y）
│   ├── runtime.ts              # OpenClaw 运行时适配（MemoryProvider 接口）
│   ├── migrate.ts              # 数据库迁移工具
│   ├── noise-filter.ts         # 噪声过滤（过滤低质量记忆片段）
│   ├── adaptive-retrieval.ts   # 自适应检索跳过逻辑
│   │
│   ├── server.ts               # 统一 HTTP/MCP Server（REST API + Streamable HTTP）
│   ├── server-bootstrap.ts     # 服务启动编排（配置加载 → 组件初始化 → 启动）
│   ├── server-config.ts        # 配置解析（CLI 参数 + 环境变量 + openclaw.json）
│   ├── server-router.ts        # 轻量 HTTP 路由器
│   ├── server-middleware.ts    # 中间件（鉴权 / CORS / 日志）
│   └── server-response.ts      # 统一响应序列化
│
├── scripts/
│   ├── pi-memory-server.ts     # Server CLI 启动脚本（bin: pi-memory-server）
│   ├── index-knowledge.mjs     # 知识库索引 CLI（bin: index-knowledge）
│   ├── lancedb-monitor.mjs     # LanceDB 监控工具（统计 + optimize）
│   ├── list-memories.mjs       # 记忆列表工具（直连 LanceDB）
│   ├── jsonl_distill.py        # JSONL 会话蒸馏脚本
│   └── smoke-openclaw.sh       # OpenClaw 冒烟测试
│
├── docs/
│   ├── server_mcp_design.md    # Server & MCP 详细设计
│   ├── server_mcp_api.md       # REST API + MCP 接口文档
│   ├── lancedb.md              # LanceDB 性能优化指南
│   ├── prompt.md               # 需求与决策记录
│   └── backup/                 # 备份文件
│
├── test/
│   └── cli-smoke.mjs           # CLI 冒烟测试
│
├── skills/                     # OpenClaw Skill 定义（pi-memory skill）
├── .github/                    # GitHub 配置
└── .npmignore
```

**目录角色说明：**
- `src/` — 核心业务逻辑，分为存储层、检索层、协议层
- `scripts/` — 可独立运行的 CLI 工具
- `docs/` — 项目文档与决策记录
- `skills/` — OpenClaw Skill 定义

---

## 模块划分

### 1. 存储层

| 模块 | 职责 | 关键文件 |
|------|------|----------|
| **Embedder** | 向量生成（OpenAI 兼容 API），内置 SHA-256 LRU 缓存（256 条目 / 30min TTL） | `src/embedder.ts` |
| **MemoryStore** | LanceDB 记忆表管理（memory_embeddings），支持 CRUD、批量插入、FTS 索引 | `src/store.ts` |
| **KnowledgeStore** | LanceDB 知识库表管理（knowledge_embeddings），含 FTS 索引 | `src/knowledge-store.ts` |
| **KnowledgeIndexer** | 文件系统扫描 → 文本分块 → 批量 Embedding → 写入知识库，支持增量索引 + mtime/hash 缓存 | `src/knowledge-indexer.ts` |

### 2. 检索层

| 模块 | 职责 | 关键文件 |
|------|------|----------|
| **Retriever** | 混合检索：Vector 搜索 + BM25 全文搜索 → RRF 融合 → Cross-Encoder Rerank → 近因加权 → 长度归一化 | `src/retriever.ts` |
| **NoiseFilter** | 过滤低质量/噪声记忆片段 | `src/noise-filter.ts` |
| **AdaptiveRetrieval** | 根据上下文判断是否跳过检索（减少不必要的 token 消耗） | `src/adaptive-retrieval.ts` |

### 3. 协议层

| 模块 | 职责 | 关键文件 |
|------|------|----------|
| **Tools** | OpenClaw 插件工具注册（memory_recall, memory_store, memory_forget, memory_update, memory_get, memory_list 等） | `src/tools.ts` |
| **KnowledgeTools** | OpenClaw 插件知识工具注册（knowledge_search, knowledge_index） | `src/knowledge-tools.ts` |
| **Scopes** | 多 Scope 隔离（global / agent:{id} / project:{name} / user:{name}），Scope 解析、验证、默认值 | `src/scopes.ts` |
| **Runtime** | OpenClaw MemoryProvider 接口适配（search / read / stats / clear） | `src/runtime.ts` |

### 4. 服务层（独立 HTTP/MCP Server）

| 模块 | 职责 | 关键文件 |
|------|------|----------|
| **Server** | 统一 HTTP/MCP 服务，单进程单端口，REST API + Streamable HTTP Transport 共存 | `src/server.ts` |
| **ServerBootstrap** | 服务启动编排：加载配置 → 创建组件 → 启动服务 | `src/server-bootstrap.ts` |
| **ServerConfig** | 三层配置解析（CLI 参数 > 环境变量 > `~/.openclaw/openclaw.json`） | `src/server-config.ts` |
| **ServerRouter** | 轻量 HTTP 路由，URL 参数提取 | `src/server-router.ts` |
| **ServerMiddleware** | 请求日志 / CORS / API Key 鉴权 | `src/server-middleware.ts` |
| **ServerResponse** | 统一响应格式、错误处理 | `src/server-response.ts` |

### 5. CLI 工具

| 工具 | 用途 | 文件 |
|------|------|------|
| `pi-memory-server` | 启动 HTTP/MCP Server | `scripts/pi-memory-server.ts` |
| `index-knowledge` | 知识库索引构建（支持单目录 / 增量 / 批量 Embedding） | `scripts/index-knowledge.mjs` |
| `lancedb-monitor` | LanceDB 状态监控（统计 / optimize / 片段分析） | `scripts/lancedb-monitor.mjs` |
| `list-memories` | 记忆列表（直连 LanceDB，不依赖 TypeScript） | `scripts/list-memories.mjs` |

### 6. OpenClaw 插件入口

| 模块 | 职责 | 关键文件 |
|------|------|----------|
| **Plugin** | OpenClaw `register()` 入口，创建 Embedder/Store/Retriever/ScopeManager，注册工具和 Hook | `index.ts` |
| **CLI** | 内嵌 CLI（memory-pro），提供 reembed / stats / search 等管理命令 | `cli.ts` |
| **Migrate** | 数据库迁移（旧版本兼容） | `src/migrate.ts` |

---

## 模块依赖关系

```
外部调用方
    │
    ├── OpenClaw 运行时 ──→ index.ts (register)
    │                           ├── MemoryStore ──→ LanceDB
    │                           ├── Embedder ──→ OpenAI-compatible API
    │                           ├── Retriever ──→ MemoryStore + Embedder + NoiseFilter
    │                           ├── ScopeManager
    │                           ├── Tools (OpenClaw tool 注册)
    │                           └── Runtime (MemoryProvider 接口)
    │
    ├── HTTP/MCP Server ──→ server-bootstrap.ts
    │                           ├── ServerConfig (配置加载)
    │                           ├── Embedder (复用)
    │                           ├── MemoryStore (复用)
    │                           ├── Retriever (复用)
    │                           ├── KnowledgeStore
    │                           ├── KnowledgeIndexer
    │                           └── server.ts (HTTP 路由 + MCP 注册)
    │
    └── CLI 工具 ──→ cli.ts / scripts/*
                        └── 直连 LanceDB 或调用 server API
```

**关键依赖规则：**
- 核心组件（store/embedder/retriever）无外部依赖，可被插件和 Server 复用
- Server 层不依赖 OpenClaw 运行时，独立启动
- 两个进程可同时运行，共享 LanceDB 数据目录（读操作并发安全，写操作 LanceDB 单写者模型）

---

## 数据流向

### 记忆存储流程

```
用户输入 / Agent 触发
    │
    ▼
OpenClaw Hook (before_agent_start / conversation_end) 或 HTTP POST /api/memory/store
    │
    ▼
noise-filter.ts — 过滤噪声（系统消息、空内容等）
    │
    ▼
scopes.ts — 解析并验证 scope（global / agent:X / project:Y）
    │
    ▼
embedder.ts — 文本向量化（先查 LRU 缓存，未命中则调用 API）
    │
    ▼
store.ts — 写入 LanceDB（批量 add，自动创建 FTS 索引）
    │
    ▼
memory table (LanceDB)
```

### 混合检索流程

```
查询请求（OpenClaw tool / HTTP POST / MCP tool）
    │
    ▼
embedder.ts — query 向量化
    │
    ▼
┌─────────────────────────────────────────┐
│ Vector Search (LanceDB ANN)             │
│     ↓                                   │
│ BM25 Full-Text Search (LanceDB FTS)     │
│     ↓                                   │
│ RRF Fusion (Reciprocal Rank Fusion)     │
│     ↓                                   │
│ Cross-Encoder Rerank (Jina/SiliconFlow) │
│     ↓                                   │
│ Recency Boost (指数衰减加权)             │
│     ↓                                   │
│ Length Normalization (长文本惩罚)        │
│     ↓                                   │
│ Noise Filter + Hard Cutoff              │
└─────────────────────────────────────────┘
    │
    ▼
返回排序后的结果列表
```

### 知识库索引流程

```
scripts/index-knowledge.mjs 或 POST /api/knowledge/index
    │
    ▼
Phase 1: 扫描知识库目录（follow symlinks，跳过隐藏文件）
    │
    ▼
Phase 2: mtime + hash 检查（跳过未变更文件）
    │
    ▼
Phase 3: 处理变更文件
    ├── 读取文件 → 文本分块（按段落/标题分割）
    ├── 批量 Embedding（最多 10 个并发）
    └── KnowledgeStore 写入（LanceDB 批量 add）
    │
    ▼
删除已不存在文件的索引条目
```

---

## 版本信息

- **当前版本**: 1.2.0
- **包名**: pi-memeory (注意拼写，历史遗留)
- **二进制**: `pi-memory-server`, `index-knowledge`
- **默认端口**: 9873
- **默认 DB 路径**: `~/.openclaw/memory/pi-memory`
