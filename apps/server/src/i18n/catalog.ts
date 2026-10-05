// The catalogs, merged per language. One JSON file per area of the source tree (spec 2026-10-04 §2):
// adding a file under locales/<lang>/ means adding its import here (`npm run i18n:check` says so).
// pt-BR holds only the plural forms: every other pt-BR text is its own key.
import enAccount from './locales/en/account.json' with { type: 'json' };
import enAgent from './locales/en/agent.json' with { type: 'json' };
import enAuth from './locales/en/auth.json' with { type: 'json' };
import enChat from './locales/en/chat.json' with { type: 'json' };
import enControl from './locales/en/control.json' with { type: 'json' };
import enDb from './locales/en/db.json' with { type: 'json' };
import enEmail from './locales/en/email.json' with { type: 'json' };
import enIntegrations from './locales/en/integrations.json' with { type: 'json' };
import enMcp from './locales/en/mcp.json' with { type: 'json' };
import enMisc from './locales/en/misc.json' with { type: 'json' };
import enMobile from './locales/en/mobile.json' with { type: 'json' };
import enRoutes from './locales/en/routes.json' with { type: 'json' };
import enTerminal from './locales/en/terminal.json' with { type: 'json' };
import ptBRControl from './locales/pt-BR/control.json' with { type: 'json' };
import type { Locale } from './index.js';

type Catalog = Record<string, string>;
const merge = (...parts: Catalog[]): Catalog => Object.assign({}, ...parts);

export const CATALOGS: Record<Locale, Catalog> = {
  'pt-BR': merge(ptBRControl),
  en: merge(enAccount, enAgent, enAuth, enChat, enControl, enDb, enEmail, enIntegrations, enMcp, enMisc, enMobile, enRoutes, enTerminal),
};
