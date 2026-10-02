# 本地 Codex 接入核验（2026-09-29）

> 此为 0.1.7 迁移时的历史快照。会话列表、持久化恢复及登录的后续状态见 [0.1.8 会话管理核验](conversation-management-2026-09-29.md)。

## 边界

应用是面试采集与展示入口：双路可选转录、手动截图、聊天界面、固定代码区和快捷指令。Codex app-server 负责模型会话、推理、读资料、搜索、工具循环和上下文压缩。没有新增题型路由、摘要模型或自动回答。

聊天不需要开始/结束开关。停止生成只中断本轮，正常中断后可沿用同一线程继续。转录单独开始/停止，关闭窗口仍保留托盘。

后续会话列表可用 HeroUI Pro ChatListView 展示；模型线程应对接 Codex 原生线程，不再另造对话引擎。应用仍需保存自己的转录、附件、代码区与线程关联。当前尚未接入跨进程会话列表/恢复，不把代码版本历史或 CLI 本地记录冒充完整应用会话恢复。

## 已完成

- Electron 主进程通过 stdio JSON-RPC 启动本机 Codex app-server。FastAPI 使用独立、capture-token 认证的模型 WebSocket 中转，浏览器无本机执行权限。
- 模型沿用 gpt-6-sol/high，禁止供应商模型回退。主聊天不再使用托管 Agents API；现有服务器 key 只继续用于转录和可选模拟面试。
- `assistant-workspace/` 为源码运行位置，AGENTS.md 为行为约定，materials/ 为按需读取的个人资料，.runtime/codex/ 为专用登录与线程记录。安装版默认使用用户数据目录，可显式指定项目目录。
- 现有简历复制到忽略的 materials/resume.txt，原文件不动。个人资料、登录和运行记录不提交、不打包。
- 动态 update_code 工具仍由服务器验证请求授权、revision 和文件内容后发布；普通聊天没有固定代码区写权限。
- 专用登录、只读沙箱、隔离继承环境；没有自动读取或迁移 Codex 桌面账号凭证。只读沙箱不等于容器级读路径隔离。
- 原生 CLI 协议有实时音频相关接口，但未作为已验证的双说话人连续转录替代；本次继续使用原有两路转录。

## 验证

以下均为离线/合成检查，未发真实模型 turn，也未启用真实音频。

| 检查 | 结果 |
| --- | --- |
| 后端 unittest（空 API key、loopback base URL、关闭磁盘档案） | 156 通过 |
| 前端 test:ui | 30 通过 |
| 桌面 test:capture（含 Codex runtime/process/host） | 49 通过 |
| 前端 build | 通过；保留已有 bundle size 提示 |
| Electron chat-ui-smoke | 13 项通过 |
| Electron desktop-chat-ui-smoke | 6 组通过 |
| FastAPI → 实际 WebSocket → 实际 stdio 子进程 → 合成 Codex | 通过，含工具权限、流输出、停止与后续请求 |
| 本机 CLI 0.158.0-alpha.2.1 initialize/account/read | 协议成功；专用账号未登录，无模型生成 |
| Windows 0.1.7 打包及 ASAR 白名单检查 | 通过；包含运行模块与公开模板，不含个人资料/凭证 |
| 隔离安装包启动诊断 | 通过；原生标题栏、可缩放、非置顶；禁网、禁采集、无已有凭证读取 |

安装包 SHA256：`C99DDE9944468ABCEBB0F7E78501174D72AFBD24BDB46BE67920D0C887DB1F27`。

## 尚未执行

- 专用 Codex 登录与真实模型质量/延迟测试。可从托盘「Codex 登录」，或执行 `node scripts/interview-codex.cjs login`。登录状态由 Codex 自己管理。
- 生产部署、安装或替换当前运行版本。本次协议为 interview-chat-v9，不能把新客户端直接连到旧 v8 后端；发布需走现有部署门禁。
- 完整应用会话的持久化列表及重启恢复。普通网络重连沿用当前内存会话；进程/服务重启后的恢复未接入。

参考：[Codex app-server](https://learn.chatgpt.com/docs/app-server)、[HeroUI ChatListView](https://heroui.pro/docs/react/components/chat-list-view)。
