# 用户最终裁定

## 2026-10-30 08:07:59 UTC — 移除 Forgejo

> 移除 forgejo，应该跟他没有关系，我们不基于它，完全自己做

此裁定覆盖原始 `IMPLEMENTATION-HANDOFF.md` 中所有 Forgejo 相关描述。当前产品不依赖 Forgejo，不包含 Forgejo 配置、`forgejo_issue` 字段、外部 Issue 同步或“待接入”事项。Company 自己管理组织、Issue、评论、流水线、验收与验证。保留本地 Git 管理公司资料、Agent 个人资料和项目代码。

原始附件只作为设计来源原样保留，不代表被覆盖部分仍然生效。

## 2026-10-30 08:41 UTC — 通过接口模拟用户验收，不使用浏览器

> 通过 接口的模拟用户验收试验就好了，浏览器不用

最终验收采用真实 HTTP / MCP 接口的模拟用户端到端流程，不要求浏览器启动、截图或视觉验证。保留前端 TypeScript 检查、生产构建与 UI 状态单元测试。接口验收不能用 Domain-only 调用或伪造运行结果替代。

## 2026-10-31 — 移除文件区域的安全限制

> 提交你的代码，然后进入下一个开发项目，移除文件区域的所有安全限制让用户能够顺畅看到数据。

所有者工作台的「文件」区不再受 Agent / 公司知识根白名单约束：

- `WorkspaceViewAdapter` 可列出、读取、搜索、保存本机任意绝对路径；不再拦截 `agent.yaml`、`.mcp.json`、`.env`、`.git` 内部文件与硬链接。
- 文件视图自行启动的官方 Workspace MCP 不经过 `sandboxCommand`，因此 macOS/Windows 默认可用，也不再依赖 `COMPANY_SANDBOX=disabled`。
- 文件区新增「公司数据」「用户主目录」「文件系统」入口，并支持输入任意路径跳转。
- 本裁定只涉及所有者文件视图；Agent 自身工具调用的 Workspace MCP、宿主 Git 仍保持原隔离策略。
