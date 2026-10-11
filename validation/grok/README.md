# Grok 真实预检

最终批次：Grok 1.0.46 stable，macOS arm64，Node 26.8.2。官方 `grok update --check --json` 确认 current=latest=1.0.46。1.0.25 是更新前历史，不作为最新支持基线。

这只是直接 CLI 接口探针，不是 agent-staff 产品实现。使用现有登录和配置默认模型，本轮 `grok models` 显示 `grok-4.7`，流中的 modelUsage 为 `grok-4.7-build`。

## 重跑

先确认 `grok models` 已登录且有可用模型，再使用新的独立证据目录。脚本要求显式 opt-in；每阶段最多 120 秒，最多 4 个 agent turns（轮数耗尽用例为 1），有界启动共 7 次模型调用。

```sh
GROK_TEST_ROOT="$(mktemp -d /private/tmp/agent-staff-grok.XXXXXX)"
for phase in seed resume deny allow cancel cancel-resume limit; do
  AGENT_STAFF_LIVE=1 AGENT_STAFF_PROBE_ROOT="$GROK_TEST_ROOT" \
    node validation/grok/probe.mjs "$phase" || break
done
```

从交付目录运行。需要网络、已有 CLI 登录、`ps` 和对本次启动进程发信号的权限；使用普通 macOS 本地终端即可，不要放在阻止进程检查的额外命令沙箱内。脚本不执行 login，不读取凭据内容，不修改全局权限。

seed 创建新随机 session UUID/nonce；已有 seed 状态会拒绝。后续阶段只引用该测试保存的会话。提示和 nonce 记录在工作区外；续聊提示不携带 nonce，实际流中也不调用读取工具。

## 已验证

1. 原生 streaming-json 中的 read 正向控制、文本增量和 `end/end_turn`。
2. 精确 `--resume UUID` 回忆随机 nonce。
3. `dontAsk` + 原生 allow/deny：实际 write 和 shell 调用被拒，read 成功，目标文件不存在。
4. 显式允许写工具后写入精确的测试内容，并从宿主核对。
5. 工具写 started marker 后，按 owned PID+birth 身份停止 CLI 和工具；超过 10 秒自然完成时间再检查无 completion/存活进程。新版本次 CLI 最终由 SIGKILL 结束，不能承诺 TERM 一定足够。
6. 取消后显式续聊仍回忆该轮 nonce、没有重启工具。
7. `--max-turns 1` 的真实失败：`max_turns_reached` + `end.stopReason=cancelled` + exit 1；之前有的文本只是过程叙述。

## 固定接入结论

- `streaming-json` 事件是 `type` 形式，不是 AGY result，也不是 JSON-RPC envelope。
- `text.data` 是 delta；所有文本按序拼接，`textScope=turn_aggregate`。`thought` 不能混入回答。
- sessionId 在已测流中直到 `end` 才出现，新任务先生成 `--session-id UUID` 并持久化，避免取消时无 ID。
- `--no-leader`、`--no-memory` 是这两个版本可执行的隐藏选项；升级后必须重新验证，不能移除失败的 no-leader 后默默退回共享进程。
- 原生工具拒绝仍可能 `end_turn/exit0`，必须单独保留 permissionDenials。
- native `cancelled` 不等于用户取消；先看 core cancel 请求、轮数限制和超时原因。
- 权限 deny 已验证具体 write/bash 调用，不代表对所有工具、插件或外部服务做了完整安全审计。

原始本地日志和机器断言见最终项目 `.local/preflight/updated/grok/`；公开语义样本在 `validation/fixtures/grok/`。fixtures 保留增量边界和实际顺序，思考文本、opaque signature、用户路径和会话 UUID 已脱敏，sidecar 明确区分宿主观察与原生事件。
