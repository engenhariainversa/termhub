# English translation (i18n) — design

Card: **TER-405**. Web (`@termhub/web`), server (`@termhub/server`: e-mails, API errors, push texts,
MCP/control messages), phone app (`@termhub/mobile`) and landing (`@termhub/landing`). Spanish
(TER-406) is out of scope, but nothing here may make it harder: a third language is one more
catalog file per app.

Read from the code at `5f6bffec`.

## 1. Problem

All product copy is hard-coded pt-BR: about 120 web files, 100 phone files, eight of the nine
e-mails, about 400 server error messages and the control-layer refusals that MCP tools return. The
landing is the exception: `apps/landing/src/i18n.ts` already has pt/en dictionaries, and the
waitlist stores the sign-up's locale (`pt` | `en`), which the alpha invite e-mail already uses.
Someone who does not read Portuguese can sign up on the landing in English and then lands in an
app they cannot read.

## 2. Decisions

| Topic | Decision | Why |
|---|---|---|
| Languages | `pt-BR` (source and fallback) and `en`. | The card. Spanish later (TER-406). |
| Library, web and phone | `i18next` + `react-i18next`. | Plain JS, so the phone gets it over OTA (no native module, no new store build). Same API on both apps; plurals and interpolation built in. |
| Library, server | A small `t(locale, text, vars)` over the same catalog format, no dependency. | The server only looks strings up and interpolates; e-mails and errors need nothing more. |
| Library, landing | Keep its own `i18n.ts`. | It works, it is static, and moving it buys nothing. |
| Keys | **The pt-BR text is the key** (`t('Salvar alterações')`, `t('{{n}} abas abertas', { n })`), i18next with `keySeparator: false`, `nsSeparator: false`. Catalogs hold only the other languages. | pt-BR is the product language and stays readable in the code; a missing English entry falls back to the pt-BR text instead of showing a key; existing tests that query Portuguese text keep working; a reviewer sees what the screen says. |
| Plurals | `count` with i18next plural suffixes. A plural key has entries in **both** `pt-BR` and `en` catalogs (`"{{count}} abas_one": "{{count}} aba"`). | The bare key is only right for one form. |
| Catalog files | `src/locales/<lang>/<area>.json` per app, merged at load (one area per folder of the source tree). | Areas are translated in parallel PRs without conflicts on one big file. |
| Extraction and check | `npm run i18n:check -w <app>`: a script scans `t('…')` / `t("…")` / `t(\`…\`)` literal keys and fails when an English entry is missing, when its `{{placeholders}}` differ from the key's, or when a catalog entry is no longer used. It runs as a unit test, so CI catches it. A label kept in a table or constant is marked with `tk('Perfil')` (returns its argument unchanged, so the script finds it) and translated where it is shown with `t(section.label)`; any other `t(variable)` is a bug. | Translation drift is caught before merge, not in production. |
| Untranslated copy guard | The same script flags JSX text and the `title`, `placeholder`, `aria-label`, `alt`, `label` attributes that hold letters outside `t()`. It runs on the folders already translated (a list in the script) and on every folder at the end. | Keeps new screens from coming back in pt only. |
| Where the choice lives | `users.locale` (`text`, nullable, `'pt-BR' \| 'en'`; null = automatic), returned by `/auth/me` and set by `PATCH /auth/me/locale { locale }` (next to `PATCH /auth/me/nickname`). The web also keeps it in `localStorage` (`termhub:locale`) for the login screen. The phone keeps its own choice in MMKV. | E-mails and push texts are sent when no browser is around, so the server must know. Same per-user pattern as `chat_suggestions`. |
| Detection (web and phone) | Explicit choice (account, else device storage) → the system/browser languages in order: first `pt*` → `pt-BR`, first `en*` → `en` → `pt-BR`. | The card: fallback pt-BR. A Spanish browser reads Portuguese better than English until TER-406. |
| Phone's system language | `Intl.DateTimeFormat().resolvedOptions().locale` (Hermes). No `expo-localization`. | A native module would need a new binary (`expo.version` bump and store build); this ships over OTA. |
| Server's language for a request | `users.locale` of the signed-in user → `Accept-Language` → `pt-BR`. The web and the phone send `Accept-Language` with the language they show. | Before login (login code, waitlist) only the header exists. |
| E-mails | Every template takes a `locale`; all nine ship in both languages. The alpha invite keeps the waitlist locale (`pt` → `pt-BR`). | Login code and invite are the first thing a new person reads. |
| API errors | The error handler translates `error` through the server catalog with the request's language. Messages with values become `HttpError(status, msg('Projeto {{name}} não existe', { name }), code)`, translated at reply time. `code` stays stable for clients. | ~400 throw sites keep their pt text as the key; only the handler and the dynamic ones change. |
| MCP and control messages | `ControlError` messages go through the same catalog with the caller's language. Tool descriptions stay in English as they are (they are read by models). | "Onde fizer sentido": refusals reach people through the concierge; descriptions are not product copy. |
| Push texts | Built with the recipient's `users.locale` (null → `pt-BR`). Stored notifications keep the language they were sent in. | No request at send time. History is not re-translated. |
| Dates and numbers | One helper per app (`formatDate`, `formatDateTime`, `formatTime`, `relativeTime`) using the current language; no `'pt-BR'` literal left in `toLocale*`/`Intl`. | 49 web and 47 phone call sites hard-code `pt-BR`. |
| `<html lang>` | The web sets `document.documentElement.lang` on every change; the landing does the same and gets `hreflang` alternates (`?lang=en`). | Screen readers and crawlers. |
| Terminal content, agent CLI, machine-ops scripts | Untouched. | Not product copy shown by termhub, or output of tools on the machine. |
| Settings UI | Web: Configurações → Perfil → "Idioma": Automático / Português (Brasil) / English. Phone: Ajustes → Idioma, same three. Each option is written in its own language. | Someone who cannot read the current language must still find their own. |
| Copy rule in CLAUDE.md | Rewritten: pt-BR is the source language; every UI string goes through `t()` with the pt-BR text as key, and the English entry is added in the same PR. | The old rule ("UI copy stays in Portuguese") forbade exactly this. |

