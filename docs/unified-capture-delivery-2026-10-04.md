# Sage 0.3.1 统一采集交付记录

2026-10-04，America/Los_Angeles。云端 Sites 版本 12 已发布；正式域名已切换，Mac 0.3.1 / build 7 已安装并恢复登录，Windows 安装包已生成。以下保留候选验证和切换记录，Windows 真机与真实媒体验收仍独立待办。

## 使用方式

电脑只负责手动采集、快捷键和设置。Mac 保持原生菜单栏；Windows 和网页共用 `apps/cloud/ui/`。网页可查看已有采集并通知 ChatGPT，不获得设备音频凭证，也不能代替电脑采集。

按「请 ChatGPT 回答」后，客户端先固定选定图片，并在双路已排队 PCM 后发送读取标记。云端等待对应尾句的最终转录，保存固定请求，然后发送 `answer.requested`。事件仅带 request_id 等元数据；Interview 对话通过只读 MCP 获取原图和文字。标记之后的新语音不混入该请求，语音继续采集。没有自动截图、自动回答或后台补发。

Mac 快捷键为 ⌃⌥⌘↩；Windows 为 Ctrl+Alt+Enter。所有端使用同一订阅选择与固定请求语义。订阅的 channel=mac 是现有任务过滤值，不限制触发设备。

「API 备用回答」需明确打开并手动生成，可使用同一次固定内容或重新选择最新内容。Mac 打开受保护的共用网页；Windows 与网页显示同一个备用面板。默认云端 Responses 模型配置保持 `gpt-6.1-sol`、xhigh；支持原图、按需读取电脑资料、流式 Markdown／代码／表格／公式、停止及保存结果。通知失败或 ChatGPT 暂时未回答不会自动启用 API，也不会自动重发。

## 已删除与保留

- 删除被替代的 React 聊天／会话／代码面板、v12 客户端传输、模拟界面链路、旧桌面后端启动器及专用测试；移除旧界面的 15 项直接依赖。Mac 已删除本地聊天、渲染和旧 AX 遍历。
- Windows 与 Mac 共用 Sites 资料桥接。安装包不包含 CLI、私有资料、登录文件或模型 key。
- 个人文件、旧草稿、历史数据库及 VPS 仍保留。正式地址现已切到 Sites；旧在线服务保留为历史与回退来源。
- 修改前源码备份在 `artifacts/backups/before-unified-trigger-20261004.tar.gz`；旧 React 界面备份在 `artifacts/backups/retired-desktop-ui-20261004.tar.gz`。`apps/cloud` 是 Sites 单独登记的源码仓库；主仓库中的未提交变更没有被强行提交或覆盖。

## 验证证据

| 层级 | 结果与边界 |
| --- | --- |
| 云端离线 | 21 项通过；覆盖双路读取标记、乱序最终结果、后续内容隔离、断线不生成快照、API 手动触发与幂等、浏览器与设备权限边界。 |
| Windows 共用代码 | 29 项采集／认证／资料／截图测试通过，1 项 Windows 专属检查在 Mac 跳过；构建及安装包白名单检查通过。 |
| 共用网页 | Chromium 合成测试通过：启动无采集／模型、按钮通知、手动备用回答、代码／表格／公式、刷新不重发、390px 布局。真实 Electron 入口与 preload 也已在 Mac 上连接合成服务并触发一次通知，启动未申请媒体或调用模型；它不证明 Windows 真机媒体能力。 |
| Mac | 24 项核心、30 项运行时、4 组资料桥接、3 项 App Shot 桥接检查通过；Release 构建与 ad-hoc 签名验证通过，未公证。本轮没有真实麦克风／屏幕采集。 |
| 真实 Sites 转录与事件 | 两路合成音频共 6.387 秒；录音连接保持期间，标记前尾句均已完成并成为固定请求；随后停止正常。Webhook 收到 delivered。没有打开麦克风。 |
| 真实 ChatGPT 回答 | 原 Interview 对话收到上述事件，实际调用 `read_interview`，产生中文回答。独立核对了对话执行记录，不仅依据 webhook 2xx。 |
| 真实 Responses | 获用户许可后一次 `gpt-6-luna` 短文本请求，1.771 秒完成并返回约定文本。使用实际答案服务代码及独立合成存储；不等于生产 Site `/api/answers` 的完整账户验收。生产模型配置未修改。 |
| 订阅生命周期 | 真实取消时源订阅删除，旧订阅请求被拒绝且未创建投递；原任务恢复并自动续期。账号／插件断开后是否立即停止仍未验证。 |

真实事件请求 ID：`qa_boundary_ec24e5b4-4f74-4b3e-9449-6dbd8e146588`。Interview 对话：`6ac3142e-488c-83ea-a7b5-9275e3fe4336`；实际回答 turn：`01a10a95-bc7f-767f-ad4d-419bf8c28397`。本阶段付费测试已完成，不应自动重复执行。

## 云端与安装包

