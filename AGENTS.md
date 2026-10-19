# Cue

## 当前方向（2026-10-07）

0.4.0 真实长测在约 59 分钟耗尽 Sites WebSocket 的 32 秒累计 CPU 限额。0.4.1 已改为客户端直连转录。用户决定（2026-10-10）不再做一小时真实长测：若长场次断线，由用户手动重新连接并重新开始转录；不要把未测的长场次稳定性写成已验收。

Cue 是回答工具，不是转录工具。Mac / Windows 桌面悬浮条（控制条、面试官字幕、一次一轮的回答卡片）中运行 Responses 回答；系统音频、麦克风和手动截图提供参考。网页具备软件的全部能力，界面与悬浮条一致：`/` 是面试页，复用 `packages/chat-ui` 的控制条、字幕和回答卡片（HeroUI v3 + HeroUI Pro 代码块），遥控电脑开始/停止转录、截图、回答（可附追问与推理深度）、停止生成、移除待发截图。三端都不做转录页、截图库或大图浏览；字幕条可往回翻最近 10 分钟。资料与提示词只在网页 `/settings` 管理（左侧导航，手机变顶部栏）。ChatGPT 只通过只读 MCP 工具读取上下文，用户让它答它就答；不做 MCP Apps 界面。不提供通知、订阅或 Events。

用户已授权完整重构、保留手动截图、在已开启的转录中轮换上游、保留 Windows、建立私有云端源码备份。不要恢复旧通知链路、CLI 模型宿主、资料轮询桥接、自动截图或自动回答。界面文案简短，避免宣传和重复说明。

## 目录与发布边界

- `packages/transcription/`：两端共用客户端 VAD、OpenAI 转录 WebSocket、轮换和有序截止逻辑。
- `packages/chat-ui/`：Windows 悬浮条界面（`App.tsx`：内容决定窗口大小，菜单与提示用原生实现以免被窗口边缘裁切）；`Messages.tsx` 是共用的回答渲染与一次一轮的回答卡片；`Captions.tsx` 是 Windows 与网页共用的可回翻字幕条；`Content.tsx` 是 Mac 回答卡片（一次渲染一轮问答，承载转录客户端，并把面试官字幕交给原生悬浮条）；`Web.tsx` 是网页面试页。依赖由 `apps/desktop` 安装；不依赖云端嵌套仓库。界面用开源 HeroUI v3 + Tailwind，代码块用 HeroUI Pro。
- HeroUI Pro 来自仓库外的授权包 `/Users/siyi/Projects/_private/vendor/heroui-pro-react-1.0.0-beta.8.tgz`（`file:` 依赖）。外层仓库公开，不得提交该包或其代码。`shiki` 在构建时被替换为 `apps/desktop/src/shiki.ts` 的固定语言集，因为 Mac 页面以 file:// 单脚本加载，不能动态导入。
- `apps/macos/`：原生 SwiftUI 悬浮条（不激活 Cue 的无边框面板：控制条、可回翻的面试官字幕、回答卡片；`ChatModel` 管理界面状态，`ChatViews` 为原生控件），只把回答卡片内容交给 WKWebView 加载 `content.html`；钥匙串、ScreenCaptureKit 双路采集、手动截图、快捷键。截图仅用 ScreenCaptureKit 截取主屏幕当前画面并排除 Cue 自身，不读取其他应用文字、不识别最近应用或页面，不申请辅助功能权限。Mac 包不含 Node 或 ChatGPT 采集组件；本机 Node 仅用于构建与离线检查。命令行 SwiftPM 构建无法加载 SwiftUI 宏，`@State` 用 `SwiftUI.State` 类型别名代替。
- `apps/desktop/`：Windows Electron 宿主（无边框透明置顶窗口，点击不取焦点，只在输入框打字时取焦点）、safeStorage、双路 AudioWorklet、截图与打包。
- `apps/cloud/`：独立私有 Sites 仓库，D1 / R2、转录、Responses、只读 MCP、网页设置（`web/settings.js`）。面试页源码是 `packages/chat-ui/Web.tsx`，由 `npm --prefix apps/desktop run build:web` 生成到 `apps/cloud/web/app/`（字体内联、文件名带哈希）；该生成物含 HeroUI Pro 代码，只能提交到私有云端仓库，不得进入外层公开仓库。改了 `packages/chat-ui` 后先重新生成再构建云端。外层 GitHub 仓库公开，不把云端源码或私人资料直接并入。
- 网页及新客户端正式地址 `https://cue.siyidu.com`；平台 MCP 地址 `https://cue-app.dusiyi0916.chatgpt.site/mcp`。沿用同一 Sites、App、插件 ID 和所有者权限，不另建插件。旧域名只用于未升级客户端与已存连接的一次迁移。
- 新协议 `cue-chat-v2`，源码版本 0.4.1。构建、离线验证、部署、安装和真实设备验收分别记录，不互相冒充。
- `baseline-20261007` 保存重构前两个仓库；外层 `legacy-v12` 保存旧服务；云端 `sites-v12` 对应原部署提交 `0b0c282`。旧 VPS、私有历史、钥匙串和用户资料不删除。
- 云端只走 Sites 发布；VPS 工作流仅允许手动从 `legacy-v12` 部署。推送 main 不部署 VPS。

