# Cue build 22：编码平台 App Shot 真机测试

日期：2026-10-10（America/Los_Angeles）。结论：**当前不能保证一次截图获得完整长题目和全部代码。** 窗口原图与上传链路可工作；代码编辑器的辅助功能正文可能为空或只有光标附近一段，题目中的公式和屏外图示也可能缺失。

## 环境与方法

- 已安装 `/Applications/Cue.app`，0.4.1 build 22；可执行文件 SHA-256：`601ccf2965ab3d7c08a3f4f927cdb3df7dae8fcd053d2f2ab91e4fc1c60d96bf`。
- macOS 27.0.1（26A434），Chrome 154.0.8037.98。外层源码 HEAD：`25658a8b27071b62a7f42f5fa3a99e3cc85b4373`。
- 每张验收图均点击已安装 Cue 的原生「截图」按钮，然后通过 Cue 插件 `read_context` 读回服务器保存的原图与 `meta.appshot`。浏览器 DOM 只用于安排测试和对照，未代替 Cue 的采集结果。
- 使用公开练习页与合成代码，没有进入真实面试或测评；没有提交代码、运行代码、调用回答模型或开启转录。
- 原图为当前窗口像素，正常尺寸 3840 × 1922；没有自动滚动、长图拼接或完整编辑器模型导出。
- [CoderPad 官方沙盒说明](https://coderpad.io/resources/docs/for-candidates/interview-preparation-guide/sandbox/)给出的入口为 `https://app.coderpad.io/sandbox`。未确认用户所指的上次面试平台，因此不将本次沙盒测试标为该场面试环境验收。

## 结果

| 场景 | 原图 | Cue 窗口文字 | 判定 |
| --- | --- | --- | --- |
| LeetCode Word Ladder II，题面停留顶部，默认 6 行 C++ 模板 | 当前窗口清楚可见，底部 Constraints 在屏外 | 两个样例、屏外 Constraints 及短模板均存在 | 此题普通文字通过；不是所有题型或图片完整性保证 |
| LeetCode，148 行合成代码，光标在开头 | 代码顶部可见 | 有首标记和编号 001–009，缺尾标记 | 全部代码失败 |
| 同上，光标在末尾 | 代码末尾可见 | 有尾标记和编号 132–140，缺首标记 | 全部代码失败 |
| 同上，光标在第 75 行 | 代码中部可见 | 只有编号 060–081，首尾均无 | 全部代码失败 |
| CoderPad，149 行 Java，默认模式，顶部与末尾各一次 | 可见代码清楚，包括相应首/尾标记 | `AXTextArea` 有 Editor content 标签但没有代码正文，编号标记为 0 | 代码文字失败；原图仅能补当前可见部分 |
| CoderPad，临时开启 Screen Reader Optimized Mode，光标在开头 | 代码顶部可见 | 有首标记和编号 001–009，缺尾标记 | 设置改善了读取，但没有提供完整代码 |
| HackerRank Queen's Attack II，顶部 | 可见题面和部分棋盘 | 屏外 Sample Input/Output 0–2、最后 Explanation 2 均存在；数学符号/坐标/数值约束缺失，图示只有通用 image 描述 | 题目不完整 |
| HackerRank，7 行合成代码，输入后 | 当前编辑区 | 首尾标记和全部短代码存在 | 此短代码通过 |
| HackerRank，148 行合成代码，光标在开头 | 代码顶部 | 有首标记和编号 001–006，缺尾标记 | 全部代码失败 |

这些正常窗口记录全部返回 `status: available`。这只能说明遍历取得了文字且未触发已识别的读取错误，不能说明题目或代码完整。

题目地址：

- `https://leetcode.com/problems/word-ladder-ii/description/`
- `https://app.coderpad.io/sandbox`
- `https://www.hackerrank.com/challenges/queens-attack-2/problem`

## 稳定性与来源选择

共保存并读回 16 条记录，其中 14 条是固定浏览器主窗口的采集，2 条是前期选到 Chrome 辅助窗口的记录。16 条都成功保存不等于 16 条内容验收通过。

固定浏览器窗口后，三次连续 CoderPad 截图均返回新记录、正确窗口标题和原图；从自动化发出原生按钮点击请求到服务器记录 `created` 分别为 1405、590、1106 ms。此计时包含控制调用开销，只是三个样本，不代表长时间稳定性或延迟分布。测试中未观察到 Cue 崩溃、断线或上传失败。

前两条记录抓到了标题为 `Window` 的 132 × 40 Chrome 共享预览小窗，文字只有 `WindowSharingSessionButton`，状态 `partial`。首次使用「最近应用」，第二次处于来源菜单操作阶段，不能把后者当作已成功固定主窗口后的复现。主窗口来源真正生效后，后续 14 条都是 3840 × 1922。

当前 `Capture.swift` 的最近应用路径按窗口顺序取同 PID、第 0 层且有标题的第一个窗口，没有排除这类共享辅助小窗。该现象在本次电脑控制/窗口共享环境中观察到；尚未在没有电脑控制的普通手动操作环境复测。

## 原因与后续修复方向

1. **编辑器暴露的是局部内容。** CoderPad 默认帮助明确显示未为屏幕阅读器优化；开启后，页面公开的 `native-edit-context` textbox 正文自身就只包含光标附近片段，与 Cue 读回内容相符。LeetCode 和 HackerRank 也随光标位置改变返回片段。这些结果远小于 80,000 字/100,000 字节限额，没有超时或截断提示，不能归因于 Cue 上传大小限制。
2. **可用状态没有完整性判据。** `AXTextBuilder` 只要读到文字且没有遍历错误就返回 `available`；工具栏和网页文字足以满足条件，空编辑器或网站主动截取的编辑器片段不会自动标为缺失。
3. **像素只覆盖当前窗口。** 可见公式和代码仍可能由模型从原图读出；屏外公式、图示、代码没有像素兜底，不能由一次普通窗口截图恢复。
4. **最近应用候选需要排除辅助小窗。** 应结合真实主窗口身份和窗口类型核对，避免仅凭 PID、层级和非空标题选择共享预览。

后续应先让返回状态明确区分有参考文字与已验证完整内容，再评估按用户动作触发的编辑器全文读取或多区域采集。仅增加文字上限、重试或开启屏幕阅读器优化无法解决本次复现。此次按测试请求记录发现，未修改采集实现、构建新包或部署服务。

## 证据与恢复

本地忽略目录：`artifacts/acceptance/20261010-coding-platform-appshot/`。

- 16 份 `.json`：服务器图片 ID、哈希、时间、完整 App Shot 文字和状态；连续三次另含点击开始时间。
- 8 张原始 `.png`：`lc1`、`lc3`、`lcLongTop`、`cpLongTop`、`cpOptimizedTop`、`hrNoModal`、`hrShort`、`hrLongCodeTop`。
- 合成夹具：`leetcode-fixture.cpp`、`coderpad-fixture.java`、`hackerrank-short.cpp`、`hackerrank-long.cpp`。
- `cleanup.json`：测试后界面与编辑器恢复检查。

已撤销三站测试输入；CoderPad 屏幕阅读器优化恢复关闭；关闭本次创建的三个浏览器标签。Cue 截图来源恢复 `frontmost`，待发送测试附件已取消选择，原有聊天保持。测试截图保留于正常截图历史，未删除服务端记录。Cue 连接正常，转录未开启。浏览器书签、窗口标题等可能出现在原始证据中，证据不提交公开仓库。
