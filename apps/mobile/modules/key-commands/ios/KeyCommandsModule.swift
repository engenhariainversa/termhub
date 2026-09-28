import ExpoModulesCore

// SPIKE (TER-368) — throwaway. A view that wraps the composer's TextInput and, while a view inside
// it is first responder, claims Return from a hardware keyboard before UITextView inserts "\n".
public class KeyCommandsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KeyCommands")

    View(KeyCommandsView.self) {
      Prop("enabled") { (view: KeyCommandsView, enabled: Bool) in
        view.enabled = enabled
      }
      Events("onSubmitKey")
    }
  }
}

class KeyCommandsView: ExpoView {
  let onSubmitKey = EventDispatcher()
  var enabled = true

  // UIKit asks every responder from the first responder up the chain for its key commands, so a
  // superview of the focused text view is asked only while that text view has focus. The on-screen
  // keyboard never goes through UIKeyCommand: its Return keeps inserting a new line.
  override var keyCommands: [UIKeyCommand]? {
    guard enabled, !isComposingMarkedText() else { return nil }
    let enter = UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(handleEnter(_:)))
    // Without priority, UITextView handles Return itself (a new line) and the command never fires.
    enter.wantsPriorityOverSystemBehavior = true
    let cmdEnter = UIKeyCommand(input: "\r", modifierFlags: .command, action: #selector(handleEnter(_:)))
    cmdEnter.wantsPriorityOverSystemBehavior = true
    // Shift+Return is deliberately not claimed: UITextView inserts the new line as usual.
    return [enter, cmdEnter]
  }

  @objc func handleEnter(_ command: UIKeyCommand) {
    onSubmitKey(["modifiers": command.modifierFlags.contains(.command) ? "command" : "none"])
  }

  /// An IME composition (Japanese, Chinese…) uses Return to confirm the marked text: never claim it then.
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
