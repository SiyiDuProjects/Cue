# AGENTS.md

## 项目更名为 Cue（2026-10-06）

用户确定产品名为 **Cue**。Mac、Windows 和网页的可见名称与后续构建产物使用 Cue；本机仓库目录为 `/Users/siyi/Projects/Cue`，Codex 项目沿用原项目 ID 并更名为 Cue。旧 `/Users/siyi/Projects/Interview` 仅作为路径兼容链接，供已有聊天和工具继续访问。

GitHub 仓库于 2026-10-07 更名为 `SiyiDuProjects/Cue`，本机 `origin` 为 `https://github.com/SiyiDuProjects/Cue.git`。

改名保留既有 bundle/app ID、钥匙串 service、`SageMac` / `Sage` 用户资料目录、协议、环境变量与 Swift 模块标识，避免断开登录、权限、订阅或历史。正式域名和平台 MCP 地址保持现有地址；历史交付记录中的旧名称保留事实含义。本次源码改名不代表线上服务或已安装应用已更新。

## 正式域名与 Mac 切换完成（2026-10-04 晚间）

`https://interview.siyidu.com` 已由旧 Cloudflare Tunnel CNAME 切换到 Sites；自定义域名和 HTTPS 证书均为 active。Sites 当前版本 12，`sage-capture-v1`。平台分配的 MCP 地址仍为 `https://sage-capture.dusiyi0916.chatgpt.site/mcp`；不得因产品域名切换就擅自改写该原生插件地址。原 Interview 订阅有效且续期，无需重建。

`/Applications/Sage.app` 已安装 0.3.1 / build 7，验证了正式域名原生认证、双路空闲连接、钥匙串自动恢复与真实 MCP 读取本机五份资料目录。旧 0.2.1 包保存在 `artifacts/releases/20261004-sites-cutover/previous-Sage.app`；旧钥匙串条目保留在同一 service 下的 `legacy-v12:https://interview.siyidu.com` account，不删除。Mac 新凭证仅保存在钥匙串，未写入文件或命令行。

旧 VPS 门锁已释放，服务与私人历史保留；旧历史未导入 Sites。Windows 0.3.1 包已生成但尚未真机安装。物理快捷键、真实媒体和账号断开后的即时停止仍不得宣称通过。详细 DNS 回退及安装记录见 `artifacts/releases/20261004-sites-cutover/receipt.json`。

## 全平台通知读取与 API 备用（2026-10-04，用户最新要求）

用户明确要求全平台统一为按钮通知 ChatGPT 读取，同时保留 Responses API 备用。Mac 保持菜单栏采集与设置，备用入口打开受保护的共用网页；Windows 与网页共用 `apps/cloud/ui/` 的采集设置页，只有明确打开备用面板才显示补充要求与答案。此要求取代早先“Mac 不保留 Responses 入口”的限制。

原生请求先创建 preparation，并在双路 PCM 后发送有序读取标记；服务器 commit 该标记前的音频、等待对应的最终转录，再固定截图和转录引用。后续语音不混入本次请求。webhook 仅含 request_id 等元数据，ChatGPT 用只读 MCP 获取内容。API 备用也读取固定请求，必须手动触发，不在通知失败或回答迟到时自动运行。正常启动和重连不录音、不截图、不发事件、不调用模型。

源码版本统一为 0.3.1。Sites、Mac 打包、Windows 打包、已安装版本、正式域名及真实模型分别验收；不得把候选包编译成功说成已切换。个人资料和 VPS 历史保留。旧 React 聊天和 v12 客户端传输已由共用采集界面替代，专用代码与测试应删除；原服务继续保留历史访问与回滚。


## 采集工具方向（2026-10-04，用户最新要求）

用户要求 Interview/Sage 简化为本地采集、快捷键和设置，回答在订阅的 ChatGPT Work 对话中完成。Mac 正常入口改为菜单栏工具，不再展示本地聊天、输入框或 Responses 回答入口；保留旧记录与后台兼容，不删除用户资料。启动和重连不自动录音、截图、生成或重发；`answer.requested` 仍只由明确按钮/快捷键触发。

