# Sage for macOS

原生 SwiftUI/AppKit 客户端，最低 macOS 15。聊天、手动 App Shot、系统音频与麦克风独立转录共用现有 `interview-chat-v12` 后端。不会在启动时申请媒体权限或自动连接生产服务器。

## 功能与边界

- 聊天：Responses API / 本机 Codex、流式回答、停止、历史会话、新建/重命名、按聊天保存草稿、截图附件预览/移除。
- 转录：手动开始；ScreenCaptureKit 分别提供系统音频和麦克风，独立转换为 24 kHz 单声道 PCM，分别发送。切换聊天保留共享转录；停止先关闭采集并刷新尾帧，再确认服务端收尾。缓冲超限丢最旧帧并显示缺口，不自动补造音频。
- App Shot：默认获取回到 Sage 前使用的应用窗口，可选择指定窗口或显示器。保存原尺寸 PNG；窗口截图附带同一窗口的辅助功能文字、应用名和窗口标题。读取有时间、节点和文字上限；文字不完整或无权限时保留原图并标注原因。不保证所有应用提供文字，也没有 OCR 回退。
- Swift 包 `SageAppShot` 仅提取 Peekaboo 的 AX 属性读取完整性策略；截图、窗口匹配和有界遍历另行实现。没有引入整个 Peekaboo、AXorcist、自动化 agent 或 CLI。具体来源、提交和 MIT 许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- UI 与采集均原生。仅 Codex/资料的既有协议桥接复用五个 CJS 模块和随包 Node，未包含 Electron、React renderer 或个人资料。
- 本版本为普通面试辅助；Windows 的可选模拟面试官尚未移植。未实现完整 Markdown 表格/数学排版，原始回答和复制内容保留。

## 构建

需要 Apple Command Line Tools（SDK 支持 macOS 15 API）、Swift，以及 Node 22+。本次构建环境为 Apple Silicon、Swift 6.4、macOS 27 SDK；其他架构/工具链尚未实测。

在仓库根目录执行：

```sh
# 本机共享工具存在时加载；其他机器使用已有 PATH。
if [ -f /Users/siyi/Projects/_tools/env.sh ]; then
  source /Users/siyi/Projects/_tools/env.sh
fi
CONFIGURATION=debug bash apps/macos/scripts/build-app.sh
open apps/macos/output/Sage.app
```

上面的命令生成 Debug 包；省略 `CONFIGURATION=debug` 构建 Release。产物为本机架构、临时签名的 `output/Sage.app`，未公证。构建失败保留上次成功的包。`SAGE_NODE_BIN` 可指定 Node，`SAGE_NODE_LICENSE` 可指定该发行版 LICENSE 文件。打包为明确白名单，不复制 `.env`、materials 内容、登录状态或历史数据库。

## 首次使用

1. 在连接设置填写现有 HTTPS 服务地址和电脑访问凭证。访问凭证可保存在 macOS 钥匙串；这里不填写 OpenAI key。后端 key 仍只在服务器。
2. 使用 Codex 时安装本机 CLI，必要时填写可执行文件完整路径，点击“登录 Codex”。登录使用 Sage 独立的 `CODEX_HOME`，不会复制开发者 Codex 登录。Responses API 不要求 CLI 登录。
3. 点击 App Shot 才申请截图/辅助功能权限。开始转录才申请麦克风及屏幕/系统音频权限。截图源消失或窗口文字无法唯一匹配会明确提示，不转用其他窗口。
4. App Shot 文字需要本次后端代码的 `/health.appshot = true`。旧 v12 后端仍可选择显示器截图；缺少标记时窗口 App Shot 显示升级提示。发布仍须按仓库部署 gate 先更新后端，再发布客户端；本次生产发布记录见下文。

本机文件位于 `~/Library/Application Support/SageMac/`：`drafts.json` 为草稿，`assistant-workspace/materials/` 为用户自行提供的资料，`assistant-workspace/.runtime/codex/` 为专用 CLI 状态。读取草稿失败时停止覆盖原文件；不要把这些文件加入产品 Git。

截图与窗口文字随选中附件进入聊天；未发送文字草稿不共享。只读 MCP 可以读取未发送的截图及其 App Shot 文字。辅助功能文字可能包含窗口内屏外内容，不能据此声称它全都在截图中可见。

## 离线验证

```sh
bash apps/macos/scripts/check-offline.sh
cd apps/server
OPENAI_API_KEY='' OPENAI_BASE_URL='http://127.0.0.1:1/v1' \
  INTERVIEW_WORKSPACE_HISTORY_DIR='' .venv/bin/python -m unittest discover -s tests
```

原生检查通过 `--self-test` 在没有 NSApplication GUI 的路径运行；使用可控 continuation、截获 HTTP、模拟 WebSocket 和合成 PCM。不会请求真实媒体、登录或模型。测试覆盖切换聊天时的发送归属、恢复连接与新连接竞争、迟到的采集创建、双路收尾、音频转换、认证首帧、发送积压和协议拒绝。

调试包可用 `Sage.app/Contents/MacOS/Sage --preview` 查看静态界面，无网络与采集。可在正常 GUI 会话加 `--render-preview /tmp/sage-preview.png` 导出自身窗口，不读取其他应用屏幕。

## 本次验证记录

