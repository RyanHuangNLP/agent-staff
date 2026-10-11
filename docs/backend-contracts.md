# 后端契约

2026-10-05，对应当前 PRD。共享原 AGY Staff 核心，一次只执行指定后端。参数实现见 companion/backend-adapters.mjs 与 agy-companion.mjs。

## 工作流

四个工具角色后台运行，ask 前台返回。共用短事务状态锁、原子结果文件、硬执行期限与软等待期限；没有长期工作树锁或跨员工调度。状态分别在当前 worktree 的 .agy-staff、.grok-staff、.cursor-staff；AGY 旧记录无需 backend 字段。

同会话运行中拒绝续聊，包括前台 ask 占用的会话。该占用记在 `foreground_sessions`，不是后台 job，调用返回后按持有进程清除。首次 ask 即使启动时还没有会话 ID，也在第一次收到该 ID 时登记，并在调用结束时释放。默认恢复该会话最新保存的 cwd、模型、effort、权限和 review JSON 输出格式，不按角色拆开，也不回退到同一会话里更早的后台 job。只有显式 `continue --job` 使用被选中 job 自己的模型、权限和输出格式。裸 `continue` 与 `continue --conversation` 继承会话上保存的格式要求。`implement --conversation` 因此继承该会话当前配置，除非本次显式覆盖。ask 即使继承到 unrestricted 记录也保持 restricted。通用 continue 要求已登记会话；角色 --conversation 允许调用原生已知 ID。最近任务只在当前后端选择。restart 用原任务新建会话，不回滚工作区。

输入预算保留 200 KiB。wait 默认 100 秒，技能通常传 10 分钟；到期退出 2，执行继续。省略 ID 时，wait 在开始时固定当时的最近任务，等待期间新启动的任务不会顶替它。后台默认 60 分钟、上限 120 分钟；ask 默认 2 分钟，保留原版可覆盖期限。wait、continue、status、result 必须使用启动该任务的同一员工入口。

## 原生映射

| 项目 | AGY | Grok Build | Cursor Agent |
| --- | --- | --- | --- |
| 程序 / 环境覆盖 | agy / AGY_BIN | grok / GROK_BIN | cursor-agent / CURSOR_BIN（兼容 CURSOR_AGENT_BIN） |
| 模型默认 | 原角色 Gemini 3.8 Flash effort | 原生默认 | 原生默认 |
| 工具角色 | dangerously-skip-permissions | bypassPermissions、workspace sandbox | force、trust |
| restricted | 不加 skip-permissions | dontAsk、workspace sandbox | 不加 force，保留 trust |
| ask | restricted，原 JSON 同步协议 | restricted，tools 空集合，禁 web search | restricted，提示要求无工具 |
| 后台输出 | stream-json | streaming-json | stream-json，无 partial-output |
| 新会话 | 原生 init/result | 宿主预分配 UUID、session-id | 原生 system/result |
| 续聊 | conversation | resume | resume |
| effort | 原模型规范化及别名 | reasoning-effort 原样传递 | 不支持独立 effort，使用原生 model |

Grok 禁用 leader、memory、subagents。Cursor trust 表示在用户交办的工作区运行；restricted 不等于不信任工作区。cwd 保留调用时的子目录，仓库根用于状态与模板上下文。

profile 表达操作意图，不是统一底层权限保证。普通任务调用不读取凭据、不写原生全局权限、不在失败后自动变更权限或后端。保留用户明确选择的 AGY setup --apply 全局配置例外。Cursor 项目 deny 与 force 的组合已有原生预检；Grok bypass 与 dontAsk 不应被视为同一策略。产品实测见实现报告。

ask 仅带问题模板，不自动读取仓库。零工具是用法约定与观测结果，不是 OS 隔离承诺。Grok/Cursor 若报告工具调用，会保留诊断并警告；AGY 前台 ask 的原生 JSON 未提供已验证的工具计数字段，因此本次零工具指标标为 unverified；不能从响应文字或轮数推断。

## 结果

AGY 保留旧结果处理；review --json 优先取原生 structured_output，缺失才取 response，并完整校验内置 review schema。Grok/Cursor 通过提示要求同一 JSON 格式并在本地校验，不声称原生 schema 强制。

Grok 按序累计 text.data，排除 thought；Cursor 只取最后一条完整 assistant 消息，聚合 result 留在原始日志。没有 assistant 时按空结果失败。工具 ID 不改写，包括换行。

新后端需要成功终帧、退出 0、非空正文、确认清理才算完成。失败所带部分文字保存在诊断。Grok max_turns_reached 优先分类 attention/turn_limit，不能因后续 cancelled 判成用户取消。

工具拒绝但原生最终成功仍可得到 done；job.permission_denials 和日志保留证据，调用方仍须验收产物。角色提示与 git guard 不能证明只读；意外改动须报告。

wait/status/observe 退出码：done=0、running=2、error/crashed=3、canceled=4、attention=5，调用错误=1。Grok/Cursor result 对已结束状态使用同样退出码；运行中收取 result 是调用错误，退出 1。AGY result 保留历史语义（已有结果通常=0、attention=5、缺结果报错）。cancel 确认停止后退出 0，不使用 wait 的 canceled=4。

## 取消与恢复

跟踪本次 CLI 及已观测后代的 PID、出生标记和父子关系，每次信号前核验身份，不按程序名批量杀进程。独立 PGID 工具仍按身份清理。进程树约 250 ms 观测一次，归属变化最多每秒持久化一次。

| 后端 | 信号与等待 |
| --- | --- |
| AGY | TERM 500 ms → KILL 500 ms |
| Grok | TERM 1200 ms → KILL 1000 ms |
| Cursor | INT 5000 ms → TERM 3000 ms → KILL 1000 ms |

已知身份消失才能确认清理。检查不可用、未知或存活时保留 attention/cleanup_unverified 与 executionMayBeActive，阻止同会话续聊。worker 异常退出后，管理命令核对记录身份；显式 cancel 可继续清理。

观测前已脱离父树的进程、远端服务生成及计费停止不在本地证据覆盖内，不承诺 OS 沙箱封闭。

## 日志与分发

后台保留 spec、结果和日志；无告警成功默认删除 events 与快照，异常、警告或 AGENT_STAFF_KEEP_LOGS=1 时保留；Grok/Cursor ask 成功默认清理临时诊断，异常或 AGENT_STAFF_KEEP_LOGS=1 时保留。原始任务材料仅在本地使用，.local 日志不随 npm 发布。

统一 CLI 和三个别名共享核心；独立插件由 build-plugins 复制相同核心、模板、参考和许可证，check-plugins 检查漂移。交付文件不会安装插件。

当前实测 macOS arm64。原 AGY 的 Windows、Pi、OpenCode 资源保留，新增两后端未做这些平台/宿主实测。当前基线 AGY 1.2.16、Grok 1.0.46、Cursor 2026.10.01-e373342，产品结果见 [实现报告](implementation-report.md)。
