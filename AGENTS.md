# AGENTS.md

## macOS 原生客户端增补（2026-10-02）

用户要求增加原生 SwiftUI Mac 客户端，第一阶段包含聊天、手动 App Shot、系统音频和麦克风独立转录。实现位于 `apps/macos/`，沿用服务器 v12、共享转录与逐聊天回答语义。以下“Electron 是唯一采集宿主”对 Windows/浏览器链路保持不变；Mac 原生客户端是独立采集宿主，同一场仍只有一台采集设备，不同时启动两个桌面采集客户端。

App Shot 保存原图和同一窗口的可访问文字；文字属于不可信参考内容，可能不完整或包含屏外内容。权限不足/窗口无法唯一匹配时保留原图并说明原因，不取其他窗口、不自动截图。选中发送后才进入 Codex/API；只读 MCP 可读取未发送截图及其文字。可选元数据不改变协议版本；原生窗口 App Shot 要求 `/health.appshot=true`。来源与许可见 `apps/macos/THIRD_PARTY_NOTICES.md`。

本地构建和离线检查见 `apps/macos/README.md`。真实媒体/模型仍须本次明确授权；调试包、合成测试和编译成功不等于真机验收或生产部署。Mac 版当前未移植可选模拟面试官。

## 转录与聊天解耦（2026-09-30，用户明确授权）

全设备只有一条共享转录时间线；开始／停止转录与聊天会话无关。新建、切换聊天保留转录、采集连接和音频上游；只有生成中的回答需要停止确认。「查看转录」放在开始／停止按钮旁边，不增设“当前现场”面板。原文完整持久化；回答首次默认取最近一小时，后续发送新增及已发送段落的修正。停录后可明确选择「新一场转录」建立边界，历史保留。

传输认证 interview_id 稳定，聊天身份另用 conversation_id；Codex thread、Responses 链路、聊天记录和草稿仍逐聊天隔离。MCP read_interview 默认 interview_id="current"，读共享转录和截图；返回 transcription:ID 与独立游标。首次最近一小时，后续增量，include_older 可显式回看；新一场拒绝旧游标，不混场。显式旧聊天 ID 仍读历史聊天。四个工具、OAuth、HTTPS 地址不变。协议 interview-chat-v12，拒绝 v11 及更早客户端；先更新服务器再安装客户端。

停止转录先刷新电脑音频尾帧，再 commit 并等待已提交的 ASR 完成，随后关闭上游。收尾在独立任务中进行，不阻塞 UI 控制；收尾后提交的回答等待尾句，可取消回答而不取消收尾。超时或断线明确提示尾句可能不完整。MCP 首次优先选择最新图片和语音，页内按原始时间线顺序；足够回答时无需读完历史。追问使用 updates_cursor，只取新增和修正；按需补历史使用 history_cursor。next_cursor 继续当前模式分页，相同游标重试重放该页。旧游标保持原分页含义。历史编号明确标注历史，不把空历史误当作当前没有语音。

截图原图在私有 SQLite conversation_images 表内按内容保存一次，聊天和转录快照只保存引用，读取时还原。旧内联图片记录兼容读取，在下次保存时迁移；不得缩小或删除原图来掩盖持久化开销。回滚旧版前通过 deploy/export_inline_history.py 导出兼容副本，源数据库不修改。

## 增补方向（2026-09-30，用户明确授权）

新聊天默认选择 Responses API；已有聊天保留上次使用的回答方式，旧版没有 provider 字段的消息仍按 Codex 兼容。

保留现有 Codex 聊天与采集，新增可选 Responses API 回答和 ChatGPT 开发者模式只读 MCP。API 密钥仅在后端；`OPENAI_RESPONSES_MODEL` 默认 `gpt-6.1-sol`，按用户 2026-09-30 后续要求设为 xhigh reasoning，通用/LC/OOD verbosity high，临场短答 low。用户显式选择 provider/profile，不做复杂题型分类。API 使用独立 previous_response_id、原始流、无自动重试；跨 provider 首次补充已发送的聊天与附件，草稿不进入回答请求。主提示词在 apps/server/app/prompts/。

