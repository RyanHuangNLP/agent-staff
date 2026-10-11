# 实现与验证交接（2026-10-05；2026-10-09追加核对；2026-10-11会话边界修复）

2026-10-11 不能把此前审计写成“没有功能缺口”。本地假 CLI 先后复现了会话边界问题，以及随后一次回归：普通续聊丢失 `review --json`。当前离线套件是 255/255、28 suites、退出码 0。`.local/verification/summary.json` 里的 238 项记录和源码哈希是更早的修复前证据，不再对应当前文件。真实模型验收没有重跑。详情见文末。

初次交接因用户周额度仅余3%而停止追加测试。用户随后分别在Cursor与Grok中完成两项收尾；2026-10-09已核对保存证据并更新本报告。那两项追加验收仍然有效；AGY前台ask工具计数等既有范围限制仍如实保留。

## 已交付

- 基于原 AGY Staff 0.7.4 的共享任务核心、AGY/Grok/Cursor 适配器、统一 CLI 和三个别名。
- 保留原版角色、前台 ask、后台任务、最近/指定会话续聊、模型和权限覆盖、状态与可选 setup。
- 三个员工各七个仓库入口；独立插件包含 runtime。未安装或修改全局插件。
- PRD、计划、后端契约、验收矩阵、源码、测试与原生预检记录。

## 已完成验证

| 检查 | 结果 |
| --- | --- |
| 离线完整回归 | 238/238，28 suites，0失败/跳过（2026-10-04 记录；当前结果见文末 255/255） |
| 技能生成一致性 | Pi/OpenCode各11文件 |
| 独立插件生成一致性 | 54文件 |
| 三后端当前/历史原生fixture | 六组离线检查通过 |
| npm候选包 | 打包成功，124文件，无.local/测试/凭据目录 |
| 独立Grok/Cursor插件子目录 | fake ask→后台→wait→continue通过 |
| 三后端真实ask | 精确回复通过；Grok/Cursor原生工具数=0 |
| 三后端真实后台读写 | 读取fixture、精确文件写入通过 |
| 三后端真实续聊 | 同session精确回忆随机token、零工具通过 |
| AGY/Cursor真实取消及恢复 | 真实20秒工具启动后取消；超过21秒无迟到写入/活身份；原session恢复且零工具 |
| Grok真实取消及恢复 | 手动收尾passed；21秒复查无迟到写入/活身份；原session精确nonce恢复，23事件零工具，cleanup confirmed |
| Cursor产品入口项目deny | 手动追加验收passed；默认unrestricted/force下原生读成功，文件写与shell明确拒绝，cleanup confirmed |

累计已完成16次产品入口原生调用：AGY 5、Grok 5、Cursor 6，含手动补验的1次Cursor调用和1次Grok续聊。不包括doctor版本检查或离线重验；此前18次原生预检另计。使用的是解包后的候选入口，非绕过产品直接调用原生CLI。

主机为macOS arm64、Node v26.8.2；AGY 1.2.16，Grok 1.0.46 (2765805b9442) stable，Cursor 2026.10.01-e373342，已完成阶段的前后版本一致。Grok观测模型grok-4.7-build；Cursor观测Grok 4.6 Extra High Fast；AGY保留原角色默认模型。

## 保留限制与已处理的历史问题

