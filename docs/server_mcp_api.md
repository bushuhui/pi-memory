# HTTP & MCP API 文档

pi-memory-server 提供单端口双协议服务：REST API + MCP Server 共享同一端口（默认 9873）。

- **REST API**: 所有 `/api/*` 和 `/health` 端点
- **MCP Server**: `/mcp` 端点（Streamable HTTP Transport）

## 通用说明

### 请求格式

- 所有 POST 请求体为 JSON，`Content-Type: application/json`
- 所有响应统一格式：`{ "success": true/false, "data": {...}, "error": "..." }`
- API Key 认证：通过 `Authorization: Bearer <key>` 或环境变量 `PI_MEMORY_API_KEY` 配置

### 错误响应

| HTTP 状态码 | 说明 |
|------------|------|
| 200 | 成功 |
| 201 | 创建成功 |
| 400 | 请求参数错误 |
| 401 | 认证失败 |
| 404 | 资源不存在 |
| 500 | 服务器内部错误 |

---

## REST API 端点

### 健康检查

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/health` | 服务状态、版本、内存使用 |

**响应示例：**

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "version": "1.2.0",
    "uptime": 123.45,
    "memory": {
      "heapUsed": "45MB",
      "heapTotal": "78MB"
    }
  }
}
```

---

### 记忆管理（`/api/memory`）

#### POST `/api/memory/search`

混合检索记忆（Vector + BM25 + Rerank）。

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 搜索查询文本 |
| `limit` | number | 否 | 返回结果数量，默认 5，最大 50 |
| `scope` | string | 否 | Scope 过滤器（如 `global`、`agent:main`） |
| `category` | string | 否 | 类别过滤器（`preference`/`fact`/`decision`/`entity`/`other`） |
| `minScore` | number | 否 | 最低分数阈值 |

**请求示例：**

```bash
curl -X POST http://localhost:9873/api/memory/search \
  -H "Content-Type: application/json" \
  -d '{"query": "用户偏好设置", "limit": 5, "category": "preference"}'
```

**响应字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `results[].id` | string | 记忆 UUID |
| `results[].text` | string | 记忆文本 |
| `results[].category` | string | 记忆类别 |
| `results[].scope` | string | 记忆 Scope |
| `results[].importance` | number | 重要性 (0-1) |
| `results[].timestamp` | number | 创建时间戳 (ms) |
| `results[].score` | number | 综合分数 |
| `results[].sources` | object | 评分来源详情 |

---

#### POST `/api/memory/store`

存储新记忆。

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | string | 是 | 记忆文本 |
| `importance` | number | 否 | 重要性 0-1，默认 0.7 |
| `category` | string | 否 | 记忆类别，默认 `other` |
| `scope` | string | 否 | 记忆 Scope，默认 `global` |

**请求示例：**

```bash
curl -X POST http://localhost:9873/api/memory/store \
  -H "Content-Type: application/json" \
  -d '{"text": "用户偏好使用中文回复", "category": "preference", "importance": 0.9}'
```

---

#### DELETE `/api/memory/:id`

删除指定记忆。

**路径参数：**

| 参数 | 说明 |
|------|------|
| `id` | 记忆 UUID（支持 8+ 字符前缀） |

**请求示例：**

```bash
curl -X DELETE http://localhost:9873/api/memory/abc12345
```

---

#### PATCH `/api/memory/:id`

更新记忆。

**路径参数：**

| 参数 | 说明 |
|------|------|
| `id` | 记忆 UUID |

**请求体：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `text` | string | 新文本（修改后会重新向量化） |
| `importance` | number | 更新重要性 |
| `category` | string | 更新类别 |
| `metadata` | object | 更新元数据 |

**请求示例：**

```bash
curl -X PATCH http://localhost:9873/api/memory/abc12345 \
  -H "Content-Type: application/json" \
  -d '{"text": "更新后的文本", "importance": 0.8}'
```

---

#### GET `/api/memory/list`

列出记忆，支持分页和过滤。