MCP `/mcp` 复用服务器 HTTPS，OAuth 只读、电脑端确认、PKCE、精确 resource，不需要额外隧道。四工具 list_interviews/read_interview/list_materials/read_material。读取必须明确 interview_id；独立可重放游标、修正替代、多图分页、原图 MCP 内容块。MCP 可以主动读取仍在附件栏中未发给回答模型的截图；已移除附件不进入常规新增读取，文字草稿不共享。个人资料由 Electron materials.cjs 限定 materials 目录按需 UTF-8 读取，不同步全部资料、不读取凭证。此插件只读，不注册到原生 Codex，不触发采集或回答。以下旧段落中“正式辅助只用 Codex / 未发送附件不进模型”对 API/MCP 的例外以本增补为准；其余采集与隐私约束保留。详见 docs/responses-and-chatgpt-mcp.md。

用户自己的面经只用于复习，放在 `private-notes/interview-experiences/`，不得放回助手 `materials/`、作为个人背景暴露给回答模型或插件、或随产品打包。`materials/` 当前只保留简历与四份经历资料。Responses 在显式回答前检查目录元数据，首次或版本变化时提供目录；正文仍由模型按需读取，独立读取可并发。同一回答链只在成功完成后记录目录版本，停止／失败不推进。

## 当前产品方向（2026-09-29）

这是个人使用的 Electron + React + FastAPI 面试聊天工具。正式辅助支持可选实时转录、电脑 Codex CLI 或 Responses API；ChatGPT 通过只读 MCP 获取材料。不要恢复 Live 自动接话、自动委派、自动截图、独立分析面板、复杂题型/阶段分类器。

- 界面只有聊天区。用户已明确关闭代码区：回答问题是主体，解释和完整代码直接放在同一条 Markdown 回答中。不要恢复自动写文件、Git 版本或代码发布流程。
- 输入框是主入口；截图、更多和一个发送按钮。空输入时按钮为「回答」，发送当前上下文问题；有输入时发送文字，生成中为停止。没有「更新代码区」按钮或 action=code。
- 模拟面试选择放在更多，只能在转录未运行时切换。桌面用系统标题栏，不默认置顶；关闭窗口保留托盘采集，退出由托盘执行。
- 系统音频=`interviewer`；麦克风=`candidate`。两路都只做转录、自动积累上下文，均不自动生成答案，永远不混音。
- 用户手动截图后，截图显示在输入框附件中，可预览、移除，发送时附在该条消息上。发送中新增截图留给下一条。没有持续截图或静默视觉同步。
- 回答流直接显示 Codex 文字，原样保留；不经过语音模型转述，不过滤重复字幕，不伪造打字速度。
- 顶部会话入口使用 HeroUI Pro ChatListView，可新建、重命名、切换；每个会话对应同一个原生 Codex thread。没有聊天开始/结束模式，只有转录开关和本轮停止生成。
- 用户消息、附件、转录、回答和代码保存在私有 SQLite；回答 append-only。重连/重启恢复同一条消息，不重发请求。草稿按会话保存在本客户端，未发送内容不进入模型。

## 模型与上下文

