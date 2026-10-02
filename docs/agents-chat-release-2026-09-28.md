# Sage 托管聊天与组件复用发布（2026-09-28）

发布：`20260929-agents-chat-044539`；API `0.9.0`，协议 `interview-chat-v8`，Windows `0.1.4`。

## 已修改

- 正式辅助使用官方 OpenAI 托管 Agents SDK 会话；Sol/high 沿用原配置。无沙箱、无子 agent；一个 update_code 工具，只有更新代码区请求可发布。
- 转录可选，停止转录保留聊天、截图、代码及正在生成的回答。
- ChatConversation 接管内容/视口变化跟随、上滚暂停、回到底部恢复；删除旧跟随状态、三段滚动 effect 和手写底部检测。回到最新采用立即定位，避免持续输出中平滑滚动追不上末尾。
- Markdown 使用 HeroUI Pro 分块渲染，删除自写解析和补全层。保留复制原文、安全链接及禁止远程图片组件。未使用 StreamMarkdown 自动补全：当前版本在缩进代码 `    if a <b` 的实测中丢失字符，不能用于代码回答。
- 代码差异继续用 diff 库计算和现有只读行展示。未增加第二套代码编辑器。
- 完整聊天跨服务重启的持久化/会话列表未实现；云端 Agent 会话和本场应用记录不等于应用的持久化历史。

## 验证

- 后端离线 154 项，前端 30 项，采集/Electron 45 项通过；生产构建通过。
- 完整 Electron 离线 13 场景通过。含长回答真实分片输出、上滚保留位置、回到最新、手动滚到底部、内容延迟增高、断线阅读恢复、截图、停止与代码历史、竖屏。
- npm audit 0 项漏洞；修复兼容范围内 marked、undici 依赖版本。
- 生产认证部署门确认空闲，发布后公网健康、协议、Sol 配置和页面资源哈希通过。外部只读资料挂载及代码档案卷保留。
- Windows 包只含白名单 Electron 文件和构建资源，307 项静态资源与已部署网页一致，无源码资料/.env/node_modules。
- Windows 安装结果及启动诊断见 artifacts/agents-release；加密连接配置哈希前后相同。
- 未调用真实付费模型，未测试真实麦克风或系统音频。本次测试不证明供应商实际延迟/回答质量。

回滚：`/opt/interview/server.deploy-backups/20260929-agents-chat-044539`。回滚前重新确认部署门空闲。
证据：`artifacts/agents-release/production-verification.json`、`package-audit.json`、`installation.json`、`installed-diagnostic.json`，`artifacts/simple-code/ui/checks.json`。
