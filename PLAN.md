# agent-staff 实施计划（按原版体验修订）

2026-10-05。产品要求以 [PRD](PRD.md) 为准。用户已授权开始实现，并明确每次通常只调用一个 staff，staff 之间不协作。此前全工作树串行、强制显式 job、统一 native-default 模型和默认收紧权限的设计已撤回。

## 实现原则

1. 复用 agy-staff 0.7.4 的 companion、状态锁、模板、角色和任务管理；保留 AGY 原入口与 `.agy-staff` 历史状态。
2. 在共享核心上增加 backend 维度，Grok/Cursor 使用独立状态目录，不复制三套手工维护的核心。
3. 单次调用只选择一个后端，不自动调度其他员工。lead 是主 agent 对当前员工的跟进说明，不是新 worker 模式。
4. 参数和原生流差异由 adapter 处理；原始输出留作诊断。新的工具拒绝、轮数耗尽和取消错误不能被普通文本掩盖。
5. 扩展功能不得删除原来的便捷用法：最近任务、角色续聊、显式会话、模型/权限覆盖、前台 ask、可选 setup 均保留。

## 目录与职责

| 路径 | 职责 |
| --- | --- |
| bin/entry.mjs | 后端选择、帮助、版本、本地 doctor |
| bin/{agent,agy,grok,cursor}-staff.mjs | 统一入口和三员工别名 |
| companion/agy-companion.mjs | 原入口及共享角色、状态、后台 worker、任务命令 |
| companion/{grok,cursor}-companion.mjs | 独立插件可使用的薄入口 |
| companion/backend-adapters.mjs | 后端 argv、原生事件投影、结果字段和停止策略 |
| companion/stream-worker.mjs | 原始流、超时、owned 进程跟踪、取消和清理 |
| companion/observation.mjs、state-lock.mjs | 有界进度、NDJSON、原子文件与短事务锁 |
| templates/、skills/ | 原 AGY 角色与共享模板 |
| scripts/build-plugins.mjs | 从同一个核心生成自包含 Grok/Cursor 插件包 |
| plugins/{grok,cursor}/ | 生成的七角色入口和安装所需 runtime，禁止手工维护副本 |

Grok/Cursor 原生默认模型由 CLI 决定；AGY 保留原角色模型和 effort。ask 固定 question-only/restricted；普通四角色默认工具可用，不要求每次先 setup。具体权限映射见 [后端契约](docs/backend-contracts.md)。

## 阶段与验收

| 阶段 | 交付与检查 |
| --- | --- |
| P0 兼容基线 | 写明PRD；复制并归属上游来源；原AGY行为回归 |
| P1 原生接入 | 两后端参数/解析/状态隔离；最新真实fixture回放 |
| P2 完整任务流程 | 前台ask、后台任务、最近/指定续聊、取消、恢复和错误保留 |
| P3 分发入口 | CLI别名、7角色插件包、生成一致性、独立目录可运行 |
| P4 真实验收 | 经产品入口执行三后端小任务；新增默认profile、ask、会话及真实shell取消 |
| P5 交付 | 同步文档与运行记录、打包检查、无残留测试执行、原参考项目未修改 |

先运行原 AGY 与新后端离线测试，再运行有界真实调用。失败保留原始输出，不更换后端、模型或权限凑出通过。测试只操作新临时仓库及本次启动进程。具体用例与证据见 [验收矩阵](docs/acceptance-matrix.md)。

## 兼容和工程边界

AGY原版的result/cancel退出语义、状态格式、model aliases、optional setup和200KiB输入预算保持兼容。Grok/Cursor的管理命令应准确报告各自的失败状态；不能把“保留原体验”理解为复制原生协议字段或隐瞒新后端失败。

工作区仍由原版方式管理：同会话不可并行续聊，独立会话可并行；主agent通常只运行一个员工，显式并行编辑用独立worktree。短状态锁保护登记，不做全工作树长期执行锁。

当前环境为macOS arm64。其他平台的原AGY代码保留，不把它等同于Grok/Cursor已经通过跨平台验收。发布、全局安装、修改CLI登录及组织策略不属于本次实现步骤。
