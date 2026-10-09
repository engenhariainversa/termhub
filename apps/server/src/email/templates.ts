import { formatVerificationCode } from '@termhub/mobile-api';
import { DEFAULT_LOCALE, t, type Locale } from '../i18n/index.js';
import type { Mail } from './mailer.js';

// Every template takes the recipient's language (`users.locale`, null → pt-BR; before sign-in, the
// request's). The pt-BR text is the catalog key (locales/en/email.json holds the English, locales/es/email.json the Spanish).

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Fills `{{name}}` placeholders of an already escaped html string with ready-made html. */
function fill(html: string, parts: Record<string, string>): string {
  return html.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => parts[name] ?? whole);
}

/** Dates in e-mails are read in Brasília time, written the way the recipient's language writes them. */
const dateLocale = (locale: Locale) => ({ 'pt-BR': 'pt-BR', en: 'en-US', es: 'es' })[locale];

export function loginCodeMail(to: string, code: string, ttlMinutes: number, locale: Locale = DEFAULT_LOCALE): Mail {
  const subject = t(locale, '{{code}} — seu código de acesso ao termhub', { code });
  const ignore = t(locale, 'Se você não pediu este código, ignore este e-mail.');
  const text = `${t(locale, 'Seu código de acesso ao termhub é: {{code}}', { code })}\n\n${t(locale, 'Ele expira em {{minutes}} minutos.', { minutes: ttlMinutes })} ${ignore}`;
  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${esc(t(locale, 'Código de acesso'))}</title></head>
<body style="margin:0;padding:0;background:#0f1115;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1115;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#161920;border:1px solid #2a2f3a;border-radius:14px;">
        <tr><td style="padding:28px 32px 4px;text-align:center;font-size:18px;font-weight:700;color:#e6e8ee;"><span style="color:#4f8cff;">&#9646;</span> termhub</td></tr>
        <tr><td style="padding:12px 32px 20px;text-align:center;font-size:14px;color:#9aa1b1;">${esc(t(locale, 'Seu código de acesso é'))}</td></tr>
        <tr><td style="padding:0 32px;">
          <div style="background:rgba(79,140,255,0.08);border:1px solid rgba(79,140,255,0.25);border-radius:10px;padding:20px;text-align:center;">
            <span style="font-size:36px;font-weight:800;letter-spacing:10px;color:#4f8cff;font-family:'SF Mono',Menlo,Consolas,monospace;">${esc(code)}</span>
          </div>
        </td></tr>
        <tr><td style="padding:16px 32px 28px;text-align:center;font-size:12px;color:#6b7280;line-height:1.6;">
          ${esc(t(locale, 'Expira em {{minutes}} minutos.', { minutes: ttlMinutes }))}<br/>${esc(ignore)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { to, subject, html, text };
}

/** A phone asked to enrol on this account: the same facts as the web card, so the owner can
 * compare the code with the phone's screen before approving. */
export function deviceRequestMail(
  to: string,
  opts: { deviceLabel: string; code: string; place: string; ip: string; appUrl: string },
  locale: Locale = DEFAULT_LOCALE,
): Mail {
  const subject = t(locale, 'Um aparelho pede acesso à sua conta');
  const code = formatVerificationCode(opts.code);
  const link = `${opts.appUrl}/settings/devices`;
  const check = t(locale, 'Confira o código na tela do celular antes de aprovar. Se você não pediu isso, recuse.');
  const view = t(locale, 'Ver pedido');
  const text = [
    subject,
    '',
    t(locale, 'Aparelho: {{device}}', { device: opts.deviceLabel }),
    t(locale, 'Local: {{place}} (IP {{ip}})', { place: opts.place, ip: opts.ip }),
    t(locale, 'Código: {{code}}', { code }),
    '',
    check,
    '',
    `${view}: ${link}`,
  ].join('\n');
  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#0f1115;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1115;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#161920;border:1px solid #2a2f3a;border-radius:14px;">
        <tr><td style="padding:28px 32px 4px;text-align:center;font-size:18px;font-weight:700;color:#e6e8ee;"><span style="color:#4f8cff;">&#9646;</span> termhub</td></tr>
        <tr><td style="padding:12px 32px 8px;text-align:center;font-size:16px;font-weight:600;color:#e6e8ee;">${esc(subject)}</td></tr>
        <tr><td style="padding:0 32px 16px;text-align:center;font-size:13px;color:#9aa1b1;line-height:1.6;">
          ${esc(opts.deviceLabel)}<br/>${esc(opts.place)} · IP ${esc(opts.ip)}
        </td></tr>
        <tr><td style="padding:0 32px;">
          <div style="background:rgba(79,140,255,0.08);border:1px solid rgba(79,140,255,0.25);border-radius:10px;padding:20px;text-align:center;">
            <span style="font-size:36px;font-weight:800;letter-spacing:6px;color:#4f8cff;font-family:'SF Mono',Menlo,Consolas,monospace;">${esc(code)}</span>
          </div>
        </td></tr>
        <tr><td style="padding:16px 32px 8px;text-align:center;font-size:13px;color:#9aa1b1;line-height:1.6;">${esc(check)}</td></tr>
        <tr><td style="padding:12px 32px 28px;text-align:center;">
          <a href="${esc(link)}" style="display:inline-block;background:#4f8cff;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 24px;border-radius:10px;">${esc(view)}</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { to, subject, html, text };
}

/** A device was revoked after too many wrong PIN attempts (spec §6): which device, when, and that
 * nothing else on the account changed. Sent only for `pin_bruteforce` revocations. */
export function deviceRevokedMail(to: string, opts: { deviceLabel: string; at?: Date }, locale: Locale = DEFAULT_LOCALE): Mail {
  const subject = t(locale, 'Um aparelho foi removido da sua conta por tentativas de PIN');
  const when = (opts.at ?? new Date()).toLocaleString(dateLocale(locale), { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
  const what = t(locale, 'O PIN foi digitado errado vezes demais, então o aparelho foi desconectado e precisa ser cadastrado de novo para voltar a acessar.');
  const rest = t(locale, 'Nada mais foi alterado na sua conta: suas máquinas, projetos e os outros aparelhos continuam como estavam.');
  const text = `${subject}\n\n${t(locale, 'Aparelho: {{device}}', { device: opts.deviceLabel })}\n${t(locale, 'Quando: {{when}}', { when })}\n\n${what}\n\n${rest}`;
  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#0f1115;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1115;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#161920;border:1px solid #2a2f3a;border-radius:14px;">
        <tr><td style="padding:28px 32px 4px;text-align:center;font-size:18px;font-weight:700;color:#e6e8ee;"><span style="color:#4f8cff;">&#9646;</span> termhub</td></tr>
        <tr><td style="padding:12px 32px 8px;text-align:center;font-size:16px;font-weight:600;color:#e6e8ee;">${esc(subject)}</td></tr>
        <tr><td style="padding:0 32px 16px;text-align:center;font-size:13px;color:#9aa1b1;line-height:1.6;">
          ${esc(opts.deviceLabel)}<br/>${esc(when)}
        </td></tr>
        <tr><td style="padding:0 32px 8px;text-align:center;font-size:13px;color:#9aa1b1;line-height:1.6;">${esc(what)}</td></tr>
        <tr><td style="padding:8px 32px 28px;text-align:center;font-size:13px;color:#9aa1b1;line-height:1.6;">${esc(rest)}</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { to, subject, html, text };
}

/** Invite: the user already exists (created with the chosen role); they just need to sign in. */
export function inviteMail(
  to: string,
  opts: { invitedBy: string; appUrl: string; roleLabel: string; accessAllowlisted: boolean },
  locale: Locale = DEFAULT_LOCALE,
): Mail {
  const subject = t(locale, '{{name}} convidou você para o termhub', { name: opts.invitedBy });
  const howTo = t(locale, 'Entre com sua conta Google usando este mesmo e-mail, ou peça um código de acesso na tela de login.');
  const allowlisted = t(locale, 'Seu e-mail já foi liberado no Cloudflare Access; use-o na tela de identificação que aparece antes do app.');
  const ignore = t(locale, 'Se você não esperava este convite, ignore este e-mail.');
  const invitedAs = t(locale, '{{name}} convidou você para o termhub como {{role}}.');
  const text = `${fill(invitedAs, { name: opts.invitedBy, role: opts.roleLabel })}\n\n${t(locale, 'Acesse: {{url}}', { url: opts.appUrl })}\n\n${howTo}${
    opts.accessAllowlisted ? `\n\n${allowlisted}` : ''
  }\n\n${ignore}`;
  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${esc(t(locale, 'Convite para o termhub'))}</title></head>
<body style="margin:0;padding:0;background:#0f1115;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1115;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#161920;border:1px solid #2a2f3a;border-radius:14px;">
        <tr><td style="padding:28px 32px 4px;text-align:center;font-size:18px;font-weight:700;color:#e6e8ee;"><span style="color:#4f8cff;">&#9646;</span> termhub</td></tr>
        <tr><td style="padding:12px 32px 8px;text-align:center;font-size:14px;color:#e6e8ee;line-height:1.6;">
          ${fill(esc(invitedAs), { name: `<strong>${esc(opts.invitedBy)}</strong>`, role: `<strong>${esc(opts.roleLabel)}</strong>` })}
        </td></tr>
        <tr><td style="padding:12px 32px 20px;text-align:center;">
          <a href="${esc(opts.appUrl)}" style="display:inline-block;background:#4f8cff;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 24px;border-radius:10px;">${esc(t(locale, 'Acessar o termhub'))}</a>
        </td></tr>
        <tr><td style="padding:0 32px 8px;text-align:center;font-size:13px;color:#9aa1b1;line-height:1.6;">${esc(howTo)}</td></tr>
        ${
          opts.accessAllowlisted
            ? `<tr><td style="padding:0 32px 8px;text-align:center;font-size:12px;color:#9aa1b1;line-height:1.6;">${esc(allowlisted)}</td></tr>`
            : ''
        }
        <tr><td style="padding:16px 32px 28px;text-align:center;font-size:12px;color:#6b7280;line-height:1.6;">
          Link: <a href="${esc(opts.appUrl)}" style="color:#4f8cff;">${esc(opts.appUrl)}</a><br/>${esc(ignore)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { to, subject, html, text };
}

/** Links the landing's footer shows; mirrored at the bottom of the alpha e-mail. */
const REPO_URL = 'https://github.com/engenhariainversa/termhub';
const COFFEE_URL = 'https://buymeacoffee.com/pedrogoiania';

const ALPHA_COPY = {
  'pt-BR': {
    subject: 'Você está na alpha do termhub 🚀',
    hi: (name: string) => `Oi, ${name}!`,
    intro: 'Obrigado por entrar na waitlist do termhub Cloud. Chegou a sua vez: liberamos o seu acesso à alpha.',
    cta: 'Acessar o termhub',
    howTo: 'Entre com sua conta Google usando este mesmo e-mail, ou peça um código de acesso na tela de login.',
    communityTitle: 'Grupo dos alpha testers',
    communityBody: 'Criamos um grupo no WhatsApp para os alpha testers: é por lá que a gente combina o que testar, ouve seus feedbacks e avisa das novidades.',
    communityCta: 'Entrar no grupo do WhatsApp',
    link: 'Link',
    ignore: 'Se você não esperava este convite, ignore este e-mail.',
    footer: { docs: 'Documentação', brand: 'Marca', coffee: '☕ Buy me a coffee', made: 'feito em Goiânia' },
  },
  en: {
    subject: "You're in the termhub alpha 🚀",
    hi: (name: string) => `Hi, ${name}!`,
    intro: "Thanks for joining the termhub Cloud waitlist. It's your turn: your alpha access is now open.",
    cta: 'Open termhub',
    howTo: 'Sign in with your Google account using this same e-mail, or request an access code on the login screen.',
    communityTitle: 'Alpha testers group',
    communityBody: "There's a WhatsApp group for the alpha testers: that's where we decide what to test next, hear your feedback and share what's new.",
    communityCta: 'Join the WhatsApp group',
    link: 'Link',
    ignore: "If you weren't expecting this invite, ignore this e-mail.",
    footer: { docs: 'Documentation', brand: 'Brand', coffee: '☕ Buy me a coffee', made: 'made in Goiânia' },
  },
  es: {
    subject: 'Estás en la alpha de termhub 🚀',
    hi: (name: string) => `Hola, ${name}.`,
    intro: 'Gracias por unirte a la lista de espera de termhub Cloud. Llegó tu turno: ya tienes acceso a la alpha.',
    cta: 'Abrir termhub',
    howTo: 'Inicia sesión con tu cuenta de Google usando este mismo correo, o pide un código de acceso en la pantalla de inicio de sesión.',
    communityTitle: 'Grupo de alpha testers',
    communityBody: 'Creamos un grupo de WhatsApp para los alpha testers: ahí decidimos qué probar, escuchamos tus comentarios y avisamos de las novedades.',
    communityCta: 'Unirme al grupo de WhatsApp',
    link: 'Enlace',
    ignore: 'Si no esperabas esta invitación, ignora este correo.',
    footer: { docs: 'Documentación', brand: 'Marca', coffee: '☕ Buy me a coffee', made: 'hecho en Goiânia' },
  },
} as const;

/** The waitlist stores the landing's language as 'pt' | 'en' | 'es'; 'pt' is pt-BR here. */
export type AlphaLocale = 'pt' | 'en' | 'es';

/**
 * Alpha-tester invite sent to waitlist sign-ups: the user already exists (like inviteMail),
 * plus the WhatsApp community link. Written in the language the person used on the landing.
 */
export function alphaInviteMail(to: string, opts: { appUrl: string; communityUrl: string; firstName: string; locale: Locale | AlphaLocale }): Mail {
  const locale: Locale = opts.locale === 'en' || opts.locale === 'es' ? opts.locale : 'pt-BR';
  const c = ALPHA_COPY[locale];
  const year = new Date().getFullYear();
  const text = `${c.hi(opts.firstName)}\n\n${c.intro}\n\n${c.cta}: ${opts.appUrl}\n${c.howTo}\n\n${c.communityTitle}\n${c.communityBody}\n${c.communityCta}: ${opts.communityUrl}\n\n${c.ignore}\n\n© ${year} termhub · MIT · ${REPO_URL} · ${c.footer.made}`;
  const footerLink = (href: string, label: string) =>
    `<a href="${esc(href)}" style="color:#9aa1b1;text-decoration:none;white-space:nowrap;margin:0 8px;">${esc(label)}</a>`;
  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${esc(c.subject)}</title></head>
<body style="margin:0;padding:0;background:#0f1115;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1115;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#161920;border:1px solid #2a2f3a;border-radius:14px;">
        <tr><td style="padding:28px 32px 4px;text-align:center;font-size:18px;font-weight:700;color:#e6e8ee;"><span style="color:#4f8cff;">&#9646;</span> termhub</td></tr>
        <tr><td style="padding:12px 32px 8px;text-align:center;font-size:14px;color:#e6e8ee;line-height:1.6;">
          <strong>${esc(c.hi(opts.firstName))}</strong><br/>${esc(c.intro)}
        </td></tr>
        <tr><td style="padding:12px 32px 20px;text-align:center;">
          <a href="${esc(opts.appUrl)}" style="display:inline-block;background:#4f8cff;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 24px;border-radius:10px;">${esc(c.cta)}</a>
        </td></tr>
        <tr><td style="padding:0 32px 20px;text-align:center;font-size:13px;color:#9aa1b1;line-height:1.6;">${esc(c.howTo)}</td></tr>
        <tr><td style="padding:0 32px 8px;">
          <div style="background:rgba(37,211,102,0.08);border:1px solid rgba(37,211,102,0.3);border-radius:10px;padding:18px 20px;text-align:center;">
            <div style="font-size:14px;font-weight:700;color:#e6e8ee;margin-bottom:6px;">${esc(c.communityTitle)}</div>
            <div style="font-size:13px;color:#9aa1b1;line-height:1.6;margin-bottom:14px;">${esc(c.communityBody)}</div>
            <a href="${esc(opts.communityUrl)}" style="display:inline-block;background:#25d366;color:#0f1115;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:10px;">${esc(c.communityCta)}</a>
          </div>
        </td></tr>
        <tr><td style="padding:16px 32px 24px;text-align:center;font-size:12px;color:#6b7280;line-height:1.6;">
          ${esc(c.link)}: <a href="${esc(opts.communityUrl)}" style="color:#4f8cff;">${esc(opts.communityUrl)}</a><br/>${esc(c.ignore)}
        </td></tr>
        <tr><td style="padding:16px 32px 22px;border-top:1px solid #2a2f3a;font-size:11px;color:#6b7280;line-height:1.8;">
          <div style="text-align:center;">
            ${footerLink(REPO_URL, 'GitHub')}${footerLink(`${REPO_URL}/blob/main/README.md`, c.footer.docs)}${footerLink('https://termhub.dev/brand/', c.footer.brand)}${footerLink(COFFEE_URL, c.footer.coffee)}
          </div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:11px;color:#6b7280;">© ${year} termhub · MIT</td>
            <td style="font-size:11px;color:#6b7280;text-align:right;">${esc(c.footer.made)}</td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { to, subject: c.subject, html, text };
}

// ---------- account deletion (TER-720, TER-728) ----------

/** The date a deletion becomes final, as the person reads it (Brasília time, in their language). */
export function deletionDateLabel(at: Date, locale: Locale = DEFAULT_LOCALE): string {
  return at.toLocaleDateString(dateLocale(locale), { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'long', year: 'numeric' });
}

/** The card shared by the deletion e-mails: a title, plain paragraphs and an optional button. */
function noticeMail(locale: Locale, to: string, subject: string, paragraphs: string[], button?: { label: string; url: string }): Mail {
  const text = `${subject}\n\n${paragraphs.join('\n\n')}${button ? `\n\n${button.label}: ${button.url}` : ''}`;
  const rows = paragraphs
    .map((p) => `<tr><td style="padding:0 32px 12px;text-align:center;font-size:13px;color:#9aa1b1;line-height:1.6;">${esc(p)}</td></tr>`)
    .join('\n        ');
  const cta = button
    ? `<tr><td style="padding:8px 32px 8px;text-align:center;">
          <a href="${esc(button.url)}" style="display:inline-block;background:#4f8cff;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 24px;border-radius:10px;">${esc(button.label)}</a>
        </td></tr>`
    : '';
  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#0f1115;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1115;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#161920;border:1px solid #2a2f3a;border-radius:14px;">
        <tr><td style="padding:28px 32px 4px;text-align:center;font-size:18px;font-weight:700;color:#e6e8ee;"><span style="color:#4f8cff;">&#9646;</span> termhub</td></tr>
        <tr><td style="padding:12px 32px 16px;text-align:center;font-size:16px;font-weight:600;color:#e6e8ee;">${esc(subject)}</td></tr>
        ${rows}
        ${cta}
        <tr><td style="padding:0 0 20px;"></td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { to, subject, html, text };
}

/** The deletion was asked: the account is deactivated, and this is the date it goes for good. */
export function deletionRequestedMail(to: string, opts: { scheduledAt: Date; appUrl: string }, locale: Locale = DEFAULT_LOCALE): Mail {
  const date = deletionDateLabel(opts.scheduledAt, locale);
  return noticeMail(
    locale,
    to,
    t(locale, 'Recebemos o pedido de exclusão da sua conta'),
    [
      t(locale, 'Sua conta do termhub foi desativada e será excluída definitivamente em {{date}}.', { date }),
      t(
        locale,
        'Nessa data apagamos suas máquinas, projetos, cards, notas, chats, memória, integrações, tokens, aparelhos e anexos. Guardamos só o que a lei exige, como os registros de acesso (6 meses).',
      ),
      t(locale, 'Mudou de ideia? Entre no termhub até essa data e toque em "Cancelar exclusão".'),
      t(locale, 'Se não foi você que pediu, entre agora e cancele a exclusão.'),
    ],
    { label: t(locale, 'Entrar e cancelar a exclusão'), url: opts.appUrl },
  );
}

export function deletionCancelledMail(to: string, opts: { appUrl: string }, locale: Locale = DEFAULT_LOCALE): Mail {
  return noticeMail(locale, to, t(locale, 'A exclusão da sua conta foi cancelada'), [t(locale, 'Sua conta do termhub voltou ao normal. Nada foi apagado.')], {
    label: t(locale, 'Acessar o termhub'),
    url: opts.appUrl,
  });
}

/**
 * Sent after the deletion job ran: nothing is left to sign in to. `backupRetentionDays` (the
 * instance's database backup retention, TER-745) adds when the copies still in backups go.
 */
export function accountDeletedMail(to: string, opts: { backupRetentionDays?: number | null } = {}, locale: Locale = DEFAULT_LOCALE): Mail {
  return noticeMail(locale, to, t(locale, 'Sua conta do termhub foi excluída'), [
    t(locale, 'Concluímos a exclusão da sua conta e de todos os dados ligados a ela.'),
    ...(opts.backupRetentionDays
      ? [t(locale, 'As cópias de segurança do banco de dados que ainda têm esses dados são apagadas em até {{days}} dias.', { days: opts.backupRetentionDays })]
      : []),
    t(locale, 'Guardamos só o que a lei exige, como os registros de acesso (6 meses). Este é o último e-mail que você recebe do termhub.'),
  ]);
}

/** The public page's confirmation link (termhub.dev/excluir-conta): single use, short-lived. */
export function deletionLinkMail(to: string, opts: { link: string; ttlMinutes: number }, locale: Locale = DEFAULT_LOCALE): Mail {
  return noticeMail(
    locale,
    to,
    t(locale, 'Confirme a exclusão da sua conta do termhub'),
    [
      t(locale, 'Alguém pediu, na página de exclusão do termhub, para excluir a conta deste e-mail.'),
      t(
        locale,
        'Para confirmar, use o botão abaixo nos próximos {{minutes}} minutos. A conta fica desativada por 30 dias e depois é excluída definitivamente; até lá, entrar no termhub permite cancelar.',
        { minutes: opts.ttlMinutes },
      ),
      t(locale, 'Se não foi você, ignore este e-mail: nada muda na sua conta.'),
    ],
    { label: t(locale, 'Confirmar exclusão'), url: opts.link },
  );
}

/** "Exportar meus dados" (TER-741): the archive is ready; the button opens Perfil, where it downloads while signed in. */
export function dataExportReadyMail(to: string, opts: { url: string; expiresAt: Date }, locale: Locale = DEFAULT_LOCALE): Mail {
  return noticeMail(
    locale,
    to,
    t(locale, 'Seus dados do termhub estão prontos para baixar'),
    [
      t(locale, 'O arquivo que você pediu, com os dados da sua conta, está pronto.'),
      t(locale, 'Baixe pelo Perfil, com a sua conta aberta, até {{date}}. Depois disso o arquivo é apagado e você pode pedir outro.', { date: deletionDateLabel(opts.expiresAt, locale) }),
      t(locale, 'Se não foi você que pediu, troque sua senha e confira os aparelhos e tokens da conta.'),
    ],
    { label: t(locale, 'Baixar meus dados'), url: opts.url },
  );
}