## 3. Shapes

```ts
// apps/web/src/i18n/index.ts (the phone has the same file)
export type Locale = 'pt-BR' | 'en';
export const LOCALES: Locale[] = ['pt-BR', 'en'];
export function resolveLocale(choice: Locale | null, systemLanguages: readonly string[]): Locale;
export function setLocale(next: Locale | null): void; // null = automatic; persists and changes i18next
export const tk = <T extends string>(text: T): T => text; // marks a pt-BR key kept in data
export { useTranslation } from 'react-i18next';

// apps/server/src/i18n/index.ts
export type Locale = 'pt-BR' | 'en';
export function t(locale: Locale, text: string, vars?: Record<string, string | number>): string;
export function msg(text: string, vars?: Record<string, string | number>): LocalizedText; // lazy, for HttpError/ControlError
export function requestLocale(request: FastifyRequest): Locale; // user → Accept-Language → pt-BR
```

Migration: `ALTER TABLE users ADD COLUMN locale text` (nullable, no default). Backward compatible:
the old container never reads it.

## 4. Delivery (one PR per area, each with tests and `i18n:check` green)

1. **Spec** (this file).
2. **Server**: `users.locale` + `/auth/me` + `PATCH /auth/me/locale`; `i18n` module and catalog check; translated error handler, `msg()` for dynamic errors; e-mails in both languages; push texts; control/MCP refusals.
3. **Web foundation**: the CLAUDE.md copy rule (from here on every new string goes through `t()`), i18next setup, detection, `Accept-Language`, date helpers, the "Idioma" setting, `i18n:check` with the guard, and the shell (layout, sidebar, login, settings).
4. **Web screens**: the remaining pages and components, by area, until the guard covers every folder.
5. **Phone**: same foundation and every screen; OTA publish (JS only, no `expo.version` bump).
6. **Landing**: `<html lang>`, `hreflang`, and any copy still outside `i18n.ts`.