- Site：[迁移验证入口](https://sage-capture.dusiyi0916.chatgpt.site)，保持所有者私有。正式产品地址仍是 `https://interview.siyidu.com`。
- Sites project：`appgprj_6ac3050911388191a096e3850daec725`；版本 12，环境 revision 2。
- 已推送源码：`0b0c2824729b43e6d028ab30349076d15c096f78`。
- 成功部署：`appgdep_6ac3390f719c81918e22c57c8e439a92`。
- 版本 10 保留为上一个已验证的事件实现；版本 11 验证新增转录边界，版本 12 增加 Responses 工具循环的加密推理状态返回。回退须保留新增数据库字段及原始数据，不能恢复旧库覆盖历史。
- Mac：`artifacts/candidates/20261004-unified-trigger/Sage-macOS-arm64-0.3.1.zip`，build 7，Apple Silicon、macOS 15+，ad-hoc 签名、未公证。
- Windows：同目录 `Sage-Setup-0.3.1.exe`，x64，未签名；已检查打包内容，未在 Windows 真机安装或验证录音。
- 同目录 `receipt.json` 保存最终 SHA-256、测试边界与部署状态；`live-boundary.json`、`live-responses.json` 为脱敏实测记录。

## 正式切换前的状态（已由下方记录取代）

`interview.siyidu.com` 仍指向旧服务。Sites 自定义域名登记 `appgdom_6ac31636296c8191bd571ceaeba45242` 处于 pending / pending_validation；当前没有可用的 Cloudflare 域名管理入口，已询问用户管理位置。取得入口后还需完成 DNS 与证书验证、正式域名认证／双路连接检查，再备份安装并导入对应设备连接；不能直接把候选版覆盖到旧配置上。

安装后的物理快捷键与真实媒体、Windows 真机，以及账号断开即时停止分别保留为待验收项。VPS 私人历史未迁移，旧服务不关闭。临时 Site 域名上的成功不代表自有域名和用户当前客户端已经切换。

## 可重复的离线检查

在 Mac 先加载 `/Users/siyi/Projects/_tools/env.sh`。云端执行 `npm test`（`apps/cloud`）；桌面执行 `npm run test:capture`、`npm run build`（`apps/desktop`）；Mac 执行 `bash apps/macos/scripts/check-offline.sh`。

共用界面合成验收先在一个终端启动 `node apps/cloud/scripts/preview.mjs`（已有云端构建产物），再在 `apps/desktop` 执行 `npm run test:ui`。预览只监听 127.0.0.1:4178，拒绝真实外部模型／媒体，完成后退出预览进程。Windows 打包在 `apps/desktop` 执行 `npm run package:windows`。


## 正式切换完成（2026-10-04 23:30 PDT）

用户在已登录 Chrome 提供 Cloudflare 管理入口后，已保存旧记录并配置两条验证 TXT。唯一 `interview.siyidu.com` CNAME 从 `bf710185-7813-4766-bdc6-119cebebf9bb.cfargotunnel.com`（Proxied）改为 `custom-domains.chatgpt.site`（DNS only，Auto TTL）。Sites 绑定、provider 和 SSL 状态均为 active；其他域名、旧 Tunnel 路由没有修改。

切换前认证部署门确认 active=false，并临时进入 draining；完成后已恢复 active=false、draining=false。正式域名通过设备认证与未认证拒绝检查、原生 AppStore 双路空闲 WebSocket 检查，未启动媒体或付费模型。Chrome 正常使用现有 ChatGPT 账号登录正式网页，显示已连接且两路已停止。

平台 `get_site` 返回的产品 URL 已是 `https://interview.siyidu.com`，原生 MCP 地址仍为自动域名 `/mcp`。正式域名的 `/mcp` 不作为插件连接入口；检查与客户端配置使用平台返回的准确 MCP 地址，原 Interview 订阅保持有效并续期。

Mac 正常退出旧版后安装与候选包字节一致的 0.3.1 / build 7，签名验证通过。旧应用完整保存在本次发布目录；旧钥匙串凭证仅改名保留，新凭证授权已安装 Sage 使用，无明文文件或命令行。启动后真实 MCP 成功读取本机五份资料的目录元数据，证明已安装应用的自动登录与资料桥接正常；没有批量读取或复制个人正文。

产物现位于 `artifacts/releases/20261004-sites-cutover/`，包含两平台安装包、SHA256SUMS、receipt.json、DNS 前后截图和 formal-state.json。候选目录继续保留为原始阶段记录。旧 VPS 私人历史尚未复制到 Sites，服务和回退保留。

本次没有新增付费 API 测试或真实媒体采集。原生 GUI 检查因 Computer Use 通道故障及 osascript 未获辅助访问未能完成，没有绕过权限；物理快捷键与真实媒体、Windows 真机和账号断开即时停止仍待实际验收。


正式网页登录后按按钮产生新请求 `9828a020-7fcb-4dd2-bfda-6547f72b3092`，一次投递收到 delivered，事件仅含标识和数量。原 Interview 对话在约 195 秒后开始新 turn `01a10ac6-8424-73d0-bdd7-66198443750e`；这次原生事件排队约三分钟，不能承诺临场即时响应。Responses 备用仍须手动触发，本次未调用。

该 turn 已完成 `read_interview(request_id=..., after_request_id=上一条已回答请求)`，最终结果为 `::SKIP_COMPLETION::`，没有新的可见回答。独立重读确认增量为 transcripts=[]、images=[]、complete=true：测试复用了已经回答的合成材料，未提供新问题。此项证明正式网页触发、原任务接收及固定增量读取；真实中文回答证据仍为上表中上一条合成请求，不能将本次 delivered 写成新答案已生成。
