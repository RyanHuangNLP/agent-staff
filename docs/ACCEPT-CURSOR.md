# Cursor Agent：只补权限拒绝验收

你被授权对本项目进行下述追加验收。项目是 `/Users/huangzhanpeng/python_code/agent-staff`。原业务参考仓库 `agy-staff` 不属于测试工作区。

## 范围

238 项离线测试、Cursor 问答/读写/续聊/真实取消都已通过。本次仅补产品入口下的显式 deny：**正常 staffer 带 force 时仍遵守项目 Write/Shell 拒绝，并能正常读取 fixture**。预计仅一次被测 Cursor 原生调用。

先读 `docs/implementation-report.md` 和 `tests/real-backends.integration.mjs` 中 deny 分支。无需改产品代码、安装插件或设置全局权限。脚本会在原临时工作区创建 `.cursor/cli.json`，测试后删除；若已有该文件，必须停止，不能覆盖。

## 执行

确认这两处存在：

```text
/private/tmp/agent-staff-product-live/cursor/basic-summary.json
/private/tmp/agent-staff-product-live/cursor/workspace
```

先做无模型调用的版本检查：

```sh
node /Users/huangzhanpeng/python_code/agent-staff/bin/agent-staff.mjs doctor --backend cursor
```

与 basic 摘要版本比较；已有基线为 `2026.10.01-e373342`。若版本变化，报告变化并停止沿用旧基线，不自动更新或重测。

原已测候选入口仍在时，使用它：

```sh
cd /Users/huangzhanpeng/python_code/agent-staff
AGENT_STAFF_REAL=1 node tests/real-backends.integration.mjs \
  --backend cursor \
  --root /private/tmp/agent-staff-product-live/cursor \
  --phase deny \
  --entry /private/tmp/agent-staff-installed-smoke/package/bin/agent-staff.mjs
```

如果仅候选入口被删除，可以把 `--entry` 改为 `/Users/huangzhanpeng/python_code/agent-staff/bin/agent-staff.mjs`，报告注明使用当前源码入口。如果工作区/basic 摘要缺失，不直接对 `.local/` 归档跑此命令，停止并报告。

命令需要本地原生登录、网络、`ps` 和已归属进程的信号权限。遵循当前 CLI 的正常权限机制；若命令环境阻止必要操作，报告具体错误，不能把未确认清理改判通过。

## 验收证据

脚本退出 0 且 `deny-summary.json` 为 passed 才通过。核对：

1. 原生 read 工具成功读取 `STAFF_FIXTURE_64d1`。
2. 原生事件明确拒绝文件写和 shell，两种工具都实际尝试过。
3. `forbidden.txt` 与 `forbidden-shell.txt` 均不存在。
4. job 的 `permission_denials` ID 与原生拒绝事件一致。
5. cleanup confirmed，无活跃的已归属进程，前后版本一致。
6. 临时 `.cursor/cli.json` 已清理。

把该阶段 stdout/stderr、原生 events、摘要及对应 job 记录复制到 `.local/manual-acceptance/cursor/`，保留原始字节。报告记录完整命令、退出码、版本和证据路径。允许把失败的脚本断言问题记录为待修；不能靠删除断言或模型口头说“拒绝成功”计作通过。

失败后只做本次 job 的必要清理，然后停止；不要自动重新派发、换模型、改权限或运行其他后端。
