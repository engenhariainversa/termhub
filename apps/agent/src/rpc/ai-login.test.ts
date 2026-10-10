import { describe, expect, it } from 'vitest';
import { cliReportedSuccess, createAiLogin, failureMessage, parseClaudeLoginScreen, parseClaudeStatus, parseCodexLoginScreen, parseCodexStatus } from './ai-login.js';

const CLAUDE_SCREEN = `Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=MF4K&code_challenge_method=S256&state=rIhl
Paste code here if prompted >
`;

const CODEX_SCREEN = `Welcome to Codex [v0.159.2]
OpenAI's command-line coding agent
Follow these steps to sign in with ChatGPT using device code authorization:
1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device
2. Enter this one-time code (expires in 15 minutes)
   LCWQ-WSPV8
Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.
`;

describe('parseClaudeLoginScreen', () => {
  it('takes the whole OAuth URL token', () => {
    expect(parseClaudeLoginScreen(CLAUDE_SCREEN).url).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=MF4K&code_challenge_method=S256&state=rIhl',
    );
  });
  it('finds nothing before the URL shows up, nor in an unrelated link', () => {
    expect(parseClaudeLoginScreen('Opening browser to sign in…\n').url).toBeNull();
    expect(parseClaudeLoginScreen('see https://docs.anthropic.com/en/docs\n').url).toBeNull();
  });
});

describe('parseCodexLoginScreen', () => {
  it('takes the device page and the one-time code', () => {
    expect(parseCodexLoginScreen(CODEX_SCREEN)).toEqual({ url: 'https://auth.openai.com/codex/device', userCode: 'LCWQ-WSPV8' });
  });
  it('has the URL before the code is printed', () => {
    const partial = CODEX_SCREEN.split('2. Enter')[0];
    expect(parseCodexLoginScreen(partial)).toEqual({ url: 'https://auth.openai.com/codex/device', userCode: null });
  });
});

describe('status parsing', () => {
  it('reads claude auth status JSON', () => {
    expect(parseClaudeStatus('{"loggedIn": true, "authMethod": "claude.ai"}')).toBe(true);
    expect(parseClaudeStatus('{"loggedIn": false}')).toBe(false);
    expect(parseClaudeStatus('warning\n{"loggedIn": true}')).toBe(true);
    expect(parseClaudeStatus('garbage')).toBe(false);
  });
  it('reads codex login status', () => {
    expect(parseCodexStatus(0, 'Logged in using ChatGPT\n')).toBe(true);
    expect(parseCodexStatus(1, 'Not logged in\n')).toBe(false);
    expect(parseCodexStatus(0, 'Not logged in\n')).toBe(false);
  });
});

describe('cliReportedSuccess', () => {
  it('takes exit 0 or the success line as the CLI ending its login itself', () => {
    expect(cliReportedSuccess(0, '')).toBe(true);
    expect(cliReportedSuccess(null, 'Opening browser to sign in…\nPaste code here if prompted > Login successful.\n')).toBe(true);
    expect(cliReportedSuccess(1, 'OAuth error: invalid_grant\n')).toBe(false);
    expect(cliReportedSuccess(null, '')).toBe(false);
  });
});

describe('failureMessage', () => {
  it('drops lines with the code, URLs and the dead-pane footer, and keeps the tail', () => {
    const text = `${CLAUDE_SCREEN.replace('prompted >', 'prompted > s3cret-code')}Invalid code: s3cret-code\nOAuth error: invalid_grant\n\nPane is dead (status 1, Thu Oct  8 10:53:59 2026)\n`;
    const msg = failureMessage(text, 's3cret-code');
    expect(msg).toBe('Opening browser to sign in…\nOAuth error: invalid_grant');
    expect(msg).not.toContain('s3cret-code');
    expect(msg).not.toContain('https://');
  });
  it('bounds the length and answers null when nothing is left', () => {
    expect(failureMessage('x'.repeat(1000))!.length).toBe(300);
    expect(failureMessage('\n\n   \n')).toBeNull();
  });
});

describe('unsupported providers', () => {
  const login = createAiLogin();
  it('status says unsupported, start and submit refuse', async () => {
    expect(await login.status({ provider: 'gemini', config_dir: null })).toEqual({ supported: false, logged_in: false });
    await expect(login.start({ provider: 'antigravity', config_dir: null, session: 's' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(login.submit({ provider: 'gemini', config_dir: null, session: 's', code: 'x' })).rejects.toMatchObject({ code: 'invalid' });
  });
});
