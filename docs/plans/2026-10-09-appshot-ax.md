# App Shot 改用系统辅助功能（AX）读取窗口文字

实施状态：已实现并安装 build 20，完成合成窗口真机验收；详见 `docs/releases/2026-10-09-appshot-ax.md`。验收补充修复：TextEdit 可选描述属性失败不再跳过正文子树；旧 ad-hoc 辅助功能授权经用户重新登记后，build 18 → 19 → 20 保留权限。旧链路同条件耗时基线未测。

## 目标

- 去掉对 ChatGPT 内部采集组件（`cua-repl` / `sky.get_app_state`）和打包 Node 的依赖。
- 窗口原图继续由 ScreenCaptureKit 截取；窗口文字改为 Cue 自己通过 macOS Accessibility API 读取。
- 产品行为不变：仅手动触发；保留原图；文字必须来自同一窗口，无法唯一确认时说明原因，不取其他窗口；截图和文字都是不可信参考。
- 上传格式不变（`appshot: { app_name, window_title, text, status, detail }`），云端和 MCP 无需改动。

## 现状（要替换的部分）

- `apps/macos/Sources/Sage/Capture.swift` 的 `screenshot(source:)` 有两处调用 `NativeAppShot.capture`：
  - `frontmost`：图和文字都来自 ChatGPT 组件；失败后退回自截窗口图。
  - 指定窗口：先自截原图，再要求该窗口是所属应用的最前窗口，然后调 ChatGPT 组件取文字，并核对尺寸后换用其图片。
- 调用链：`NativeAppShot.swift` → 打包的 `sage-node` → `Support/native-appshot.cjs` → 扫描 `~/.codex/plugins/cache/openai-bundled/unified-computer-use`，启动 ChatGPT 的 Node 运行时。
- 潜在问题：旧桥接允许最多 180,000 字文字，但云端 `store.image` 要求 `JSON.stringify(appshot).length < 100000`，文字过长时整张截图上传失败（413）。

## 设计

### 1. 权限

- 在 `ScreenAccess` 旁新增 `AccessibilityAccess`：
  - `granted` 使用 `AXIsProcessTrusted()`，不弹窗。
  - `require(asking:)` 只在用户点击 App Shot 时，用 `AXIsProcessTrustedWithOptions`（prompt = true）请求权限。列出来源时不得弹窗，与录屏权限的规则一致。
  - 设置页地址：`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`。
- 不需要 Info.plist 键。签名身份固定，预期跨版本保留授权，但必须像 build 15 验证录屏权限那样实测一次。
- 没有辅助功能权限时：原图照常上传，`status = "unavailable"`，`detail` 提示在「辅助功能」中开启 Cue。不阻断截图。

### 2. 窗口对应（一个 SCWindow 对应一个 AX 窗口）

- 先确定 SCWindow：
  - `frontmost`：沿用现有逻辑，用 `previousApp` 的 pid 取它最前面的第 0 层、带标题的窗口。
  - 指定窗口：按 windowID 查找。
- 在 `AXUIElementCreateApplication(pid)` 的 `kAXWindowsAttribute` 中找对应窗口：
  1. 优先用 `_AXUIElementGetWindow(element, &windowID)` 精确比对 CGWindowID。这是可选的私有能力：用 `dlsym` 查找并通过 C 调用约定的函数指针调用，不用 `@_silgen_name` 建立强链接。符号不存在或查询失败时允许几何回退，应用仍应正常启动和截图。成功查出其他窗口 ID 的候选不得再靠几何位置匹配到目标；多个候选返回目标 ID 时也视为有歧义。
  2. 没有精确命中时，只对无法取得 ID 的候选使用现有的 `WindowMatch.unique(bounds:title:candidates:)`，比对 AX 的位置、尺寸和标题。两边都应是左上角原点的全局坐标，实施时用真实窗口核对一次。
  3. 不唯一：文字不可用，保留原图，`detail` 写「窗口身份无法唯一确认」。
- 取消"所选窗口必须是最前窗口"的限制，因为 AX 可以读后台窗口。
- 匹配结果保留依据（精确 ID / 几何回退），读完文字后用新的 `SCShareableContent` 分别复核：
  - 精确 ID：按 PID + windowID 找到唯一目标，核对目标自身的标题和几何位置未变；同应用中另有同名、同位置窗口，不应否决已确认的 ID。
  - 几何回退：继续要求同应用中的标题和几何位置唯一，并且最终仍是截图时的 windowID。
  - 目标关闭、被替换、PID 改变或标题/几何位置改变时丢弃文字，保留原图。几何位置比较沿用现有的小于 2 点的容差。
  - 修改 `WindowMatch.isCurrent` 接收匹配依据，不能原样复用目前「先检查几何唯一，再检查 ID」的逻辑；对应更新现有同名重叠窗口测试。

