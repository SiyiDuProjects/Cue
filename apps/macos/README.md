# Cue for macOS

macOS 15+ / Apple Silicon。原生半透明浮窗装载共用聊天界面；原生宿主采集系统音频和麦克风、执行 App Shot 并保管设备凭证；共用本地界面通过短期凭证直连 OpenAI 转录。

- 窗口内 ⌘ Enter 回答；全局快捷键 ⌃⌥⌘ Enter。
- 关闭窗口保留菜单栏，菜单栏退出会停止采集和连接。
- 只有明确开始转录才申请媒体；启动与重连只恢复连接。
- 登录沿用 `com.siyidu.sage.mac.connection` 钥匙串与既有 SageMac 资料目录。名称改为 Cue 不删除旧登录。
- 设置可打开网页编辑提示词及资料；App Shot 保留同一窗口原图和可访问文字。
- App Shot 直接用 ScreenCaptureKit 截图，并通过系统辅助功能读取所选窗口文字，支持后台窗口。首次手动窗口截图时才申请辅助功能权限；未授权、窗口身份不明确或读取失败时保留原图并说明原因。超时或文字截断标记为不完整；应用未提供的文字不会通过 OCR 补全。

## 构建

加载本机 Node / Swift 工具环境后：

```sh
bash apps/macos/scripts/check-offline.sh
bash apps/macos/scripts/build-app.sh
```

产物为 `apps/macos/output/Cue.app`，使用固定的本地签名身份，未公证。构建时先验证原生核心，再构建共用 UI。Node 仅用于构建和合成上传预算检查，不打包进应用；App Shot 不依赖 ChatGPT 采集组件。

离线检查包含窗口 ID 与几何回退、文字大小、超时/取消和临时辅助功能属性恢复；不会读取真实窗口、申请权限或上传截图。真实应用文字覆盖、原图上传、MCP 读回与跨版本权限保留仍需单独验收，检查清单见 `docs/plans/2026-10-09-appshot-ax.md`。

本机首次配置运行 `python3 apps/macos/scripts/local-signing.py setup`。证书和专用构建钥匙串保存在相邻的 `_private/Cue/signing/`，不要提交 Git，也不要在更新时重新生成。此脚本不修改系统证书信任、现有钥匙串条目或媒体权限。后续构建自动复用身份；也可显式设置 `CUE_SIGN_IDENTITY` 使用已有签名证书。没有固定身份时默认停止，只有临时测试显式设置 `CUE_ALLOW_ADHOC=1` 才使用 ad-hoc。

从旧 ad-hoc 版本迁移后可能需要一次系统授权。固定签名的跨版本身份校验通过不等于已验证真实钥匙串和媒体授权持久化。安装前应从菜单栏「Cue → 退出 Cue」正常退出旧进程；新版也支持 ⌘Q。只替换磁盘目录不会更新仍在运行的旧窗口。

若辅助功能（新版系统称「设备控制和数据访问」）中 Cue 已开启，重启后仍不可用，先检查 TCC 日志是否明确报 `Failed to match existing code requirement`。旧 ad-hoc 授权可能仍绑定旧 `cdhash`；这种情况需在该权限列表移除 Cue，再添加 `/Applications/Cue.app` 并授权，让记录绑定当前固定签名。不要重置所有隐私权限或重新生成签名证书。

`Cue.app/Contents/MacOS/Cue --preview --render-preview /absolute/path.png` 使用合成空聊天渲染，不连接生产或开启媒体。真实登录、录音、快捷键与上游时长验收需分别记录。

`--check-connection` 通过相同钥匙串和原生 HTTP 检查已授权连接，仅打印状态与数量。额外显式传入 `--import-existing-materials` 才会把既有五份简历/经历文本写入服务器；它不读取面经目录，不开媒体或模型。真实运行需等待系统钥匙串授权。