- Debug 构建和签名验证通过；31 项协议/AX/状态检查、45 项原生运行时检查通过。发布准备时在获准的本机构建进程中完成 Release 编译与 dSYM 生成，31 项 Release 协议/AX/状态检查通过；已有 Debug 包保持不变；Release 应用作为离线候选单独打包，安装、启用和分发以对应后端已上线为前提。
- 打包 Node 桥接的模拟登录、独立运行目录、凭证环境过滤、资料模板白名单检查通过。
- 后端 58 项相关测试通过，包含新增 App Shot 上传校验、选中附件入模、MCP 读取和原图/文字持久化恢复。
- 发布准备时在允许 loopback 监听的离线进程执行后端全套 201 项，全部通过（清空真实 key、使用不可达的 loopback provider 地址）；此前受限环境的 11 项监听阻断已解除。桌面 UI 33 项通过，采集 64 项通过、1 项 Windows 专属检查跳过，Web 构建通过。
- 当前受限进程的 GUI 启动在 macOS `_RegisterApplication` 阶段退出；没有完成真实窗口、真实截图/AX、真实音频和真实模型验收。没有通过改权限或改测试断言隐藏此限制。

## 归属与登录边界复查

本轮使用合成数据先复现失败，再修复和验证；没有读取真实登录凭据或应用窗口。

- AX 匹配不再将空标题当通配条件；读取前后检查原窗口 ID、进程、标题与位置，并拒绝同应用内重叠同名窗口。窗口关闭、替换或变化时丢弃文字，原图保留。公开 AX 接口的文字与截图并非原子快照，仍不能承诺文字逐字对应截图时刻。
- 截图点击时固定聊天与连接代次；切走再切回也会失效。采集事件携带所属聊天，采集完成后再检查；失效结果不会上传。截图操作 ID 控制按钮状态，旧完成事件不会释放新操作。服务端取消后的截图请求拒绝迟到上传，图片和文字不进入新聊天或 MCP。
- 登录桥接没有新增 HTTP/OAuth 回调接口，只读取父进程私有 stdin 的首条配置。重复配置不会再次启动登录；EOF/取消会终止并回收 CLI，包含忽略 SIGTERM 的合成进程。服务器来源仍由 Swift `ServerAddress` 限定 HTTPS/loopback；登录的 OAuth 回调与 state 验证由所安装 Codex CLI 负责，本轮未执行真实登录，不能据此声明已验证 CLI 内部 OAuth 防重放行为。
- 先前受限环境中 `dsymutil` 的 `Operation not permitted` 已在获准的本机构建进程中解除；未修改系统权限或禁用检查。Release 编译不等于 GUI、真实媒体、真实登录或真实模型验收，相关限制维持原记录。

初始快照边界补充：`session_ready` 仅表示认证完成，截图按钮及请求准入会继续等待 `operation_snapshot`。重连和聊天重置重新关闭准入；排队任务发送前复核当前截图操作 ID，快照已经取消的请求不能在稍后再次发出。六项合成回归覆盖首次连接、快照结束后只接纳一次、旧请求恢复、恢复期间排队任务、完整快照抢先执行以及切换聊天。

收尾错误归属补充：`capture_stopped` 发送失败只有在连接代次及对应采集链接仍匹配时，才写入当前界面错误。合成回归确认同连接失败仍显示尾句可能不完整；旧连接迟到失败不会覆盖新连接提示。

回滚能力边界补充：断开或任一采集/界面链接失效时立即清空 App Shot 能力；会话自动恢复和 WebSocket 自动重连均重新读取 health。健康检查按连接代次与独立能力代次归属，迟到的旧成功/失败不能污染新连接；未知能力、旧 v12 或截图过程中发生重连时拒绝窗口 App Shot，保留显式屏幕截图选择。11 项合成检查覆盖旧 v12 恢复、frontmost/window 拒绝、重复重连、旧 health 回包和截图中途重连，不触发真实采集。

## 2026-10-02 生产发布

- 源码候选 `52e43347cba5f57475b5c156bb4ca723f673377b` 已通过官方 `deploy/release.py` 上线，release ID 为 `20261002-native-appshot-52e4334`。本机与公网 health 验证 v12、`chat=true`、`pinned_code=false`、`appshot=true`；发布后认证 gate 为 `active=false, draining=false`。
- 用户明确确认无人面试后，先通过正常 `stop_transcription` 控制收尾离线设备遗留的转录状态，再取得原子部署门禁。未篡改活动标记、删除历史或绕过门禁。
- 回滚目录为服务器 `/opt/interview/server.deploy-backups/20261002-native-appshot-52e4334`；保留旧源码、环境、镜像和私有 Compose 配置。回滚仍须取得部署门禁。
- 配套 arm64 Release ZIP 位于本机 `artifacts/releases/20261002-native-appshot-52e4334/Sage-macOS-arm64-52e4334.zip`，SHA-256 为 `2c2686bfdbd1adfd63cc58e899a0069f3401cfd59cebefb4e5dd005cc0395349`。本机 ad-hoc 签名通过 deep/strict 校验，未公证；现有 Debug 包保留，未自动安装或启动 Release。
- 本次仅做发布健康检查，没有真实媒体、登录或付费模型验收。`main` 同步提交使用 `[skip ci]` 避免对已验证的手动发布再次触发生产部署；后续正常代码提交仍遵循原有 CI/部署流程。
