import ExpoModulesCore
import UIKit

public class KeyCommandsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KeyCommands")

    View(KeyCommandsView.self) {
      Events("onSubmitKey")

      Prop("enabled") { (view: KeyCommandsView, enabled: Bool) in
        view.enabled = enabled
      }
    }
  }
}

/// Wraps a text input (TER-368). While a view inside it is first responder, a hardware keyboard's
/// Return and Cmd+Return fire `onSubmitKey` instead of inserting a new line. Shift+Return is not
/// claimed, so the text view inserts the new line as usual, and the on-screen keyboard never goes
/// through UIKeyCommand: its Return keeps inserting a new line too.
class KeyCommandsView: ExpoView {
  let onSubmitKey = EventDispatcher()
  var enabled = true

  private lazy var submitCommands: [UIKeyCommand] = {
    let modifiers: [UIKeyModifierFlags] = [[], .command]
    return modifiers.map { flags in
      let command = UIKeyCommand(input: "\r", modifierFlags: flags, action: #selector(termhubSubmitKey(_:)))
      // Without priority the text view handles Return itself (a new line) and the command never fires.
      command.wantsPriorityOverSystemBehavior = true
      return command
    }
  }()

  // UIKit collects key commands from the first responder up the responder chain, so this view is
  // only asked while the focused view is one of its descendants: other inputs are never affected.
  override var keyCommands: [UIKeyCommand]? {
    guard enabled, !isComposingMarkedText() else { return super.keyCommands }
    return (super.keyCommands ?? []) + submitCommands
  }

  @objc func termhubSubmitKey(_ command: UIKeyCommand) {
    onSubmitKey(["modifiers": command.modifierFlags.contains(.command) ? "command" : "none"])
  }

  /// An IME composition (Japanese, Chinese…) confirms its marked text with Return: never claim it then.
  private func isComposingMarkedText() -> Bool {
    guard let input = firstResponderTextInput(in: self) else { return false }
    return input.markedTextRange != nil
  }

  private func firstResponderTextInput(in view: UIView) -> UITextInput? {
    if view.isFirstResponder, let input = view as? UITextInput { return input }
    for sub in view.subviews {
      if let found = firstResponderTextInput(in: sub) { return found }
    }
    return nil
  }
}