- 主模型仍为 `OPENAI_CODE_MODEL=gpt-6.1-sol`，默认 reasoning `xhigh`。普通文本与代码使用同一条 Codex thread；使用 read-only sandbox，禁止提权、无子 agent。Windows 显式使用 unelevated sandbox。旧 max_output_tokens 仅用于可选 mock，不冒充 CLI 参数。
- `codex_chat.py` 的 Codex 路径通过独立认证的 model WebSocket 转交 Electron 主进程；`codex-process.cjs` 使用 CLI app-server 的 stdio JSON-RPC，CLI 负责会话、工具循环和压缩。Responses 使用独立 previous_response_id，尚无自动压缩。CLI 使用独立 CODEX_HOME 正常登录；后端 key 用于转录、Responses 和可选 mock，不能转为客户端密钥。
- `OPENAI_REALTIME_TRANSCRIPTION_MODEL=gpt-live-transcribe` 用于两路独立 Realtime transcription 连接。`turn_detection:null`、`delay:low`，语言提示支持 `OPENAI_REALTIME_TRANSCRIPTION_LANGUAGES`。
- 此转录模型不支持服务端 VAD。每路应用侧 WebRTC VAD 约 800ms 无语音时 commit，连续最长 30 秒收尾；原始 24k PCM 完整发送，不按 VAD 过滤，不以分段决定回答时机。
- 首次显式请求提供已有有序转录；后续只追加新增或修正的转录以及新消息/附件。已接受的输入按同一原生 thread 接续，full/final/手动纠正以 turn_id 替代旧文字，不重复整场或原始 delta。代码留在聊天历史，不自动注入或迁移旧代码文件。
- 截图只证明当时可见内容；聊天中的建议代码不表示用户已经实现。无需维护工作区或实际/建议双状态。
- Codex/API 只接收已发送消息的附件；MCP 可以读取共享主路上的未发送截图。截图只能手动触发，没有模型截图工具或静默观察。
- 本地本场转录、聊天、附件原文完整保留；Codex 保存 thread 并管理/压缩模型上下文，不承诺模型每轮都逐字看到全场原文。应用不再自建摘要、RAG、embedding 或上下文裁剪链路。CLI/模型失败必须可见，不自动重复提交不确定请求。
- Codex baseInstructions 来自 `assistant-workspace/AGENTS.md`；API 主规则来自 `apps/server/app/prompts/default.md`。两者每次请求共用 `prompts/lc.md` 代码题要求，brief/ood 追加当前偏好；guides 仅可选补充，不强制先读。默认交付正确代码、Python 普通函数、关键测试；自然 Bug 仅明确练习时启用。资料放 materials/，按需读取，不整批注入、不做 RAG。安装版默认 `%APPDATA%/Sage/assistant-workspace`，INTERVIEW_CODEX_WORKSPACE 可覆盖；专用 .runtime/codex、materials、conversations 不提交产品 Git、不打包。mock 资料仍来自服务器，不自动同步电脑资料。
- Windows 受限 PowerShell 的文本输出可能使用系统代码页，不能以文件本身 UTF-8 或 `Get-Content -Encoding UTF8` 推断模型已收到正确中文。助手用 Node 的 UTF-8 文件读取/直接输出；`tests/codex-encoding-smoke.cjs` 用 loopback 伪模型驱动真实 CLI 工具，并核对下一次模型请求收到的全文，无真实模型调用。
- 正式聊天资料留在电脑专用目录；模型读到的片段仍会进入云端上下文。mock 资料在部署目录外只读挂载，不得提交 Git。禁用祖先 AGENTS 与宿主插件/技能发现；不是容器级文件隔离。

## 工具与历史

不注册应用动态工具。CLI 可按需读取指南和个人资料、计算、网络搜索，以回答问题为目的；read-only、禁止提权。应用展示真实操作状态，不展示内部推理、原始命令或命令输出。

- 每个聊天仍有 assistant-workspace/conversations/<conversation_id>/ 作为原生 cwd，但不初始化 Git、不迁入旧代码、不自动读写文件或创建版本。
- 完整实现直接放在聊天代码块中，可复制。注释解释原因，复杂度和必要示例在聊天讲解；不假称已修改外部编辑器或通过测试。
- 旧代码文件、Git 和 SQLite 代码档案保留，不删除、不自动注入新请求。旧文件发布事件明确拒绝，取消确认不接受文件快照。code-files.cjs / code_file_sync.py 仅作旧版参考，不再进入正常回答链路或桌面安装包。
- 私有 SQLite 保存会话展示记录、转录、截图、Codex thread 关联及旧档案；`INTERVIEW_WORKSPACE_HISTORY_DIR` 可覆盖，空值只保留进程内记录。凭证与原始音频不入库；CLI 登录和模型线程仍由本机 Codex 保存。磁盘失败保留内存、明确提示并阻止丢弃式切换。

