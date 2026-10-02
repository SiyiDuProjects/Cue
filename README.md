# Sage

一个带面试转录上下文、快捷截图和个人资料的个人 AI 聊天应用。Electron 负责采集，React 提供同一套桌面/手机界面，FastAPI 保存本场原始记录并中转到电脑上的 Codex CLI app-server。

## 怎样使用

1. 打开即可聊天、截图，无需开麦。需要语音上下文时点「开始转录」；系统音频和麦克风独立转录，说话不自动出答案。停止转录保留聊天。
2. 在输入框提问，或点「回答」使用当前对话。需要看屏幕时点「截图」，图片会成为下一条消息的附件，可以预览/移除。
3. 普通聊天可以给代码，也可以讨论分析、澄清、OOD。需要实现时直接提出，解释与完整代码都直接显示在聊天中。
4. 继续提问、优化或要求换解法即可。生成中可停止；输入中的下一条草稿保留。
5. 左上角打开会话列表，新建、重命名或切回以前的面试。空闲时直接切换；正在转录/生成时确认停止再切换。手机与桌面共享当前会话。

主界面只有聊天。代码作为回答中的 Markdown 代码块，支持单独复制。继续追问或给新截图即可修改，不维护另一个代码面板，也不自动写文件、保存 Git 版本。旧代码文件与历史保留在原位置。更多里可看/纠正转录、切换模拟面试、选择截图来源。没有分步、进度识别和自动切题。

桌面端使用系统标题栏，可最小化、最大化和调整大小，默认不置顶。关闭窗口收至托盘并保留浏览器采集连接；完全退出使用托盘「退出」。

## 模型链路

```text
系统音频、麦克风 -> 两路独立实时转录 -> 本场上下文
输入/快捷按钮 + 手动截图 -> FastAPI -> Electron 主进程 -> Codex app-server
Codex 解释与代码 -> 同一条聊天回答
```

- 两路转录用 `gpt-live-transcribe`，不会自动发起回答。
- 回答默认是 `gpt-6.1-sol` / xhigh，直接流式显示文字。
- 没有代码区、代码发布工具或文件交付要求。没有独立分析页、自动截图、Live 助手或额外调度模型。
- 只有已有的可选模拟面试模式仍使用一个会说话的 Live 面试官；它看不到辅助答案和未提交代码。

首次发送提供已有转录；以后只补入新增/修正的转录与本次消息、手动附件，Codex 同一 thread 接续问答。个人资料由 CLI 按需读文件，不整批注入。手机的截图按钮仍请求在线 Electron 电脑截图；手机发消息也通过这台在线电脑运行 Codex。

应用在私有 SQLite 保存聊天、截图、转录、固定代码和对应的 Codex thread ID。Codex 负责模型历史和压缩；恢复界面不生成答案，下一次发送通过原生 thread/resume 继续。转录修正同一段，不累积 delta；已经发过的记录不整场重播。重启后保留已保存的文字，未完成回答标为中断，转录须手动开启。草稿按会话保存在当前客户端。没有新增摘要模型、检索库或自动回答。

截图只证明当时可见内容；聊天代码是建议，不代表用户已实施。未发送附件不会进入云端。失败保留本场记录，不自动重复生成。

详见 [当前架构](docs/architecture.md) 和 [开发约定](AGENTS.md)。

## 本地启动

仓库根目录 `.env` 参考 `.env.example`。后端 API key 继续用于转录与可选 mock，不能进入 renderer 或 Git。正式回答改用独立的 Codex 登录。

在项目根目录执行 `node scripts/interview-codex.cjs login`，或者在桌面托盘选择「Codex 登录」。资料放 [assistant-workspace/materials](assistant-workspace/materials)，提示词在 [assistant-workspace/AGENTS.md](assistant-workspace/AGENTS.md)。[目录说明](assistant-workspace/README.md) 解释源码版、安装版目录与覆盖配置。修改提示词后重启 Sage，原会话可继续。可选 mock 仍读取服务器 `INTERVIEW_CONTEXT_DIR`，电脑资料不会自动同步给它。

后端（PowerShell）：

```powershell
cd D:\Projects\Interview\apps\server
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

桌面：

```powershell
cd D:\Projects\Interview\apps\desktop
$env:INTERVIEW_API_BASE_URL="http://127.0.0.1:8000"
npm.cmd run dev:desktop
```

也可用 `npm.cmd run start:local` 启动本地配套服务；只有点开始转录才会初始化媒体。普通桌面启动默认连接生产 `https://interview.siyidu.com`，不要误用作离线验收。

只有 Electron 可以采集。浏览器打开固定服务器地址选择在线电脑，首次在桌面确认，之后记住 30 天；桌面和浏览器都能操作同一场会话。

## 离线验证

```powershell
cd D:\Projects\Interview\apps\server
$env:OPENAI_API_KEY=""
$env:OPENAI_BASE_URL="http://127.0.0.1:1/v1"
$env:INTERVIEW_WORKSPACE_HISTORY_DIR=""
.\.venv\Scripts\python.exe -m unittest discover -s tests
```

```powershell
cd D:\Projects\Interview\apps\desktop
npm.cmd run build
npm.cmd run test:ui
npm.cmd run test:capture
.\node_modules\.bin\electron.cmd tests/chat-ui-smoke.cjs
```

最后一项使用实际 React/FastAPI/WebSocket 与合成 Codex 事件/截图，屏蔽外网，不采集媒体。还需运行 `electron tests/desktop-chat-ui-smoke.cjs` 检查桌面新建/重连。真实语音/付费模型测试必须另获授权，离线通过不代表真实模型回答质量已验证。

## 部署与资料保存

当前协议 `interview-chat-v11`，不能与旧 v5/v6/v7/v8/v9/v10 后端混用。后端先发布并通过 health/protocol 检查，再发布客户端；[部署流程](apps/server/deploy/README.md) 保留活跃面试 gate 和回滚。

- 一台采集设备、一场当前面试，可同时连接多个界面；生产单 worker/单副本。
- 普通断线与服务重启恢复已保存聊天、附件、转录和代码；不会自动重发旧请求、重启录音或续播音频。
- `INTERVIEW_WORKSPACE_HISTORY_DIR` 保存私有会话与代码档案，空值禁用磁盘保存；生产路径放部署目录外。它不保存凭证或原始音频。电脑上的专用 Codex 工作目录也需保留，才能续接原模型线程。
- 远程服务器地址使用 HTTPS/WSS；OpenAI key、访问凭证和私有资料不得写入前端/日志/Git。
- Windows 打包：`npm.cmd run package:windows`，输出 `releases/windows/`；发布前递增版本。不要将 .env 或私有资料打进安装包。

HeroUI Pro 使用已安装的 CollectUI 包；CI 需配置 `HEROUI_AUTH_TOKEN`，不使用另一套组件库静默替代。
