# Cursor CLI 预检

这些脚本只验证原生 CLI，不实现产品适配器。所有模型调用使用当前登录和默认模型，不指定 `--model`。每套验证必须使用新建的临时根目录；不会复用用户已有会话，也不会修改真实项目或全局配置。CLI 自身仍会保存测试会话，并可能执行其默认的后台自动更新。

## 重跑

需要 Python 3.9+、已登录的 `cursor-agent`（或 `agent`），以及本机读取进程身份和向本次进程发信号的权限。`--cli` 可明确指定已验证的 CLI 路径。下列相对脚本路径以本目录为当前目录；`PREFLIGHT_ROOT` 必须是全新临时目录。

```sh
PREFLIGHT_ROOT=$(mktemp -d /private/tmp/cursor-preflight.XXXXXX)
python3 preflight.py baseline --root "$PREFLIGHT_ROOT"
python3 preflight.py resume --root "$PREFLIGHT_ROOT"
python3 preflight.py deny --root "$PREFLIGHT_ROOT"
python3 preflight.py write --root "$PREFLIGHT_ROOT"
python3 preflight.py cancel_tree --root "$PREFLIGHT_ROOT"
python3 preflight.py cancel_resume --root "$PREFLIGHT_ROOT"
```

`baseline` 会拒绝已有工作区或状态文件。`resume` 只读本套测试自动保存的 session ID；随机 nonce 不写入工作区，也不进入续聊提示词。`cancel_resume` 优先恢复本套 `cancel_tree` 会话，并明确禁止重启被取消命令。`--timeout` 默认 150 秒；`--long-task-seconds` 默认 90 秒。取消测试会在读到真实工具 PID 和心跳后启动，无需等待自然完成。

在取消信号发出后超过脚本自然运行时间，再执行只读延迟观察；检查输出的 `past_natural_completion_window=true`，不足时稍后重跑观察，不新增模型调用。

```sh
python3 preflight.py observe --root "$PREFLIGHT_ROOT"
python3 sanitize_fixtures.py --raw-root "$PREFLIGHT_ROOT" --output-dir "$PREFLIGHT_ROOT/fixtures" --label CURRENT_VERSION
python3 ../fixtures/cursor/assert_fixtures.py --fixtures "$PREFLIGHT_ROOT/fixtures"
```

可选 `cancel` 是历史反例测试：只取消 CLI 进程组，再检查和精确清理逃逸的已记录工具 PID。常规重跑使用 `cancel_tree`，无需再次制造此反例。取消通过 PID、启动时间和命令身份验证，仅操作本次子进程；不使用进程名称批量杀进程。脚本记录实际信号及清理阶段。生产适配器仍需处理观察间隔内新建/重父化进程等竞态，不能把这份有限测试当成所有平台的进程隔离证明。

## 证据与隐私

原始 `logs/*.stdout.ndjson`、stderr、命令 manifest 和结果摘要只保存在本次 `--root`。它们不含读取到的凭据；fixture 生成器统一替换本机用户路径、临时根路径、测试 nonce 和 session ID，移除 thinking 内容但保留事件类型。`call_id` 是不透明字符串，包括其中的换行，必须原样保留。`index.json` 给出原始文件路径、原始和脱敏后 SHA256。

V1 明确不启用 `--stream-partial-output`，本预检也未验证该模式。默认 `stream-json` 的 assistant 事件按完整消息段处理；终端 `result.result` 可能包含进度和最终答案。`thinking` 和未知新增事件应忽略或仅记录类型。

## 权限与自动更新边界

单次 argv 可表达：`--workspace`、`--resume`、`--mode ask|plan`、`--force`、`--trust`、`--sandbox enabled|disabled`。其中 Ask/Plan 是模式选择，不是经过本预检证明的操作系统级只读边界；`--trust` 也不等于限制写权限。预检不使用 `--approve-mcps`。

Read/Write/Shell allow/deny 依赖原生 `.cursor/cli.json`（项目）或 CLI 全局配置。本预检只在新建临时工作区写项目配置，并实测 `--force` 仍受显式 deny 约束。新产品不应自动修改用户真实项目的 `.cursor/cli.json`；若用户要求强制只读，必须使用受控工作区内的明确策略，或检查用户已有原生策略并在不满足时明确拒绝启动，不能静默降级成提示词约束。

在旧版本真实进程树中发现 CLI 自行启动下载更新的 `curl`/`tar`。未调用 `agent update`，也未隐藏该行为的证据。官方安装文档确认默认自动更新；本地入口脚本及所查官方文档未提供可确认的禁用 flag/env。不要猜测开关。每次前后记录 CLI 版本；如果发生版本漂移，不能把旧协议结论默认为新版本通过。

官方参考：[参数](https://cursor.com/docs/cli/reference/parameters)、[输出格式](https://cursor.com/docs/cli/reference/output-format)、[权限](https://cursor.com/docs/cli/reference/permissions)、[安装与自动更新](https://cursor.com/docs/cli/installation)。最新实测结论以同目录 `summary.json` 和 `findings.md` 为准；`history/` 是历史证据。
