import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Linking, ScrollView, Share, Text, View } from 'react-native';
import Markdown, { type RenderRules } from 'react-native-markdown-display';
import { markdownStyle } from '@/features/chat/view/markdown-style';
import { sendFileToChat } from '@/features/chat/model/chat-inbox';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { t, useTranslation } from '@/i18n';
import { api } from '@/services/api';
import type { TFilePreviewOk, TFilePreviewQuery } from '@/services/api/contract';
import { AppText, Banner, Button, Screen, useSchemeName } from '@/ui';
import { filePreviewRoute } from '../model/md-paths';
import { dirOf, fileLinkTarget } from '../model/refusals';
import { createFilePreviewStore } from '../viewmodel/createFilePreviewStore';

const isMarkdown = (name: string) => /\.(?:md|markdown)$/i.test(name);
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;


/**
 * Markdown rules for a previewed file (spec 2026-10-04 file preview D13): an image is a tappable
 * "imagem: alt" that opens the browser only when tapped, never fetched by the screen.
 */
export const fileRules = (onImage: (src: string) => void): RenderRules => ({
  image: (node) => {
    const src = String(node.attributes.src ?? '');
    const alt = String(node.attributes.alt ?? '') || src;
    return (
      <Text key={node.key} accessibilityRole="link" className="text-app-accent underline" onPress={() => onImage(src)}>
        {t('imagem: {{alt}}', { alt })}
      </Text>
    );
  },
});

/** Where a link inside the file goes: a preview, the browser (http/https), or nowhere. False = handled here. */
export function onFileLink(url: string, dir: string, open: { file(path: string): void; web(url: string): void }): boolean {
  const target = fileLinkTarget(url, dir);
  if (target?.kind === 'file') open.file(target.path);
  else if (target?.kind === 'web') open.web(target.url);
  return false;
}

/** A Markdown file an agent wrote, read on its machine (spec 2026-10-04 file preview D15). */
export function FilePreviewScreen() {
  // Re-renders on a language change; the copy below reads `t` at render time.
  useTranslation();
  const router = useRouter();
  const scheme = useSchemeName();
  const params = useLocalSearchParams<{ path?: string; project_id?: string; tab_id?: string }>();
  const query: TFilePreviewQuery = useMemo(
    () => ({ path: one(params.path) ?? '', project_id: one(params.project_id), tab_id: one(params.tab_id) }),
    [params.path, params.project_id, params.tab_id],
  );
  const store = useMemo(() => createFilePreviewStore({ api, session: () => useSessionStore.getState(), query }), [query]);
  const state = store((s) => s.state);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (query.path) void store.getState().load();
  }, [store, query.path]);

  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)'));
  const openWeb = (url: string) => {
    if (/^https?:\/\//i.test(url)) void Linking.openURL(url);
  };
  const dir = dirOf(query.path);
  const openLink = (url: string) =>
    onFileLink(url, dir, {
      file: (path) => router.push(filePreviewRoute(path, { projectId: query.project_id, tabId: query.tab_id })),
      web: openWeb,
    });
  const rules = useMemo(() => fileRules(openWeb), []);

  const file: TFilePreviewOk | null = state.phase === 'ok' ? state.file : null;
  const share = () => {
    if (file) void Share.share({ title: file.name, message: file.content });
  };
  const toChat = async () => {
    if (!file) return;
    try {
      await sendFileToChat(file.project_id, file.name, file.content);
      router.push(`/chat/${file.project_id ?? 'general'}`);
    } catch {
      setNote(t('Não foi possível anexar o arquivo.'));
    }
  };

  const name = query.path.split('/').pop() || query.path;
  return (
    <Screen padded={false}>
      <View className="flex-row items-center gap-2 border-b border-app-border px-2 py-2">
        <Button label={t('Voltar')} variant="ghost" onPress={goBack} />
        <AppText variant="title" className="flex-1 text-xl" numberOfLines={1}>
          {name}
        </AppText>
        <Button label={t('Atualizar')} variant="ghost" disabled={state.phase === 'loading'} onPress={() => void store.getState().load()} />
      </View>
      {file ? (
        <View className="gap-1 border-b border-app-border px-4 py-2">
          <AppText variant="muted" className="text-xs" numberOfLines={2}>{`${file.path} · ${file.machine.name}`}</AppText>
          <View className="flex-row flex-wrap gap-2">
            <Button label={t('Compartilhar')} variant="secondary" onPress={share} />
            {file.github_url ? <Button label={t('Abrir no GitHub')} variant="secondary" onPress={() => openWeb(file.github_url!)} /> : null}
            <Button label={t('Mandar para o chat')} variant="secondary" onPress={() => void toChat()} />
          </View>
          {note ? <AppText variant="muted">{note}</AppText> : null}
        </View>
      ) : null}
      <ScrollView testID="file-preview-body" contentContainerClassName="px-4 py-3">
        {!query.path ? <Banner tone="danger" text={t('Nenhum arquivo indicado.')} /> : null}
        {query.path && state.phase === 'loading' ? <AppText variant="muted">{t('Abrindo arquivo…')}</AppText> : null}
        {state.phase === 'refused' ? <Banner tone={state.outdated ? 'info' : 'danger'} text={state.machine ? `${state.text} (${state.machine})` : state.text} /> : null}
        {file ? (
          isMarkdown(file.name) ? (
            <Markdown style={markdownStyle(scheme)} rules={rules} onLinkPress={openLink}>
              {file.content}
            </Markdown>
          ) : (
            <Text selectable className="font-mono text-sm text-app-text">
              {file.content}
            </Text>
          )
        ) : null}
      </ScrollView>
    </Screen>
  );
}
