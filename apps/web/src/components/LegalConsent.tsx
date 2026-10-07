import { Trans } from '../i18n';

const LINK_CLASS = 'font-medium text-accent hover:underline';

/**
 * "Li e aceito os Termos de Uso e a Política de Privacidade", with each name linking to its public
 * page (TER-742). Controlled: the caller keeps `checked` and decides what accepting means. Only the
 * documents that have a URL are named (a single versioned document is accepted alone). Used by the
 * acceptance page, and meant for the checkout (TER-681), which records the acceptance with the purchase.
 */
export function LegalConsent({
  termsUrl,
  privacyUrl,
  checked,
  onChange,
  disabled,
}: {
  termsUrl?: string;
  privacyUrl?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const link = (href: string, key: string) => <a key={key} href={href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS} />;

  let sentence;
  if (termsUrl && privacyUrl) {
    sentence = <Trans i18nKey="Li e aceito os <0>Termos de Uso</0> e a <1>Política de Privacidade</1>." components={[link(termsUrl, 't'), link(privacyUrl, 'p')]} />;
  } else if (termsUrl) {
    sentence = <Trans i18nKey="Li e aceito os <0>Termos de Uso</0>." components={[link(termsUrl, 't')]} />;
  } else if (privacyUrl) {
    sentence = <Trans i18nKey="Li e aceito a <0>Política de Privacidade</0>." components={[link(privacyUrl, 'p')]} />;
  } else {
    return null;
  }

  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm">
      <input type="checkbox" className="mt-0.5" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{sentence}</span>
    </label>
  );
}
