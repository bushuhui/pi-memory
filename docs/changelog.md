# Changelog

> 主 Changelog 见项目根目录 `CHANGELOG.md`，此文件记录文档和架构变更。

## 格式说明

每次改动按以下格式追加到文件顶部：

```markdown
## YYYY-MM-DD — 改动摘要
- **范围**：涉及的模块
- **修改**：file_a.ts, file_b.py
- **接口变更**：如有则列出
- **备注**：破坏性变更、待办事项等
```

---

## 2026-05-09 — 文档体系初始化

- **范围**：文档体系
- **新增**：
  - `docs/architecture.md` — 项目架构总览（技术栈、目录结构、模块划分、依赖关系、数据流向）
  - `docs/api.md` — API 接口快速索引（指向 `server_mcp_api.md`）
  - `docs/changelog.md` — 本文档
- **更新**：
  - `docs/server_mcp_design.md` — 修正 API 路径（`/api/v1/*` → `/api/*`），补充"设计与实现差异"章节（SSE → Streamable HTTP 等）
- **备注**：
  - 设计文档中的 SSE 端点描述已标注为历史方案，实际实现使用 Streamable HTTP (`/mcp`)
  - 根目录 `CHANGELOG.md` 为主版本变更记录，持续维护中
