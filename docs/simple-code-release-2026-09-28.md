# 固定代码区简化与发布记录（2026-09-28）

## 实际改动

- 入口为输入框，以及手动截图、回答、更新代码区。按钮与输入框共用 Responses 链路。
- 普通聊天支持解释和代码，不修改右侧。仅更新代码区请求开放 update_code，服务端再次检查权限。
- 自动提供完整资料、已记录转录、问答和已发送截图，以及代码答案历史和当前固定代码；当前版本仅一份。未发截图保留在下一条草稿。
- 右侧是一份固定的完整代码答案。移除实际/建议双状态、步骤/拆步/进度、换题与回到上一题操作，以及模型读上下文/截图工具。换题直接聊天，旧代码直到用户明确更新才改变。
- 保留复制、可选复杂度、来源清晰的 diff 和只读代码历史。首次没有对比来源时直接显示代码；相对上一版的基准由应用提供，相对截图的基准必须引用已经发送的截图。
- 旧版本档案只读适配，未迁移/覆盖原记录。停止或失败不删除已经成功发布的代码；只有工具成功、无额外文字时仍算正常完成，不伪造模型回复。
- 可选模拟面试沿用原链路，只能收到用户明确提交的固定代码。提交不代表外部编辑器已经存在这些代码。

## 验证

- 151 项后端离线测试通过（测试进程空 OpenAI key、loopback provider、禁用实际私有历史）。
- 31 项前端测试、44 项采集与桌面状态测试通过。
- 11 项完整 Electron UI 流程通过：语音仅积累上下文、IME、未确认发送重连、附件、固定代码、停止、重连恢复、阅读位置、聊天换题不写代码区、差异与只读历史、窄屏。
- TypeScript/Vite 构建通过；保留现有 bundle 大小提示。
- 原生剪贴板回归通过，恢复用户剪贴板。最终桌面/竖屏截图在 artifacts/simple-code/ui。
- 0.1.3 安装包白名单审查通过：不含私有资料、.env、依赖源码或测试。
- 已安装应用的离线启动诊断通过：真实 renderer/preload 加载，连接配置保留，未采集媒体或发起网络请求。
- 未进行真实付费模型或麦克风准确率/回答质量测试。

## 发布

- API 0.8.0，协议 interview-chat-v7；旧 v5/v6 客户端不兼容。
- 公网：https://interview.siyidu.com
- 发布 ID：20260928-simple-code-233852
- 通过认证 deployment gate，无活跃面试时更新；当前 active=false、draining=false。
- 公网 health、JS/CSS 与发布文件哈希一致；私有上下文挂载检查通过，代码档案持久挂载可写。
- 后台仍为 gpt-6-sol/high，转录为 gpt-live-transcribe；没有切换模型或进行付费探针。
- 回滚保留：/opt/interview/server.deploy-backups/20260928-simple-code-233852
- Windows：本机 Sage 已从 0.1.2 更新至 0.1.3；安装返回 0，连接配置保留。
- 安装包：releases/windows/Sage-Setup-0.1.3.exe
- 安装包 SHA256：197895a358d47864c81ea1c07b2628b59bb013f96335029c12d0e52c0518abc2
- 发布/安装证明：artifacts/simple-code-release/production-verification.json、installation.json、installed-diagnostic.json、package-audit.json。

旧源码与被替代的步骤测试保留在 artifacts/simple-code/superseded，不进入发布包。仓库存在之前已有的未提交工作，本次未提交或重置这些改动。
