// Adapted from Peekaboo, commit 016240d908566e54b702336ba39abc0f621b5b60. MIT; see THIRD_PARTY_NOTICES.md.
import AppKit
import ApplicationServices
import CoreGraphics

@_spi(Testing) public enum AXAttributeReadCompletenessPolicy {
    @_spi(Testing) public static func embeddedError(in value: Any) -> AXError? {
        let cfValue = value as CFTypeRef
        guard CFGetTypeID(cfValue) == AXValueGetTypeID() else { return nil }
        let axValue = unsafeDowncast(cfValue, to: AXValue.self)
        guard AXValueGetType(axValue) == .axError else { return nil }
        var error = AXError.success
        return AXValueGetValue(axValue, .axError, &error) ? error : .failure
    }

    @_spi(Testing) public static func hasIncompleteErrorValue(in values: [Any]) -> Bool {
        values.contains { value in
            guard let error = self.embeddedError(in: value) else { return false }
            return self.isIncomplete(error: error)
        }
    }

    @_spi(Testing) public static func isIncomplete(error: AXError) -> Bool {
        switch error {
        case .success, .noValue, .attributeUnsupported, .parameterizedAttributeUnsupported, .notImplemented:
            false
        default:
            true
        }
    }

    /// Attributes that identify and place a node. Without them the element cannot be emitted or
    /// targeted at all, so a hard error on one of them really does make the node unreadable.
    @_spi(Testing) public static let nodeIdentityAttributeNames: Set<String> = [
        kAXRoleAttribute,
        kAXPositionAttribute,
        kAXSizeAttribute,
    ]

    /// Decides whether one attribute's embedded AX error invalidates the whole node.
    ///
    /// Applications answer inapplicable optional attributes with a generic `.failure` instead of
    /// `.attributeUnsupported`: NSTextView does it for `AXDescription`, Finder's window root does it
    /// for `AXValue`. Reading that as an unreadable node drops the element *and* abandons its subtree,
    /// which is how a document's editable text area disappears from an otherwise healthy observation.
    /// Only a node-identity attribute, or an error proving the read itself did not complete
    /// (dead element, unanswered request), may invalidate the node.
    @_spi(Testing) public static func attributeErrorInvalidatesNode(
        _ error: AXError,
        attribute: String) -> Bool
    {
        guard self.isIncomplete(error: error) else { return false }
        return error != .failure || self.nodeIdentityAttributeNames.contains(attribute)
    }

    @_spi(Testing) public static func hasNodeInvalidatingErrorValue(
        names: [String],
        values: [Any]) -> Bool
    {
        zip(names, values).contains { name, value in
            guard let error = self.embeddedError(in: value) else { return false }
            return self.attributeErrorInvalidatesNode(error, attribute: name)
        }
    }
}
