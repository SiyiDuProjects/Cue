# Mac Spotlight 重复应用整理

Spotlight 原先索引了同一 Cue bundle ID 的 36 个应用：正式安装版、一个构建产物和 34 个旧版备份，搜索 Cue 会同时出现这些副本。

- 正式安装仍是 `/Applications/Cue.app`，不替换、不重启。
- 将 34 个旧版 `.app` 原样移到 `artifacts/apps.noindex/`，保留原相对目录结构；本机 `migration.json` 记录每个迁移位置。没有删除备份或用户资料。
- 将现有构建目录移到 `apps/macos/output.noindex/`，构建脚本与忽略规则同步使用新路径。
- 仅注销这些旧路径的 LaunchServices 注册，并重新注册正式安装路径；没有重建系统索引或重置全局应用注册。

本机整理后，以 `com.siyidu.sage.mac` 查询 Spotlight 只返回 `/Applications/Cue.app`。脚本语法和 Git 差异检查通过；忽略规则覆盖构建产物与归档。此次仅调整产物位置，没有重新构建应用，也未运行媒体或 MCP 验收。