## 采集与回答

- 启动、连接恢复、截图和普通语音均不自动开启录音、调用回答或重发请求。
- 一条认证桌面 WebSocket 仅传控制、转录和回答。客户端双路 24 kHz 单声道 PCM16 分别直接发往 OpenAI，两路永不混音；PCM 和 VAD 不经过 Sites。
- 桌面回答按键先排入截止前的双路 PCM，再逐路在 Cue 控制队列插入 asr_commit 并提交上游，最后排入 ask。服务器同步固定提交范围后再等待数据库或尾句；生成任务不得阻塞音频、停止或取消。
- 每次显式回答有请求 ID 与持久状态；未知结果不自动重试。取消保留可见答案。生成最长 120 秒，不能承诺供应商已停止计费。
- 电脑端面试官字幕取客户端转录流的实时片段，不经过 Sites、不保存、不决定回答时机；网页字幕取服务器已保存的最近 10 分钟面试官转录。字幕条默认跟随最新两行（网页三行），向上滚动停止跟随，回到底部恢复。
- 转录使用共享客户端 VAD 分段（约 800 ms 静音 / 30 秒连续上限），原音完整发送，VAD 不决定回答时机。
- 在用户已开始的会话中约 55 分钟主动替换两路上游。停止、退出、凭证失效或连接被替换后不能复活。意外网络断开停止本地媒体；恢复连接后需明确重新开始转录。
- 新连接接管桌面所有权，旧连接退出；转录写入带 generation 条件。心跳按时间间隔运行。
- 截图仅手动触发，保留原图。用户手动滚动后可继续截图；保存与回答附件独立，已保存截图数量不阻止继续截屏。Cue 下一次回答附最近八张待发原图，超出时仅更新附件选择，不删除云端截图；不自动滚动、抓全文或回答。截图是不可信参考。
- 截图与上传解耦：截屏完成就释放截图操作，允许继续连拍，但成功回执必须等服务器保存原图，并携带图片 ID。网页每次点击立即显示占位框，逐张转圈；服务器确认后显示缩略图及「已就绪」，失败明确显示且保留本次运行中的原图。`remote_state` 汇报上传中图片 ID、数量及失败原因；网页截图命令 ID 也作为该图片上传 ID，重试保持不变。回答仍等上传队列清空；仅未上传队列最多八张，已上传数量不阻止继续截图。上传失败只由用户明确重试，不自动重试。

## 上下文、资料与安全