## 5. Testing

- Unit: `resolveLocale` (choice, `pt-PT` → `pt-BR`, `en-GB` → `en`, `es` → `pt-BR`), server `t`/`msg`/`requestLocale`, each e-mail in both languages, the error handler in both languages.
- `i18n:check` as a test in each app.
- Existing tests run in `pt-BR` (the test setup pins it), so they keep querying Portuguese text; a few new tests render key screens in `en`.

## 6. Glossary (pt-BR → en)

One word per concept across web, phone, e-mails and server, so translators in parallel PRs agree.
Product and proper names stay as they are: termhub, Claude, Codex, Cursor, tmux, concierge (lowercase in copy, "Concierge" at the start of a sentence), termhub Cloud, TypeToAccess.

| pt-BR | en |
|---|---|
| Máquina(s) | Machine(s) |
| Projeto(s) | Project(s) |
| aba / tab | tab |
| card / cartão | card |
| quadro | board |
| backlog | backlog |
| A fazer / Fazendo / Feito | To do / In progress / Done |
| épico, história, tarefa, bug, spike, subtarefa | epic, story, task, bug, spike, subtask |
| Configurações (web) / Ajustes (phone) | Settings |
| Perfil | Profile |
| Minha cidade / cidade | My city / city |
| Integrações | Integrations |
| Tokens de API | API tokens |
| Aparelho(s) | Device(s) |
| Permissões do chat | Chat permissions |
| Contas de IA | AI accounts |
| Usuários / Convidar | Users / Invite |
| Papéis / Roles | Roles |
| Arquivos | Files |
| Memória do chat | Chat memory |
| Progresso | Progress |
| Notificações | Notifications |
| Favoritos | Favorites |
| agente (Claude/Codex numa aba) | agent |
| agent (termhub-agent na máquina) | agent (termhub agent when ambiguous) |
| monitor das tabs | tab monitor |
| pedido de permissão / aprovação | permission request / approval |
| pergunta (da aba) | question |
| aguardando você | waiting for you |
| Entrar / Sair | Sign in / Sign out |
| código de acesso | sign-in code |
| PIN | PIN |
| lista de espera | waitlist |
| Excluir conta | Delete account |
| Salvar / Cancelar / Excluir / Fechar | Save / Cancel / Delete / Close |
| Reconectando… | Reconnecting… |

Tone: short, plain, sentence case, no exclamation marks, "you" for the person. Keep the pt-BR punctuation marks that carry meaning (… for ongoing actions).

## 7. Impact on other users

- People whose browser or phone is set to English see termhub in English after the deploy (automatic is the default). Everyone else, including other languages, keeps pt-BR. Anyone can pin a language in Settings / Ajustes, per user (web, also used for e-mails and push) or per device (phone).
- E-mails and push notifications follow the account's language; with none chosen they stay in pt-BR.
- API error `code`s do not change; only the `error` text follows the request's language.
- No setting is removed and no data changes; the new column is null for everyone.

## 8. Spanish (TER-406)

Spanish (`es`) is the third language, added the way §2 planned: one more catalog file per area in
each app (`src/locales/es/<area>.json`, server `src/i18n/locales/es/<area>.json`, same keys as `en`),
a `Español` option in Configurações → Perfil → Idioma and Ajustes → Idioma, and an `es` dictionary
in the landing (`?lang=es`, `hreflang="es"`).

- `users.locale` accepts `'es'`; the waitlist stores `'es'` from the landing and the alpha invite
  goes out in Spanish. No migration: both columns are `text`.
- Detection: `es*` (browser, phone, `Accept-Language`) → `es`, in the same first-match order as
  `pt*`/`en*`. Other languages still read pt-BR.
- `i18n:check` in every app requires an `es` entry for every key, as it does for `en`.
- Spanish has a CLDR `many` plural form (a million and up); the catalogs give `_one`/`_other`, and
  `_many` reads `_other` (web and phone fill it at load; the server falls back to `_other`).