已安装版本仍是 0.2.1/v12；源码中的 0.3.0 是 `sage-capture-v1` 候选客户端，已完成认证、双路空闲连接和合成资料读取验证，但不能提前安装到正式域名。继续保留 `interview.siyidu.com` 作为正式地址；Sites 自动域名用于迁移验证，DNS 尚未切换。

用户随后明确批准 Sites 原生认证上线：平台校验用户身份，Sage 每次投递检查来源资源权限、订阅存在与有效期，不要求转发或保存 OAuth bearer，仍保留回调挑战、签名和加密存储。Sites 版本 10 已通过真实 Work 订阅及原生请求动作触发的合成图片回答；回调用 `redirect: manual` 并拒绝所有非 2xx，不跟随跳转。真实停用 Work 任务已触发 events/unsubscribe；服务器删除订阅，旧订阅请求返回 409 且未创建投递。同一个原任务已重新启用，服务器再次确认 events/subscribe 成功；取消与恢复实测通过。账号断开是否即时停止仍未验证。正式域名、已安装客户端和 VPS 未切换。

云端以 Sites 承担采集数据、MCP 和事件为迁移方向。旧段落“保留聊天／不迁移 Sites”被这次方向取代；只有原生客户端认证、双路实时转录与停止收尾、原图读取、固定快照和事件投递实际验证后，才能切换正式后端。现阶段菜单栏客户端仍兼容既有 v12 服务，不能把界面简化说成已完成 Sites 迁移，也不能提前关闭 VPS。

用户进一步明确要求删除被替代实现，不接受只隐藏入口后持续增加代码。Mac 产品不保留聊天输入、Responses 调用、答案渲染、草稿读写、旧 AX 遍历及其专用依赖／测试；保留个人文件与服务端历史。旧服务仍被 Windows／网页使用时，不据此直接删除其在线模块。

## ChatGPT Events 与 Mac 手动触发（2026-10-04，用户明确要求）

Interview/Sage 的既有 `/mcp` 增加 MCP 2.0 `2026-07-28` 的发现、订阅与取消接口。事件只有 `answer.requested`，由已认证 Mac 的明确按钮/全局快捷键触发；语音、截图、启动和重连不自动发事件。保留现有 VPS、OAuth 与四个只读工具，不迁移 Sites。订阅由用户在 ChatGPT Work 云端对话中创建，回调 URL/secret 由 ChatGPT 提供。

Mac 的“请 ChatGPT 回答”是独立于 Responses 的明确动作，默认全局快捷键 ⌃⌥⌘↩，可在“更多 → ChatGPT 订阅”关闭。选择一个订阅后，按键绑定当前聊天、选定截图和固定转录快照；文字草稿不共享，不额外截图或开录。答案显示在订阅的 ChatGPT 对话，Sage 只展示投递状态；webhook 2xx 不代表答案已生成。当前没有回答回传工具。

`read_interview(request_id=...)` 读取固定请求，追问可用 `after_request_id` 获取新增及修正；分页重放不改读 current，不混入后来的题目。原图仍按内容存储一次。订阅、快照、投递状态写现有私有 SQLite；复核 OAuth grant，撤销或过期停止投递。失败重试保留事件 ID；重启将未确认请求标中断，不自动重发。真实 ChatGPT 账号内的完整订阅/接收/回答仍须实测后才能声称验收。

## 全平台产品统一（2026-10-04，用户明确要求）

Mac 保留原生 SwiftUI/AppKit；Windows 与网页共用 React。三端新回答（包括继续旧 Codex 聊天）统一使用服务器 Responses，移除 provider 选择器、回答正文上的产品/风格标签，以及 Windows 本机 CLI 登录与打包运行模块。旧消息、后台兼容协议及旧本机登录文件保留，不自动迁移或删除。