1. AGY前台ask原生JSON没有可验证的工具计数字段；问答已通过，但不能宣称已证明零工具。原版协议未因此变更。
2. Grok取消测试的旧断言问题已修正；中断流可无end/sessionId。手动收尾已完成：21秒前后与续聊后按PID+born核验原身份不执行、文件标记不变、无completed；新job staffer-muzr6vuv-ffea470f在原session成功恢复，正文仅原随机token，23条原生事件零工具，end含正确sessionId，清理确认。原失败记录保留，证据见.local/manual-acceptance/grok/REPORT.md。
3. Cursor产品入口显式项目deny已补验通过，job为staffer-muzr3jhv-38704e09。候选入口与CLI版本基线保持一致；两条真实拒绝事件与permission_denials匹配，目标文件不存在，清理确认，临时策略文件已删除。空.cursor目录保留不影响验收。完整证据见.local/manual-acceptance/cursor/REPORT.md。
4. 首轮basic脚本误把wait标准标题计入回答，原失败文件保留。修正断言后对同一批原始证据严格重验，三后端通过，无重复模型调用。
5. 新增后端未做Windows/Linux和其他宿主真实验收；Node24未运行版本矩阵。PyYAML缺失使通用quick_validate脚本不可用，已完成仓库自有角色/引用/生成一致性与独立运行检查。
6. 此次未发布npm、未推送、未激活Goal、未安装全局插件。最终代码与已测试候选的runtime应保持一致；文档更新不等于新的真实验收。

## 当前交接状态

先读本报告、PRD和tests/real-backends.integration.mjs。2026-10-09 的手动证据仍然有效，但当时的“代码已完成”不覆盖会话边界。当前离线结果以 255/255 为准。252/252 没有覆盖随后发现的 `review --json` 续聊回归。

- Cursor deny与Grok取消收尾/原会话续聊均已通过，无需重跑，本次也没有调用真实模型。
- 收取任务必须用启动它的入口。`grok-staff staffer` 之后用 `grok-staff wait`，不能用 `cursor-staff wait`；agy-staff、cursor-staff 同样只能等自己的任务。
- 当前macOS/已记录CLI版本的既有真实流程验收仍有效；AGY前台ask零工具统计及其他平台/宿主范围限制如上保留。
- 共享 runtime 再变时，运行相关离线测试，并执行 `npm run build:plugins` 与 `npm run check:plugins`。发布与全局安装需用户另行要求。
- `.local/verification/summary.json` 的 238 项源码哈希是修复前记录，不能用来证明当前 companion 或插件副本未变。

## 证据位置

.local/verification/summary.json与npm-test.log记录238项测试及源码哈希；plugin-package-audit.json记录独立插件检查。package-candidate.json和候选tgz记录已测试包。

.local/product-smoke/{agy,grok,cursor}包含原始命令、stdout/stderr、native事件、状态、工具标记及basic/cancel摘要。日志中的/private/tmp/agent-staff-product-live前缀是历史运行位置，归档后对应本项目.local/product-smoke；不改写原始字节。

validation/保留先前原生预检的脱敏fixture，.local/preflight保留其原始证据。原始会话内容仅本地保留，不随npm包发布。

## 2026-10-09 Cursor追加证据核对

已只读核对deny摘要、33条原生事件、保存状态、cleanup证据和临时工作区。摘要及原生事件的归档/源文件字节与SHA-256一致；阶段内doctor/staffer/wait记录均退出0。没有重跑测试或调用模型。

这次观测模型为Grok 4.7 256K High Fast；原先basic观测为Grok 4.6 Extra High Fast。CLI版本仍为2026.10.01-e373342，说明原生默认模型可以随CLI配置或服务端变化，观测名称不应被当作固定模型ID。

外层证据采集shell曾把退出码赋给zsh只读变量status，导致采集shell退出1；该问题与被测阶段的passed结果单独记录在手动REPORT.md中。后续采集使用任务专用变量（如TEST_EXIT）避免此问题。


## 2026-10-09 Grok追加证据核对

已只读核对原取消流、续聊命令及退出记录、结果正文、23条恢复事件、进程身份和21秒文件标记观察。恢复原生流归档与来源字节一致，SHA-256为45bb9afff3cfb5640aaf778584c86400d5dc222eaf438763fd679be5c664b1ba；正文SHA-256为3808c4c9aab2664d8846803b088c6d78fa67b45cf0c65a2a4a07a14f1489f155。

