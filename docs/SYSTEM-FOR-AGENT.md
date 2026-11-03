# System For Agent 顶层设计

本轮依据 2026-11-02 用户裁定：**Agent 自主性优先。系统服务于 Agent，代码提供可靠能力与可核验事实；任务拆解、流程选择、协作方式、执行顺序和纠偏由 Agent 决定。**

## 一 责任边界

| 层 | 负责 | 决策归属 |
| --- | --- | --- |
| CompanyDomain | 身份、业务事实、版本、证据一致性 | 校验事实是否成立；不选择 Agent 的下一步 |
| CompanyStore 与 mutation completion | 原子文件、Git、请求完成与局部失败续做 | 不推断任务是否完成 |
| Agent profile | 安全读取与合并 CLAUDE、saved/applied 配置 | 稳定边界由系统定义；长期记忆和工作方法由 Agent 维护 |
| AgentService 与 notices | 唤醒固定 Session、投递简短事实通知、呈现接受状态 | 收到通知后是否及如何工作由 Agent 决定 |
| PeriRuntime | 固定会话、SDK 激活、本地 Workspace（无 OS 沙箱）、有限幂等缓存 | 并发工作由 Peri multitasks/work 执行 |
| Agent context view | 有界工作摘要、按 ID 取正文、历史分页 | Agent 自主决定读取哪些正文与历史 |

CompanyDomain 保留公共应用边界。新增模块按以上责任提取，不按单个 bug 临时堆 helper，也不引入自动流水线引擎。

## 二 不变量

1. 完成回执代表业务操作与约定提交已经完成；Git 失败后同请求可继续完成，不重复业务写入。
2. 一个 Agent 对应一个固定 Session。权威 binding 统一投影；隔离校验失败绝不能伪装成缺失或恢复成功。
3. saved 配置只在显式成功重启后生效。成员职责的即时更新使用 applied instructions，CLAUDE 自由记忆始终保留。
4. 任何修改 Issue 的操作都校验当前 owner，包括 Preview 批次移除。验收/验证必须关联当前代码，接受通知不推进状态。
5. Agent 目录可写文件不是宿主可信输入；宿主记忆读取使用文件描述符验证，不跟随链接。
6. 输入、消息与历史不无限复制进默认上下文。完整正文有按需读取入口。
7. 新建工单、指派信息更新、明确答复产生事实通知，通知携带稳定 ID 与原始对象引用；不自动执行 plan/code/preview，不把通知当作完成。Agent 自己已知的操作结果不再回送给自己。
8. 不引入临时数据库表、每 Issue Session、新 Agent 调度器或新的审批流程；保持 WASM 运行时。

## 三 本轮代码方向

- 提取 mutation completion，复用现有 events/requests 记录表达未完成提交；初始化复用已确认的 Agent/Session，补齐花名册。
- 提取安全 Agent memory/profile 模块；先验证再更新，统一 applied instructions 与 CLAUDE 的生效路径。
- AgentService 使用权威 runtime binding；运行时区分缺失与 cwd 不符，控制内部投递缓存生命周期。
- 应用入口通过单一 work notices 服务处理工单变化与答复通知，保留现有 IM。通知失败不篡改已提交的业务事实，状态可见且同一通知可安全重试。
- MCP 的 Agent 工作清单采用有限摘要与分页，正文仍通过 getIssue；所有者工作台保持现有数据读取兼容。
- 修复所有者文件视图 UTF-8 流式解码；不改变已裁定的所有者文件访问能力。

## 四 上下文使用契约

新工作到来时，Agent 读取当前 CLAUDE profile、目标 Issue 与流程文件，自主确定行动。multitask/work 带 Issue ID、当前版本和工作目录等最小定位信息；迟到结果回写前重读当前 owner/status。任务判断来自最新业务事实，历史聊天只作参考。

新 Session 的固定系统提示词只说明身份、稳定操作边界和如何获得当前事实。当前职责、专属指导与已应用 instructions 统一来自 CLAUDE；已有 Session 不重建、不改写冻结历史。配置与业务正文不在每条输入中重复灌入；事实通知仅传引用和变化原因。

工作清单、参与的 IM 线程和 Preview 都保留有界索引；未回复的发出线程与历史 Preview 也可重新发现。裁剪正文不能裁掉发现入口。所有者运行面板展示最近通知状态，只有确定未接收的通知允许显式重试；接收结果不明时先核对会话和队列。

### 公司资产 skill（只读 MCP 资源）

公司资产的操作边界由 `company-assets` skill 说明。源文件是应用仓库的 `templates/skills/company-assets/SKILL.md`，通过已有的 `company_org` MCP 挂载为只读 resource：`skill://company-assets/SKILL.md`。MCP 客户端用 `resources/list` / `resources/read` 读取，Agent 侧保证路径是 `mcp_read_resource(server_name="company_org", uri="skill://company-assets/SKILL.md")`；Peri 若把它纳入技能目录，则用 catalog 中的精确名称（可能是 `company-assets` 或 `company_org:company-assets`）调用 `SkillTool`，这是 best-effort。

没有每 Agent 的 skill 文件、没有 Agent Git 版本化、没有 `.mcp.json` 迁移。MCP resource 是动态的，旧 Session 不需要重建；旧 Session 通过 `CLAUDE.md` 托管块的新 section 获得 URI 指针，刷新脚本只更新托管块。新 Session 的冻结系统提示词只保留短指针，完整分类与规则在 `SKILL.md`：公共事实走三个 Company MCP；公共知识走 `knowledgebase/` 普通 Markdown（无 CAS、无自动 commit，需要版本化时由 Owner 通过文件视图提交）；公司定义 Agent 只读；Agent 私有内容留在自己的 Workspace；宿主秘密与凭据不读、不复制、不写。该 skill 是产品约定，不授予权限，不是 OS ACL。

## 五 验证边界

验证以用户行为与边界不变量为中心：失败重试、交接后权限、保存与重启顺序、固定 Session 投影、事实通知接受、有界读取及文件完整性。测试替身只用于明确的外部边界，结果区分宿主控制流测试与真实 WASM/模型验收。
