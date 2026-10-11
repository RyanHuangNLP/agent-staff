# 在 Cursor Agent / Grok Build 中追加验收

无需 Codex。`agent-staff` 的运行核心是 Node 程序，可以在普通终端、Cursor Agent 或 Grok Build CLI 中调用。

**本次只补剩余验收，预计各一次被测后端调用。** 把对应下列指令复制到已经登录的 CLI 会话；外层助手的对话也使用该 CLI 自己的模型服务。

## 给 Cursor Agent 的指令

```text
请读取 /Users/huangzhanpeng/python_code/agent-staff/docs/ACCEPT-CURSOR.md，按其中要求只补 Cursor 产品入口的权限拒绝验收，保存真实证据和报告。不要重新跑已通过的 basic、238 项回归或其他后端。不要安装插件或改全局设置。
```

## 给 Grok Build 的指令

```text
请读取 /Users/huangzhanpeng/python_code/agent-staff/docs/ACCEPT-GROK.md，按其中要求只补已取消 Grok job 的迟到写入复查与原会话续聊验收，保存真实证据和报告。不要重新创建取消任务、重跑 basic 或测试其他后端。不要安装插件或改全局设置。
```

## 结果应如何判定

- 调用 `bin/agent-staff.mjs` 才是在验收产品的适配器、会话、状态、取消和结果处理；直接在原生 CLI 中聊天只能验证原生 CLI 本身。
- 测试应操作先前的临时工作区。不要在业务仓库创建 deny 策略或取消标记。
- 当前临时工作区仍可用，但未来可能被系统删除；归档在 `.local/product-smoke/`。归档状态里的绝对路径不可直接当成新位置使用。缺少工作区或会话时停止并报告，不自动扩大到整套重测。
- 输出保存到 `.local/manual-acceptance/cursor/` 和 `.local/manual-acceptance/grok/`。各自写 `REPORT.md`，列明版本、命令退出码、证据路径和 passed/failed/unverified，不覆盖原历史报告。

这份说明没有启动任何追加测试。现有完整结果见 [实现报告](implementation-report.md)。