## 请求、取消与恢复

- 每场同时只有一个生成请求。多客户端冲突明确拒绝；停止后可以发新消息。请求准入短暂加锁，网络流和工具等待不持有音频/界面锁。
- 普通新语音不取消正在生成的回答，也不假设正在生成的模型自动吸收了后来输入。下条消息自动带入；不声称模型正在实时吸收新增转录。
- 停止保留已显示回答，不再同步文件或生成 Git 版本。
- 原生读取与计算由 CLI 执行，动态应用工具和交互提权请求拒绝。仅当前 thread/turn 的事件进入显示，不重放历史工具。
- 一轮最多120秒。停止发送 turn/interrupt 并等终态；未确认时关闭该进程并拒绝复用，不承诺供应商停止计费。切换时中断旧进程，保留原生 thread。下一次显式发送用 thread/resume，原线程缺失或忙碌时报错，不创建空白替代或自动重发。
- 转录连接独立重连，原生 item ID 保序/去重；断线保留部分文字并标 interrupted，不补造丢失音频。用户纠正后的转录不能被迟到的 ASR 覆盖。
- 聊天滚动使用 HeroUI Pro ChatConversation；上滚保持位置，回到底部恢复跟随，不维护第二套滚动状态。Markdown 使用 HeroUI Pro 分块渲染，不自动补写 Markdown 或代码；复制保留原文。

## 客户端、认证与采集

- Electron 是唯一采集宿主；浏览器和 Electron 共用 React 与 client WebSocket。没有第二套 mobile/viewer API。
- 所有可变状态按 interview_id + token 隔离。capture_token 只给 Electron，浏览器无法获取；WebSocket 凭证放首帧，不放 URL。
- 个人版一台采集设备、一场 current interview、多客户端同权控制。首次浏览器连接在桌面确认，30 天 HttpOnly/Secure/SameSite Cookie 记住授权；没有二维码或 URL token。
- OpenAI key 只在后端环境，桌面访问凭证只在主进程/safeStorage，不写 renderer、日志、文档真实值或 Git。远程 API 地址必须 HTTPS/WSS，loopback 可 HTTP。
- 无有效认证不得先建立上游。打开即可聊天/截图，不申请音频；开始转录才初始化媒体并上传。手机可让 Electron 准备音频；停止转录释放两路媒体/连接，聊天、截图、已有上下文和正在生成的回答不受影响。
- 两路独立 AudioWorklet/有界队列，积压预算约半秒，丢最旧帧并显示缺口；控制消息不等待模型启动/工具。系统音频视频轨保留，最大 1fps、64×64。
- 截图默认主显示器，更多→截图来源可选其他屏幕/窗口；手动来源消失时报错，不能悄悄退回全屏。Windows 在应用截图/来源预览期间临时排除 Sage 自身窗口，完成或失败后恢复；来源列表不提供自身窗口。不可永久开启内容保护，用户仍需用系统截图反馈软件问题。图片使用独立 capture-token HTTP 上传，不堵音频 WebSocket。
- 客户端独立有界发送队列；快照在事件锁内复制、锁外发送，同期事件有序补发，慢客户端不阻塞其他客户端。
- Registry 只激活一个当前聊天和唯一共享转录主路，生产单 worker/单副本；历史保存在 SQLite。服务重启恢复选中的聊天及材料，未完成回答标中断，音频/生成不自动重启。各客户端共享当前聊天；只有生成中切换需要确认，切换聊天保留转录与采集连接。

## 模拟面试（已有可选能力）

