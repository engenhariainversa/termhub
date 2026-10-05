// `react-native-markdown-display` under jest (test/ui-setup.js): the source text in a `Text`
// tagged `markdown`, so a test can tell an assistant's markdown bubble from a plain one. Every
// render appends its source to `renders`, so a test can check which bubbles re-rendered, and its
// props to `props`, so a test can call `onLinkPress` or a rule the real renderer would.
const React = require('react');
const { Text } = require('react-native');

const renders = [];
const props = [];

function Markdown(p) {
  renders.push(p.children);
  props.push(p);
  return React.createElement(Text, { testID: 'markdown' }, p.children);
}

module.exports = { __esModule: true, default: Markdown, renders, props };
