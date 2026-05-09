# API 接口定义

pi-memory 的 API 接口文档见 [`server_mcp_api.md`](./server_mcp_api.md)。

## 快速索引

### REST API（单端口双协议）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 服务状态检查 |
| `/api/memory/search` | POST | 记忆混合检索 |
| `/api/memory/store` | POST | 存储新记忆 |
| `/api/memory/:id` | DELETE | 删除记忆 |
| `/api/memory/:id` | PATCH | 更新记忆 |
| `/api/memory/list` | GET | 记忆列表 |
| `/api/memory/stats` | GET | 记忆统计 |
| `/api/knowledge/search` | POST | 知识库搜索 |
| `/api/knowledge/index` | POST | 知识库索引 |
| `/api/knowledge/stats` | GET | 知识库统计 |

### MCP 工具

| 工具名 | 说明 |
|--------|------|
| `memory_search` | 混合检索记忆 |
| `memory_store` | 存储新记忆 |
| `memory_forget` | 删除记忆 |
| `knowledge_search` | 搜索知识库 |
| `knowledge_index` | 重建知识库索引 |

### 默认配置

- **端口**: 9873
- **协议**: REST API + Streamable HTTP (MCP)
- **认证**: 可选 API Key (`Authorization: Bearer <key>`)
