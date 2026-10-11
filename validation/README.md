# 验证包入口

此目录保留实现前原生后端的接入验证。当前产品的测试另见 `tests/` 与 [实现报告](../docs/implementation-report.md)。最终基线是在 2026-10-05（Asia/Shanghai）完成各 CLI 更新检查之后重新执行的 18 次调用：AGY 5 次、Grok 7 次、Cursor 6 次。历史批次单独保留。

## 无模型调用的离线检查

从此交付包根目录运行，需 Node 和 Python 3：

```sh
node validation/agy/check-fixtures.mjs
node validation/agy/check-fixtures.mjs --fixtures validation/fixtures/agy/history/pre-update-v1.2.16
node validation/grok/assert-fixtures.mjs
node validation/grok/assert-fixtures.mjs validation/fixtures/grok/history/1.0.25
python3 validation/fixtures/cursor/assert_fixtures.py --fixtures validation/fixtures/cursor/current
python3 validation/fixtures/cursor/assert_fixtures.py --fixtures validation/fixtures/cursor/history/2026.09.02-c22c1a3
```

以上命令覆盖 active/history 样本和相应哈希；不会重新调用模型。原始证据的可选校验方法见各后端说明。全包的文件摘要见 `manifest.json`，它记录相对路径和 SHA-256；不把生成的摘要文件自身纳入摘要。

## 真实重跑

真实重跑会消耗模型额度，并由原生 CLI 保存测试会话。使用已有登录、新建临时仓库、受限的小任务；不要在业务仓库执行。macOS 本地终端需允许本次进程树的身份检查和信号清理。

| 后端 | 说明 | 阶段 |
| --- | --- | --- |
| AGY | [README](agy/README.md) | 上游 cancel-continue 三次 + nonce/schema 两次；显式 opt-in |
| Grok | [README](grok/README.md) | seed/resume/deny/allow/cancel/cancel-resume/limit；显式 opt-in |
| Cursor | [README](cursor/README.md) | baseline/resume/deny/write/cancel_tree/cancel_resume；执行命令即开始调用 |

严格检查每一步退出码和新生成的摘要。权限用例必须看到实际工具拒绝并检查目标文件不存在；取消用例必须看到工具 started marker 后才发信号，并在超过原定完成时长后检查 completion、心跳和进程身份。模型自称“已拒绝”或“已停止”不构成通过。

Cursor 当前基线取消任务原定 15 秒，脚本重跑默认 90 秒；延迟观察应按该次实际参数等待。`cancel` 是旧版本“只停进程组”的失败反例，常规使用修正后的 `cancel_tree`。脚本可以运行的选项不等于已冻结的产品 V1 参数集合。

## 来源与边界

`fixtures/` 中是脱敏后的真实 stdout/sidecar；文件名中的 `meta`、`manifest`、`summary` 是宿主观察，不能当作原生事件。保留的失败样本不能改名为成功样本。AGY 最小上游源码见 `agy/upstream/`，只用于复现及参照；原版权和许可证随附。

原始日志位于本项目 `.local/preflight/`。旧绝对路径是历史来源标识；把其 `/private/tmp/agent-staff-preflight.fODiUI/` 前缀替换为本项目 `.local/preflight/` 即可找到归档副本。真实 session ID、进程 PID、native 思考记录等仅在本地原始证据保存；对外提供脱敏 fixtures。所有源文件 hash 均以原始字节计算，不重写原始日志来伪造可移植路径。
