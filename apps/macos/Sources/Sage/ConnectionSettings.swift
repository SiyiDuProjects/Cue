import SwiftUI
import AppKit

private typealias ConnectionState<Value> = SwiftUI.State<Value>

struct ConnectionView: View {
    @ObservedObject var store: AppStore
    @ConnectionState<String> private var token = ""
    @ConnectionState<Bool> private var updatingLogin = false
    @FocusState private var credentialFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Text(store.connected ? "Cue" : "登录 Cue").font(.title2.weight(.semibold))
                Text(store.connected ? "已登录。下次打开时会自动恢复。" : "登录一次，即可在这台电脑上持续使用。")
                    .font(.callout).foregroundStyle(.secondary)
            }
            if !store.connected || updatingLogin {
                VStack(alignment: .leading, spacing: 8) {
                    Text("登录凭证").font(.callout.weight(.medium))
                    SecureField("输入 Cue 登录凭证", text: $token)
                        .controlSize(.large).focused($credentialFocused)
                    Text("凭证安全保存在此 Mac 的钥匙串中。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Label("自动连接已开启", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.secondary).font(.callout)
                Button("更新登录…") { updatingLogin = true; credentialFocused = true }
                    .buttonStyle(.borderless)
            }
            if let error = store.error {
                Text(error).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                if store.connecting { ProgressView().controlSize(.small) }
                Spacer()
                Button(store.connected ? "完成" : "取消") { store.showSettings = false }.keyboardShortcut(.cancelAction)
                if !store.connected || updatingLogin {
                    Button(store.connecting ? "正在登录…" : "登录") {
                        Task { await store.connect(server: AppStore.serviceURL, token: token, remember: true) }
                    }.buttonStyle(.borderedProminent).disabled(store.connecting || token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .keyboardShortcut(.defaultAction)
                }
            }.controlSize(.large)
        }.textFieldStyle(.roundedBorder).padding(28).frame(width: 380)
            .onAppear { credentialFocused = !store.connected }
    }
}

func decodedImage(_ value: String?) -> NSImage? {
    guard let value, value.hasPrefix("data:image/"), let comma = value.firstIndex(of: ","),
          let data = Data(base64Encoded: String(value[value.index(after: comma)...])) else { return nil }
    return NSImage(data: data)
}


struct CopyButton: View {
    let text: String
    let label: String
    @ConnectionState private var copied = false
    var body: some View {
        Button { copy(text); copied = true } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc").frame(width: 24, height: 24)
        }.buttonStyle(.plain).help(copied ? "已复制" : label).accessibilityLabel(copied ? "已复制" : label)
            .task(id: copied) {
                guard copied else { return }
                try? await Task.sleep(for: .seconds(1.5))
                if !Task.isCancelled { copied = false }
            }
    }
}


func copy(_ text: String) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string) }
