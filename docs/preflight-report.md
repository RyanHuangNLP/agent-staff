> 这是实现前的原生 CLI 预检证据。后续产品按 [PRD](../PRD.md) 保留原版体验；本文的历史设计建议不覆盖新需求。产品验收见 [实现报告](implementation-report.md)。

# 开发前真实预检报告

日期：2026-10-05（Asia/Shanghai；部分原始 UTC 日志日期为 2026-10-04）。本轮证明三种原生 CLI 可以接入统一任务核心，并找出了必须在设计阶段处理的协议、权限和取消差异。它不证明尚未实现的 agent-staff 产品已通过。

## 1. 最新版本确认

先完成官方 CLI 更新，再在全新临时工作区重新测试。每个最终批次都有前后版本记录。

| CLI | 更新前实测版本 | 更新检查后的最终版本 | 最新确认 |
| --- | --- | --- | --- |
| AGY | 1.2.16 | 1.2.16 | `agy update` 返回已是最新，exit 0 |
| Grok Build | 1.0.25 | 1.0.46（2765805b9442）stable | `grok update --stable` 成功；`update --check --json` 返回 current=latest、updateAvailable=false |
| Cursor CLI | 2026.09.02-c22c1a3 | 2026.10.01-e373342 | 更新后二次 `cursor-agent update` 返回 Already up to date、exit 0；`agent` 与 `cursor-agent` 都指向新版本 |

Cursor 首次更新已安装新版本，但更新器尝试覆盖现有 `cursor` IDE 启动快捷方式时遇到 EPERM 并退出 1。检查确认 CLI 两个别名已更新，保留 IDE 的 `cursor` 链接；再次官方检查成功。没有把第一次非零退出忽略为成功。

环境为 macOS arm64，Node v26.8.2。AGY 最终批次仅在测试子进程设置官方 `AGY_CLI_DISABLE_AUTO_UPDATE=true`，没有修改全局设置。Cursor 原生自动更新曾在旧批次子进程中出现；未找到确认可用的关闭开关，因此记录每次版本而不虚构开关。这里的“最新”指该时刻各官方更新器为本机提供的版本。

最终共 18 次有界 CLI 调用：AGY 5、Grok 7、Cursor 6。Grok/Cursor 使用原生默认模型；Grok 观察到 `grok-4.7-build`，Cursor 观察到 `Grok 4.6 Extra High Fast`。AGY 显式使用 `gemini-3.8-flash-low`。不同任务可能发生多轮模型请求，“18 次”是 CLI 调用数量，不是模型推理请求或计费次数。

## 2. 最终真实测试矩阵

| 能力 | AGY 1.2.16 | Grok 1.0.46 | Cursor 2026.10.01-e373342 |
| --- | --- | --- | --- |
| 原生流及实际 cwd | 通过 | 通过；read 正向控制 | 通过；read 正向控制 |
| 明确 session 续聊 | 通过 | 通过，预分配 UUID | 通过，显式 resume |
| 随机 nonce 精确回忆 | 通过；续聊提示无 nonce，0 工具 | 同左 | 同左 |
| 实际 write/shell deny | 未测试 restricted 策略 | 通过；实际工具失败、目标文件不存在 | 通过；force 下仍受项目 deny 约束 |
| 允许后实际文件修改 | 取消/继续用例有真实 shell 修改 | 精确内容核验通过 | 精确内容核验通过 |
| 工具执行期间取消 | 通过；上游 runner 清理 | 通过；需 KILL 升级 | 通过；跟踪完整 owned 身份 |
| 取消后的显式续聊 | 通过；新任务成功，旧工具不复活 | nonce 回忆通过，0 工具 | nonce 回忆通过，0 工具 |
| 原生结构化 schema | 通过；structured_output 有效 | 未测试，V1 不暴露 | 未测试，V1 不暴露 |
| 轮数耗尽真实反例 | 未测试 | 已证实；不能当 success/canceled | 未测试 |

Grok/Cursor 权限验证不依靠模型口头描述：同时检查原生 tool denial、read 对照、退出状态与宿主文件存在性。AGY 本批全部调用是显式固定模型与 unrestricted（原生 always-proceed）；Cursor 本批全部调用带 `--force --trust`。这不验证计划中的 AGY native-default/restricted 和 Cursor force=false/trust=false 默认路径；这些路径在产品真实验收中单列。

## 3. 取消的实际证据