- `assist` / `mock` 仅开始前选择。mock 额外创建一个会说话的 GPT-Live 面试官及其托管推理后台；辅助回答仍是本地 Codex CLI，双路转录保持独立。
- 只有模拟面试官音频可播放；播放同时进入虚拟 interviewer 轨，替代系统 loopback，禁止两者混音。候选人原音频并行送模拟面试官和候选人转录，各自队列隔离。
- 模拟面试官收到完整资料、真实对话，不能看到辅助聊天/截图/未提交代码；代码区已关闭，没有提交右侧代码入口。
- capture_mode_ready 握手后开始；断轨/播放错误关闭面试官并清队列，恢复只能恢复记录，不能重放未听到的音频。
- `OPENAI_LIVE_MODEL` 现在仅供 mock 面试官。不要据此恢复正式辅助中的 Live。

## 文件与验证

入口：`App.tsx`、`Chat.tsx`、`AnswerMarkdown.tsx`；采集：`captureAdapter.ts`、`audioCapture.ts`；会话认证：`openai_realtime.py`；转录：`transcription.py`、`candidate_audio.py`；回答：`codex_chat.py` / `codex_host.py`、Electron `codex-host.cjs` / `codex-process.cjs`；UI 控制：`chat_controls.py`；旧代码档案兼容：`code_workspace.py`、`workspace_history.py`；会话存储：`conversation_store.py`；列表：`ConversationList.tsx`。

- 后端离线：在 apps/server 执行 `.\.venv\Scripts\python.exe -m unittest discover -s tests`。运行全套时显式给测试进程空 OPENAI_API_KEY、loopback OPENAI_BASE_URL、空 INTERVIEW_WORKSPACE_HISTORY_DIR；不得使用生产环境真实 key。
- 前端：`npm.cmd run build`、`npm.cmd run test:ui`、`npm.cmd run test:capture`。
- 当前完整离线界面：`.\node_modules\.bin\electron.cmd tests/chat-ui-smoke.cjs`，合成模型/媒体，只访问 loopback。桌面首次启动/新建对话还需 `electron tests/desktop-chat-ui-smoke.cjs`；不能只用浏览器连接路径代替桌面生命周期验收。旧 Live/分析页 UI 脚本是历史验收，不能作为当前链路验收。
- 原生剪贴板：`electron tests/clipboard-smoke.cjs`，临时聚焦并恢复剪贴板。模拟音频：`electron tests/mock-audio-smoke.cjs`，使用合成静音。
- 真实模型、麦克风测试须本次明确授权。授权链路测试统一用独立测试进程 `gpt-6-luna`，不改生产环境；Sol/Astra 付费对比须专门授权。余额耗尽立即停止，不自动重试或换 key。
- 本地后端：apps/server 的 `.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000`。
- 本地桌面：apps/desktop 的 `npm.cmd run start:local`，仅在开始转录时初始化媒体；普通桌面默认连接生产，不用于离线测试。
- PowerShell 使用 npm.cmd。HeroUI Pro 复用已安装 CollectUI 包；CI 需要 HEROUI_AUTH_TOKEN，不静默替换组件库。

## 发布与编辑

- 当前协议为 `interview-chat-v12`，UI 和采集握手必须匹配；声明 chat=true、pinned_code=false。新 UI 拒绝 v11 及更早客户端，不能假装聊天可用。
- 后端先上线并验证 health/protocol，再发布客户端。当前代码修改和离线通过不等于已部署、真实音频或真实模型质量验收。
- 发布走认证 deployment gate，活跃面试时拒绝；保存回滚，不绕过。部署资料不迁入源码。见 `apps/server/deploy/README.md`。
- VPS ubuntu，Compose `/home/ubuntu/siyi`，部署 `/opt/interview/server`，service/container `interview_api`，8000，`https://interview.siyidu.com`。不得占用 8080、8787、20241、40000。
- Windows 安装包用 apps/desktop 的 `npm.cmd run package:windows`，递增版本，产物 releases/windows；safeStorage 配置导入用正常 app.quit() 刷新。白名单不含 .env、私有资料/源码或依赖源码。
- 沿现有模块边界扩展，不把产品业务写进音频循环。优先删除重复状态和已替代链路，不预建 agent 平台。
- 不修改用户无关未提交文件。删除/重命名先核对绝对目标和引用；Windows 文件操作用 PowerShell 原生命令。