原job staffer-muu4p03l-3c46c4b3与新job staffer-muzr6vuv-ffea470f使用同一session e5908da9-ef5a-4883-92ee-a9826a27874d。doctor/continue/wait记录均退出0；恢复prompt不包含核验token。17项恢复检查全部通过，等待21005ms的迟到写入复查通过；started仅一次、heartbeat为0、completed不存在。版本仍为Grok 1.0.46 (2765805b9442) stable，模型观测grok-4.7-build。没有重新创建取消任务或重跑既有测试。

独立报告和原始证据保留在.local/manual-acceptance/grok/。本次主报告更新没有执行模型调用或改动产品代码。

## 2026-10-11 会话边界修复

此前“没有功能缺口”的结论不成立。审查只用本地假 CLI 复现了三处问题，没有调用真实模型，也没有先改产品代码。复现记录在 `/private/tmp/agent-staff-review-wjFyUu/findings.json`。三处都在 `companion/agy-companion.mjs`，修复后由 `npm run build:plugins` 复制进 `plugins/grok` 与 `plugins/cursor`。

1. 跨角色续聊会丢掉会话配置。`research --restricted --model model-one` 结束后，`implement --conversation <同一会话>` 落到 implement 的 unrestricted 默认，模型也丢失。Grok 因此收到 `bypassPermissions`，Cursor 收到 `--force`。原因是查找先前配置时按角色过滤。现在按会话查找：显式 `--model`、`--effort`、`--restricted`、`--unrestricted` 仍覆盖；未覆盖时继承该会话的模型、effort 和权限。ask 即使继承到 unrestricted 记录也保持 restricted。`continue --job` 仍优先使用指定 job 的配置。
2. 前台 ask 没有挡住同会话的另一次调用。占用检查只看后台 job，而 ask 不写 job。第一个 ask 尚未返回时，第二个相同会话的 ask 或 implement 仍会进入原生 CLI。Grok 与 Cursor 都复现。现在已知会话的前台调用在返回前登记 `foreground_sessions`（pid 与出生标记），同会话续聊直接拒绝且不排队；调用结束或持有进程已消失后清除。这不是一条后台 job。
3. 不带 ID 的 wait 会在轮询中改选最新任务。开始等 A 后再启动 B，wait 会返回 B 并退出 0，A 仍在运行。现在省略 ID 时只在开始时选定当时的最近 job，之后按该 ID 轮询。

回归在本地假 CLI 上覆盖 AGY、Grok、Cursor：跨角色继承且显式覆盖仍生效；前台 ask 占用期间第二次 ask 和 implement 都拒绝，返回后占用消失且会话可再用；无 ID 的 wait 在第二个任务完成后仍返回第一个任务。对应测试在 `tests/continuation.test.mjs`、`tests/wait.test.mjs`、`tests/multi-backend.test.mjs`。

本次实际跑过的命令：

| 检查 | 结果 |
| --- | --- |
| 修复后 `npm test`（`node --test tests/*.test.mjs`） | 247/247，28 suites，0 失败，退出码 0，约 38 秒 |
| `npm run build:plugins` | 54 个插件文件，其中 4 个相对旧副本有变化 |
| `npm run check:plugins` | 54 个文件，0 漂移 |

插件尚未重建时，完整套件曾有 1 项失败：`tests/entry-and-packaging.test.mjs` 指出 grok/cursor 的 companion 与 jobs skill 过期。重建并 `check:plugins` 通过后重跑完整套件，该项一并通过。没有重跑 Cursor deny、Grok 取消/续聊或其它真实模型检查，没有 `npm publish`，没有安装全局插件。

交接时不要把员工入口混用。启动 `grok-staff staffer` 后用 `grok-staff wait` 收取；`cursor-staff wait` 读的是另一份状态，既等不到这个任务，也不能代替它。README、后端契约和两个 jobs skill 已写明同一规则。无 ID 的 wait 固定的是该员工开始等待时的最近任务。

