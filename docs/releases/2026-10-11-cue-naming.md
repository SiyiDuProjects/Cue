# Cue 名称与旧运行环境清理（2026-10-11）

当前源码的 Mac targets/目录/类型、Windows IPC/preload、音频处理器、图标和打包元数据统一为 Cue。删除无业务消费者的 Codex 环境变量读取、资料目录保存字段、旧 Session 定义及无引用启动脚本。项目运行动作改为当前 Cue 目录。

网站及新客户端使用 `https://cue.siyidu.com`；同一 Sites 项目的平台地址改为 `https://cue-app.dusiyi0916.chatgpt.site`，MCP/OAuth resource 为其 `/mcp`。Cue 插件、App、Site ID 与所有者权限均保留。独立验证站点也改名为 Cue 架构验证 / cue-runtime-validation。

保留应用 ID、钥匙串 service/account、原用户数据目录及生产设备认证绑定 `SAGE_DEVICE_TOKEN`，这些是已有身份而不是旧功能分支。Mac 钥匙串账号与网址解耦，继续读取原登录；Windows 将已有加密连接中的同站点旧地址一次更新为新地址，不允许重定向到任意主机。配置中废弃的字段不再保存。资料文件没有删除。

删除 Sites 中未再使用的 `SAGE_CALLBACK_HOSTS`、`SAGE_ORIGIN`、`SAGE_STORAGE_KEY`，环境修订为 3。旧 Codex 运行目录删除，退役登录文件和原本机配置移入 Git 忽略、权限受限的 `artifacts/retired-runtime-2026-10-11/` 备份。旧 output/Sage.app 和 15 个旧 Windows 打包暂存目录删除；历史发布记录、VPS 回退源码、私人历史不改写。

## 验证

- 桌面采集/配置：38 通过、1 项仅 Windows 环境检查跳过。增加废弃配置拒收、加密登录的一次迁移及失败保留、真实 preload 的 origin/IPC 边界测试。
- Electron Windows 界面、Mac 回答页/VAD 桥接、网页设置上传与 PDF/DOCX 解析：通过，外部网络禁用。
- Mac：23 项 Core/连接检查，77 项原生离线检查通过；包含固定钥匙串和用户目录标识断言。签名 build 31 已生成并安装，旧 build 30 备份保留。安装时 Cue 未运行，没有打断录音。
- Mac build 31 已通过真实只读连接检查：使用原钥匙串凭证访问新 Cue 域名，认证 health 和已保存状态读取成功；无录音、截图或付费模型调用。
- 云端：41 项测试、构建和产物校验通过；网页包已重新生成，仅在私有云端仓库。
- Windows 安装包已生成：`releases/windows/Cue-Setup-0.4.1.exe`；实查 app.asar 包名 cue，未包含旧 Codex 运行文件或私人凭证。
- 现有 Cue 插件改名后实际只读调用成功，既有资料可见。没有读取资料正文。

真实 Windows 安装/采集、手机和长时间运行没有在本轮验证。源码测试、打包、安装及真实只读连接分别记录。

## 发布

云端源码：`6cdb7a602c40c8aa01b6c677b33ab50fb584085d`（Sites 源码仓库）。Sites v31 发布成功（环境修订 3），部署 `appgdep_6acc273d8f80819192e3d47e6a1cc435`；发布后现有 Cue MCP 再次只读调用成功。
经用户确认，外层仓库将此前清理、本次改名、回归测试与发布记录一起提交，并更新私有云端提交引用；私人配置、凭证、资料和构建产物不纳入公开仓库。

用户另行确认后，已卸载旧 Sage 插件 `plugin_asdk_app_6abcc472ffc88191bde7eb3fcb168c06`（旧地址 /mcp，身份验证已失效）。未删除该应用或旧服务器资料，现有 Cue 插件和登录保留。

Cue 架构验证插件的应用说明已通过所属设置页更新，并从插件元数据读回确认。
