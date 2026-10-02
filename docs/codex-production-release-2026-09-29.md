# Codex 会话版已发布（2026-09-29）

用户明确授权发布后，已完成现有后端、网页和本机客户端更新。

- 后端：`https://interview.siyidu.com`，API 0.10.0，协议 `interview-chat-v10`，回答链路 `codex-app-server`，模型沿用 Sol/high。
- 发布 ID：`20260929-codex-sessions-112959`。
- 发布前认证门禁为空闲。执行现有单服务发布流程，只更新 `interview_api`；私有资料只读挂载及会话存储持久挂载保留。
- 回滚目录：`/opt/interview/server.deploy-backups/20260929-codex-sessions-112959`。
- 内部/公开 health、网页 JS/CSS 哈希和持久目录写入核验通过。
- 本机 Sage 已安装 0.1.8 并重新打开；生产后端已确认桌面在线。
- 安装版连接使用 safeStorage 正常保存，工作目录明确沿用 `D:/Projects/Interview/assistant-workspace`。主提示词和 `materials/resume.txt` 可用；项目专用 Codex 登录通过原生 initialize/account/read 核验，未复制登录凭证。
- 桌面加密连接的生产会话接口返回 200。

没有发送真实模型 turn、启动麦克风或进行真实转录质量测试。离线连接和恢复验收见 [会话管理核验](conversation-management-2026-09-29.md)。

本次从已验证的工作区生成白名单发布包，不包含 .env、个人材料或 CLI 登录文件；没有提交无关的本地 Git 修改。发布清单和证据位于 `artifacts/codex-release/`：`package.json`、`production-verification.json`、`installation.json`、`desktop-online.json`。
