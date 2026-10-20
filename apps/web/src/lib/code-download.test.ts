// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codeFileExtension, codeFileName, downloadText, slugify } from './code-download';

const NOW = new Date(2026, 9, 14, 16, 30);

describe('codeFileExtension', () => {
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
    ['yml', 'yaml'],
    ['ts', 'ts'],
    ['js', 'js'],
    ['py', 'py'],
    ['TypeScript', 'ts'],
    ['rust', 'txt'],
    ['C++', 'txt'],
  ])('%s → .%s', (language, ext) => {
    expect(codeFileExtension(language)).toBe(ext);
  });
});

describe('slugify', () => {
  it('drops accents, case and punctuation', () => {
    expect(slugify('Prompt: integração Keycloak!')).toBe('prompt-integracao-keycloak');
  });

  it('keeps it short and cuts at a word boundary', () => {
    const slug = slugify('uma primeira linha muito comprida que nunca acaba e continua por aí');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toBe('uma-primeira-linha-muito-comprida-que');
  });

  it('is empty when nothing usable is left', () => {
    expect(slugify('🚀 --- ###')).toBe('');
  });
});

describe('codeFileName', () => {
  it('names the file after the first non-empty line, the date and time, and the extension', () => {
    expect(codeFileName('\nPrompt de integração Keycloak\nlinha 2\n', 'text', NOW)).toBe('prompt-de-integracao-keycloak-2026-10-14-1630.txt');
  });

  it('gives bash, json and toml blocks their own extension', () => {
    expect(codeFileName('$ npm test\n', 'bash', NOW)).toBe('npm-test-2026-10-14-1630.sh');
    expect(codeFileName('{ "a": 1 }\n', 'json', NOW)).toBe('a-1-2026-10-14-1630.json');
    expect(codeFileName('[server]\n', 'toml', NOW)).toBe('server-2026-10-14-1630.toml');
  });

  it('falls back to "codigo" and never carries a character a filesystem refuses', () => {
    const name = codeFileName('/\\:*?"<>|\n', null, NOW);
    expect(name).toBe('codigo-2026-10-14-1630.txt');
    expect(codeFileName('a/b\\c:d*e?f"g<h>i|j', null, NOW)).toMatch(/^[a-z0-9-]+\.txt$/);
  });
});

describe('downloadText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clicks an <a download> on a UTF-8 Blob holding exactly the content', async () => {
    const blobs: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn((b: Blob) => (blobs.push(b), 'blob:x')), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });

    const content = 'linha 1\nlinha 2 ✅ 🚀\n';
    expect(downloadText('a.txt', content)).toBe(true);

    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('a.txt');
    expect(clicked[0].href).toBe('blob:x');
    expect(clicked[0].isConnected).toBe(false);
    expect(blobs[0].type).toBe('text/plain;charset=utf-8');
    // jsdom's own Blob, so read through its FileReader (Node's `Response` does not know it).
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blobs[0], 'utf-8');
    });
    expect(text).toBe(content);
  });

  it('says it failed instead of throwing when there is no Blob URL', () => {
    Object.defineProperty(URL, 'createObjectURL', { value: undefined, configurable: true });
    expect(downloadText('a.txt', 'x')).toBe(false);
  });
});
