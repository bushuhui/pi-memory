

## 2026-04-29

你仔细看一下这个项目，是 OpenClaw 的记忆插件。你看一下 /home/bushuhui/pi-lab/0_ai_agent/agents/hermes-agent  Hermes的代码，是否可以给本仓库增加 Hermes 的记忆插件，查知识库的时候可以调用本仓库的知识查询的功能。还是给本仓库增加一个 REST API，让 Hermes 或者 Claude Code调用？ 

按方案B来做。先不写代码，把技术方案想清楚。CLI启动脚本从 bin/pi-memory-server 改成 scripts/pi-memory-server
把详细设计方案保存为 docs/server_mcp_design.md


我修改了 docs/server_mcp_design.md 里面的一部分的内容，你重新读一下。
你可以仔细阅读 /home/bushuhui/.openclaw/openclaw.json 里面的 pi-memory 部分的设置项。然后改进 docs/server_mcp_design.md embedding等内容。

是否不使用单独的配置文件 `~/.config/pi-memory/pi-memory.json` ， 直接使用 ~/.openclaw/openclaw.json 里面的 pi-memory 部分的配置，这样更方便。

mcp 是否默认使用 sse 更方便？

HTTP server 是否可以和 MCP 的sse服务整合在一起？还是每个单独写？

HTTP server 和 MCP 的sse服务的端口可以共用一个

我修改了 docs/server_mcp_design.md 里面的一部分的内容，你重新读一下。


你仔细阅读一下 README.md ，把最近的新增的功能增加到说明文件。

你仔细阅读一下 git 的提交记录，把还没有更新到 CHANGELOG.md 的改进等，增加到 CHANGELOG.md


## 2026-04-30

scripts/index-knowledge.mjs 你仔细看一下这个程序。
- 遍历知识库目录的时候，能跟着符号链接进入下一级目录吧
- 你看一下 PI-LLM-Server 的API文档 /home/bushuhui/pi-lab/0_ai_agent/agents/pi-llm-server/doc/api.md 。你检查一下你们的程序，能否一次 embedding 调用，发送多段文字，让多个文字同时进行 embedding 计算 


## 2026-05-06

你仔细阅读一下 docs/lancedb.md ， 帮我在 scripts 目录写一个程序监控、优化 lancedb
- 查看当前片段数量
- 运行 `optimize()`



需要检索的文件的目录在 配置文件： pi-memory.config.knowledgePaths
const pluginConfig = config?.plugins?.entries?.["pi-memory"]?.config || {};
const extraPaths = pluginConfig.knowledgePaths || []; 

这里面 /home/a409/knowledge_base/research_projects 里面有特别多的文件，每次执行构建索引需要花非常多的时间。能否在程序增加一个命令行参数，单独对 某一个目录进行构建索引？
另外，构建索引最后的步骤中，只删除这次构建索引的目录，例如 pi-memory.config.knowledgePaths 列的目录，或者是用户通过命令行输入的目录。其他不在构建索引的目录里面的删除的文件不进行删除索引操作
你先不写代码，先把方案想清楚。