### 3. 文字提取

- 从窗口元素开始深度优先遍历。每个节点读取 role、subrole、title、description，以及字符串类型的 value。文本区的 `kAXValueAttribute` 往往包含滚出可见区域的全文。
- 输出缩进文本，首行为 `Window: "<标题>", App: <应用名>`，节点行形如 `[AXRole] 标题/描述: 值`。跳过没有文字也没有子节点的节点；连续重复的字符串只保留一次。
- Chromium / Electron：
  - 遍历前对应用元素设置 `AXManualAccessibility = true`，否则网页内容树很稀疏。
  - 首次开启后网页树会异步生成，最多等待约 1 秒、重试一次。
  - 仍没有 `AXWebArea` 内容时，才临时设置 `AXEnhancedUserInterface`，读完恢复原值。这个属性可能影响部分应用的窗口动画和定位。
- 限制：
  - 所有 AX 读取/写入通过共同的调用封装：每次调用前检查取消状态和剩余时间，并对实际接收调用的 AX 元素设置 `AXUIElementSetMessagingTimeout`，取 `min(0.5 秒, 剩余时间)`；剩余时间耗尽就停止，不传 0（0 会恢复默认超时）。只给应用元素设置超时不会传递到窗口或子节点。
  - 使用单调时钟计时，文字采集共用约 3 秒预算，包含窗口匹配、Chromium 树等待、重试和遍历；重试不能重置预算。节点上限约 20,000，深度上限约 60。
  - 80,000 个 Unicode 标量只作为文字构建的初步上限，不能作为上传安全保证。最后对完整 `appshot` 对象统一执行序列化预算检查，包括 `app_name`、`window_title`、`text`、`status` 和 `detail`，必须满足云端严格的 `< 100000` 条件。
  - Swift 端使用紧凑 `JSONSerialization` 输出的 UTF-8 字节数作为保守上限（它可能比服务端重新序列化后的 JavaScript UTF-16 长度更大），要求 `< 100000`。超限时先设置最终 `partial` 状态和固定简短原因，再按有效 Unicode 边界缩短文字前缀并重新序列化；可用二分查找避免逐字重试。不把原始文字长度、Swift `String.count` 或未转义的 UTF-16 长度当作对象大小。
  - 应用名、标题沿用现有 512 / 2048 个 Unicode 标量上限，`detail` 使用有界文案；`available`、`partial`、`unavailable` 都经过同一预算检查。即使异常元数据不能装入预算，也退回有界的不可用说明并保留原图，不让文字附件使整张图上传失败。
  - 超时或截断都标 `status = "partial"`，保留已读到的内容，`detail` 说明原因。
- AX 调用是同步的：放在专用串行队列执行，不阻塞主线程。取消信号通过线程安全标志传给工作队列；正在执行的同步调用需要返回或超时后才能退出，不能把 `Task.cancel()` 当成强制中断。取消后不再开始新的采集调用，取消结果不继续上传。
- 临时开启 `AXEnhancedUserInterface` 后，无论成功、失败、截止还是取消，都走同一清理路径恢复已读取的原值；无法读到原值时不修改该属性。清理调用使用单独的短超时（至多约 0.5 秒），恢复失败不无限重试。约 3 秒是采集预算，不是包含系统调度、清理和图片上传的硬性总耗时承诺。
- 顺序：先用 `SCScreenshotManager` 截图并记录 `captured_at`，紧接着读 AX。文字与像素之间可能有极短的时间差，按参考内容对待。

### 4. 结构

- 纯逻辑放进 `SageAppShot` target（`WindowIdentity.swift` 所在处），以便 `SageChecks` 测试：
  - `AXNode` 协议：role / title / value / children。
  - `AXTextBuilder`：负责格式、去重、截断和节点上限。
  - 完整 `appshot` 的序列化预算与安全截断，供所有结果状态共用。
  - 窗口匹配规则及匹配依据：精确 ID 优先，几何位置兜底，按依据复核。
  - 截止和取消策略支持注入时钟、调用结果，离线覆盖慢调用、重试和清理路径。
- 真实的 `AXUIElement` 适配层、动态符号查询和权限检查放在 `Sage` target（新文件，例如 `WindowText.swift`）；适配层采用可替换的调用接口，测试无需读取真实应用或申请权限。

