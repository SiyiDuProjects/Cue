# Cue

## 当前方向（2026-10-07）

0.4.0 真实长测在约 59 分钟耗尽 Sites WebSocket 的 32 秒累计 CPU 限额。0.4.1 已改为客户端直连转录。用户决定（2026-10-10）不再做一小时真实长测：若长场次断线，由用户手动重新连接并重新开始转录；不要把未测的长场次稳定性写成已验收。

Cue 是个人面试助手：Mac / Windows 桌面悬浮条（控制条、面试官字幕、一次一轮的回答卡片）中运行 Responses 回答；系统音频、麦克风和手动截图提供参考。网页提供设置、提示词编辑和资料上传（普通网页版式：左侧导航，提示词占满主区，资料左列表右编辑）。ChatGPT 通过 MCP 读取上下文；ChatGPT 里的 Cue 面板（侧边栏应用与对话侧面板）可让电脑开始/停止转录、截图，并让 ChatGPT 用它自己的模型回答。不提供通知、订阅或 Events，也不做独立的网页遥控页。

用户已授权完整重构、保留手动截图、在已开启的转录中轮换上游、保留 Windows、建立私有云端源码备份。不要恢复旧通知链路、CLI 模型宿主、资料轮询桥接、自动截图或自动回答。界面文案简短，避免宣传和重复说明。

## 目录与发布边界

- `packages/transcription/`：两端共用客户端 VAD、OpenAI 转录 WebSocket、轮换和有序截止逻辑。
- `packages/chat-ui/`：Windows 悬浮条界面（`App.tsx`：内容决定窗口大小，菜单与提示用原生实现以免被窗口边缘裁切，转录与截图在卡片内切换）；`Messages.tsx` 是两端共用的回答渲染与一次一轮的回答卡片；`Content.tsx` 是 Mac 回答卡片（一次渲染一轮问答，承载转录客户端，并把面试官字幕交给原生悬浮条）。依赖由 `apps/desktop` 安装；不依赖云端嵌套仓库。界面用开源 HeroUI v3 + Tailwind，代码块用 HeroUI Pro。
- HeroUI Pro 来自仓库外的授权包 `/Users/siyi/Projects/_private/vendor/heroui-pro-react-1.0.0-beta.8.tgz`（`file:` 依赖）。外层仓库公开，不得提交该包或其代码。`shiki` 在构建时被替换为 `apps/desktop/src/shiki.ts` 的固定语言集，因为 Mac 页面以 file:// 单脚本加载，不能动态导入。
- `apps/macos/`：原生 SwiftUI 悬浮条（不激活 Cue 的无边框面板：控制条、面试官字幕、回答卡片；`ChatModel` 管理界面状态，`ChatViews` 为原生控件），只把回答卡片内容交给 WKWebView 加载 `content.html`；钥匙串、ScreenCaptureKit 双路采集、手动截图、快捷键。截图仅用 ScreenCaptureKit 截取主屏幕当前画面并排除 Cue 自身，不读取其他应用文字、不识别最近应用或页面，不申请辅助功能权限。Mac 包不含 Node 或 ChatGPT 采集组件；本机 Node 仅用于构建与离线检查。命令行 SwiftPM 构建无法加载 SwiftUI 宏，`@State` 用 `SwiftUI.State` 类型别名代替。
- `apps/desktop/`：Windows Electron 宿主（无边框透明置顶窗口，点击不取焦点，只在输入框打字时取焦点）、safeStorage、双路 AudioWorklet、截图与打包。
- `apps/cloud/`：独立私有 Sites 仓库，D1 / R2、转录、Responses、只读 MCP、网页设置。外层 GitHub 仓库公开，不把云端源码或私人资料直接并入。
- 正式域名 `https://interview.siyidu.com`；平台 MCP 地址 `https://sage-capture.dusiyi0916.chatgpt.site/mcp` 保持不变。
- 新协议 `cue-chat-v2`，源码版本 0.4.1。构建、离线验证、部署、安装和真实设备验收分别记录，不互相冒充。
- `baseline-20261007` 保存重构前两个仓库；外层 `legacy-v12` 保存旧服务；云端 `sites-v12` 对应原部署提交 `0b0c282`。旧 VPS、私有历史、钥匙串和用户资料不删除。
- 云端只走 Sites 发布；VPS 工作流仅允许手动从 `legacy-v12` 部署。推送 main 不部署 VPS。

