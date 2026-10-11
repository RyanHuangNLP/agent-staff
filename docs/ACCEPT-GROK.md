# Grok Build：收尾已有取消任务

你被授权对本项目进行下述追加验收。项目是 `/Users/huangzhanpeng/python_code/agent-staff`。

## 范围

Grok 的 ask、后台读写、原会话 nonce 续聊和原生 fixture 已通过。真实工具取消也已发生，job 状态 canceled、cleanup confirmed。原测试中断在“没有 end 帧就必须提供 sessionId”的错误断言；脚本已修正，剩余仅迟到写入复查和取消后原会话续聊。**不要重新运行 `--phase cancel`；该阶段会重新创建任务，而且原标记已存在。** 没有 `finalize-cancel` 自动阶段。

预计只需一次被测 Grok 续聊。先读 `docs/implementation-report.md`、`tests/real-backends.integration.mjs`，特别是 `confirmCleanup`、`nativeEvents` 和 cancel 分支。

## 原有证据

```text
工作区：/private/tmp/agent-staff-product-live/grok/workspace
证据根：/private/tmp/agent-staff-product-live/grok
已取消 job：staffer-muu4p03l-3c46c4b3
取消启动时进程证据：cancel-started-process-evidence.json
取消部分摘要：cancel-partial-summary.json
随机 token 来源：cancel-cancel-start.prompt.txt
```

归档副本在本项目 `.local/product-smoke/grok/`，其中绝对路径是历史位置。若原工作区或原生会话不可用，报告未验证并停止；不要伪造恢复、修改归档路径或自动启动新测试。

## 1. 不消耗模型的复查

1. 确认已取消 job 及其终态 sidecar，读取原 session ID。要求 canceled、cleanup.status=confirmed、executionMayBeActive=false。
2. 读取原 started 进程证据。按现有脚本的 `PID + born` 身份比较，对 CLI 和工具身份分别检查当前 `ps`；不能只凭 PID 不存在或程序名判断。原身份仍执行、进程检查不可用或证据不足时报告失败/未验证并停止。
3. 记录 started.txt 与 heartbeat.txt 的字节和时间；started 必须只有一次启动，completed.txt 必须不存在。
4. 再观察至少 21 秒后重读，started/heartbeat 均不变，completed 仍不存在，已归属身份不执行。原工具自然时长是 20 秒。可使用一个只读小脚本按现有 harness 算法采集，不能修改原日志或标记。
5. 运行 doctor，版本须与 basic 摘要一致（原基线 Grok 1.0.46）。若版本变化，报告变化并停止沿用旧基线。

把复查证据写到 `.local/manual-acceptance/grok/`。

## 2. 仅发一次恢复请求

先从原启动 prompt 读取 `CANCEL_MEMORY_` token，保留作核验预期，**不要把 token 值写入续聊 prompt**。

原已测候选入口可用时执行：

```sh
cd /private/tmp/agent-staff-product-live/grok/workspace
AGENT_STAFF_KEEP_LOGS=1 node /private/tmp/agent-staff-installed-smoke/package/bin/agent-staff.mjs \
  --backend grok continue \
  --job staffer-muu4p03l-3c46c4b3 \
  --timeout 90s \
  --prompt "Do not use tools and do not restart the interrupted command. Recall only the exact CANCEL_MEMORY_ token from the previous request. Return just that token."
```

若仅候选入口已删除，可使用本项目 `bin/agent-staff.mjs`，报告注明当前源码入口。保持其余参数不变。记录返回的新 job ID，并等待它：

```sh
node /private/tmp/agent-staff-installed-smoke/package/bin/agent-staff.mjs \
  --backend grok wait NEW_JOB_ID --timeout 120s
```

`NEW_JOB_ID` 必须替换为刚返回的 ID；若切换为源码入口，wait 也使用同一入口。wait 输出含标准 job 标题，**应核对保存的 result_file 正文**，不能把标题一起拿来比较 token。

## 3. 通过条件

- 新 job done、成功 end_turn、退出 0、cleanup confirmed。
- 新 job session ID 与已取消 job 相同。
- result_file 只包含原 token 和结尾换行。
- 完整原生流中没有 tool_call/tool_call_update，证明恢复没有用工具重新取 token 或重启命令。
- 完成恢复后，started/heartbeat 仍不变，completed 仍不存在，已归属身份无执行。
- Grok 中断前可以尚未发出 sessionId；成功恢复的 end 帧必须包含正确 sessionId。

保存命令、退出码、版本、前后文件证据、原生 events、状态及结果到 `.local/manual-acceptance/grok/`，写 REPORT.md。失败后只清理本次新 job，然后停止；不重复调用、不换模型或权限、不改写历史失败为成功。不要更新主实现报告，先交付这次独立报告供复核。
