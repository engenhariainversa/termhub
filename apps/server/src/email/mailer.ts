import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** SMTP real (Mailpit em dev, Mailgun/SES/etc. em prod). */
class SmtpMailer implements Mailer {
  private transporter: Transporter;
  constructor(smtp: NonNullable<typeof config.email.smtp>) {
    this.transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.auth,
    });
  }
  async send(mail: Mail): Promise<void> {
    await this.transporter.sendMail({ from: config.email.from, ...mail });
  }
}

export interface MailerLog {
  info(msg: string): void;
  error(msg: string): void;
}

export interface MailerOptions {
  smtp: typeof config.email.smtp;
  isProd: boolean;
  /** EMAIL_DEV_CONSOLE: print e-mails to the log instead of sending them. Ignored in production. */
  devConsole: boolean;
}

/** `pedro@example.com` → `p***@example.com`: enough to tell recipients apart, not to identify one. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * Explicit development mode (EMAIL_DEV_CONSOLE=true, never in production): prints the whole e-mail,
 * login code included, to the log instead of sending it.
 */
class ConsoleMailer implements Mailer {
  constructor(private log: MailerLog) {}
  async send(mail: Mail): Promise<void> {
    this.log.info(`\n===== E-MAIL (EMAIL_DEV_CONSOLE) =====\nPara: ${mail.to}\nAssunto: ${mail.subject}\n\n${mail.text}\n======================================\n`);
  }
}

/**
 * No SMTP and no dev console: every send fails (callers already treat a failed send as such) and
 * the log only says that an e-mail to a masked recipient was dropped. Never the subject or the body:
 * the login code is in both.
 */
class UnconfiguredMailer implements Mailer {
  constructor(private log: MailerLog, private hint: string) {}
  async send(mail: Mail): Promise<void> {
    this.log.error(`e-mail para ${maskEmail(mail.to)} não enviado: ${this.hint}`);
    throw new Error('E-mail não enviado: SMTP não configurado');
  }
}

export function createMailer(
  log: MailerLog,
  opts: MailerOptions = { smtp: config.email.smtp, isProd: config.isProd, devConsole: config.email.devConsole },
): Mailer {
  if (opts.smtp) return new SmtpMailer(opts.smtp);
  if (opts.devConsole && !opts.isProd) return new ConsoleMailer(log);
  const hint = opts.isProd
    ? 'SMTP_HOST não configurado'
    : 'SMTP_HOST não configurado (em desenvolvimento, EMAIL_DEV_CONSOLE=true imprime os e-mails no log)';
  log.error(`${hint}: nenhum e-mail será enviado (código de login, convites, avisos de aparelho).`);
  return new UnconfiguredMailer(log, hint);
}
