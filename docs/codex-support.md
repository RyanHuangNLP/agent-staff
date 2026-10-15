# Codex CLI 支持

0.9.0 增加第四个后端 `codex`，保留 AGY、Grok 和 Cursor 的入口与状态。适配依据为 [Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)和 [CLI 命令参考](https://learn.chatgpt.com/docs/developer-commands?surface=cli)，本机参数检查使用 Codex CLI 0.142.0。

## 使用

在待处理项目目录运行源码中的 `bin/codex-staff.mjs`，或给统一入口传 `--backend codex`。使用现有 Codex CLI 登录，不需要把凭据复制到项目里。`CODEX_BIN` 可指定可执行文件路径。

```sh
node /absolute/path/to/agent-staff/bin/codex-staff.mjs doctor
node /absolute/path/to/agent-staff/bin/codex-staff.mjs ask --prompt "解释这个方案的取舍"
node /absolute/path/to/agent-staff/bin/codex-staff.mjs implement --effort high --prompt "修复输入校验并验证"
node /absolute/path/to/agent-staff/bin/codex-staff.mjs wait --timeout 10m
node /absolute/path/to/agent-staff/bin/codex-staff.mjs continue --prompt "补充回归测试"
```

独立插件为 `codex@agent-staff`，包含 `lead`、`staffer`、`researcher`、`reviewer`、`implementer`、`ask`、`jobs`。例如 `$codex:reviewer 审查当前改动` 会把任务交给独立的 Codex CLI 进程。普通宿主 Codex 工作不需要调用这个插件。安装方法见 [README](../README.md)。

## 原生调用与结果

| 项目 | 行为 |
| --- | --- |
| 执行 | `codex exec --json`；任务从 stdin 传入，支持原有 200 KiB 输入预算 |
| 工作目录 | 保留调用时的子目录；非 Git 工作区使用 `--skip-git-repo-check` |
| 默认模型 | 不传 `--model`，沿用原生模型配置；显式模型 ID 原样传递 |
| 推理强度 | `--effort` 对应单次 `-c model_reasoning_effort=...`，可用值由所选原生模型决定 |
| 默认工具角色 | unrestricted，对应 `--dangerously-bypass-approvals-and-sandbox` |
| restricted / ask | `--sandbox read-only`、`approval_policy=never`；ask 提示要求不使用工具 |
| 新会话 | 从 `thread.started.thread_id` 记录；未拿到 ID 不伪造会话 |
| 续聊 | `exec resume <保存的 ID>`，不使用 `--last`；模型、effort、权限和 JSON 格式按既有规则继承 |
| 状态目录 | 当前 worktree 的 `.codex-staff`；与其他三个后端隔离 |
| 结构化审查 | `review --json` 生成原生 `--output-schema` 文件，再执行共享的结果校验；无位置的 finding 使用空字符串 `file`、`line` |
| 结果 | 最后一条完整的 `agent_message`；排除 reasoning、带 commentary phase 的消息和未完成快照 |
| 完成 | `turn.completed`、非空正文、已记录会话 ID、CLI 退出 0、进程清理确认；缺一项都不报告成功 |
| 失败 | `turn.failed` 保留错误与部分答复；连接重试诊断保留为告警，最终状态以终帧为准 |
| 工具 | 记录命令、文件更改、MCP、搜索等 item 的状态；明确的权限拒绝保留在诊断中 |
| 取消 | 仅清理本次已核验身份的进程及已观测后代；INT 1500 ms → TERM 1000 ms → KILL 1000 ms |

ask 的无工具要求属于使用约定。read-only sandbox 仍允许读取文件，原生 CLI 也可能加载自己的项目指令与已配置工具；不能把它称为严格的零工具隔离。有工具活动时保留日志并提示。原生完成也不证明业务目标已达成，调用方仍需检查实际产物。

## 本机配置兼容

部分桌面版本会在用户 `config.toml` 中写入 `[features.context_management]` 表，CLI 0.142.0 则要求该值为布尔类型。适配器检测到这个表时，为子进程追加 `-c features.context_management=false`。覆盖只作用于本次调用，不重写配置，不使用 `--ignore-user-config`，其余模型、provider、登录与规则继续由原生 CLI 加载。普通布尔配置保持不变。

这是明确的单项兼容处理，不会在模型、登录或权限错误后自动更换后端或放宽权限。

## 验证范围

离线测试使用假 CLI，覆盖四种后台角色、前台 ask、首次会话占用、跨角色续聊、最新配置优先级、显式旧 job、JSON 格式继承、固定 wait 目标、失败终帧、权限拒绝、取消和 worker 异常恢复。Codex 专项还覆盖长 stdin 输入、启动时关闭 stdin、缺失会话 ID、非零退出、重试后恢复和复制到独立目录的插件运行。

2026-10-15 本机完整回归为 283/283 通过；7 个 Codex 技能通过技能格式校验，生成器核验 87 个独立插件文件无漂移。CLI 参数检查涵盖新会话和显式续聊各自的 restricted / unrestricted 组合。

本轮未调用真实模型。真实模型质量、当前账户与模型的可用性、Codex 原生工具和 sandbox 的实际执行效果仍需单独实测；离线假工具的清理通过不等同于真实 Codex 工具进程的清理验收。其他后端的历史真实测试见 [实现报告](implementation-report.md)，不能替代 Codex 的真实验收。
