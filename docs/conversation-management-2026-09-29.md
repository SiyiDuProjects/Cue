# 会话管理核验（0.1.8，2026-09-29）

> 以下为本地完成时的核验快照。随后用户授权发布，后端和本机客户端已上线，见 [生产发布记录](codex-production-release-2026-09-29.md)。

## 已实现

- 顶部会话名称打开 HeroUI Pro 会话列表；新建、重命名、切回历史。关闭抽屉后仍是聊天和代码两栏。
- 每个会话保存聊天、转录、已发/待发截图、固定代码及历史，关联一个原生 Codex thread。应用不重新实现模型历史、推理、工具循环或压缩。
- 私有 SQLite 沿用 `INTERVIEW_WORKSPACE_HISTORY_DIR` 的持久目录，添加会话表，不改写旧代码档案。空值时只保留进程内记录。原始音频和凭证不入库。
- 服务重启恢复上次选中的会话；未完成文字标记为中断。恢复界面不调用模型、不重发消息、不重放工具、不启动转录。下一次显式发送才调用原生 `thread/resume`。
- 原线程缺失或仍忙碌时明确报错，不偷偷创建空白线程。电脑专用 Codex 工作目录须保留；仅有服务器 UI 记录不能重建已经丢失的 Codex 历史。
- 空闲切换直接完成；转录或生成中切换需要一次确认。旧请求在保存前停止接受新输入，迟到工具不能写进新会话。存储失败保留原会话并阻止切换。
- 未发送草稿按会话保存在当前客户端；不是模型上下文，也不在多端之间同步。桌面和手机共享当前激活的会话。

## 验证证据

本次只核验应用与 CLI 的连接，不将合成结果当成真实模型质量验证。

| 检查 | 结果 |
| --- | --- |
| 后端离线全套（空 key、loopback URL、临时/禁用存储） | 162 通过 |
| 前端状态测试 | 30 通过 |
| 采集与 CLI 桥接单元测试 | 50 通过 |
| Electron 普通聊天验收 | 13 项通过 |
| Electron 桌面会话流程 | 11 组通过：新建、切换、改名、草稿恢复、续问、生成中确认、紧凑窗口等 |
| 实际 FastAPI/WS/stdio + 合成 CLI 子进程 | 通过；真正重启服务和子进程后用 thread/resume，未重新 thread/start 或重播旧消息 |
| 前端 build、Windows 打包及 ASAR 白名单检查 | 通过；不包含登录、个人材料或私有配置 |
| 项目专用 Codex CLI login status | 已登录 ChatGPT；没有发送真实模型 turn |

界面证据：`artifacts/chat-controls/ui/conversation-list.png`、`checks.json`。
后端结果：`artifacts/conversation-backend-tests.log`。
打包结果：`artifacts/conversation-package.log`。

## 发布边界

- 安装包：`releases/windows/Sage-Setup-0.1.8.exe`。
- SHA256：`08D0C29D5070ACFB2660D705295F56C74837A5D5C5929FD5AEF0F76659C0265F`。
- 新协议 `interview-chat-v10`，须先发布对应后端，再使用新客户端。
- 本次没有生产部署、安装替换、真实模型或真实麦克风测试。
- 源码版的专用登录在项目 `assistant-workspace/.runtime/codex`；安装版默认另一工作目录。安装时应显式沿用 `INTERVIEW_CODEX_WORKSPACE`，或在安装版自己的托盘登录；不会复制凭证。

旧迁移记录 `codex-cli-migration-2026-09-29.md` 反映 0.1.7 当时状态，本文件更新其中会话恢复及登录两项。
