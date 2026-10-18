# agent-staff

保留原版 agy-staff 的任务流程，增加 **Grok Build**、**Cursor Agent** 和 **Codex CLI** 三个可选员工。通常一次选一个：交办任务、等待结果、继续追问；员工之间不互相调度。

当前版本为 0.9.0。源码仓库为 [RyanHuangNLP/agent-staff](https://github.com/RyanHuangNLP/agent-staff)。交付包含本地源码与四个可安装插件，尚未发布 npm 包。

## 致谢与项目来源

感谢 [agy-staff](https://github.com/keli-wen/agy-staff) 原项目及其作者 [Keli Wen](https://github.com/keli-wen) 的开源贡献。**agent-staff 是参考并基于 agy-staff 0.7.4 改造和扩展的项目**，沿用了原项目的任务委派流程、角色技能与 companion runtime，并在此基础上加入 Grok Build、Cursor Agent 和 Codex CLI 三个后端，扩展了多后端的任务管理与续聊能力。

原项目采用 MIT 许可证；本仓库保留原作者的版权声明与许可证，详见 [LICENSE](LICENSE)。原始版本、提交及代码归属记录见 [NOTICE](NOTICE)。

## 安装四个 Codex 插件

这四个插件安装在 **Codex** 中，分别调用本机 AGY、Grok Build、Cursor Agent、Codex CLI。Codex 插件会启动独立的 Codex CLI 进程。需要 Node.js 24+，以及已经安装并登录的相应原生 CLI；没有额外 npm 运行依赖。可以只安装需要的后端。

在终端注册本地源码并安装所需插件：

```sh
codex plugin marketplace add /Users/huangzhanpeng/python_code/agent-staff
codex plugin add agy@agent-staff
codex plugin add grok@agent-staff
codex plugin add cursor@agent-staff
codex plugin add codex@agent-staff
codex plugin list --marketplace agent-staff --json
```

路径替换为你保存此仓库的完整目录。也可把第一条命令的本地路径替换为 `RyanHuangNLP/agent-staff`，直接使用 GitHub 源；私有仓库需要当前 Git 身份具有读取权限。当前本机已核对 Codex CLI 0.142.0 的 `marketplace add`、`plugin add` 和 `plugin list` 语法。旧版 CLI 没有这些命令时，在 Codex 中打开此仓库，重启桌面应用，然后在插件目录选择 **Agent Staff** 来源并安装所需插件。来源目录约定见 [OpenAI 官方插件文档](https://developers.openai.com/plugins/build/plugins)。

**本机配置兼容说明：** 如果命令报告 `features.context_management` 的 `invalid type: map, expected a boolean`，在每条命令的 `codex` 后加 `-c features.context_management=false`。这是本机现有配置与 CLI 0.142.0 的类型不兼容；该参数只覆盖当前命令的读取值，不需要修改原配置表。

安装后重启 Codex 桌面应用并打开一个新对话，切换到真正要处理的项目，再输入其中一条：

```text
$agy:staffer 检查当前项目的登录流程，给出问题和依据
$grok:implementer 修复登录表单的输入校验，并运行相关测试
$cursor:reviewer 审查当前工作区改动，按严重程度列出问题
$codex:implementer 修复登录流程，并运行相关测试
```

每个插件均有 `lead`、`staffer`、`researcher`、`reviewer`、`implementer`、`ask`、`jobs` 七个入口。首次可从 `staffer` 开始；要持续委派并验收结果时用 `lead`。`ask` 只用于无需读文件或执行工具的简短问题。后台角色的技能会负责等待并收取结果。

已有旧来源的 AGY 插件时，在插件目录中确认使用的是本仓库 **agent-staff** 来源下的 0.9.0，避免同名插件混淆。安装步骤只安装插件，不替你安装原生 CLI、不切换登录，也不修改原生全局权限。

## 模型与 effort 选择

在项目中首次调用某个员工的技能时，宿主会展示该后端的模型与适用的 effort 选项。选择后保存在当前 worktree 的 `.<backend>-staff/config.json`，后续任务自动使用；四个员工分别保存。也可以选择沿用原生/内置默认值，确认后不会重复询问。模型列表来自原生 CLI；Codex 使用本机原生模型目录缓存，并标明缓存属性，不保证账号或自定义 provider 当前可用。

随时可以用自然语言修改，例如「把这个项目的 Codex 默认 effort 改成 high」或「修改 Cursor 的默认模型」。只请求改设置时不会启动任务。「这次用……」和调用中的 `--model`、`--effort` 仅覆盖本次，不改项目默认值。首次调用已明确指定选择时，会直接保存并使用，无需再次确认；明确说仅本次或跳过配置时不保存。

| 员工 | 模型选择 | effort 选择 |
| --- | --- | --- |
| AGY | 原生具体 ID，或 `flash` / `pro` 家族别名 | 具体 ID 已包含 effort；家族支持的 `low` / `medium` / `high` 组合以模型列表为准 |
| Grok | 原生模型 ID | 推理模型支持的原生 effort；也可沿用原生默认 |
| Cursor | 原生 ID、带 effort 的模型变体或受支持的括号参数 | 随模型字符串保存，不传独立的非默认 `--effort` |
| Codex | 原生模型 ID | 所选模型目录中列出的等级；如 `low`、`high`、`xhigh`，不统一限制为三档 |

在待处理项目目录也可直接查看、保存或修改设置（把路径和模型 ID 换成实际值）：

```sh
node /absolute/path/to/agent-staff/bin/codex-staff.mjs models
node /absolute/path/to/agent-staff/bin/codex-staff.mjs config
node /absolute/path/to/agent-staff/bin/codex-staff.mjs config --model "<原生模型ID>" --effort high
node /absolute/path/to/agent-staff/bin/codex-staff.mjs config --effort medium
node /absolute/path/to/agent-staff/bin/codex-staff.mjs config --model default --effort default
node /absolute/path/to/agent-staff/bin/codex-staff.mjs config --reset
```

`config` 不带参数只读取；带参数只更新提供的字段。`default` 清除该字段的覆盖，`--reset` 忘记整个模型选择、让技能下次重新询问，二者均保留权限策略。偏好不会修改原生全局配置，也不会启动模型任务。直接调用命令行不会弹出交互选择，适合脚本使用。

优先级是 **本次参数 → 原会话配置 → 项目默认 → 原生/内置默认**。更改项目默认只影响之后的新任务，运行中任务不变；续聊保留原选择，仍可显式覆盖。`restart` 使用原任务及其配置。Codex 的可选 effort 取决于模型和客户端，见 [OpenAI 官方配置说明](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 直接使用

需要 Node.js 24+，以及已安装并登录的所选 CLI。无需额外 npm 运行依赖。以下在**待处理项目目录**运行：

```sh
node /Users/huangzhanpeng/python_code/agent-staff/bin/agent-staff.mjs doctor --backend all
node /Users/huangzhanpeng/python_code/agent-staff/bin/grok-staff.mjs ask --prompt "解释这两种方案的取舍"
node /Users/huangzhanpeng/python_code/agent-staff/bin/cursor-staff.mjs staffer --prompt "检查当前项目的登录流程"
node /Users/huangzhanpeng/python_code/agent-staff/bin/cursor-staff.mjs wait --timeout 10m
node /Users/huangzhanpeng/python_code/agent-staff/bin/cursor-staff.mjs continue --prompt "继续处理第一个问题，并验证改动"
node /Users/huangzhanpeng/python_code/agent-staff/bin/codex-staff.mjs staffer --effort high --prompt "修复登录表单的输入校验"
node /Users/huangzhanpeng/python_code/agent-staff/bin/codex-staff.mjs wait --timeout 10m
node /Users/huangzhanpeng/python_code/agent-staff/bin/codex-staff.mjs continue --prompt "补充边界情况测试"
```

ask 在当前调用返回答案；staffer、research、review、implement 返回后台 job ID。后续的 wait、continue、status、result 必须用启动该任务的同一入口：`grok-staff staffer` 之后用 `grok-staff wait`，不能改用 `cursor-staff wait` 或其他员工的入口。四个状态目录互不相通。统一入口也接受 --backend agy|grok|cursor|codex；省略后端默认 AGY。同一条命令里的 `--backend` 必须和要操作的状态目录一致。

Codex 使用 `codex exec --json` 和显式会话 ID 续聊，默认模型沿用原生配置，`--model` 指定原生模型 ID，`--effort` 设置本次推理强度。普通工具角色沿用本项目的 unrestricted 默认；`--restricted` 和 `ask` 使用原生 read-only sandbox 与 `approval_policy=never`。`review --json` 使用原生 `--output-schema` 并再次本地校验。参数、配置兼容处理与验证范围见 [Codex CLI 支持](docs/codex-support.md)。

## 命令

| 命令 | 用途 |
| --- | --- |
| staffer / research / review / implement | 通用任务、调研、审查、实现 |
| ask | 简短问答，不自动加入仓库材料，约定不使用工具 |
| wait [job] --timeout 10m | 等待并返回完整结果；省略 ID 时固定开始那一刻的最近任务；超时仅结束等待 |
| observe [job] / status [job] | 查看有界进度或任务状态 |
| result [job] | 收取已结束任务的结果 |
| continue --job ID --prompt TEXT | 继续指定任务 |
| continue --prompt TEXT | 继续当前员工最近会话 |
| cancel ID / restart ID | 停止执行；或用原任务开启新会话 |
| models | 查询模型选择；Codex 返回本机原生模型目录缓存 |
| config [--model ID\|default] [--effort LEVEL\|default] | 查看、保存或修改当前员工的项目模型默认值 |
| config --reset | 忘记模型选择，保留权限策略 |

角色也支持 --continue、--conversation ID。续聊按会话而不是按角色继承模型、effort 与权限，可显式覆盖。前台 ask 在返回前占用该会话，同会话续聊会被拒绝且不会排队。历史分别保存在当前 worktree 的 .agy-staff、.grok-staff、.cursor-staff、.codex-staff。

任务输入用 --prompt、--prompt-file 或 --stdin。工具角色默认允许原生工具执行，--restricted 可主动收紧；ask 始终 restricted。没有项目偏好或本次覆盖时，AGY 保留原角色模型默认值，Grok/Cursor/Codex 使用原生 CLI 模型。详见 [后端契约](docs/backend-contracts.md)。

## Codex 入口文件

每个员工有 lead、staffer、researcher、reviewer、implementer、ask、jobs 七个入口。根目录保留 AGY 插件；plugins/grok、plugins/cursor 和 plugins/codex 包含各自完整 runtime。安装后可用 $agy:staffer、$grok:staffer、$cursor:staffer、$codex:staffer 等名称。

这些 skill 文件把任务交给 CLI。lead 跟进选中的员工，不启动多个员工协作。交付没有改动已安装技能或插件；不安装插件也能使用上述 Node 命令。

## 开发与验证

```sh
npm run build:plugins
npm run check:skills
npm run check:plugins
npm test
npm run pack:checked
```

修改共享 runtime 后重新生成独立插件副本。进程身份与取消测试需要正常的本地 ps/信号权限；限制这些操作的沙箱会报告清理未确认。

既有三后端的真实验证通过 tests/real-backends.integration.mjs 显式开启，只用新临时仓库及现有登录。[实现报告](docs/implementation-report.md)记录版本、结果与证据。原生预检在 validation/，原始日志放在 Git 忽略的 .local/。

需求见 [PRD](PRD.md)，分工见 [PLAN](PLAN.md)，检查项见 [验收矩阵](docs/acceptance-matrix.md)。[原 AGY 参考](docs/REFERENCE.zh-CN.md)保留。Grok/Cursor 的既有真实验收基于 macOS arm64；Codex 本轮只做离线协议、流程和本机 CLI 参数检查，未调用真实模型，其他平台或宿主资源不等同于已完成实测。
