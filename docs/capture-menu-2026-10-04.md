# Sage Mac 0.2.1：菜单栏采集工具

最新 0.3.1／Sites 版本 12 状态见 [统一采集交付记录](unified-capture-delivery-2026-10-04.md)。本文保留各阶段的原始验收与阻塞过程；较早的“当前”结论不代表最新状态。

## 已交付

- Mac 正常启动为菜单栏工具，不显示 Dock 图标，不自动打开聊天或设置窗口。
- 菜单可开始／停止转录、手动截图、请求 ChatGPT 回答、打开设置和退出。
- 设置保留登录、截图来源、原图预览／移除、查看转录、新一场、订阅和快捷键。
- 正常 Mac 界面没有聊天、文字输入框、Responses 生成或模型选择入口。旧记录、草稿文件保留；被替代的客户端实现已在后续清理中删除。
- 全局快捷键仍为 ⌃⌥⌘↩；只有明确操作才发送 `answer.requested`。后台恢复不开始采集或自动重发。
- 退出时等待已开始的音频收尾；截图来源保存在本机设置。

## 本轮验证

- 原生 Release 构建和 ad-hoc 签名验证通过；未公证。
- 25 项核心离线检查、59 项原生运行时检查、5 项真实应用生命周期检查通过。
- 生命周期检查使用合成数据，确认菜单栏初始化、启动无窗口、设置可打开、打开设置不采集，以及合成转录数据仍可查看。
- 3 项 App Shot 桥接检查及 5 组只读资料桥接检查通过。
- 设置窗口浅色预览已渲染和检查；该预览不调用真实媒体或模型。
- 安装前通过容器内只读部署状态确认 `active=false`、`draining=false`。旧 0.2.0 在钥匙串同步读取中阻塞主线程，正常退出失败；核实精确进程及未采集后终止该旧进程，备份并原子安装 0.2.1。新版钥匙串操作在后台执行，取消连接与退出保持响应；晚到的凭证结果不会重连。
- `/Applications/Sage.app` 已运行，版本 0.2.1，`LSUIElement=true`，签名验证通过，安装后的可执行文件 SHA-256 与构建产物一致。
- 正式后端健康接口返回 HTTP 200，`chatgpt_events=true`，release `20261004-events-130537`；本轮没有更换后端。

- 用户完成钥匙串授权后，现有 Sage MCP 成功查询到本机 5 份资料目录；仅运行 `/Applications/Sage.app`，没有启动音频或模型。
- 本轮实际删除旧聊天、渲染、AX 遍历及专用测试／依赖，Mac Swift 源码和 Package.swift 从 3,762 行减至 2,555 行，净减少 1,207 行。这是相对于本轮清理前工作区的统计，不是整个仓库相对 Git HEAD 的净变化。

## 产物与回退

- 安装包：`artifacts/releases/20261004-capture-cleanup/Sage-macOS-arm64-0.2.1.zip`
- SHA-256：`7e1d8d070eee92c116e59154dad0a2712000bdd2821fae382bb8e1520273bea9`
- 安装记录：同目录 `receipt.json`。
- 原客户端备份：同目录 `previous-Sage.app`。钥匙串、资料目录和服务端历史没有替换。

## 尚未完成

这次客户端交付不等于整个新架构完成：

1. Sites 私有采集服务已建立并部署：`https://sage-capture.dusiyi0916.chatgpt.site`，源码在 `apps/cloud`；原生安装版仍连接 VPS，尚未完成切换。
2. 用户已同意复用 Interview 现有密钥，通过 Sites 秘密配置保存；没有写入源码或安装包。
3. Sites 私有 HTTP 与双路 WebSocket 传输已分别用 Node 与 macOS 原生 URLSession 在真实托管地址验证。连接探针不发送 start、音频或模型请求。服务凭证不能冒充 MCP 用户身份；新的 Sites 插件也已通过真实账户成功调用 list_interviews。
4. Sites 的插件授权复核、Mac 采集适配和 Work 订阅／快捷键投递／原对话回答仍须完成。云端双路 ASR／尾句已用合成声音验证传输及保存，但发现一处识别错误，不能称为准确率验收通过。Webhook 成功不代表回答已生成。
5. Windows／网页仍使用原有服务。不能因为 Mac UI 已简化，就删除这些在线模块或私人历史。

在认证、实时转写收尾、原图／固定快照和事件投递实际验证后再切换服务。旧 VPS 在此之前保留。

## Sites 实测中的阻塞

