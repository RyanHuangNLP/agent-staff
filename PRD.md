# agent-staff 产品需求

## 0.9.0 扩展：Codex CLI

在原三后端基础上增加第四个可选员工 Codex CLI：统一入口接受 `--backend codex`，新增 `codex-staff` 别名、`.codex-staff` 独立状态和 `$codex:<角色>` 七类插件入口。继续复用原有任务、等待、续聊、取消与配置继承流程；不增加跨员工调度。

Codex 使用原生默认模型，支持显式模型和 reasoning effort；通过 `exec --json` 的线程、回合和 item 事件取证，显式 ID 续聊，结构化审查使用原生 schema 与本地校验。新功能的验证范围记录在 [Codex CLI 支持](docs/codex-support.md)，本轮不消耗真实模型额度。下文保留 0.8.0 的原需求与真实验收标准，不能据此宣称 Codex 已完成真实模型验收。

版本：2026-10-05 修订。本文优先于先前以统一接口为由收缩原功能的设计。

## 1. 用户目标

**保留原版 agy-staff 的使用方式，增加 Grok Build 和 Cursor Agent 两种可选择的员工。用户每次通常只调用一个 staff，staff 之间不需要相互协作。**

用户继续使用“交办任务 → 等待 → 收取结果 → 继续追问”的流程。选择 AGY、Grok 或 Cursor 只决定该次任务由哪个 CLI 执行，不启动其他员工，不自动切换后端，不引入跨员工讨论、任务分发平台或后台调度器。

原项目基线：agy-staff 0.7.4，提交 `9a30e0774de09e0815c4fc5caf456472f8fc3509`。保留其 MIT 归属。

## 2. 用户入口与角色

每个员工均提供七类技能：`lead`、`staffer`、`researcher`、`reviewer`、`implementer`、`ask`、`jobs`。Codex 名称分别为 `$agy:<角色>`、`$grok:<角色>`、`$cursor:<角色>`；保留 AGY 原名称。

| 入口 | 用户得到的行为 |
| --- | --- |
| staffer | 通用任务，任务本身决定工作和输出；可以使用该员工的原生能力 |
| researcher | 取证、调研，说明来源、结论与未验证事项 |
| reviewer | 审查代码或方案；代码问题给出位置、条件、影响，一般审查检查假设和取舍 |
| implementer | 在当前工作区完成范围明确的改动与验证，保留用户已有改动 |
| ask | 简短的一问一答，在当前调用中返回答案，不让用户先管理后台 job |
| jobs | 通过自然语言或 CLI 等待、查看结果、取消、继续和重新开始 |
| lead | 当前 Codex 跟进选中的一个员工，负责简报、验收、追加任务与整合交付 |

`lead` 不是新的 CLI 执行模式。它默认把适合委派的工作交给当前员工；结果有实质缺口时继续同一会话，主 agent 保持与用户沟通和最终判断。没有用户要求时不换员工、不为一次任务自动招募其他员工。

直接调用角色时，主 agent 保留用户任务、约束和已给授权，不先完成整项工作再伪装成委派。短结果原样交付；长结果可摘要并链接完整文件，不能改写关键结论、数值或错误。lead 场景允许主 agent 验收和综合。

## 3. 保留原体验的具体要求

### 任务执行与等待

- staffer/research/review/implement 返回后台 job；ask 前台输出答案。任务执行与用户是否查看进度无关。
- 默认派发后等待；收到用户进度问题或失败诊断需要时再 observe，不自动轮询进度做例行汇报。
- 裸 wait 默认 100 秒；技能可使用 `--timeout 10m`。等待到期返回 running，执行继续。
- 后台执行默认 60 分钟，最大 120 分钟；ask 默认 2 分钟，保留原版可覆盖期限。执行超时和等待超时分开。
- 保留 prompt/prompt-file/stdin 三种输入，任务正文不被重新解释为 flags；原 200 KiB 输入预算不缩小。

### 默认模型与权限

| 员工 | 默认模型 | 常规四种工具角色 | ask |
| --- | --- | --- | --- |
| AGY | ask=Gemini 3.8 Flash low；staffer/review=medium；research/implement=high | 原版 unrestricted，无需先 setup | question-only、restricted、前台 |
| Grok | 当前 CLI 默认，可用 --model 覆盖 | 默认可非交互使用工具，具体由 Grok 适配器映射 | question-only、restricted、前台 |
| Cursor | 当前 CLI 默认，可用 --model 覆盖 | 默认可非交互使用工具，具体由 Cursor 适配器映射 | question-only、restricted、前台 |

