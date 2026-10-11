# Cursor 实际预检结论

2026-10-05（Asia/Shanghai）在更新后的 **2026.10.01-e373342** 上完成 6 次有限真实调用，默认模型实际显示为 **Grok 4.6 Extra High Fast**，未指定模型覆盖。6 次调用前后版本均一致；没有遗留已观测的测试进程。`summary.json` 的 10 项检查全部通过，当前及历史脱敏样本的离线断言也均通过。这里只证明列明的行为，不宣称所有工具、插件、平台和进程竞态均已覆盖。

| 检查 | 当前版本实测 |
|---|---|
| 非交互协议与目录 | 完整 NDJSON；init.cwd、真实 shell `pwd` 均为独立测试工作区；read 正向控制成功；exit 0 + terminal result。 |
| 精确续聊 | 显式 `--resume <本套session>` 成功回忆随机 nonce；续聊提示没有 nonce，期间没有文件/工具调用。 |
| 明确拒绝 | `--force` 下，临时原生项目配置的 Write/Shell deny 仍生效；分别观察到 `writePermissionDenied` 与 `permissionDenied`，原文件不变、shell marker 未创建；read 同时成功。 |
| 允许修改 | 文件编辑工具修改 `allowed.txt`；模型读回及测试脚本独立比对均通过。 |
| 完整取消 | 真实 shell 启动 15 秒心跳程序。对已观测且身份匹配的 CLI/后代逐个 SIGINT，CLI exit 130，无 terminal result，心跳保持为 1，全部已观测进程退出。信号后 38.75 秒再次检查，无 completion、无存活进程，已超过自然完成窗口。 |
| 取消后恢复 | 精确恢复同一取消会话，返回 `CANCEL_RECOVERY_OK`，没有工具调用或重启原命令。 |

## 推荐的 V1 启动和输出契约

使用 subprocess + stdout runner 即可，不需要模拟 TUI 或操作 Cursor IDE。实际验证的执行命令形状为：

```text
cursor-agent --print --output-format stream-json
  --workspace <absolute workspace> --trust --force
  [--resume <exact provider session ID>] <prompt>
```

父进程 cwd 也设为同一工作区。`--force` 仅用于用户已授权的执行策略；不能对所有任务无条件打开。保存从 init/result 取得的 provider session ID，并同时绑定 provider 和 workspace；不要用 `--continue` 或“最近会话”做并发 staff 的续聊。

V1 **不启用 `--stream-partial-output`**，没有验证它。按每个完整 assistant 消息段追加进度，最终报告优先取最后一个 assistant 消息；同时保留 terminal `result` 作为完成证据。实测 `result.result` 聚合了过程与最终回答，不等于最后一条回答。CLI 的结果只证明本轮终止；权限拒绝用例仍 exit 0、result success，需单独暴露拒绝事件，不能把它解释为任务目标完成。

`tool_call` 含 `readToolCall`、`editToolCall`、`shellToolCall` 等结构及额外元数据。使用 **原样的 `call_id`** 关联 started/completed；已观察到字符串内嵌换行，不能 trim 或当作物理日志行分隔。拒绝完成事件可能没有 args，或 path 为空，需通过 started 事件补充信息。未知工具类型、未知新增字段保留或忽略，不应让解析器崩溃。