- 真实新插件调用返回 `subscription_authorization: {forwarded: false, revalidated: false}`。Worker 请求头只有平台认证身份，没有 Authorization；所以目前 `events/subscribe` 的原 OAuth 凭证复核方案明确拒绝订阅。不能据此宣称 Sites 原生 Events 全部不可用，但当前实现不能完成投递。
- 官方 [MCP Events 文档](https://developers.openai.com/plugins/build/mcp-events) 要求在订阅有效期内复核访问并在撤销后停止。已检查的 Sites 文档说明平台身份与服务访问，但没有给出可替代的订阅授权复核接口；不能拿服务凭证代替用户授权。
- 用户随后明确授权不超过 30 秒的双路合成 ASR 测试。初次失败提示无法区分启动与音频接收；补上脱敏诊断后复测确认，语音服务已启动，第一帧因运行时默认 Blob 而被拒绝。已在 accept 前明确选择 ArrayBuffer 并补上原始 PCM、尾句、失败清理与秘密脱敏的离线回归。

## Sites 版本 4 的结果

- 地址：`https://sage-capture.dusiyi0916.chatgpt.site`；project `appgprj_6ac3050911388191a096e3850daec725`。
- 已推送源码：`4d15bbeafe5fe09fdcbd84c66f6424f8d56a193b`；deployment `appgdep_6ac31205fd5c8191bf05d369eefb0da9` 成功，仍为所有者私有。
- 13 项离线测试通过。Mac 原生 URLSession 私有 HTTP／双路 WebSocket 握手通过。
- 实际云端 ASR 使用两段系统生成语音共 6.387 秒，无麦克风、无屏幕采集、无回答请求。两路最终文本、停止收尾与持久化检查均通过，两路结束状态均为 idle。逐字准确性断言未通过：interviewer 把 “binary search” 识别为 “BFS”；candidate 的 “The time complexity is logarithmic.” 正确。没有自动更换模型或密钥。
- 真实账户的 Site MCP 可读取保存的两路文本。单像素合成图片通过真实 R2 写入和 MCP 原图读取，返回字节与上传完全一致；从当前附件移除后，固定 request_id 重读仍返回同一原图和转录。没有把真实截图／资料同步到新 Site。
- 新 Site 尚无订阅。原生正式安装版仍为 0.2.1，未切到 Site；后续已完成云端适配候选版，见下一节。原 VPS 与私人历史保留。


## 0.3.0 云端适配候选版（尚未安装）

- Mac 的连接、采集状态、双路转录、截图上传和按需资料桥接已换成 Sites 接口，删除对应 v12 客户端传输链路；Windows／网页的在线实现仍保留。
- 接口保持正式自有域名 `interview.siyidu.com`。已在现有 Site 登记该域名，仍待 DNS 验证；没有更改 DNS。默认 chatgpt.site 地址只是迁移验证入口。
- 24 项核心检查、30 项原生运行时检查、5 项真实菜单栏生命周期检查、4 组资料桥接检查和 3 项 App Shot 桥接检查通过。较旧数字属于 0.2.1；删除被替代协议后测试范围已同步调整。
- 使用 0.3.0 真实 AppStore 验证 Sites 认证、采集快照、双路空闲 WebSocket 均通过；没有开启媒体、模型或写入新登录。
- 打包后的资料桥接与真实 Sites MCP 完成临时合成 UTF-8 文件的目录和正文读取；随后退出辅助进程并移除测试目录。个人资料没有上传到新 Site。
- 云端版本 5 已修复新场次与旧空闲音频连接的竞争，旧连接不能跨场启动付费转录；新场次切换与活动采集互斥。14 项云端离线检查通过。
- 按用户要求新建的 Work 云端对话名称为 **Interview**，对话 ID `6ac3142e-488c-83ea-a7b5-9275e3fe4336`。用户已授权继续在该对话测试订阅。
- 首次及一次重试均未保存订阅。新增脱敏日志证明重试时 `events/subscribe` 和清理用的 `events/unsubscribe` 到达服务器并以 400 被拒绝，平台仅报告任务服务 unexpected error。继续定位具体校验项，不能称为订阅或自动回答成功。
- 已安装 0.2.1、钥匙串和私有历史未替换；正式域名与 VPS 未切换。

- 0.3.0 Release 编译与本机 ad-hoc 签名通过，候选包保存在 `artifacts/candidates/20261004-sites-adapter/`；同目录 receipt 记录哈希与验证范围。没有安装，正式 0.2.1 仍运行。云端适配阶段按 Swift、Package.swift 和 Mac 资料桥接统计，源码从 2,584 行减至 2,283 行，净减少 301 行。


## 订阅失败的真实定位与域名说明

- 已确认第三次订阅请求到达 Sites，拒绝原因是 `callback_host_not_allowed`，ChatGPT 真实回调主机为 `connectors.api.openai.com`。只记录了主机名，没有记录完整回调 URL 或签名秘密。
- 生产运行配置 `SAGE_CALLBACK_HOSTS` 从 `chatgpt.com` 修正为 `chatgpt.com,connectors.api.openai.com`，环境 revision 2。相似主机、子域伪装及本地地址仍拒绝；HTTPS、签名和禁止重定向不变。
- 同一真实 `events/subscribe` 请求的 `authorization_forwarded=false`。现有授权复核方案仍不能在 Sites 上成立，不移除检查来掩盖问题。
- 云端版本 6 对应源码 `5c24eec0ff6c846a1116fc8b669712e2d6ca7fd8`，环境更新后重新发布同一版本。服务器 RPC 401/403 现以对应 HTTP 状态返回；事件错误日志仅含校验类别、主机及是否存在授权头。
- 自定义域名登记 ID `appgdom_6ac31636296c8191bd571ceaeba45242`；`interview.siyidu.com` 尚未切换 DNS。Sites 自动分配地址不取代正式域名。完整迁移通过前，继续保留当前 VPS 及 Windows／网页服务。


## Sites 原生认证方案（已获批准并上线，以下保留审批过程）

- 已查阅 Sites MCP 身份文档以及 MCP Events 规范 Authorization 部分。Sites 在托管入口负责 OAuth，服务端接收已验证主体；Events 协议要求复核主体对来源资源的权限，并不要求把平台 OAuth bearer 保存到应用。
- 本地候选修改只影响 `apps/cloud`：订阅身份沿用受信平台用户；每次投递检查当前来源所有者、`events_access` 策略、订阅存在与到期时间；取消订阅移除授权；ChatGPT 返回 401/403/404/410 时删除订阅并取消排队投递。回调白名单、HMAC、挑战验证、加密存储、有限重试均保留。
- 不改变 VPS OAuth，不使用设备服务凭证冒充用户，不导出或保存平台 bearer。账号断开时平台是否立即发 unsubscribe 尚未实测；平台会限制后续工具访问和续订，订阅仍有有限有效期，不能声称即时断开行为已验收。
- 15 项离线检查通过，包含未认证与其他用户拒绝、来源权限撤销、过期、410 后取消所有排队请求、不保存 OAuth bearer。
- 自动审批拒绝了将这一候选修改推送／发布到生产：判定为持久认证边界变更，需要用户明确授权具体范围。已向用户展示方案并请求批准；未绕过拦截。线上仍是版本 6 / 环境 revision 2，真实订阅失败码已明确为 `grant_not_forwarded`。


## 用户批准后的订阅联调

- 用户明确回复“允许上线并完成订阅测试”，授权上述平台原生身份和来源资源权限方案。重新提交发布后自动审批通过；没有绕过原拦截。
- 版本 7 已上线该方案，真实订阅请求已通过用户和资源权限校验。版本 8 将回调失败细分为网络、HTTP、响应格式和挑战不一致；真实错误为 `unreachable`。
- 版本 9 修正 Worker 全局 fetch 的调用接收者并加入回归，真实错误进一步定位为 TypeError / redirect。此证据只说明重定向相关请求失败，不能直接判定回调主机断网或不支持 Events。
- 当前仍没有已保存的 Work 任务或服务端订阅，没有发送测试回答事件。每次创建前后均核对任务列表，失败不累积重复任务。
- 准备的测试素材是一张本机绘制的二分查找问题图片，标记 `SAGE-EVENT-20261004`，没有麦克风或屏幕采集。它位于独立新测试场次；原有 ASR 合成记录保持不变。


## Sites 版本 10：真实订阅与原对话回答通过

- 发布源码 `c82970cc75fdc2d2a9bad1d1e2de443f3feb71a1`；deployment `appgdep_6ac323c2e79c8191a4a35feca6b8afd8` 成功，环境 revision 2，所有者私有。
- 回调请求使用 `redirect: manual`，所有非 2xx（含 3xx）均拒绝，不跟随重定向。切换后真实回调 challenge 成功；不能把前面的 TypeError 当成真实 HTTP 跳转的证据。全局 fetch 接收者修正也保留。17 项云端离线检查通过，包括不跟随 307、不保存失败订阅。
- 2026-10-05 04:14 UTC，Interview 对话的真实原生事件任务保存并启用。服务端订阅 `sub_b503643fff594ce85c572173d14e78e18e45b2d32c5a667c68a803d2c1d5f9fb`，channel `mac`，首次有效期至 05:14:17 UTC。
- DEBUG 原生客户端通过受控隐藏输入连接真实 Sites，确认独立测试场次、唯一合成图片、无语音，然后调用生产 `AppStore.requestChatGPT()`。没有读取或改写钥匙串、开启媒体或资料后台。
- 固定请求 `5114064a-4c7a-41cf-961d-42ae8ac7be4e` 收到 `delivered`。紧接着该 Work 对话发生独立事件触发 turn `01a10a46-35e7-73fb-be4a-adfec508cdae`，调用 Sites `read_interview` 后返回中文 O(log n) 解释和 Python 二分查找实现，识别到 `SAGE-EVENT-20261004` 图片标记。此项同时核对了 webhook 回执和真实 ChatGPT 回答。
- 这证明原生动作处理器的完整链路，不等于物理快捷键、真实麦克风或正式安装客户端已验收。0.2.1 安装、DNS、VPS 尚未更改；0.3.0 Release 候选包仍是之前的未安装归档，新增 DEBUG 测试入口不在该归档中。


## 当前收尾状态

- 连续两次向 Interview 对话发送取消测试指令均由消息接口返回 `Too many requests`；核对后台对话仍是已完成的自动回答轮次，没有执行取消操作。已停止重试，有效订阅保留。取消、恢复订阅与账号断开即时停止均仍需真实验证，不能用离线测试替代。
- 已从当前测试场次移除唯一合成附件，再用真实 MCP 重读上述固定 request_id，仍返回该原图和空转录，固定快照不受移除影响。
- `/Applications/Sage.app` 再次核实为 0.2.1 / build 5。根工作区差异格式检查通过；无生产安装替换。
- Cloudflare 权威 NS 为 `david.ns.cloudflare.com` 与 `kate.ns.cloudflare.com`。Sites 自定义域名仍 pending / pending_validation，未修改 DNS。后续切换还需 Cloudflare 管理访问和保留 Windows／网页旧服务的路由安排，不能直接关闭 VPS。

当前 Sites 版本 10 的上线与订阅创建、一次完整回答验收已完成；全部产品迁移尚未完成。详细候选包与验证边界记录在 `artifacts/candidates/20261004-sites-adapter/receipt.json`。


## 插件重新连接后的核对

- Sage 插件连接通知后，再次调用真实 Sites `list_interviews` 成功，返回 `sites_identity` 且 `resource_access=true`，当前测试场次 idle。
- 再尝试一次已授权的取消测试消息，接口仍返回 `Too many requests`；对话没有新的执行轮次，取消操作仍未发生。停止继续重试，保留有效订阅；此阻塞属于跨对话消息服务，不能解释为 MCP 连接失败。


## 取消订阅实测通过（2026-10-04 晚间，America/Los_Angeles）

- 原 Interview 任务于 21:27 左右成功停用，`is_enabled=false`。当前 ChatGPT 任务接口保留停用记录；清空事件触发器的调用被参数校验拒绝，没有删除任务记录。
- 停用动作真实触发 `events/unsubscribe`，Worker 日志为 complete（UTC 04:27:31）。服务端旧订阅已消失；使用该旧订阅发起受控请求得到 409，再查该请求得到 404，证明没有创建投递，也没有发送新事件。
- 已请求恢复同一个原任务，首次恢复消息被 `Too many requests` 拦住。暂时保持停用，正在退避后恢复；不得声称当前订阅仍有效或已经恢复。


## 原订阅恢复完成（2026-10-04 21:33，America/Los_Angeles）

- 间隔后恢复指令送达原 Interview 对话。同一个原任务重新启用并经 ChatGPT 确认 `is_enabled=true`；没有新建重复任务，原 `answer.requested / channel=mac`、中文回答和 Python 要求保留。
- Worker 在 UTC 04:33:03 记录真实 `events/subscribe` complete。恢复没有读取旧测试题或产生新的回答事件。此前的限流来自跨对话消息接口，这次取消／恢复生命周期已通过；账号断开即时停止仍是独立未验收项。

- 设备认证接口复核仅有一条恢复后的有效订阅：`sub_4b8ccb9beb57e0a49e7ce6f4a94277e91cb3955d31df16b7912f4321b0655739`，channel mac，本次有效期至 2026-10-04 22:33:03 PDT。
