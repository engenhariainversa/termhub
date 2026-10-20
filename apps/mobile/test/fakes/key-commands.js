const React = require('react');
const { View } = require('react-native');

// The composer's hardware-keyboard wrapper (modules/key-commands) has no native view under jest: a
// plain view that keeps its props, so a test fires `submitKey` the way UIKit would on Return.
function KeyCommands(props) {
  return React.createElement(View, { testID: 'key-commands', ...props });
}

module.exports = { KeyCommands };