| 后端 | 触发条件与策略 | 超过自然结束窗口后的检查 |
| --- | --- | --- |
| AGY | 真实 shell 写入 entered marker；上游按进程身份 TERM→必要时 KILL | shell 进入后 103,193ms，超过 65,000ms 上限；无 completion、无记录进程、无 running job；entered 仅一次 |
| Grok | 真实工具写 started 和 heartbeat；核验 owned PID/birth 后 TERM，1,200ms 后仍存活则 KILL | 取消后额外等待 12,000ms，超过 10,000ms 自然时长；无 completion/存活身份；本次 CLI 最终 SIGKILL |
| Cursor | 真实工具写 PID/heartbeat；包括独立 PGID 子进程，逐个身份核验后 INT | 首次取消信号后 38.75s，超过 15s 自然时长；心跳停在 1，无 completion/存活身份；CLI exit 130 |

关键历史反例：Cursor 旧版本只向 CLI 进程组发送 SIGINT 时，CLI 已退出 130，另一个 PGID 的 Python 工具仍活着。随后按先前记录的准确 PID 和出生身份清理，延迟检查超过原工具 90 秒窗口后没有迟到写入。最终新版本测试验证了修正的完整进程身份策略，没有重跑有意制造孤儿的旧策略。

因此，产品取消完成的判据必须是“本地已观测 owned 执行清理确认”，不能只看父 CLI 退出。有限进程采样不证明任意脱离进程、外部服务或远端模型计费都停止；V1 明确排除共享 Grok leader 和外部常驻执行委派。

## 4. 影响设计的协议事实

- **Grok 的耗尽不能误判。** `--max-turns 1` 实际输出 `max_turns_reached`，随后 `end.stopReason=cancelled`、exit 1，前面只有“将读取文件”的过程文本。分类须优先保留 turn_limit；没有用户取消请求就不能标 canceled。
- **原生 success 不等于文件任务已达成。** Grok/Cursor 的工具被权限拒绝后仍可正常完成回答。结果应保留 permissionDenials；`done` 只代表 CLI 回合成功，调用者再验收业务结果。
- **三个文本投影不同。** AGY 优先原生 structured_output；Grok text.data 为 delta，按序拼成 turn_aggregate；Cursor result.result 聚合了过程文字，最终回答应取最后一条完整 assistant 消息。thought/thinking 不进入回答。
- **ID 必须准确保留。** Grok 已测流直到 end 才返回 sessionId，需在 spawn 前生成 UUID 并传 `--session-id`；AGY 新 init 的 conversation_id 位于顶层；Cursor tool call_id 可包含换行，不得 trim。
- **配置不能混用。** Grok 的 dontAsk/allow/deny、Cursor force/trust/原生项目权限、AGY unrestricted 是不同语义。项目不自动改写这些配置，也不在错误后提升权限。

## 5. 保留的历史失败

历史样本放在各后端 `validation/fixtures/**/history/`，原始批次放在 `.local/preflight/{agy,grok,cursor}/`；最终批次放在 `.local/preflight/updated/`。

除 Cursor 取消反例外，AGY 早期 schema 检查将观测日志写进工作树，触发 companion 的 git 改动告警，整份人类结果文件的 JSON.parse 因尾部告警失败。该次测试失败保留。后续离线检查证实原生结构化字段有效；最终更新后重新执行的便携 harness 将证据写在工作树外并通过。不能将修复后的通过状态倒填给旧失败。

## 6. 可交接程度与剩余验证

可以据此开始按冻结契约实现：调用方式、会话绑定、文本提取、已测权限、取消策略和重要失败映射均有实证与 fixtures。详见 [实施计划](../PLAN.md)、[后端契约](backend-contracts.md) 和 [验收矩阵](acceptance-matrix.md)。

尚未实施/验证的产品行为：共享状态和锁、崩溃恢复、硬 timeout、CLI 命令退出码、wrapper 并发、最终安装包和 skills。AGY restricted 拒绝、Cursor partial output/ACP、Grok streaming+schema、其他模型/版本/操作系统均不在本轮通过范围。Node 24 只是计划最低版本，本轮未跑 Node 24。

每个后端验证目录包含实测摘要、可移植脚本和来源哈希。原始证据不含从用户认证目录复制的凭据；原生输出仍可能包含会话标识和思考内容，因此仅本地保存。交接方不需要访问当前用户登录数据就能运行离线 fixtures；真实重跑使用其自身已登录 CLI。