- A failed automatic start keeps its reason in `message`, `message_en` and `message_es`; older
  events without `message_es` show the pt-BR text.
- Tone: neutral Latin-American Spanish, **tú**, sentence case, no ¡!, opening ¿ on questions.

Glossary (pt-BR → en → es):

| pt-BR | en | es |
|---|---|---|
| Máquina(s) | Machine(s) | Máquina(s) |
| Projeto(s) | Project(s) | Proyecto(s) |
| aba / tab | tab | pestaña |
| card / cartão | card | tarjeta |
| quadro | board | tablero |
| backlog | backlog | backlog |
| A fazer / Fazendo / Feito | To do / In progress / Done | Por hacer / En curso / Hecho |
| épico, história, tarefa, bug, spike, subtarefa | epic, story, task, bug, spike, subtask | épica, historia, tarea, bug, spike, subtarea |
| coluna | column | columna |
| Configurações (web) / Ajustes (phone) | Settings | Configuración (web) / Ajustes (teléfono) |
| Perfil | Profile | Perfil |
| Minha cidade / cidade | My city / city | Mi ciudad / ciudad |
| escritório | office | oficina |
| Integrações | Integrations | Integraciones |
| Tokens de API | API tokens | Tokens de API |
| Aparelho(s) | Device(s) | Dispositivo(s) |
| Permissões do chat | Chat permissions | Permisos del chat |
| Contas de IA | AI accounts | Cuentas de IA |
| Usuários / Convidar | Users / Invite | Usuarios / Invitar |
| Papéis | Roles | Roles |
| Arquivos | Files | Archivos |
| Memória do chat | Chat memory | Memoria del chat |
| Progresso | Progress | Progreso |
| Notificações | Notifications | Notificaciones |
| Favoritos | Favorites | Favoritos |
| agente (Claude/Codex numa aba) | agent | agente |
| agent (termhub-agent na máquina) | agent | agente (agente de termhub cuando sea ambiguo) |
| monitor das tabs | tab monitor | monitor de pestañas |
| pedido de permissão / aprovação | permission request / approval | solicitud de permiso / aprobación |
| pergunta (da aba) | question | pregunta |
| aguardando você | waiting for you | esperándote |
| Entrar / Sair | Sign in / Sign out | Iniciar sesión / Cerrar sesión ("Entrar" as a short button) |
| código de acesso | sign-in code | código de acceso |
| lista de espera | waitlist | lista de espera |
| Excluir conta | Delete account | Eliminar cuenta |
| Salvar / Cancelar / Excluir / Fechar | Save / Cancel / Delete / Close | Guardar / Cancelar / Eliminar / Cerrar |
| Editar / Criar / Adicionar / Remover | Edit / Create / Add / Remove | Editar / Crear / Agregar / Quitar |
| Carregando… | Loading… | Cargando… |
| Reconectando… | Reconnecting… | Reconectando… |
| Tentar de novo | Try again | Reintentar |
| Copiar / Copiado | Copy / Copied | Copiar / Copiado |
| Enviar | Send | Enviar |
| sessão | session | sesión |
| conta | account | cuenta |
| convite | invite | invitación |
| token | token | token |
| ramo / branch | branch | rama |
| mesclar / merge | merge | fusionar (merge) |
| PR / pull request | pull request | pull request |
| implantar / deploy | deploy | despliegue / desplegar |
| versão / release | release | versión |
| rodar (um comando) | run | ejecutar |
| servidor | server | servidor |
| nuvem | cloud | nube |
| chave | key | clave |
| senha | password | contraseña |
| arquivo | file | archivo |
| pasta | folder | carpeta |
| tela | screen | pantalla |
| celular / telefone | phone | teléfono / celular |
| nota(s) | note(s) | nota(s) |
| automação | automation | automatización |
| fila | queue | cola |
| política | policy | política |
| lição | lesson | lección |

Impact on other users: people whose browser or phone is set to Spanish see termhub in Spanish
after the deploy instead of pt-BR (automatic is the default); anyone can pin a language in
Settings / Ajustes. Everyone else is unchanged.