### 5. 删除与更新

- 删除：`Sources/Sage/NativeAppShot.swift`、`Support/native-appshot.cjs`、`tests/native-appshot-smoke.cjs`。
- `scripts/build-app.sh`：
  - 不再复制和签名 `sage-node`，不再复制 `Node-LICENSE.txt` 和 `bridge/` 目录。
  - 构建时仍需要本机 Node，用于 `npm run build:mac` 和修补 `content.html`，这部分保留。
  - 签名调用去掉 `sage-node` 参数。
- `scripts/check-offline.sh`：去掉旧采集桥接的 smoke 测试，接入 Swift 合成结果与 Node 云端长度表达式的预算检查。
- `THIRD_PARTY_NOTICES.md`：删除 Node.js 和 ChatGPT runtime 两节。
- 文档里的「Node 仅供 App Shot」改为 AX 说明：`AGENTS.md` 的 `apps/macos/` 条目，以及 `apps/macos/README.md`。
- 错误文案不再提 ChatGPT；`detail` 改为「系统辅助功能读取」等简短说明。

### 6. 测试

- 离线（SageChecks，合成数据，不需要权限）：
  - `AXTextBuilder`：格式、去重、初步文字上限截断标 partial、节点和深度上限。
  - 上传预算：普通文字、密集引号/反斜杠/换行/控制字符、emoji、组合字符，以及达到上限的应用名和标题；检查完整最终对象严格小于 100,000、Unicode 有效、状态和原因计入预算，并覆盖三个结果状态。边界包含 99,999 和 100,000 字节，后者必须缩短。
  - 使用合成对象复现旧缺陷：80,000 个引号或 emoji 仍可使 `JSON.stringify(appshot).length` 超过 100,000。对 Swift 输出的合成结果用构建环境 Node 复核云端相同表达式，作为离线检查的一部分；Node 仅用于开发检查，不进入 Mac 包。
  - 窗口匹配：精确 ID 命中；同名同位置的两个窗口中精确 ID 仍可确认；同样场景在几何回退时拒绝；唯一几何命中；已知不同 ID 不得参与回退；读取后窗口关闭、替换、PID 或属性改变均拒绝。
  - 私有能力降级：注入符号缺失和 ID 查询失败，确认分别进入几何回退或文字不可用，原图仍保留；检查发布二进制没有对 `_AXUIElementGetWindow` 的强导入。
  - 超时与取消：用假时钟和模拟 AX 调用，核对窗口/子节点均设置超时，单次等待不超过剩余预算，Chromium 等待和重试共用截止，取消后不再遍历或上传。成功、错误、超时和取消路径均尝试有界恢复临时属性。
- 真机验收（需用户在场，仅用合成内容）：
  1. 首次点击 App Shot 时弹出辅助功能授权；授权后再次截图成功。
  2. TextEdit 长文档滚动到中部：文字包含屏幕外的内容。
  3. Chrome 打开本地合成 HTML 题目（含验证码，例如 `ORBIT-4729`）：文字包含验证码；回答能读出。
  4. VS Code 或其他 Electron 应用：能读到编辑区文字。
  5. 选择一个后台窗口：读到的是该窗口的文字，不是前台窗口的。
  6. 未授权：原图照常上传，`status=unavailable`，提示清楚。
  7. 安装新 build 后无需再次授权。
  8. MCP `read_context` 读回同一份文字。
  9. 记录从点击到上传完成的耗时，与旧链路对比。
- 第 5 项补充同一应用的两个同名、同位置合成窗口，核对精确 ID 路径不会错误拒绝或串窗；第 8 项补充含大量转义字符和 emoji 的长文本，核对截断状态、原图保存和 MCP 读回。

## 不在本次范围

- OCR 兜底：之后若发现 canvas 渲染的内容 AX 读不到再加。
- Windows 截图：不变。
- 云端和 MCP：不变。

## 完成标准

- Mac 包内不再有 `sage-node`、`bridge/` 和任何 ChatGPT 组件路径。
- `bash apps/macos/scripts/check-offline.sh` 通过，新增的 SageChecks 覆盖上面的离线项。
- 完整 App Shot 元数据满足云端长度限制；AX 超时覆盖实际接收调用的每个元素；精确窗口身份不被几何唯一性检查误拒绝；私有符号不可用时正常降级。
- 真机验收第 1–8 项通过，并按 `docs/releases/` 惯例单独记录；构建、离线检查和真机结果分开写。