保留 `--restricted`/`--unrestricted` 和继承规则。不同后端的 profile 表达共同操作意图，不声称原生权限机制完全相同。显式 deny、组织规则、操作系统限制的实际效力，以该 CLI 实测为准；不能通过失败重试偷偷提权。

AGY 保留 --effort、flash/pro 模型别名和原规范化规则。Grok 可使用本地 CLI 支持的 reasoning effort；Cursor 不把 Gemini effort 后缀硬套到模型上，不支持的单独选项给出明确错误。

ask 保留“不使用工具回答问题”的产品约定：只传问题与问答模板，不把仓库上下文自动混入。普通 smoke 必须观察到零工具事件。原 AGY 的实现是提示词约定加 restricted，不是操作系统强禁工具；新产品也不能夸大为沙箱隔离保证。发生工具活动必须保留诊断，不把异常说成已验证的零工具调用。

普通调用不改全局权限。保留用户主动选择的 AGY setup：默认预览，全局 apply 需要明确授权、备份并保留已有规则；`setup --restrict` 只设置所选员工的仓库角色策略。Grok/Cursor 不复用 AGY settings 路径，也不自动生成它们的全局允许列表。

### 续聊与任务选择

- “继续刚才的任务”可用；保留通用 continue、角色 --continue、--conversation、continue --job、restart。
- 最近任务和会话只在当前员工、当前 worktree 中选择；角色 --continue 进一步按角色筛选。
- 未显式覆盖时继承目标会话的模型与权限；显式 model/effort/profile 覆盖仍允许，不能要求每次重新开会话。
- 通用 continue 的指定会话必须已登记；角色显式 --conversation 保留原 AGY 的原生会话用法。
- wait/observe 可省略 ID 选择该员工最近 job；result 可选择最近已结束 job；明确 ID 优先。自然语言用户不需要手工记 ID，技能负责跟踪。
- 同一会话仍在运行时拒绝续聊；不排队，也不跨员工寻找碰巧相同的 session ID。
- restart 使用原任务、新原生会话和当前工作区上下文；不撤销此前文件改动。

### 工作区与状态

- 保留 AGY 的 `.agy-staff` 状态、历史会话和仓库策略；Grok/Cursor 分别使用 `.grok-staff`、`.cursor-staff`，结构共用、记录隔离。
- 不增加“同目录所有任务一律串行”的新限制。原有同会话占用检查与短事务状态锁保留。
- 当前产品面向通常一次一个员工；如用户显式并行，沿用原 lead 规则：同目录读任务可并行，编辑任务顺序执行或使用独立 worktree。角色名称不构成强只读证明。
- implement 可以在 dirty 或非 Git 工作区运行；原有改动必须作为用户工作保留。默认交付可审阅 diff；用户明确要求的 commit/push/PR 可在其授权范围内执行。

## 4. 后端接入要求

共享任务核心和技能流程；适配器负责参数、模型差异、原生事件、session 和停止策略。直接 CLI 的原始输出保持原样，不能把自造事件当成 CLI 证据。

- Grok：text.data 按序累加；思考内容不混入答复；新会话预分配 UUID；轮数耗尽不能当成功或用户取消。
- Cursor：使用最后一条完整 assistant 消息作为答复；result 的聚合文本不重复拼接；tool ID 作为不透明字符串保留。
- 权限拒绝即使伴随成功终态也须保留诊断，主 agent 根据真实产物验收。
- 取消必须核验本次已观测的进程身份并清理工具后代；只有 CLI 退出不构成取消完成。

## 5. 本次交付与不包含的工作

交付统一 CLI、三个员工别名、三个员工的七类技能、原 AGY 兼容入口、中文说明、原测试回归、新后端离线测试、打包检查和真实 smoke。使用现有 CLI 登录，不在安装时强制改模型或原生权限配置。

不引入跨员工合作、自动员工路由、任务 DAG、自动 worktree 创建、远程服务或 GUI；不在本轮发布 npm 包、推送代码或代替用户安装/覆盖已安装的 Codex 插件。AGY 原有其他宿主资源可以保留，新增两后端首先验收当前 Codex/macOS 使用场景，不宣称未测平台已支持。

## 6. 完成标准

原 AGY 回归通过；三个员工均能从交付入口完成问答、后台任务、结果收取和继续对话；Grok/Cursor 的权限和真实工具取消覆盖安装产物；skills 在独立安装目录能找到完整 runtime；没有把另外两个员工启动起来；原参考仓库未修改。

先前预检的 18 次调用只证明原生 CLI 接入前提。新版默认 profile、ask 和最终 wrapper 的行为必须重新记录实测。未通过的能力应准确标注为失败或待验证，不能靠修改 PRD 降低已确认的用户要求。
