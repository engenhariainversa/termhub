import { i18n } from '../i18n';
import { formatTime } from './format';
import type { AutomationFeedEvent } from './types';

/**
 * The sentence of one feed line, in the language on screen (spec D25, §11), or null for a kind this app has
 * no line for (a kind a newer server adds). Same wording as the app's `features/progress/model/feed.ts`.
 */
export function feedLine(e: AutomationFeedEvent): string | null {
  const t = i18n.t.bind(i18n);
  const ref = e.ref ?? t('um card');
  const package_ = e.workflow ?? t('pacote');
  switch (e.kind) {
    case 'run_started':
      if (!e.machine) return t('{{ref}} iniciado', { ref });
      return e.account ? t('{{ref}} iniciado em {{machine}} ({{account}})', { ref, machine: e.machine, account: e.account }) : t('{{ref}} iniciado em {{machine}}', { ref, machine: e.machine });
    case 'run_resumed':
      return t('{{ref}}: retomado', { ref });
    case 'run_done':
      return t('{{ref}}: agente terminou', { ref });
    case 'run_blocked':
      return t('{{ref}}: parou e espera você', { ref });
    case 'question_answered':
      return t('{{ref}}: pergunta do agente respondida', { ref });
    case 'escalated':
      return t('{{ref}} precisa de você: {{reason}}', { ref, reason: e.reason_text ?? '' });
    case 'pr_opened':
      return t('{{ref}}: PR aberto', { ref });
    case 'merged':
      return e.branch ? t('{{ref}}: merge feito na {{branch}}', { ref, branch: e.branch }) : t('{{ref}}: merge feito', { ref });
    case 'merge_needs_approval':
      return t('{{ref}}: merge espera sua aprovação', { ref });
    case 'deploy_ok':
      return e.epic ? t('Deploy concluído ({{epic}})', { epic: e.epic }) : t('Deploy concluído');
    case 'deploy_failed': {
      const what = e.epic ? t('Deploy falhou ({{epic}})', { epic: e.epic }) : t('Deploy falhou');
      return e.paused === false ? what : t('{{what}} — automático pausado no projeto', { what });
    }
    case 'release_ok':
      return e.version ? t('Publicado {{package}} {{version}}', { package: package_, version: e.version }) : t('Publicado {{package}}', { package: package_ });
    case 'release_failed':
      return t('Publicação falhou ({{package}})', { package: package_ });
    case 'quota_hit': {
      const account = e.account ?? t('padrão');
      return e.until ? t('Conta {{account}} no limite até {{time}}', { account, time: formatTime(e.until) }) : t('Conta {{account}} no limite', { account });
    }
    case 'quota_reset':
      return t('Conta {{account}} voltou a funcionar', { account: e.account ?? t('padrão') });
    case 'paused':
      return t('Automático pausado');
    case 'resumed':
      return t('Automático retomado');
    case 'budget_hit':
      return t('Limite de gasto do automático atingido');
    case 'ci_fix_requested':
      return t('{{ref}}: correção do CI pedida', { ref });
    case 'worktree_cleanup':
      return t('{{ref}}: pasta de trabalho limpa', { ref });
    default:
      return null;
  }
}
