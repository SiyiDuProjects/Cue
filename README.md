# Cue

个人面试助手：桌面悬浮聊天、双路转录、手动截图。Mac 和 Windows 共用聊天界面；网页具备同样的能力并管理提示词、模型档位和个人资料；ChatGPT 通过只读插件按需读取上下文。

## 使用

开启转录后，系统音频和麦克风分别积累上下文。需要时手动截图，按回答按钮或快捷键提问。答案在 Cue 中流式显示，可继续追问和停止。启动及重连不会自行采集或重发。

网页 `https://cue.siyidu.com` 通过 ChatGPT 登录，手机浏览器也可用。首页和悬浮条一样：控制条、可往回翻 10 分钟的面试官字幕、一次一轮的回答卡片；可遥控电脑开始/停止转录、截图、回答（可附追问和推理深度）、停止生成、移除待发截图。指令只发给页面显示的电脑连接，结果如实显示，失败或超时不自动重试。当前云端遥控需要遥控协议第 3 版客户端。截到即确认，可继续截图；原图顺序上传，回答等全部传完。上传失败会明确提示并保留本次运行中的原图，可手动重试。新客户端使用 Cue 域名，升级保留原有登录和资料。

`/settings` 的「回答设置」和「个人资料」可编辑回答提示词、上传或更换 TXT、Markdown、PDF、Word 资料。修改从下一次提问生效。

在 ChatGPT 中，现有 Cue 插件使用 `https://cue-app.dusiyi0916.chatgpt.site/mcp`，只提供只读工具：让 ChatGPT 读取 Cue 的转录、截图和资料后回答。同一对话自动只给未读内容和修正，每次最多四张截图；需要更早转录时可请求历史。没有会话编号的客户端保持普通读取。

当前发布与真实设备验证范围见[网页遥控发布记录](docs/releases/2026-10-11-web-remote.md)。

## 代码

- `packages/transcription`：共用 VAD、直连转录和截止顺序。
- `packages/chat-ui`：共用 React 聊天；`Web.tsx` 是网页首页，`npm --prefix apps/desktop run build:web` 生成到私有云端仓库的 `web/app/`。
- [Mac](apps/macos/README.md)：AppKit / ScreenCaptureKit 原生宿主。
- `apps/desktop`：Windows Electron 宿主与打包。
- [云端](apps/cloud/README.md)：私有独立仓库，Sites、D1、R2、模型和设置页。桌面构建不依赖此仓库。

源码版本 0.4.2。实际发布与验收状态见 [发布记录](docs/releases/2026-10-19-cue-0.4.2.md)，不能由源码版本推断安装状态。重构前历史保存在 `baseline-20261007` / `legacy-v12`；VPS 私人历史保留。

## 验证与打包

在 `apps/desktop` 安装依赖后运行 `npm run test:capture`、`npm run build` 和 `npm run test:ui`。Mac 执行 `bash apps/macos/scripts/check-offline.sh`，打包执行 `bash apps/macos/scripts/build-app.sh`。Windows 包在桌面目录执行 `npm run package:windows`，输出 `releases/windows`。

Mac 本地固定证书可保持应用签名条件，但钥匙串对这种签名仍按构建指纹授权，更新后可能再次要求输入登录钥匙串密码。不能将辅助功能权限保留等同于钥匙串跨版本免确认；后者需要 Apple 签发的开发者身份及迁移后的实际升级验收。已有证书可通过 `CUE_SIGN_IDENTITY` 指定。

云端在其目录执行 `npm test`、`npm run build`。合成网页上传测试用桌面 Electron 运行 `apps/cloud/tests/settings-ui.cjs`。离线测试不调用真实模型或录制媒体。产品边界见 [AGENTS.md](AGENTS.md)。
