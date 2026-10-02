# 桌面首次启动重复聊天区修复

用户在 0.1.4 安装版首次连接后看到两个欢迎区和两个聊天滚动容器。

原因：App 中同级 ChatConversation 和 ChatComposer 使用同一个 session key；桌面初始化从 new 转为真实会话 ID 时，React 留下孤立旧聊天节点。既有浏览器配对测试在会话建立后才挂载聊天，未覆盖这次身份变更。打包启动诊断未连接服务，也未覆盖这条路径。

修复：分别使用 conversation: 和 composer: key 前缀。同场重连保持组件身份；新对话重置两个组件，键不冲突。不引入额外状态或改滚动组件。

复现证据：未修复构建的桌面离线验收失败，scrolls=2、empty=2、composers=1；修复后均为 1。
回归：4 项桌面启动场景通过（首次连接、重连、发送后连续两次新对话、小窗口），13 项原聊天 UI 场景通过，构建通过。模型和媒体均为合成，未调用真实供应商。

发布：Windows 0.1.5，release_id `20260929-chat-startup-045811`。服务端/网页资源和挂载核验见 artifacts/chat-startup-release/production-verification.json。安装核验见 installation.json、installed-diagnostic.json。包构建第一次遇输出文件占用失败，不能使用该半成品；成功重建和审计后才安装。

截图：artifacts/chat-startup/ui/initial.png 和 compact.png。
回滚路径：`/opt/interview/server.deploy-backups/20260929-chat-startup-045811`；需重新确认部署门空闲。