Mac 启动自动从钥匙串恢复 Sage 登录，正式服务器地址内置，不再让用户填网站。Windows 继续使用系统加密的已有登录配置并自动连接；临时网络故障自动重连，过期凭证要求重新验证。只恢复连接，不启动音频、截图或模型，也不自动重发未确认消息。浏览器/手机保留一次电脑确认及 30 天安全 Cookie。首次安装仍使用既有 Sage 访问凭证体系，不虚构新的账号服务。

Windows 与 Mac 打包同一 `apps/desktop/electron/materials-host.cjs`，只读既有资料目录。Windows 旧配置中的 codexWorkspace 只迁移为资料位置，codexBin 不再恢复；不创建 CLI 登录或 agent 工作区。普通界面不展示开发服务器和 CLI 设置。Mac 的原生 Markdown/表格/公式渲染与 Web 的 GFM/KaTeX 对齐常用格式；复制保留原始回答，滚动末端渐隐。下述较早 Codex 产品入口说明由本段取代；历史兼容和回滚保留。

## macOS 客户端简化（2026-10-03，用户明确选择）

Mac 版保留 Sage 聊天，回答仅使用服务器 Responses API；不再提供或运行本机 Codex CLI。旧回答的来源标记与历史保留，继续旧聊天时新请求固定使用 Responses。后续 Windows/网页统一方向见上文。

Mac 本地负责手动截图、双路音频采集/格式转换、界面和按需只读资料；语音模型连接、转录与回答在服务器处理。`Support/materials-host.cjs` 仅复用 v12 已有 `/model` 认证传输读取资料，拒绝生成请求，不加载 CLI 或创建 agent 工作区。已有 `assistant-workspace/materials` 路径保留，不删除旧登录状态。Node 仍用于资料与原生截图桥接，不代表保留本地模型宿主。

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
- PowerShell 使用 npm.cmd。HeroUI Pro 使用现有 CollectUI 渠道，复用已安装组件；CI 安装遵循 CollectUI 原版教程与项目锁定版本，不要求官方 HeroUI 账号或 `HEROUI_AUTH_TOKEN`，不静默替换组件库。文档更正不代表该项目 CI 已经实测通过。
- 修改现有 HeroUI 前端时主动使用全局 `heroui-react-pro`、`heroui-pro-design-taste` 和已配置的 `heroui-pro` MCP；先定位实际前端 package.json 并检查组件产物，再判断安装问题。CollectUI MCP/Skills 与组件安装分别验证；教程为 https://docs.collectui.pro/ai-tools/mcp、https://docs.collectui.pro/ai-tools/skills、https://docs.collectui.pro/hpsetup/usage。

## 发布与编辑

- 当前协议为 `interview-chat-v12`，UI 和采集握手必须匹配；声明 chat=true、pinned_code=false。新 UI 拒绝 v11 及更早客户端，不能假装聊天可用。
- 后端先上线并验证 health/protocol，再发布客户端。当前代码修改和离线通过不等于已部署、真实音频或真实模型质量验收。
- 发布走认证 deployment gate，活跃面试时拒绝；保存回滚，不绕过。部署资料不迁入源码。见 `apps/server/deploy/README.md`。
- VPS ubuntu，Compose `/home/ubuntu/siyi`，部署 `/opt/interview/server`，service/container `interview_api`，8000，`https://interview.siyidu.com`。不得占用 8080、8787、20241、40000。
- Windows 安装包用 apps/desktop 的 `npm.cmd run package:windows`，递增版本，产物 releases/windows；safeStorage 配置导入用正常 app.quit() 刷新。白名单不含 .env、私有资料/源码或依赖源码。
- 沿现有模块边界扩展，不把产品业务写进音频循环。优先删除重复状态和已替代链路，不预建 agent 平台。
- 不修改用户无关未提交文件。删除/重命名先核对绝对目标和引用；Windows 文件操作用 PowerShell 原生命令。