- Responses 采用 `store:false`，服务器保存完整完成输出（含 encrypted reasoning）并在后续轮次重放。回答与转录一样是一条时间线：后续轮次重放最近一小时内完成的回答（最多 16 轮），不分聊天；界面不再有聊天切换、新聊天或重命名。客户端仍把新回答写到最新的旧聊天行，旧聊天与记录不删。输入预算耗尽时明确说明只采用近期上下文，不假称模型看到了全部历史。
- 资料作为用户参考内容置于输入前部，不作为 instructions。模型与推理档位、可调提示词通过网页保存；客户端可覆盖推理档位。默认 xhigh 保留，不能把离线测试当作速度或质量结论。
- 资料只在网页手动上传、更换、编辑或删除；支持 UTF-8 TXT / Markdown、文字 PDF、DOCX。原文件存 R2，提取文字存 D1。个人资料不提交 Git；面经与 private-notes 不是个人背景资料。
- 网页遥控经 D1 中转（Sites 只有 D1/R2，连接间无共享内存，无法从网页请求直接推送到桌面连接）：网页经所有者鉴权的 `/api/remote` 写入 `remote_commands`；桌面通过设备鉴权的 `/capture/remote` 独立 HTTPS 请求领取，网页最近 10 分钟内打开过时每次请求完成后约 500 ms 再取，否则约 3 秒检查一次；WebSocket 不轮询指令。指令绑定网页看到的桌面 generation，在 D1 中校验当前所有者并原子领取一次，领取后再校验所有者；超过 15 秒的指令不执行。桌面经 `remote_state` 汇报状态（遥控协议 version 3，其他版本必须更新），只有当前所有者的汇报有效。指令：start、stop、shot、ask（`text` ≤ 16,000、可选 `effort`）、cancel、unselect（`image`）。ask 的回执可带 `answer`（该次回答 ID），网页据此跟随；shot 成功回执必须带已保存的图片 ID，不能以本地截屏完成冒充成功。每条指令记录完成/失败回执，超过 30 秒未确认时明确提示，不自动重试。桌面执行与自身按钮相同的代码，遥控开关默认开启；由网页开始的录音在悬浮条标明。网页按 `updated` 增量读取最近一小时的回答（生成中每 2 秒保存一次），读取不写库：超过 20 秒未保存的生成中回答由网页显示为已中断；待发截图的缩略图经所有者鉴权的 `/api/remote/images/:id` 返回。`/api/remote` 等网站接口只接受同源请求，`https://chatgpt.com` 只能访问 `/mcp`。
- 转录和截图是一条连续时间线；回答、插件和界面都只取最近一小时。没有场次，也没有「新一场」；数据库旧 `recording` 列只写同一个固定值。
- MCP 只有三个只读工具：`read_context`、`list_materials`、`read_material`；不声明 resources，不提供 MCP Apps、通知或自动回答。首次 `read_context()` 返回最近一小时的近期内容；之后用返回的 `next_cursor` 作为 `cursor`，只返回新增、修订及未取完内容。`has_more` 时沿 `next_cursor` 分批继续，图片清单每批最多 32 张、原图最多四张，总编码 JSON 不超过 3.75 MiB。每个位置独立且不可推进；相同输入 cursor 重试重放同一页，不使用对话 ID 或全局已读状态。位置与文字页缓存保留七天、最多 512 条，过期明确报错，不删除源材料。`images:[id...]` 按 ID 回看，`before:oldest` 向前读转录；两者不能与 cursor 混用。截图上传时记录原图字节数，历史图使用对象元数据获取大小，预算筛选后只下载本批实际返回的原图。超大或不可用的图片明示原因，不静默压缩；缓存页重放失败不能自动推进。旧 ack/history 忽略，旧已读表保留但不使用。
- 长期 OpenAI key 仅服务器持有。服务器签发 60 秒有效的 Realtime 连接凭证；它只进入本地聊天渲染进程并连接固定 OpenAI 地址，不入日志、URL、存储或 Git。凭证有效期限制新连接，不等于会话时长。设备凭证仅原生主进程 / 系统安全存储持有，不进网页进程、URL、日志或 Git。Web 设置和 MCP 依靠 Sites 验证后的所有者身份；不能用设备凭证冒充用户。
- 保留既有 bundle/app ID、钥匙串 service/account 与用户资料目录作为固定存储标识，名称变化不能清除权限或旧登录。源码、打包目标、IPC 和当前配置统一 Cue；已删除 Codex 宿主、其配置读取与资料目录字段，不增加旧功能兼容分支。HTTP 不跟随携凭证的重定向。
- 数据库迁移只追加 schema，不删除旧用户记录，不用迁移文件上传个人资料。

## 开发与验证

Mac 可加载 `/Users/siyi/Projects/_tools/env.sh`。Windows 使用 `npm.cmd`。共享私钥位于相邻 `_private/Keys`，需要时确认文件，不输出其内容；不要修改其他项目配置。

用户决定（2026-10-12）：每次完成修改并通过适用测试后，直接提交并推送到对应仓库，无需再次确认或等待提醒；纯文档改动完成文档检查即可。只提交本次相关且已核验的改动，遵守公开与私有仓库边界，不提交凭证、私人资料或受限依赖。涉及两个仓库时，先提交推送私有云端，再提交推送外层仓库的引用与改动。推送后核对远端提交，报告提交号；若有实际阻碍，明确说明原因。

- 云端：`npm --prefix apps/cloud test`、`npm --prefix apps/cloud run build`。
- 桌面：`npm --prefix apps/desktop run test:capture`、`npm --prefix apps/desktop run build`（Windows）、`npm --prefix apps/desktop run build:mac`（Mac 回答页）、`npm --prefix apps/desktop run test:ui`（需先完成两种构建）。
- 网页真实 DOM / 文件解析测试：`apps/desktop/node_modules/.bin/electron apps/cloud/tests/settings-ui.cjs`（仅 loopback，合成文件）。
- Mac：`bash apps/macos/scripts/check-offline.sh`；发布包 `bash apps/macos/scripts/build-app.sh`。
- 云端真实长测：明确获准后运行 `bash apps/macos/scripts/check-live.sh --run-live 65`。使用合成 PCM、原生钥匙串和真实付费服务，会接管当前桌面连接；期间不要启动另一个客户端或部署云端。它不替代麦克风、系统音频和 Windows 真机验收。
- Windows：`npm --prefix apps/desktop run package:windows`。
- 离线测试使用合成媒体和模拟上游，不读生产 key。真实媒体、付费模型和长连接结果单独留证；无人值守不打开用户麦克风。

沿现有职责边界修改；删除和重命名先核对引用与绝对路径。不得删除未跟踪私有文件。重构以减少重复职责衡量，不追求固定代码行数。发布记录见 `docs/releases/`。
