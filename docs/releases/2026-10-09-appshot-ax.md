# Cue 0.4.1 build 20：App Shot 系统辅助功能采集

**已安装到 `/Applications/Cue.app`，完成用户在场的合成窗口验收。** 源码、离线检查、签名包、安装及真实采集分别验证；未部署云端，未开启麦克风、系统音频或转录。验收中显式执行了一次合成截图回答。

## 实现

- Mac 窗口原图由 ScreenCaptureKit 获取，随后读取同一窗口的系统辅助功能文字。仅手动窗口截图时请求权限；列出来源和显示器截图不请求辅助功能。未授权或窗口身份无法确认时保留原图及原因。
- 精确窗口 ID 优先，查询符号通过动态查找使用，缺失时回退到唯一的标题和几何匹配。已知不同 ID 不参与回退；读取结束再次核对目标。后台及同名重叠窗口的精确 ID 路径不会被几何唯一性误拒绝。
- 文字遍历使用专用串行队列、约 3 秒共享预算、节点和深度限制。每次系统调用对实际接收元素设置超时；取消阻止后续读取和上传。Chromium/Electron 启用内容树，临时增强属性有界恢复。
- 最终完整 `appshot` 对象按紧凑 UTF-8 序列化大小限制在 100,000 字节以下，保守满足云端 JavaScript 长度限制。80,000 个 Unicode 标量仅为初步文字上限。
- 删除旧 ChatGPT 采集桥接、对应测试及 Mac 包内 Node；开发环境 Node 仍用于界面构建和跨语言预算检查。
- 真机测试发现 TextEdit 的 `AXDescription` 返回 `-25200`。原实现因此跳过整个正文区域；build 20 改为可选文字属性分别读取，单项失败保留其他值并继续遍历子元素，状态标为 `partial`。角色和安全文本分类仍失败即停止，不读取可能的密码字段；超时和取消继续传播。新增 6 项回归检查。
- 构建缓存改用 `.build/modules/`，避开旧 `Interview` 路径缓存；未删除旧缓存或私人文件。权限提示不再依赖随系统版本改名的设置页名称。

## 离线、打包与安装

- build 18：`check-offline.sh` 通过 97 项原生检查（69 项 App Shot）及 8 组 Swift → Node 上传预算检查。
- 最终 build 20：`build-app.sh` 的 Release 编译、103 项原生检查（75 项 App Shot）、8 组预算检查、Mac 回答页构建和固定身份签名均通过。
- 最终包只包含原生 Cue 可执行文件，无 `sage-node`、`Node-LICENSE.txt`、旧桥接路径；无 `_AXUIElementGetWindow` 强导入。
- 安装包 `codesign --verify --deep --strict` 通过；构建产物与安装应用二进制 SHA-256 相同：`4ca2b14e8e6e909e751b3f254ff8639652438bd4d61da2e6180900029b2e4674`。
- bundle ID 仍为 `com.siyidu.sage.mac`，build 18 与 20 的固定证书签名条件一致。旧登录、历史和录屏权限保留；build 17、18、19 的回退包存于本地验收目录。
- `apps/cloud` 原有未提交改动保留，本次未修改、提交或部署；Windows 实现未变。

## 真机验收

全部截图由 Cue 自身按钮触发，原图和窗口文字通过 MCP `read_context` 读回。目标文档和网页均为合成内容；浏览器的工具栏仍属于所选窗口原图。

| 场景 | 实测结果 | 点击至服务器保存 |
| --- | --- | --- |
| 未获有效辅助功能授权 | 原图成功上传，文字 `unavailable`，包含授权说明；来源列表未触发请求 | 单独记录，不参与下列耗时比较 |
| TextEdit 文档滚至中部 | 原图只显示中段，文字同时含屏外 `ORBIT-AX-7319`、`COMET-AX-8624`；因描述属性错误标记 `partial` | 0.596 秒 |
| Chrome 本地 HTML | `available`，包含 `AXWebArea` 及 `ORBIT-CHROME-4827` | 2.011 秒 |
| 独立 Electron 合成编辑区 | 首次 Cue 采集得到 `AXWebArea`、`AXTextArea`、`ELECTRON-AX-9652` 和代码，状态 `available` | 0.935 秒 |
| 后台、同名、同位置窗口 | A/B 均为 `Cue AX Twin`，位置尺寸均为 `(180,120,900,650)`；前台 B 编号 18459，选中后台 A 编号 18458。原图及文字只含 A 的 `ALPHA-AX-3792`，不含 B 的码，状态 `available` | 1.873 秒 |
| 大量引号、反斜杠及 emoji | 原图成功上传；文字 `partial`，保留起始码、截去尾部；完整对象 JS 长度 79,998，紧凑 UTF-8 长度 99,998 字节 | 0.844 秒 |
| 显式回答 | 新建「验收：App Shot AX」，只选择一张 Chrome 截图；回答正确输出 `ORBIT-CHROME-4827` 和 `42` | 不作为截图耗时 |

以上为每个场景的一次观测，并非性能分布或固定延迟承诺。没有同条件的旧链路点击耗时基线，因此不声称量化提速。Electron 使用本地真实 Electron 运行时及合成 textarea，未把它视为 VS Code 编辑器的专项验收。

### 旧授权记录修复与跨版本保留

系统设置里 Cue 开关已开启，但最初仍不可用。实时 TCC 日志确认：辅助功能授权仍绑定旧 ad-hoc `cdhash H"691bbebf726b8c122a4ab5bc0f6ddc7862457f5d"`，系统报 `Failed to match existing code requirement` 并返回 `authValue=0`。当前签名正常；录屏记录已经匹配固定证书。

用户在系统界面只移除并重新添加 Cue 的辅助功能条目后，build 18 获得窗口访问。随后安装 build 19、20，均无需再次授权；build 20 的正文读取、后台窗口、Chrome/Electron 采集成功。未重置其他隐私权限，也未重新生成证书。该结果证明这次迁移后的权限保留，不替代所有 macOS 版本及首次全新安装的测试。

验收结束已关闭合成 Chrome、Electron、TextEdit 窗口，恢复 `frontmost` 截图来源，清除待发送测试附件选择；保留验收聊天及本地证据。Cue 连接正常，转录未开启。

## 本地产物与边界

- 应用：`apps/macos/output/Cue.app`；已安装副本：`/Applications/Cue.app`。
- 压缩包：`artifacts/releases/20261009-appshot-ax-build20/Cue-macOS-arm64-0.4.1-build20.zip`。
- 同目录 `build.log`、`receipt.json`；ZIP SHA-256：`86ef7175617c1f9d56e93ba8abdcdc1c7fa4b9a0c5b5abe977b1d711ade31deb`。
- 真实读回、签名诊断及合成夹具：`artifacts/acceptance/20261009-appshot-ax/`，该目录不提交公开仓库。

本次不改变既有转录长测、真实双路音频和 Windows 真机验收状态。未取得旧链路同条件性能基线；几何回退、私有符号缺失、超时、取消等故障路径由离线注入检查覆盖，未冒充真实系统故障重现。
