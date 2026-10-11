# 历史样本说明

这些是更新前的 2026.09.02-c22c1a3 样本，不代表当前版本新增验证。

`cancel` 保留了仅 SIGINT CLI 进程组的失败及后续精确 PID 清理。首个 `cancel_actions` 中 `tool_running_after_grace=true`，且 `tool_process_after_group_cancel` 非空，是原始失败证据；心跳从 1 继续增长到 10。后续精确清理后没有 completion，并在自然完成窗口之后再次验证。

旧 harness 的遗留字段 `owned_processes_alive_after_group_cancel` 命名不准确：该列表实际在额外工具 PID 清理之后采样，因此为空。保留原始 manifest，没有静默修正证据；不要用该字段否定前述失败。后来的 `cancel_tree` 与当前版本 manifest 使用 `owned_processes_alive_after_primary_cancel`、`owned_processes_alive_after_exact_tool_cleanup` 区分阶段。离线断言检查的是正确的阶段证据。
