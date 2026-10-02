# 面试 Codex 工作目录

- `AGENTS.md`：唯一的面试行为提示词，Codex 进程启动或恢复原线程时读取；修改后重启 Sage 即可用于原会话。
- `guides/`：简短的编程、算法和对象设计指南，相关任务按需读取。
- `conversations/<会话ID>/`：Codex 的会话目录。旧代码与 Git 留存，新回答不再创建文件或版本。
- `materials/`：你自己的简历、项目细节、固定 BQ 故事。建议用 Markdown / TXT；PDF 可以放，但文字版更容易精确读取。
- `.runtime/codex/`：专用 Codex 登录、会话和运行记录。自动生成，不提交、不打包、不分享。

在项目根目录执行 `node scripts/interview-codex.cjs login` 登录。
安装版也可从系统托盘选择「Codex 登录」；「面试资料目录」直接打开实际使用的目录。
`node scripts/interview-codex.cjs login status` 检查登录。
`node scripts/interview-codex.cjs` 可直接在这个目录启动交互 CLI。
Sage 自己使用 app-server，不需要你保持终端窗口打开。

个人资料放进 materials 后，模型按需要读取；新资料建议在新对话使用，
避免模型继续依赖先前已读的旧内容。不要把密码、API key 或无关私人文件放进来。
这些资料不会被应用整批塞进提示词，但模型读到的片段会进入云端模型上下文。

这是面试资料目录，不是产品源码目录。Sage 显式加载本目录 AGENTS.md，
禁用祖先目录规则及宿主插件/技能发现，避免继承项目的部署和开发指令。
正式聊天使用只读沙箱、禁止提权；不是容器级读取隔离。原始转录完整保存在应用中，请求只追加新增或修正部分，不依赖模型主动翻字幕文件。

源码运行默认使用本目录。安装版默认使用 `%APPDATA%/Sage/assistant-workspace`。
可通过 `INTERVIEW_CODEX_WORKSPACE` 指定这个项目目录；
`INTERVIEW_CODEX_BIN` 可指定 Codex 原生可执行文件（不使用 cmd/bat 命令拼接）。

本地 Codex 仍调用云端模型，需要联网和有权限的登录。普通聊天不使用后端 API key；
现有双路实时转录仍使用服务器 API key，互不混用。
