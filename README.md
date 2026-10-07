# Cue

个人面试采集工具。Mac 原生菜单栏与 Windows 客户端负责手动截图、两路独立音频和设置；按按钮通知订阅的 ChatGPT Work 对话读取当前资料并回答。Responses API 保留为手动备用。

当前版本为 **0.3.1**，Sites 版本 **12** 已发布。正式域名 `interview.siyidu.com` 已切换并通过 HTTPS／认证检查；Mac 0.3.1 已安装并恢复登录，Windows 安装包已准备但尚未真机安装。旧 VPS 与私人历史保留。完整产物、实测证据和剩余验收见 [交付记录](docs/unified-capture-delivery-2026-10-04.md)。

## 使用流程

1. 需要语音上下文时开始转录；系统音频和麦克风独立处理，不混音。截图始终由用户手动获取。
2. 在 ChatGPT Work 对话订阅 Cue 的 `answer.requested`，在客户端选择该订阅。
3. 按「请 ChatGPT 回答」或全局快捷键。服务器等待本次音频标记前的尾句并固定资料，事件只通知 ChatGPT 读取该请求。答案出现在订阅的对话中。
4. 需要备用链路时明确打开「API 备用回答」并生成。Mac 打开共用网页；Windows 和网页显示同一个备用面板。

启动、重连、普通语音和新增截图不会触发答案。刷新不自动重发；不确定投递需要核对原对话。网页使用 Sites 身份认证，不取得设备录音凭证；设备凭证保存在系统安全存储，模型 key 只在云端。

## 代码位置

- [Sites 后端与共用网页](apps/cloud/README.md)：采集存储、转录、固定请求、MCP Events、Responses 备用。`apps/cloud` 使用 Sites 登记的独立源码仓库与发布流程。
- [Mac 原生客户端](apps/macos/README.md)：菜单栏、设置、双路采集和快捷键。
- `apps/desktop`：Windows Electron 采集宿主，复用 `apps/cloud/ui/`，两端共用只读资料桥接。
- `apps/server`：现有 v12 服务及旧历史兼容。其发布流程保留线上 v12 网页，不把新的 Sites 网页部署到旧后端。

## 构建与验证

Mac 按需加载 `/Users/siyi/Projects/_tools/env.sh`。云端在 `apps/cloud` 执行 `npm test` 和 `npm run build`；桌面在 `apps/desktop` 执行 `npm run test:capture` 和 `npm run build`。Mac 原生检查执行 `bash apps/macos/scripts/check-offline.sh`。

界面合成测试需先在仓库根目录启动 `node apps/cloud/scripts/preview.mjs`，再在 `apps/desktop` 执行 `npm run test:ui`；预览仅访问 loopback，不使用真实模型或媒体。Windows 安装包命令为 `npm run package:windows`；PowerShell 使用 `npm.cmd`。

旧后端测试必须显式清空 `OPENAI_API_KEY` 与 `INTERVIEW_WORKSPACE_HISTORY_DIR`，并设置 `OPENAI_BASE_URL=http://127.0.0.1:1/v1`，然后执行 `python -m unittest discover -s tests`。真实模型、麦克风和付费转录另需本次授权；离线、候选包与实际设备验收分别记录。

产品边界与资料保护规则见 [AGENTS.md](AGENTS.md)。原服务、旧安装包与旧登录均保留回退；不自动搬迁或删除旧草稿和历史。