## 采集与回答

- 启动、连接恢复、截图和普通语音均不自动开启录音、调用回答或重发请求。
- 一条认证桌面 WebSocket 仅传控制、转录和回答。客户端双路 24 kHz 单声道 PCM16 分别直接发往 OpenAI，两路永不混音；PCM 和 VAD 不经过 Sites。
- 桌面回答按键先排入截止前的双路 PCM，再逐路在 Cue 控制队列插入 asr_commit 并提交上游，最后排入 ask。服务器同步固定提交范围后再等待数据库或尾句；生成任务不得阻塞音频、停止或取消。
- 每次显式回答有请求 ID 与持久状态；未知结果不自动重试。取消保留可见答案。生成最长 120 秒，不能承诺供应商已停止计费。
- 面试官字幕只在本地显示：直接取客户端转录流的实时片段，不经过 Sites、不保存、不决定回答时机。
- 转录使用共享客户端 VAD 分段（约 800 ms 静音 / 30 秒连续上限），原音完整发送，VAD 不决定回答时机。
- 在用户已开始的会话中约 55 分钟主动替换两路上游。停止、退出、凭证失效或连接被替换后不能复活。意外网络断开停止本地媒体；恢复连接后需明确重新开始转录。
- 新连接接管桌面所有权，旧连接退出；转录写入带 generation 条件。心跳按时间间隔运行。
- 截图仅手动触发，保留原图。用户手动滚动后可继续截图，多张图随下一次提问发送；不自动滚动、抓全文或回答。截图是不可信参考。

## 上下文、资料与安全