**查询参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `limit` | number | 每页数量，默认 20，最大 100 |
| `offset` | number | 偏移量，默认 0 |
| `scope` | string | Scope 过滤 |
| `category` | string | 类别过滤 |

**请求示例：**

```bash
curl "http://localhost:9873/api/memory/list?limit=10&offset=0&category=fact"
```

---

#### GET `/api/memory/stats`

记忆统计信息和 embedding 缓存状态。

**响应字段：**

| 字段 | 说明 |
|------|------|
| `memories` | 记忆统计（按 scope、category 分布） |
| `embedding.model` | 使用的 embedding 模型 |
| `embedding.dimensions` | 向量维度 |
| `embedding.cache` | 缓存命中/失败统计 |
| `hasFts` | 是否支持全文搜索 |

---

### 知识库（`/api/knowledge`）

#### POST `/api/knowledge/search`

混合检索知识库（Vector + BM25 + RRF 融合 + Cross-Encoder Rerank）。

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 搜索查询文本 |
| `limit` | number | 否 | 返回结果数量，默认 20，最大 100 |

**请求示例：**

```bash
curl -X POST http://localhost:9873/api/knowledge/search \
  -H "Content-Type: application/json" \
  -d '{"query": "无人机控制", "limit": 10}'
```

**响应字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `results[].id` | string | 文本块 UUID |
| `results[].text` | string | 文本内容 |
| `results[].filePath` | string | 源文件完整路径 |
| `results[].fileName` | string | 源文件名 |
| `results[].fileType` | string | 文件类型 |
| `results[].chunkIndex` | number | 块索引 |
| `results[].score` | number | 综合分数 |
| `results[].sources` | object | 评分来源详情 |

---

#### POST `/api/knowledge/index`

重建知识库索引。

**请求体：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `incremental` | boolean | 增量索引，默认 `true`（设为 `false` 则全量重建） |

**请求示例：**

```bash
# 增量索引
curl -X POST http://localhost:9873/api/knowledge/index \
  -H "Content-Type: application/json" \
  -d '{}'

# 全量重建
curl -X POST http://localhost:9873/api/knowledge/index \
  -H "Content-Type: application/json" \
  -d '{"incremental": false}'
```

**响应字段：**

| 字段 | 说明 |
|------|------|
| `indexed` | 是否成功 |
| `incremental` | 是否增量模式 |
| `totalFiles` | 索引文件总数 |
| `totalChunks` | 索引文本块总数 |
| `log` | 最近 10 条索引日志 |

---

#### GET `/api/knowledge/stats`

知识库统计信息。

**响应字段：**

| 字段 | 说明 |
|------|------|
| `totalFiles` | 已索引文件数 |
| `totalChunks` | 已索引文本块数 |
| `files` | 文件列表（最多 50 条） |
| `knowledgePaths` | 知识库扫描路径 |

---

## MCP Server

MCP Server 通过 `/mcp` 端点提供服务，使用 **Streamable HTTP Transport**（MCP 2024-11-05 协议），无状态模式。

### 连接方式

```bash
curl -X POST http://localhost:9873/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"my-client","version":"1.0"}}}'
```

### 可用工具

#### `memory_search`

混合检索记忆。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 搜索查询 |
| `limit` | number | 否 | 最大结果数，默认 5，最大 50 |
| `scope` | string | 否 | Scope 过滤 |
| `category` | string | 否 | 类别过滤 |
| `minScore` | number | 否 | 最低分数阈值 |

---

#### `memory_store`

存储新记忆。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | string | 是 | 记忆文本 |
| `importance` | number | 否 | 重要性 0-1，默认 0.7 |
| `category` | string | 否 | 记忆类别，默认 `other` |
| `scope` | string | 否 | 记忆 Scope，默认 `global` |

---

#### `memory_forget`

删除记忆。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `memoryId` | string | 是 | 记忆 UUID（完整或 8+ 字符前缀） |

---

#### `knowledge_search`

搜索知识库。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 搜索查询 |
| `limit` | number | 否 | 最大结果数，默认 20，最大 100 |

---

#### `knowledge_index`

重建知识库索引。

**参数：** 无
