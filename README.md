# Cue

个人面试助手：桌面悬浮聊天、双路转录、手动截图。Mac 和 Windows 共用聊天界面；网页管理提示词、模型档位和个人资料；ChatGPT 通过只读插件按需读取上下文。

## 使用

开启转录后，系统音频和麦克风分别积累上下文。需要时手动截图，按回答按钮或快捷键提问。答案在 Cue 中流式显示，可继续追问和停止。启动及重连不会自行采集或重发。

网页设置位于 `https://interview.siyidu.com/settings`，通过 ChatGPT 登录；可编辑回答提示词、上传或更换 TXT、Markdown、PDF、Word 资料。修改从下一次提问生效。

## 代码

- `packages/chat-ui`：共用 React 聊天。
- [Mac](apps/macos/README.md)：AppKit / ScreenCaptureKit 原生宿主。
- `apps/desktop`：Windows Electron 宿主与打包。
- [云端](apps/cloud/README.md)：私有独立仓库，Sites、D1、R2、模型和设置页。桌面构建不依赖此仓库。

源码版本 0.4.0。实际发布与验收状态见 [发布记录](docs/releases/2026-10-07-cue-0.4.0.md)，不能由源码版本推断安装状态。重构前历史保存在 `baseline-20261007` / `legacy-v12`；VPS 私人历史保留。

## 验证与打包

在 `apps/desktop` 安装依赖后运行 `npm run test:capture`、`npm run build` 和 `npm run test:ui`。Mac 执行 `bash apps/macos/scripts/check-offline.sh`，打包执行 `bash apps/macos/scripts/build-app.sh`。Windows 包在桌面目录执行 `npm run package:windows`，输出 `releases/windows`。

云端在其目录执行 `npm test`、`npm run build`。合成网页上传测试用桌面 Electron 运行 `apps/cloud/tests/settings-ui.cjs`。离线测试不调用真实模型或录制媒体。产品边界见 [AGENTS.md](AGENTS.md)。
