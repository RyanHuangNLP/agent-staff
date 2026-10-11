# Cursor 协议样本

- `current/`：2026.10.01-e373342 实测 baseline、精确 resume、deny、write、完整进程树 cancel、cancel 后 resume；6 次默认模型调用。
- `history/2026.09.02-c22c1a3/`：旧版 7 次调用，额外保留“只取消 CLI 进程组不能结束工具”的失败反例及后续精确清理证据。不要把历史行为当作新版已复测。
- 每个目录的 `index.json` 提供原始日志路径、源 SHA256、fixture SHA256 和脱敏规则。
- 原始流里的工具 call_id 含换行；JSON 编码后仍在同一个物理 NDJSON 行，解码后按原字符串关联。
- 模型 thinking 内容已移除，事件 type/subtype 保留。用户路径、临时目录、nonce、session ID 已替换；自动更新和工具进程的结构性事实未屏蔽。

离线验证，不运行模型或调用网络：

```sh
python3 assert_fixtures.py --fixtures current
python3 assert_fixtures.py --fixtures history/2026.09.02-c22c1a3
```
