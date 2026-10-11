import AppKit
import Carbon

/// System-wide ⌃⌥⌘ shortcuts that work while another app has focus.
@MainActor final class GlobalHotkeys {
  struct Key {
    let code: Int
    let name: String
    let action: () -> Void
  }
  private var keys: [EventHotKeyRef] = []
  private var actions: [UInt32: () -> Void] = [:]
  private var handler: EventHandlerRef?
  /// Registers each key with ⌃⌥⌘ and returns the names already taken.
  func register(_ entries: [Key]) -> [String] {
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
            id.signature == 0x5361_6765
          else { return OSStatus(eventNotHandledErr) }
          let hotkeys = Unmanaged<GlobalHotkeys>.fromOpaque(context).takeUnretainedValue()
          let key = id.id
          Task { @MainActor in hotkeys.actions[key]?() }
          return noErr
        }, 1, &event, Unmanaged.passUnretained(self).toOpaque(), &handler)
      guard result == noErr else { return entries.map(\.name) }
    }
    var taken: [String] = []
    for entry in entries {
      let id = UInt32(actions.count + taken.count + 1)
      var key: EventHotKeyRef?
      if RegisterEventHotKey(
        UInt32(entry.code), UInt32(controlKey | optionKey | cmdKey),
        EventHotKeyID(signature: 0x5361_6765, id: id), GetApplicationEventTarget(), 0, &key)
        == noErr, let key
      {
        keys.append(key)
        actions[id] = entry.action
      } else {
        taken.append(entry.name)
      }
    }
    return taken
  }
  deinit {
    for key in keys { UnregisterEventHotKey(key) }
    if let handler { RemoveEventHandler(handler) }
  }
}
