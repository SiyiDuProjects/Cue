import AppKit
import Carbon

@MainActor final class AnswerHotkey {
  private var key: EventHotKeyRef?
  private var handler: EventHandlerRef?
  private let action: () -> Void
  init(action: @escaping () -> Void) { self.action = action }
  func setEnabled(_ enabled: Bool) -> Bool {
    if let key {
      UnregisterEventHotKey(key)
      self.key = nil
    }
    guard enabled else { return true }
    if handler == nil {
      var event = EventTypeSpec(
        eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
      let result = InstallEventHandler(
        GetApplicationEventTarget(),
        { _, event, context in
          guard let context, let event else { return OSStatus(eventNotHandledErr) }
          var id = EventHotKeyID()
          guard
            GetEventParameter(
              event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
              nil,
              MemoryLayout<EventHotKeyID>.size, nil, &id) == noErr,
            id.signature == 0x5361_6765, id.id == 1
          else { return OSStatus(eventNotHandledErr) }
          let hotkey = Unmanaged<AnswerHotkey>.fromOpaque(context).takeUnretainedValue()
          Task { @MainActor in hotkey.action() }
          return noErr
        }, 1, &event, Unmanaged.passUnretained(self).toOpaque(), &handler)
      guard result == noErr else { return false }
    }
    let id = EventHotKeyID(signature: 0x5361_6765, id: 1)
    return RegisterEventHotKey(
      UInt32(kVK_Return), UInt32(controlKey | optionKey | cmdKey), id,
      GetApplicationEventTarget(), 0, &key) == noErr
  }
  deinit {
    if let key { UnregisterEventHotKey(key) }
    if let handler { RemoveEventHandler(handler) }
  }
}
