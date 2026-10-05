import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain Node script, no type declarations
import { runCheck, scanSource } from '../../scripts/i18n-check.mjs';

const scan = (code: string, guarded = true): { keys: { key: string }[]; problems: string[] } => scanSource('x.tsx', code, { guarded });

describe('npm run i18n:check', () => {
  it('passes on this checkout: every key has its English entry, every entry is used, guarded files hold no bare copy', () => {
    const { problems } = runCheck();
    expect(problems).toEqual([]);
  });
});

describe('key extraction', () => {
  it('finds t(), i18n.t(), tk() and <Trans i18nKey> literal keys', () => {
    const { keys } = scan(`
      const a = t('Um');
      const b = i18n.t("Dois", { n: 1 });
      const c = t(\`Três\`);
      const d = tk('Quatro');
      const e = <Trans i18nKey="Cinco <0>{{x}}</0>" />;
    `);
    expect(keys.map((k) => k.key)).toEqual(['Um', 'Dois', 'Três', 'Quatro', 'Cinco <0>{{x}}</0>']);
  });

  it('refuses a key built with ${}', () => {
    expect(scan('const a = t(`Olá ${nome}`);').problems).toHaveLength(1);
  });
});

describe('untranslated-copy guard', () => {
  it('flags JSX text and copy attributes outside t()', () => {
    const { problems } = scan(`
      const A = () => (
        <div title="Título" aria-label={ok ? 'Sim' : t('Não')}>
          Texto solto
          {busy ? 'Salvando…' : t('Salvar')}
          <input placeholder={\`Nome de \${x}\`} />
        </div>
      );
    `);
    expect(problems.map((p) => p.replace(/^x\.tsx:\d+: /, ''))).toEqual([
      'title= outside t(): "Título"',
      'aria-label= outside t(): "Sim"',
      'JSX text outside t(): "Texto solto"',
      'JSX text outside t(): "Salvando…"',
      'placeholder= outside t(): "Nome de"',
    ]);
  });

  it('leaves symbols, class names, comparisons and translated text alone', () => {
    const { problems } = scan(`
      const A = () => (
        <div className="flex gap-2" title={t('Ok')}>
          ✕ … — 42
          {step === 'code' ? <b>{t('Código')}</b> : null}
          {cn('text-sm', x)}
        </div>
      );
    `);
    expect(problems).toEqual([]);
  });

  it('allows a literal marked i18n-ignore on its line or the line above', () => {
    const { problems } = scan(`
      const A = () => (
        <h1>
          termhub {/* i18n-ignore */}
          {/* i18n-ignore: the brand */}
          <span title="termhub" />
        </h1>
      );
    `);
    expect(problems).toEqual([]);
  });

  it('does not look at files outside GUARDED', () => {
    expect(scan('const A = () => <p>Texto</p>;', false).problems).toEqual([]);
  });
});
