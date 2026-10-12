// Every line the legal acceptance screen shows a person (TER-742). Getters: each read returns the
// current language.
import { t } from '@/i18n';
import { formatDate } from '@/i18n/format';
import type { TLegalVersion } from '@/services/api/contract';

/** "7 de outubro de 2026" / "October 7, 2026", in the phone's own time zone; `null` for an
 * unreadable date. */
export function effectiveDate(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return formatDate(d, { day: 'numeric', month: 'long', year: 'numeric' });
}

export const LEGAL_MSG = {
  get title() {
    return t('Termos de Uso e Política de Privacidade');
  },
  get intro() {
    return t('Para continuar usando o termhub, leia e aceite a versão em vigor dos documentos abaixo.');
  },
  documentName(document: TLegalVersion['document']): string {
    return document === 'terms' ? t('Termos de Uso') : t('Política de Privacidade');
  },
  versionSince: (version: string, date: string) => t('versão {{version}}, em vigor desde {{date}}', { version, date }),
  versionOnly: (version: string) => t('versão {{version}}', { version }),
  get open() {
    return t('Ler o documento');
  },
  /** The link's accessibility label, naming the document it opens. */
  openDocument: (name: string) => t('Ler {{name}}', { name }),
  get consent() {
    return t('Li e aceito os Termos de Uso e a Política de Privacidade');
  },
  get continue() {
    return t('Continuar');
  },
  get network() {
    return t('Não foi possível falar com o servidor. Tente de novo.');
  },
};
