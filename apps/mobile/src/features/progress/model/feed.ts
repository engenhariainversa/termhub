// The sentence of one feed line (spec D25, §11). Same wording as the web's lib/automation-feed.ts: keep both in sync.
import { t } from '@/i18n';
import { formatTime } from '@/i18n/format';
import type { TAutomationFeedEvent } from '@/services/api/contract';

/** The line in the language the app shows, or null for a kind this app has no line for (one a newer server adds). */
export function feedLine(e: TAutomationFeedEvent): string | null {
  const ref = e.ref ?? t('um card');
  const pkg = e.workflow ?? t('pacote');
  switch (e.kind) {
    case 'run_started':
      if (!e.machine) return t('{{ref}} iniciado', { ref });
      return e.account ? t('{{ref}} iniciado em {{machine}} ({{account}})', { ref, machine: e.machine, account: e.account }) : t('{{ref}} iniciado em {{machine}}', { ref, machine: e.machine });
    case 'run_resumed':
      return t('{{ref}}: retomado', { ref });
    case 'run_done':
      return t('{{ref}}: agente terminou', { ref });
    case 'run_blocked':
      // a start that failed says why (TER-987)
      return e.reason_text ? t('{{ref}} não começou: {{reason}}', { ref, reason: e.reason_text }) : t('{{ref}}: parou e espera você', { ref });
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
      return e.version ? t('Publicado {{package}} {{version}}', { package: pkg, version: e.version }) : t('Publicado {{package}}', { package: pkg });
    case 'release_failed':
      return t('Publicação falhou ({{package}})', { package: pkg });
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
    case 'budget_warning':
      return t('Gasto do automático em 80% do orçamento diário');
    case 'ci_fix_requested':
      return t('{{ref}}: correção do CI pedida', { ref });
    case 'worktree_cleanup':
      return t('{{ref}}: pasta de trabalho limpa', { ref });
    case 'automation_on':
      return t('Automático ligado no projeto');
    case 'automation_off':
      return t('Automático desligado no projeto');
    case 'setup_changed':
      return t('Setup do automático alterado');
    case 'tagged':
      return t('{{ref}}: marcado como automático', { ref });
    case 'untagged':
      return t('{{ref}}: tirado do automático', { ref });
    case 'machine_opt_in':
      return e.machine ? t('{{machine}} passou a aceitar trabalho automático', { machine: e.machine }) : t('Uma máquina passou a aceitar trabalho automático');
    case 'machine_opt_out':
      return e.machine ? t('{{machine}} deixou de aceitar trabalho automático', { machine: e.machine }) : t('Uma máquina deixou de aceitar trabalho automático');
    default:
      return null;
  }
}
