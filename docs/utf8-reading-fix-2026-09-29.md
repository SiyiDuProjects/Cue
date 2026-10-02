# 中文资料读取修复

## 故障与修复

Sage 0.1.10 的一次新会话中，原生 Codex `exec_command` 读取指南的返回包含中文乱码。
原始 Markdown 是有效 UTF-8，主提示词通过 Node 读取并正常传递；故障在 PowerShell 工具输出链路。

原生 `command/exec` 的独立测试中，`Get-Content -Encoding UTF8` 可以正确返回文本，
但这不能证明模型实际调用的 Code Mode → `exec_command` 链路正确：后者仍会乱码。
受限语言模式不允许设置 `[Console]::OutputEncoding`；`chcp` 加显式读取编码也未通过完整链路检查。

主提示词改为指导助手使用 Node 的 `fs.readFileSync(path, "utf8")` 和 `process.stdout.write`
直接读取输出，适用于指南与个人文本资料。保留现有 read-only/unelevated 沙箱和权限。
历史里的乱码读取不能当作已读；需要重新读取。

这是原生工具的读取约定，不是应用拦截或重写每条命令；模型仍须遵循该指令。
没有批量改写资料、注入全部指南或增加检索/摘要组件。

## 验证

- `node apps/desktop/tests/codex-encoding-smoke.cjs`：用本地脚本提供的伪模型响应触发真实 Codex 原生工具，
  然后检查下一次模型请求里收到的工具结果。三份指南及含中文文件名、中文、数学符号、emoji 的
  UTF-8 文件与原文一致，无替换字符。不是仅检查磁盘文件或外围 `command/exec` 的输出。
- `codex-runtime.test.cjs` 与 `codex-process.test.cjs`：8 项通过。
- 安装版读取的工作目录已含新规则；无需替换后端或客户端二进制。下一次打包会包含更新后的公共提示词。
- 无真实模型调用、无音频采集；这些检查不证明最终回答的讲解深度已经满足要求。

证据：`artifacts/encoding-fix/native-tool-result.json`、`installed.json`。