## 2026-10-11 第二轮遗漏

上一轮 247/247 没有覆盖下面两条。复核只用本地假 CLI，证据在 `/private/tmp/agent-staff-fix-review-SHzJOK/findings.json`。没有调用真实模型，复核时也没有改产品代码。

1. 较早的后台 job 仍覆盖最新会话配置。`research` 使用模型 A、unrestricted 后，同会话 `ask` 显式改为模型 B、restricted，再 `implement --conversation` 又回到模型 A、unrestricted。Grok 收到 `bypassPermissions`，Cursor 收到 `--force`。原因是查找时旧 job 仍排在 `conversation_configs` 前面。现在最新保存的会话配置优先；只有显式 `continue --job` 使用被选中 job 自己的模型、effort 和权限。不带 `--job` 的 continue 同样不再把旧 job 当成配置来源。
2. Cursor 首次 ask 没有登记占用。新会话启动时 ID 为空，原生事件返回 ID 后也没有补登记，于是第一次 ask 尚未结束时 `ask --continue` 进入了同一会话。现在第一次保存该 ID 时，会话记录和前台占用在同一次状态写入里一起发布，调用结束时释放。Grok 仍在启动前分配 UUID 并占用。AGY 前台 ask 使用一次性 JSON，会话 ID 要等该 CLI 退出才到达，因此没有 Cursor 这种调用中途才出现 ID 的窗口。

回归：AGY、Grok、Cursor 都检查“ask 改过的配置不被旧 research job 盖回”，并且 `continue --job` 仍回到被选中的旧配置。Grok 与 Cursor 另外检查第一次 ask 在 ID 出现后拒绝 `ask --continue`，返回后占用消失且可以再续。上一轮的 9 项回归和 wait 固定任务仍然通过。

本次实际跑过的命令：

| 检查 | 结果 |
| --- | --- |
| `npm run build:plugins` | 54 个插件文件，其中 2 个 companion 副本相对旧副本有变化 |
| `npm run check:plugins` | 54 个文件，0 漂移 |
| 紧接着的 `npm test` | 252/252，28 suites，0 失败，退出码 0，约 38 秒 |

没有重跑 Cursor deny、Grok 取消/续聊或其它真实模型检查，没有 `npm publish`，没有安装全局插件。

## 2026-10-11 review JSON 续聊回归

第二轮把最新会话配置放在旧 job 前面之后，裸 `continue` 和 `continue --conversation` 不再读取旧 spec 里的 `opts.json`，而会话配置本身没有保存这个格式要求。三个后端都复现：`review --json` 之后假 CLI 返回普通文本，任务仍被标为 done、退出 0。`continue --job` 对照组仍退出 3。复核证据在 `/private/tmp/agent-staff-json-followup-ynKEMN/findings.json`。复核当时 9/9 通过，没有改产品代码，也没有调用真实模型。

修复后，每次运行把有效的 review JSON 要求写进 `conversation_configs`。裸 `continue` 和 `continue --conversation` 继承这份最新记录，因此继续校验输出；模型和权限的优先级不变。显式 `continue --job` 仍使用被选中 job 自己的格式。没有该字段的旧会话记录才回退到 job spec。

本次实际跑过的命令：

| 检查 | 结果 |
| --- | --- |
| `npm run build:plugins` | 54 个插件文件，其中 2 个 companion 副本相对旧副本有变化 |
| `npm run check:plugins` | 54 个文件，0 漂移 |
| 紧接着的 `npm test` | 255/255，28 suites，0 失败，退出码 0，约 39 秒 |

新增回归覆盖 AGY、Grok、Cursor 的裸 `continue` 和 `continue --conversation`：非 JSON 文本退出 3，原因是 `invalid_structured_output`，保存的 `opts.json` 为 true。没有重跑真实模型检查，没有 `npm publish`，没有安装全局插件。