当前版本实际输出 `thinking:delta/completed`；官方输出文档仍称 print 中不输出 thinking。适配器应忽略这些内容；脱敏 fixture 已只保留事件类型。失败/取消允许没有 terminal result；结合子进程退出、stderr 和本地 cancel_requested 状态判定，不能因为 stdout 结束就标记完成。[官方输出文档](https://cursor.com/docs/cli/reference/output-format)

## 权限配置契约

| 策略 | 单次 argv 能表达 | 需要原生配置/额外条件 |
|---|---|---|
| 工作区和模式 | `--workspace`；`--mode ask|plan`，默认 agent 模式 | 工作区路径不是操作系统级文件边界；Ask/Plan 不能被当作已验证的硬权限隔离。 |
| 自动执行 | `--force`（显式 deny 仍优先） | 没有本次验证过的 `--allow-tools`/`--deny-tools` argv。Read/Write/Shell allow/deny 依赖原生项目或全局权限配置。 |
| 信任和沙箱 | `--trust`、`--sandbox enabled|disabled` 是已发现选项 | trust 不等于读写限制；本次没有验证 sandbox 的文件/网络强隔离效果。 |
| MCP | 有 `--approve-mcps` | 本次未开启、未验证 MCP 权限隔离；不建议默认附加。 |

验证过的原生项目只读操作策略为：

```json
{"permissions":{"allow":["Read(**)"],"deny":["Write(**)","Shell(*)"]}}
```

它在本次 read/write/shell 对照中有效，但不是对所有 web/MCP/plugin 能力的完整安全隔离证明。测试只在新建临时工作区创建 `.cursor/cli.json`。新产品 **不应自动修改真实项目的 `.cursor/cli.json`**。要求强制只读时，应使用产品控制的独立工作区策略，或检查用户已有原生配置；若无法满足，明确标记不支持/拒绝启动，不能静默只加一句“不要改文件”。普通 native-policy 模式可以继承用户配置，但必须展示其保证范围。[官方参数](https://cursor.com/docs/cli/reference/parameters)、[官方权限](https://cursor.com/docs/cli/reference/permissions)

## 取消和版本边界

历史版本 **2026.09.02-c22c1a3** 上做过真实反例：只向 CLI 进程组 SIGINT，CLI 已退出，工具 Python 仍继续心跳；原因是 shell 位于另一个 PGID。随后按已记录身份清理，超过 90 秒自然完成窗口后确认没有 completion。历史反例保存在 `../fixtures/cursor/history/2026.09.02-c22c1a3/`，没有覆盖或伪装成新版验证。

历史反例的旧 harness 有一个阶段字段命名不准确，已在该历史目录 README 解释；原始 manifest 原样保留，断言以首个信号后的存活标志和实际进程身份为准。

新版完整取消测试仍观察到 shell 使用不同于 CLI 的 PGID，并观察到本次 CLI 自己启动的 worker-server/LSP 进程。新版未重复“只杀 CLI 组”反例，因此不能声称该单一步骤已修复或一定仍失败；推荐按已通过的完整策略实现：运行中持续登记本次后代身份，取消时再次采样，发送信号并验证退出；必要时只对同一身份升级 TERM/KILL。取消请求与停止完成是两个状态，必须在检查工具和后代退出后才标 cancelled。已经后台化、重父化、换 exec、观察间隙出生等竞态仍需生产实现处理。

旧版原始进程树保留了 CLI 自动启动的更新 `curl`/`tar`，没有屏蔽它。所查本地入口脚本和官方文档未发现可确认的禁用更新开关，不能编造 env/flag。官方确认默认自动更新；每次启动前及运行后记录版本，漂移时重新预检。[官方安装/更新说明](https://cursor.com/docs/cli/installation)

ACP、partial-output、跨版本 session 迁移、所有工具权限、操作系统 sandbox 和远程取消都未做本轮实际验证，不属于 V1 已证明能力。

## 证据位置

- 当前原始证据：`/private/tmp/agent-staff-preflight.fODiUI/updated/cursor/logs/`。
- 历史原始证据：`/private/tmp/agent-staff-preflight.fODiUI/cursor/logs/`。
- 当前脱敏样本：`../fixtures/cursor/current/`，`index.json` 映射每个源文件与 SHA256。
- 历史脱敏样本：`../fixtures/cursor/history/2026.09.02-c22c1a3/`。
- 便携脚本、重跑步骤与离线检查：同目录 `preflight.py`、`sanitize_fixtures.py`、`summarize.py`、`README.md`；断言入口为 `../fixtures/cursor/assert_fixtures.py`。
