# Cue

## 当前方向（2026-10-07）

Cue 是个人面试助手：Mac / Windows 桌面半透明悬浮窗中运行 Responses 聊天；系统音频、麦克风和手动截图提供参考。网页提供设置、提示词编辑和资料上传。ChatGPT 仅通过只读 MCP 按需读取服务器上下文，不再提供通知、订阅或 Events。

用户已授权完整重构、保留 App Shot、在已开启的转录中轮换上游、保留 Windows、建立私有云端源码备份。不要恢复旧通知链路、CLI 模型宿主、资料轮询桥接、自动截图或自动回答。界面文案简短，避免宣传和重复说明。

## 目录与发布边界

- `packages/chat-ui/`：Mac WKWebView 与 Windows Electron 共用 React 聊天。依赖由 `apps/desktop` 安装；不依赖云端嵌套仓库。
- `apps/macos/`：AppKit 窗口、钥匙串、ScreenCaptureKit 双路采集、手动 App Shot、快捷键。Node 仅供 App Shot。
- `apps/desktop/`：Windows Electron 宿主、safeStorage、双路 AudioWorklet、截图与打包。
- `apps/cloud/`：独立私有 Sites 仓库，D1 / R2、转录、Responses、只读 MCP、网页设置。外层 GitHub 仓库公开，不把云端源码或私人资料直接并入。
- 正式域名 `https://interview.siyidu.com`；平台 MCP 地址 `https://sage-capture.dusiyi0916.chatgpt.site/mcp` 保持不变。
- 新协议 `cue-chat-v1`，源码版本 0.4.0。构建、离线验证、部署、安装和真实设备验收分别记录，不互相冒充。
- `baseline-20261007` 保存重构前两个仓库；外层 `legacy-v12` 保存旧服务；云端 `sites-v12` 对应原部署提交 `0b0c282`。旧 VPS、私有历史、钥匙串和用户资料不删除。
- 云端只走 Sites 发布；VPS 工作流仅允许手动从 `legacy-v12` 部署。推送 main 不部署 VPS。

## 采集与回答

- 启动、连接恢复、截图和普通语音均不自动开启录音、调用回答或重发请求。
- 一条认证桌面 WebSocket，PCM 首字节 0 为系统音频（interviewer）、1 为麦克风（candidate），其后是 24 kHz 单声道 PCM16；两路永不混音，各自连接转录上游。
- 按键先把截止前的双路 PCM 放入同一发送队列，再同步插入 ask 标记。服务器收到标记先提交两路音频，再等待数据库或尾句；生成任务不得阻塞音频、停止或取消。
- 每次显式回答有请求 ID 与持久状态；未知结果不自动重试。取消保留可见答案。生成最长 120 秒，不能承诺供应商已停止计费。
- 转录使用应用 VAD 分段（约 800 ms 静音 / 30 秒连续上限），原音完整发送，VAD 不决定回答时机。
- 在用户已开始的会话中约 55 分钟主动替换两路上游。停止、退出、凭证失效或连接被替换后不能复活。意外网络断开停止本地媒体；恢复连接后需明确重新开始转录。
- 新连接接管桌面所有权，旧连接退出；转录写入带 generation 条件。心跳按时间间隔运行。
- App Shot 仅手动触发，保留原图。窗口文字必须匹配同一窗口，匹配失败说明原因而不取其他窗口。截图和窗口文字是不可信参考。

## 上下文、资料与安全

- Responses 采用 `store:false`，服务器保存完整完成输出（含 encrypted reasoning）并在后续轮次重放。保留完整历史；输入预算耗尽时明确说明只采用近期上下文，不假称模型看到了全部历史。
- 资料作为用户参考内容置于输入前部，不作为 instructions。模型与推理档位、可调提示词通过网页保存；客户端可覆盖推理档位。默认 xhigh 保留，不能把离线测试当作速度或质量结论。
- 资料手动上传、更换、编辑或删除；支持 UTF-8 TXT / Markdown、文字 PDF、DOCX。原文件存 R2，提取文字存 D1。个人资料不提交 Git；面经与 private-notes 不是个人背景资料。
- MCP 只有 `read_context`、`list_materials`、`read_material`。分页使用完整条件、修订水位与签名游标，不写整份快照；返回截断标志。转录按提交顺序，不能按识别完成顺序排列。
- OpenAI key 仅服务器持有。设备凭证仅原生主进程 / 系统安全存储持有，不进网页进程、URL、日志或 Git。Web 设置和 MCP 依靠 Sites 验证后的所有者身份；不能用设备凭证冒充用户。
- 保留既有 bundle/app ID、钥匙串 service 与 Sage 用户资料路径，名称变化不能清除权限或旧登录。HTTP 不跟随携凭证的重定向。
- 数据库迁移只追加 schema，不删除旧用户记录，不用迁移文件上传个人资料。

## 开发与验证

Mac 可加载 `/Users/siyi/Projects/_tools/env.sh`。Windows 使用 `npm.cmd`。共享私钥位于相邻 `_private/Keys`，需要时确认文件，不输出其内容；不要修改其他项目配置。

- 云端：`npm --prefix apps/cloud test`、`npm --prefix apps/cloud run build`。
- 桌面：`npm --prefix apps/desktop run test:capture`、`npm --prefix apps/desktop run build`、`npm --prefix apps/desktop run test:ui`。
- 网页真实 DOM / 文件解析测试：`apps/desktop/node_modules/.bin/electron apps/cloud/tests/settings-ui.cjs`（仅 loopback，合成文件）。
- Mac：`bash apps/macos/scripts/check-offline.sh`；发布包 `bash apps/macos/scripts/build-app.sh`。
- Windows：`npm --prefix apps/desktop run package:windows`。
- 离线测试使用合成媒体和模拟上游，不读生产 key。真实媒体、付费模型和长连接结果单独留证；无人值守不打开用户麦克风。

沿现有职责边界修改；删除和重命名先核对引用与绝对路径。不得删除未跟踪私有文件。重构以减少重复职责衡量，不追求固定代码行数。发布记录见 `docs/releases/`。
