# Cue 简化前基线（2026-10-07）

本记录区分本地源码基线、已经上线的云端源码和已安装客户端。第 0 步不推送、不部署、不安装、不停用线上订阅，也不运行真实媒体或模型测试。

## 两个独立 Git 仓库

| 仓库 | 基线提交 | 本地标签 | 基线之前的 HEAD |
| --- | --- | --- | --- |
| 主仓库 `/Users/siyi/Projects/Cue` | `63efea06f81753567d8877b80ec9f110ec0f45b6` | `baseline-20261007` | `a80119e` |
| 云端 `/Users/siyi/Projects/Cue/apps/cloud` | `24ee945c1169254a8b96003f89c769726af04682` | `baseline-20261007` | `0b0c2824729b43e6d028ab30349076d15c096f78` |

- 主仓库基线保存原有 109 个变更路径，包括之前已经发生的删除和新增；没有重新整理或重写这些修改。另一个状态项是独立的 `apps/cloud/` 仓库。
- 云端基线保存原有 8 个修改文件，主要为 Cue 可见名称更新；不代表这些修改已经上线。
- 两个基线均逐文件核对 Git 保存内容与提交前工作树的 SHA-256，相同名称的标签属于各自仓库。
- 主仓库提交不包含 `apps/cloud/`，也没有创建缺少远程地址的 gitlink/submodule。主仓库仍会显示 `?? apps/cloud/`；必须在该目录单独查看状态和历史。Windows 目前仍从 `apps/cloud/ui` 导入界面，共用界面搬迁属于后续步骤。
- 云端仓库当前未配置远程。私有 GitHub 备份尚未创建或推送；本地标签与 bundle 均不是异地备份。
- 旧 VPS 部署工作流的手动触发修改与最新方向文档在主仓库基线之后另行提交。基线本身保留了原工作流，因此不得把检出基线后直接推送 main 当作安全的部署操作。

## 已上线来源与安装状态

| 项目 | 记录 |
| --- | --- |
| 产品域名 | `https://interview.siyidu.com` |
| Sites project | `appgprj_6ac3050911388191a096e3850daec725` |
| 已发布版本 | Sites 版本 **12** |
| 已发布云端源码 | `0b0c2824729b43e6d028ab30349076d15c096f78` |
| 已发布源码标签 | 云端仓库的 **`sites-v12`**，指向上述提交，不指向新基线 |
| MCP 地址 | `https://sage-capture.dusiyi0916.chatgpt.site/mcp` |
| 当前协议 | `sage-capture-v1` |
| Mac 安装版 | `/Applications/Sage.app`，0.3.1 / build 7 |
| Windows | 0.3.1 安装包已保存；尚未确认安装和真机运行 |
| 旧 VPS | 原服务和私人历史保留；未在本步骤连接或改变 |

版本与原始发布信息来源于本机 `artifacts/releases/20261004-sites-cutover/receipt.json`；该目录被 Git 忽略。本记录仅提取非敏感的版本、源码和产物依据，不复制凭证、私人资料或用户内容。Sites 当前版本 12 已在本次简化评估期间经只读平台查询确认；不表示已重测整个线上链路。

## 发布产物校验

2026-10-07 重新计算了下列本地文件的 SHA-256，均与原交付回执一致：

| 文件 | SHA-256 |
| --- | --- |
| `artifacts/releases/20261004-sites-cutover/Sage-macOS-arm64-0.3.1.zip` | `66c937d39a84a386437e2a9191838b7b279d94a018ce277a3247e21e772de868` |
| `artifacts/releases/20261004-sites-cutover/Sage-Setup-0.3.1.exe` | `0ae0fbee6b9276b4f3269e5d2e26ba6d41d1f493015309ad91e8d546a446d433` |
| `/Applications/Sage.app/Contents/MacOS/Sage` | `9c266b9f2393fd8db9fa94cf183ab49afe4e210ab993fb4579dbae5c76ebf3e5` |

二进制哈希只核对该可执行文件，不冒充整个应用包、权限或真机采集验收。完整安装包、旧应用备份仍留在原 artifacts 目录，没有提交到源码仓库。

## 本地恢复材料

目录：`artifacts/baselines/20261007-step0/`（被 Git 忽略）。

- `working-tree-before.json`：原始变更路径、父提交、内容哈希与删除标记。
- `release-checks.json`：本次重新计算的安装包与已安装可执行文件哈希。
- `cue-main.bundle`：主仓库第 0 步完成后的本地 Git 历史与标签。
- `cue-cloud.bundle`：云端仓库本地 Git 历史、基线标签与 `sites-v12`。

bundle 可克隆到新的恢复目录后核对；两个仓库分别恢复。不要为回退而覆盖正在使用的工作树。源码 bundle 不包含忽略的 `.env`、钥匙串、私人资料、数据库或安装包；这些内容继续保留在原有位置。

## 第 0 步验收范围

核对基线逐文件内容、标签目标、上述产物校验值、工作流 YAML 的手动触发和部署条件，以及 Git bundle 的完整性。此步骤只改变配置和文档，没有修复现有业务缺陷；本轮不重跑旧产品全套测试，也不把先前离线报告当作新版验收。真实长时间转录、上游轮换、连续聊天、Windows 使用及新版部署均属于后续工作。
