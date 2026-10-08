import { i18n } from '../i18n';
import { formatTime } from './format';
import type { AutomationFeedEvent } from './types';

/**
 * The sentence of one feed line, in the language on screen (spec D25, §11), or null for a kind this app has
 * no line for (a kind a newer server adds). Same wording as the app's `features/progress/model/feed.ts`.
 */
/** A tool name for the feed: an MCP tool shown as its bare name (`mcp__termhub__create_task` → `create_task`). */
function toolLabel(tool: string | null): string | null {
  if (!tool) return null;
  const m = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(tool);
  return m ? m[1]! : tool;
}

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
      // a blocked run a PR from its branch took over says so (TER-1049)
      return e.reason_text ? t('{{ref}}: {{reason}}', { ref, reason: e.reason_text }) : t('{{ref}}: agente terminou', { ref });
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
    case 'deploy_retried':
      return t('Deploy falhou por problema do GitHub; rodando de novo');
    case 'github_wait':
      return t('{{ref}}: erro do GitHub; o termhub tenta de novo quando ele voltar', { ref });
    case 'trust_auto_accepted':
      return t('{{ref}}: confiança da pasta confirmada sozinha', { ref });
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
    case 'budget_warning':
      return t('Gasto do automático em 80% do orçamento diário');
    case 'ci_fix_requested':
      return t('{{ref}}: correção do CI pedida', { ref });
    case 'worktree_cleanup':
      return t('{{ref}}: pasta de trabalho limpa', { ref });
    case 'permission_auto_approved': {
      const tool = toolLabel(e.tool);
      return tool ? t('{{ref}}: {{tool}} liberado sozinho', { ref, tool }) : t('{{ref}}: permissão liberada sozinha', { ref });
    }
    case 'guard_blocked': {
      const tool = toolLabel(e.tool);
      return tool ? t('{{ref}}: {{tool}} bloqueado pela trava', { ref, tool }) : t('{{ref}}: ação bloqueada pela trava', { ref });
    }
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
