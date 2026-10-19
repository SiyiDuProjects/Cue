# 转录保存失败恢复

## 范围与根因

仅修复云端转录保存队列。旧实现把每次写入追加到同一个 Promise；一次数据库写入失败后，后续 `.then()` 都跳过，连接仍在接收转录但无法再保存。

截图采集、连拍上传、网页就绪状态、MCP 增量与历史分页均未修改。桌面端无需重新打包或安装。

## 修改

- 每条未保存转录保留最新版本，数据库确认成功后才移出队列；后续转录不会继承之前失败的 Promise。
- 重用现有三秒连接维护循环重试，因此最后一句保存失败后即使没有新语音，也会继续尝试保存；未增加计时器或协议。
- 重试沿用原转录 ID、版本号与桌面所有权条件，写入结果未知时也不会重复落库，旧连接不能越权补写。
- 回答截止等待所需转录保存成功；超时时说明尚未保存，不带缺失上下文开始回答。取消仍可立即结束等待。

待保存内容保留在当前云端连接的内存中；这不是跨连接或进程重启的持久恢复机制。原有断线后手动重新开始转录的策略不变。

## 检查

- 新增六项转录持久化回归检查全部通过：无后续语音时补存、连续失败保留多句及修订、回执丢失不重复写入、回答等待及取消、写入期间修订、连接所有权隔离。
- 修复前运行第一项检查，复现保存失败后不能恢复；修复后通过。
- 云端构建通过，`git diff --check` 通过。
- 云端全套测试：58 项，55 通过，3 失败。失败均为原有截图/MCP 测试断言与当前接口不一致，已在未修改的 `e7869810b66f2c0f8b8282c129fd073df754abf0` 上复现相同三项失败：
  - `saving 40 screenshots needs no answer or read acknowledgement; catalog limits never limit capture`
  - `MCP defaults to latest content and explicit history pages never consume it`
  - `screenshots keep original pixels and multiple attachments without window text`
- 未修改上述截图测试来消除失败；未开启麦克风、系统音频、真实付费模型或长连接测试。

构建、离线检查与部署记录不代表真实语音设备验收。

## 发布

- 云端提交：`2fc8f21685036db10c7cd836c71b30b3d1d643a1`，已推送 Sites 源仓库与私有 GitHub 仓库。
- Sites 部署：`appgdep_6ad5aa6c6b3881919bc7043b0f7dc35a`，状态 `succeeded`。
- 保存版本：`appgprj_6ac3050911388191a096e3850daec725~appgver_e4eb7039d5788191954ada092edbd44a`。
- 部署返回地址：`https://cue-app.dusiyi0916.chatgpt.site`；继续沿用 `https://cue.siyidu.com` 与既有所有者访问范围。