- Responses 采用 `store:false`，服务器保存完整完成输出（含 encrypted reasoning）并在后续轮次重放。回答与转录一样是一条时间线：后续轮次重放最近一小时内完成的回答（最多 16 轮），不分聊天；界面不再有聊天切换、新聊天或重命名。客户端仍把新回答写到最新的旧聊天行，旧聊天与记录不删。输入预算耗尽时明确说明只采用近期上下文，不假称模型看到了全部历史。
- 资料作为用户参考内容置于输入前部，不作为 instructions。模型与推理档位、可调提示词通过网页保存；客户端可覆盖推理档位。默认 xhigh 保留，不能把离线测试当作速度或质量结论。
- 资料手动上传、更换、编辑或删除；支持 UTF-8 TXT / Markdown、文字 PDF、DOCX。原文件存 R2，提取文字存 D1。个人资料不提交 Git；面经与 private-notes 不是个人背景资料。
- 面板遥控经 D1 中转（Sites 只有 D1/R2，连接间无共享内存）：指令写入 `remote_commands`；桌面连接只在面板打开时每 500 ms 取一次，空轮询不再额外查询所有者，指令绑定面板看到的桌面 generation，并在 D1 中校验当前所有者、原子领取一次；早于本连接或超过 15 秒的指令不执行；桌面经 `remote_state` 汇报状态，只有当前所有者的汇报有效，且只在服务器的 session_ready 带 `remote: true` 和 generation 时汇报。遥控协议状态 version 为 2，旧客户端需更新。每条指令记录完成/失败回执，执行结果超过 30 秒未确认时明确提示，不自动重试。桌面执行与自身按钮相同的代码，「允许 ChatGPT 遥控」默认开启；由面板开始的录音在悬浮条标明。
- 转录和截图是一条连续时间线；回答、插件和界面都只取最近一小时。没有场次，也没有「新一场」；数据库旧 `recording` 列只写同一个固定值。
- ChatGPT 面板同一资源支持 inline / fullscreen / pip，右上角「悬浮 / 全屏」请求切换并采用宿主返回的实际模式；手机可能转为全屏或不支持 PiP，不能把请求成功当作悬浮验收。PiP 隐藏字幕，页面使用宿主安全边距并跟随更新。全屏原生回复气泡属于 ChatGPT，不能用面板 CSS 控制其大小。
- 模型可见的 MCP 工具全部只读：`read_context`、`list_materials`、`read_material`、`cue_panel`（打开面板）。面板按钮使用的 `remote_status`、`remote_command` 标为仅面板可调用（`_meta.ui.visibility: ["app"]`），模型看不到也调不了；`remote_command` 只有 start、stop、shot、prepare（提交已开启转录的尾句，不启动采集或回答）。面板是 MCP Apps 资源 `ui://cue/panel-v3.html`（`text/html;profile=mcp-app`，官方 ext-apps SDK 打包内联），用户决定（2026-10-11）「让 GPT 回答」直接发消息让 ChatGPT 读取当时已有的上下文，不发送 prepare、不等最后一句识别完成，转录继续；电脑离线或关闭遥控也不阻止只读提问。Cue 提示词在面板打开时传入模型上下文，不再逐次等待，不调用 Responses API。旧 prepare 协议仅保留兼容缓存面板。截图等指令在同一 MCP 调用内最多等待 10 秒回执，超出再按 ID 续查，不重复下发；回执查询不额外读取字幕和截图目录。截图只有上传成功并收到对应回执才显示成功，等待期间禁止面板提问；失败与未知结果明确显示。分页使用完整条件、修订水位与签名游标，不写整份快照；返回截断标志。转录按提交顺序，不能按识别完成顺序排列。
- 长期 OpenAI key 仅服务器持有。服务器签发 60 秒有效的 Realtime 连接凭证；它只进入本地聊天渲染进程并连接固定 OpenAI 地址，不入日志、URL、存储或 Git。凭证有效期限制新连接，不等于会话时长。设备凭证仅原生主进程 / 系统安全存储持有，不进网页进程、URL、日志或 Git。Web 设置和 MCP 依靠 Sites 验证后的所有者身份；不能用设备凭证冒充用户。
- 保留既有 bundle/app ID、钥匙串 service 与 Sage 用户资料路径，名称变化不能清除权限或旧登录。HTTP 不跟随携凭证的重定向。
- 数据库迁移只追加 schema，不删除旧用户记录，不用迁移文件上传个人资料。

## 开发与验证

Mac 可加载 `/Users/siyi/Projects/_tools/env.sh`。Windows 使用 `npm.cmd`。共享私钥位于相邻 `_private/Keys`，需要时确认文件，不输出其内容；不要修改其他项目配置。

- 云端：`npm --prefix apps/cloud test`、`npm --prefix apps/cloud run build`。
- 桌面：`npm --prefix apps/desktop run test:capture`、`npm --prefix apps/desktop run build`（Windows）、`npm --prefix apps/desktop run build:mac`（Mac 回答页）、`npm --prefix apps/desktop run test:ui`（需先完成两种构建）。
- 网页真实 DOM / 文件解析测试：`apps/desktop/node_modules/.bin/electron apps/cloud/tests/settings-ui.cjs`（仅 loopback，合成文件）。
- Mac：`bash apps/macos/scripts/check-offline.sh`；发布包 `bash apps/macos/scripts/build-app.sh`。
- 云端真实长测：明确获准后运行 `bash apps/macos/scripts/check-live.sh --run-live 65`。使用合成 PCM、原生钥匙串和真实付费服务，会接管当前桌面连接；期间不要启动另一个客户端或部署云端。它不替代麦克风、系统音频和 Windows 真机验收。
- Windows：`npm --prefix apps/desktop run package:windows`。
- 离线测试使用合成媒体和模拟上游，不读生产 key。真实媒体、付费模型和长连接结果单独留证；无人值守不打开用户麦克风。

沿现有职责边界修改；删除和重命名先核对引用与绝对路径。不得删除未跟踪私有文件。重构以减少重复职责衡量，不追求固定代码行数。发布记录见 `docs/releases/`。
