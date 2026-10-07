# Cue for macOS

菜单栏采集工具，要求 macOS 15+、Apple Silicon。电脑负责手动截图、系统音频与麦克风采集；回答显示在订阅的 ChatGPT Work 对话中。

## 使用

1. 已登录设备启动时从钥匙串恢复连接。正式地址内置；不填写 OpenAI key。已安装 0.3.1 使用 Sites 连接凭证；旧 0.2.1 和 v12 登录均保留回退。
2. 菜单栏可开始／停止转录、截图、请求 ChatGPT 回答、打开设置和退出。启动与重连不开始采集。
3. 在 ChatGPT Work 云端对话订阅 `answer.requested`，然后在 Cue 设置选择该订阅。默认快捷键 **⌃⌥⌘↩**，可关闭。Webhook 接收成功不表示答案已生成。
4. 设置保留截图来源、原图预览／移除、转录查看、新一场、登录和投递状态。窗口消失时提示，不自动改截全屏。
5. 按键先等待双路音频中本次标记之前的转录完成，再通知 ChatGPT 读取固定请求。通知只带标识，不夹带全文。菜单中的「API 备用回答」打开受保护的共用网页，必须再次手动确认生成；通知失败不会自动调用 API。

截图与相关窗口文字只由手动操作获取；文字是不可信参考，可能包含屏外内容。两路音频独立上传、不混音，不触发回答。停止和退出时先刷新尾帧并等待转录收尾。

Mac 已删除本地聊天列表、聊天输入框、Responses 调用实现、答案渲染、草稿读写和旧 AX 遍历。备用回答由共用网页及云端 Responses 实现。Swift 包不再依赖 Markdown、SwiftMath 或公式字体。旧文件与服务端历史继续保留。

## 本地资料与凭证

- 资料位置：`~/Library/Application Support/SageMac/assistant-workspace/materials/`。只读桥接按需读取此目录中的 UTF-8 文本。
- 旧 `drafts.json`、CLI 登录状态及历史文件不会被读取、覆盖或删除。
- 正式连接凭证保存在系统钥匙串，API key 只在服务器。安装包不含私有资料、凭证、历史数据库或 CLI。
- `sage-node` 仅运行只读资料和手动截图桥接。App Shot 复用用户已安装的 ChatGPT Computer Use 组件；不是公开 Appshot SDK，兼容性取决于已安装应用。

## 构建与验证

先按需加载 `/Users/siyi/Projects/_tools/env.sh`，然后在仓库根目录运行：

```sh
bash apps/macos/scripts/build-app.sh
bash apps/macos/scripts/check-offline.sh
```

默认 Release；`CONFIGURATION=debug` 构建调试包。产物 `apps/macos/output/Cue.app` 使用本机 ad-hoc 签名，未公证。Node.js 22+ 用于桥接；可用 `SAGE_NODE_BIN`、`SAGE_NODE_LICENSE` 指定发行版。

离线检查使用截获 HTTP、模拟 WebSocket、合成 PCM 和截图，不使用真实模型或媒体。覆盖连接恢复、快捷键去重、固定截图归属、转录尾帧、双路隔离、积压与协议拒绝。已移除产品功能的渲染和聊天发送测试不再运行。

调试包的 `--preview` 只显示合成设置窗口；`--check-capture-app` 检查菜单栏生命周期；`--preview --render-preview /tmp/sage.png` 渲染自身窗口。

## 当前交付边界

当前安装版与发布包为 0.3.1 / build 7，使用 `https://interview.siyidu.com` 的 Sites 服务及 `sage-capture-v1` 协议。正式域名认证、原生双路空闲连接和安装后自动登录均已验证；旧 0.2.1 应用备份在 `artifacts/releases/20261004-sites-cutover/previous-Sage.app`。

只读资料桥接也已换成 Sites 按需请求，Mac 与 Windows 打包同一份实现，不再包含旧 model WebSocket host。Sites 两种连接凭证仅经内存、钥匙串和子进程 stdin 传递；服务凭证严格绑定同一网站，模型密钥不进入客户端。

调试包的 `--check-sites-connection` 从 stdin 读取 `{origin, credential:{site,device}}`，只验证认证、快照和两路空闲握手；不写钥匙串、不开媒体、不运行资料后台或模型。真实运行必须使用隐藏输入，禁止将凭证放在命令行或日志中。

调试包的 `--check-sites-event` 仅用于明确授权的完整订阅测试：隐藏 stdin 额外提供 `expected_recording`、`expected_image` 和 `expected_subscription`，确认当前只有指定合成图片、无转录且订阅匹配后，调用与菜单／快捷键相同的原生回答请求动作。它会发送一个真实事件；不模拟物理按键，不打开媒体、不写钥匙串，投递回执与 ChatGPT 实际回答需分别核对。

新 Sites 服务位于 `apps/cloud`，线上版本 12。正式自有域名 `interview.siyidu.com` 已切换，DNS、Sites 绑定及 HTTPS 证书均已生效；自动生成的 chatgpt.site 地址仍是平台分配的 MCP 内部连接地址，原订阅无需重建。双路合成语音的按键边界、Work 订阅／接收／回答、取消／恢复及续期已实测通过。安装后已通过真实 MCP 读取本机五份资料目录；账号断开即时停止、物理快捷键和真实媒体仍未验收，VPS 及旧私人历史保留。完整交付与切换条件见 [0.3.1 交付记录](../../docs/unified-capture-delivery-2026-10-04.md)。
