import { codeFileExtension, codeFileMime, codeFileName, fenceLanguage, slugify } from './code-file';

const NOW = new Date(2026, 9, 14, 16, 30);

describe('code-file (TER-1084)', () => {
  it.each([
    [null, 'txt'],
    ['text', 'txt'],
    ['markdown', 'md'],
    ['md', 'md'],
    ['bash', 'sh'],
    ['sh', 'sh'],
    ['json', 'json'],
    ['toml', 'toml'],
    ['yaml', 'yaml'],
    ['ts', 'ts'],
    ['js', 'js'],
    ['py', 'py'],
    ['rust', 'txt'],
  ])('%s → .%s', (language, ext) => {
    expect(codeFileExtension(language)).toBe(ext);
  });

  it('reads the language off the info string and drops anything unsafe', () => {
    expect(fenceLanguage('bash title=x')).toBe('bash');
    expect(fenceLanguage('')).toBeNull();
    expect(fenceLanguage('<img>')).toBeNull();
  });

  it('names the file after the first non-empty line, the time and the extension', () => {
    expect(codeFileName('\nPrompt de integração Keycloak\n', 'text', NOW)).toBe('prompt-de-integracao-keycloak-2026-10-14-1630.txt');
    expect(codeFileName('/\\:*?"<>|\n', null, NOW)).toBe('codigo-2026-10-14-1630.txt');
  });

  it('keeps the slug short, cut at a word', () => {
    expect(slugify('uma primeira linha muito comprida que nunca acaba e continua por aí')).toBe('uma-primeira-linha-muito-comprida-que');
  });

  it('tells Android a type that does not change the extension', () => {
    expect(codeFileMime('txt')).toBe('text/plain');
    expect(codeFileMime('json')).toBe('application/json');
    expect(codeFileMime('sh')).toBe('application/octet-stream');
  });
});
