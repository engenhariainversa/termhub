// Every catalog, merged statically (Metro bundles them; no dynamic require). One file per area of
// the source tree (i18n spec §2), so areas are translated in parallel without conflicts. pt-BR files
// hold only plural forms: every other pt-BR text is its own key.
import type { Resource } from 'i18next';
import en_app from '@/locales/en/app.json';
import en_aiLogin from '@/locales/en/ai-login.json';
import en_ui from '@/locales/en/ui.json';
import en_account from '@/locales/en/account.json';
import en_chat from '@/locales/en/chat.json';
import en_chatView from '@/locales/en/chat-view.json';
import en_chatGrants from '@/locales/en/chat-grants.json';
import en_filePreview from '@/locales/en/file-preview.json';
import en_fileRecent from '@/locales/en/file-recent.json';
import en_home from '@/locales/en/home.json';
import en_notifications from '@/locales/en/notifications.json';
import en_permissions from '@/locales/en/permissions.json';
import en_automation from '@/locales/en/automation.json';
import en_progress from '@/locales/en/progress.json';
import en_projectAi from '@/locales/en/project-ai.json';
import en_session from '@/locales/en/session.json';
import en_settings from '@/locales/en/settings.json';
import en_shared from '@/locales/en/shared.json';
import en_tabChat from '@/locales/en/tab-chat.json';
import en_services from '@/locales/en/services.json';
import es_app from '@/locales/es/app.json';
import es_aiLogin from '@/locales/es/ai-login.json';
import es_ui from '@/locales/es/ui.json';
import es_account from '@/locales/es/account.json';
import es_chat from '@/locales/es/chat.json';
import es_chatView from '@/locales/es/chat-view.json';
import es_chatGrants from '@/locales/es/chat-grants.json';
import es_filePreview from '@/locales/es/file-preview.json';
import es_fileRecent from '@/locales/es/file-recent.json';
import es_home from '@/locales/es/home.json';
import es_notifications from '@/locales/es/notifications.json';
import es_permissions from '@/locales/es/permissions.json';
import es_automation from '@/locales/es/automation.json';
import es_progress from '@/locales/es/progress.json';
import es_projectAi from '@/locales/es/project-ai.json';
import es_session from '@/locales/es/session.json';
import es_settings from '@/locales/es/settings.json';
import es_shared from '@/locales/es/shared.json';
import es_tabChat from '@/locales/es/tab-chat.json';
import es_services from '@/locales/es/services.json';
import pt_app from '@/locales/pt-BR/app.json';
import pt_aiLogin from '@/locales/pt-BR/ai-login.json';
import pt_ui from '@/locales/pt-BR/ui.json';
import pt_account from '@/locales/pt-BR/account.json';
import pt_chat from '@/locales/pt-BR/chat.json';
import pt_chatView from '@/locales/pt-BR/chat-view.json';
import pt_chatGrants from '@/locales/pt-BR/chat-grants.json';
import pt_filePreview from '@/locales/pt-BR/file-preview.json';
import pt_fileRecent from '@/locales/pt-BR/file-recent.json';
import pt_home from '@/locales/pt-BR/home.json';
import pt_notifications from '@/locales/pt-BR/notifications.json';
import pt_permissions from '@/locales/pt-BR/permissions.json';
import pt_automation from '@/locales/pt-BR/automation.json';
import pt_progress from '@/locales/pt-BR/progress.json';
import pt_projectAi from '@/locales/pt-BR/project-ai.json';
import pt_session from '@/locales/pt-BR/session.json';
import pt_settings from '@/locales/pt-BR/settings.json';
import pt_shared from '@/locales/pt-BR/shared.json';
import pt_tabChat from '@/locales/pt-BR/tab-chat.json';
import pt_services from '@/locales/pt-BR/services.json';

type Catalog = Record<string, string>;

/** The `en` catalogs, by area (`i18n:check` reads the same files). */
export const EN_AREAS: Record<string, Catalog> = {
  'app': en_app,
  'ui': en_ui,
  'account': en_account,
  'ai-login': en_aiLogin,
  'chat': en_chat,
  'chat-view': en_chatView,
  'chat-grants': en_chatGrants,
  'file-preview': en_filePreview,
  'file-recent': en_fileRecent,
  'home': en_home,
  'notifications': en_notifications,
  'permissions': en_permissions,
  'automation': en_automation,
  'progress': en_progress,
  'project-ai': en_projectAi,
  'session': en_session,
  'settings': en_settings,
  'shared': en_shared,
  'tab-chat': en_tabChat,
  'services': en_services,
};

/** The `es` catalogs, by area. */
export const ES_AREAS: Record<string, Catalog> = {
  'app': es_app,
  'ui': es_ui,
  'account': es_account,
  'ai-login': es_aiLogin,
  'chat': es_chat,
  'chat-view': es_chatView,
  'chat-grants': es_chatGrants,
  'file-preview': es_filePreview,
  'file-recent': es_fileRecent,
  'home': es_home,
  'notifications': es_notifications,
  'permissions': es_permissions,
  'automation': es_automation,
  'progress': es_progress,
  'project-ai': es_projectAi,
  'session': es_session,
  'settings': es_settings,
  'shared': es_shared,
  'tab-chat': es_tabChat,
  'services': es_services,
};

/** The `pt-BR` catalogs (plural forms only), by area. */
export const PT_AREAS: Record<string, Catalog> = {
  'app': pt_app,
  'ui': pt_ui,
  'account': pt_account,
  'ai-login': pt_aiLogin,
  'chat': pt_chat,
  'chat-view': pt_chatView,
  'chat-grants': pt_chatGrants,
  'file-preview': pt_filePreview,
  'file-recent': pt_fileRecent,
  'home': pt_home,
  'notifications': pt_notifications,
  'permissions': pt_permissions,
  'automation': pt_automation,
  'progress': pt_progress,
  'project-ai': pt_projectAi,
  'session': pt_session,
  'settings': pt_settings,
  'shared': pt_shared,
  'tab-chat': pt_tabChat,
  'services': pt_services,
};

const merge = (areas: Record<string, Catalog>): Catalog => Object.assign({}, ...Object.values(areas)) as Catalog;

/**
 * Spanish has a `many` plural form (a million and up) where the catalogs give `_one`/`_other`: a
 * `_many` lookup reuses `_other` instead of falling back to the pt-BR text.
 */
function withManyForms(catalog: Catalog): Catalog {
  const out = { ...catalog };
  for (const [key, text] of Object.entries(catalog)) {
    if (!key.endsWith('_other')) continue;
    const many = `${key.slice(0, -'_other'.length)}_many`;
    if (!(many in out)) out[many] = text;
  }
  return out;
}

export const resources: Resource = {
  en: { translation: merge(EN_AREAS) },
  es: { translation: withManyForms(merge(ES_AREAS)) },
  'pt-BR': { translation: merge(PT_AREAS) },
};
