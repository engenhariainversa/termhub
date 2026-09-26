import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, CONCIERGE_SETTINGS, mcpConfig } from './index.js';

const spec = {
  session_id: '3f1e9b1e-0000-4000-8000-000000000001',
  resume: false,
  mcp_config_path: '/tmp/mcp.json',
  model: null as string | null,
};

describe('buildClaudeArgs', () => {
  it('produces the exact argv the spec fixes, flag-value pairs adjacent, in a fixed order', () => {
    // A test that only checks a flag is present would still pass if its value drifted onto another
    // flag's slot; toEqual on the whole array is the strongest form of "adjacent pair" assertion.
    // The disallowed-tools value is the literal, not the DISALLOWED_TOOLS constant under test: a
    // test that compared the constant to itself would stay green even if the constant's own value
    // drifted (a tool dropped, reordered, or wrong), which is exactly the drift this file exists to
    // catch.
    expect(buildClaudeArgs(spec)).toEqual([
      '-p',
      '--session-id', spec.session_id,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--mcp-config', spec.mcp_config_path,
      '--strict-mcp-config',
      '--allowed-tools', 'mcp__termhub__*',
      '--disallowed-tools', 'Bash,Read,Write,Edit,WebFetch,WebSearch',
    ]);
  });

  it('resumes with --resume alone: the CLI refuses it next to --session-id', () => {
    // Error: --session-id can only be used with --continue or --resume if --fork-session is also
    // specified. Passing both broke every message after the first, and this pins that it never
    // happens again.
    const args = buildClaudeArgs({ ...spec, resume: true });
    const idx = args.indexOf('--resume');
    expect(args.slice(idx, idx + 2)).toEqual(['--resume', spec.session_id]);
    expect(args).not.toContain('--session-id');
  });

  it('names the session on a first run, where --session-id is the only way to choose the id', () => {
    const args = buildClaudeArgs({ ...spec, resume: false });
    const idx = args.indexOf('--session-id');
    expect(args.slice(idx, idx + 2)).toEqual(['--session-id', spec.session_id]);
    expect(args).not.toContain('--resume');
  });

  it('passes the model through when given, and omits the flag entirely when absent', () => {
    const withModel = buildClaudeArgs({ ...spec, model: 'sonnet' });
    const idx = withModel.indexOf('--model');
    expect(withModel.slice(idx, idx + 2)).toEqual(['--model', 'sonnet']);

    const withoutModel = buildClaudeArgs({ ...spec, model: null });
    expect(withoutModel).not.toContain('--model');
    const undefinedModel = buildClaudeArgs({ session_id: spec.session_id, resume: false, mcp_config_path: spec.mcp_config_path });
    expect(undefinedModel).not.toContain('--model');
  });

  it('appends the system prompt as the last flag pair, only when set', () => {
    expect(buildClaudeArgs({ ...spec, append_system_prompt: 'Você é o chat do projeto X.' }).slice(-2)).toEqual(['--append-system-prompt', 'Você é o chat do projeto X.']);
    expect(buildClaudeArgs({ ...spec, append_system_prompt: null })).not.toContain('--append-system-prompt');
    expect(buildClaudeArgs({ ...spec, append_system_prompt: '' })).not.toContain('--append-system-prompt');
  });

  it('streams input, replays messages and loads the background hook only when asked', () => {
    const args = buildClaudeArgs({ ...spec, stream_input: true });
    const i = args.indexOf('--disallowed-tools');
    expect(args.slice(i + 2, i + 7)).toEqual(['--input-format', 'stream-json', '--replay-user-messages', '--settings', CONCIERGE_SETTINGS]);
    // The one-shot argv is exactly what it always was.
    expect(buildClaudeArgs({ ...spec, stream_input: false })).toEqual(buildClaudeArgs(spec));
    expect(buildClaudeArgs(spec)).not.toContain('--input-format');
  });

  it('puts the system prompt last in a streamed run too', () => {
    const args = buildClaudeArgs({ ...spec, stream_input: true, append_system_prompt: 'foco' });
    expect(args.slice(-2)).toEqual(['--append-system-prompt', 'foco']);
  });
});

describe('mcpConfig', () => {
  it('puts the token in the header and nowhere else, and is valid JSON with one server named termhub', () => {
    const token = 'thb_pat_' + 'A'.repeat(43);
    const url = 'https://termhub.dev/mcp';
    const raw = mcpConfig(url, token);
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({
      mcpServers: {
        termhub: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } },
      },
    });
    // The token must not leak into a second place in the payload (e.g. a query string or a log field).
    expect(raw.split(token)).toHaveLength(2);
  });
});
