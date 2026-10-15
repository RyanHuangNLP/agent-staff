# 当前产品验收矩阵

本矩阵按 PRD 的“保留原版体验，单次选择一个员工”修订。先前原生预检记录见 preflight-report.md；它与产品运行验证分开。

| ID | 要求 | 验证方式 |
| --- | --- | --- |
| C01 | AGY既有模型/effort、权限、输入和角色行为不回退 | 原 flags/modes/policy/setup/triage 测试 |
| C02 | AGY旧状态和continue/restart、最近任务、显式覆盖保留 | 原 continuation/recovery/state/jobs/wait 回归 |
| C03 | 四入口路由只启动指定CLI，doctor不触发模型 | entry-and-packaging、multi-backend |
| C04 | 每员工独立state；相同原生ID也不串会话；原工作目录恢复 | multi-backend、continuation |
| C05 | Grok增量文本、Cursor最后assistant、thought隔离、不透明tool IDs | backend-adapters，真实fixtures |
| C06 | Denial保留、turn_limit不误判成功、非零退出和部分结果准确 | backend-adapters、multi-backend |
| C07 | 前台ask不打印后台派发横幅；普通问答零工具 | 离线fake加产品真实smoke |
| C08 | 后台job→wait/result→最近/指定continue工作，软wait不取消；无 ID 的 wait 固定开始时选中的 job | multi-backend、原streaming/wait |
| C09 | 真实工具started后cancel，清理独立PGID，过自然时长无迟到写入 | 离线独立子进程回归+产品真实取消 |
| C10 | owned PID身份、未知清理、worker异常、硬timeout不伪报成功 | streaming/windows/terminal-observation及新增用例 |
| C11 | 同会话running拒绝follow-up，含前台ask占用；跨角色续聊继承会话模型与权限；不新增全工作区运行锁 | continuation、multi-backend |
| C12 | 每员工七技能，lead只跟进该员工，relative runtime可达 | 插件生成一致性、资源检查、独立目录调用 |
| C13 | npm包包含所需源码/模板/技能/许可证，不包含raw/凭据/测试目录 | packaging检查与npm pack |
| C14 | AGY可选setup保留，新后端本地policy不写AGY全局配置 | setup/policy/newbackend测试 |
| C15 | dirty/nonGit工作区和review两种口味/JSON体验保留 | modes/recovery及newbackend JSON回归 |

## 真实产品 smoke

使用当前已登录CLI，在新临时仓库执行；版本前后记录，日志放在对应本地验证目录。不修改业务仓库和全局权限设置。

- 三后端：经交付入口进行前台ask、后台小任务和续聊，确认选中的模型/会话、任务结果和cwd。
- Grok/Cursor：验证新默认工具profile可以修改指定临时文件，restricted时准确呈现已配置的拒绝，不因权限错误自动提权。
- Grok/Cursor：真实shell写started/heartbeat后取消；超过工具原定完成时长复查无completion/活身份，续聊不复活原工具。
- AGY：保留原始真实预检作为协议基线，另外经产品入口进行兼容smoke；不把历史wrapper外的调用计作新产品成功。
- 打包后的CLI、Grok/Cursor独立插件入口至少各有可运行验证；全套结束核查owned执行和原参考仓库状态。

原版ask的无工具约定由提示和restricted构成；测试记录观察到的工具次数，不宣传OS强隔离。失败/未验证项目必须在最终运行报告明确说明，不计入通过。
# 0.9.0 Codex CLI 补充验收

Codex 接入复用上方既有任务语义，新增离线检查：原生 JSONL 终帧与会话 ID、stdin 长任务、启动失败的管道清理、原生 JSON schema、最新会话配置与显式旧 job、跨角色和前台续聊占用、取消和 worker 异常清理、四后端状态隔离，以及独立插件复制后的 ask → 后台任务 → wait → continue。

本机只检查 Codex CLI 0.142.0 的版本和参数解析；未运行真实模型或原生工具。原三后端的历史真实结果不能转移到 Codex。当前结果和限制见 [Codex CLI 支持](codex-support.md)。
