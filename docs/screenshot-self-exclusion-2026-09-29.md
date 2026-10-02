# Sage 自身截图排除

Windows 版默认截图仍取主显示器，也可手选其他屏幕或窗口。应用截图和来源缩略图采集期间，临时为自身窗口启用 Electron content protection；等待桌面合成后采集，在 finally 中恢复。重叠的截图与预览共用保护期，避免较早完成的请求提前恢复。

来源列表按原生窗口 ID 排除 Sage，显式传入自身 ID 也不能选择。系统音频的来源枚举不启用保护，不改变转录连接。正常使用时不启用保护，因此系统截图仍可用于反馈 Sage 的界面问题。

该实现验证于当前 Windows 机器。Electron 文档说明 Windows 10 2004 及之后会从捕获中去除窗口，旧版 Windows 可能显示黑块；本改动不声称 macOS/Linux 具备相同屏幕排除效果。

## 验证

- `electron/screen-capture.test.cjs`：默认显示器、手动窗口、来源消失、源切换、大小上限、自身 ID 排除、并发采集与异常恢复、已受保护窗口状态保留、音频枚举，共 10 项通过。
- `tests/screenshot-self-exclusion-smoke.cjs`：两个临时纯色原生窗口叠放。原始截图捕获前景色；三次并发截图/预览捕获被遮挡的背景色；结束后原始截图再次捕获前景色。另核验自身不能选择、其他窗口可选和音频来源不变。
- 原生结果只保存像素数值到 `artifacts/screenshot-self-exclusion/native-result.json`，不保存整屏截图，不调用模型，不采集音频。
- 完整桌面采集/主进程离线测试 57 项通过，TypeScript/Vite 构建和 Windows 打包通过。
- 0.1.11 已安装；安装后的 ASAR 与本次构建 SHA-256 一致。使用安装包内的截图模块重跑上述原生测试通过，登录账户只读检查成功，加密连接配置哈希未变。未重新发送用户请求或调用真实模型。

参考：[Electron BrowserWindow.setContentProtection](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable-macos-windows)。
