import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, TextInput, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Banner, Button, Screen } from '@/ui';
import { accountLine, AI_LOGIN_MSG, manualLine, redoesLogin, resumedLine, resumeQuestion } from '../model/ai-login';
import { makeAiLoginFlow } from '../viewmodel/deps';
import { useAiLoginStore } from '../viewmodel/useAiLoginStore';

const INPUT = 'rounded-xl border border-app-border bg-app-surface px-4 py-3 text-base text-app-text placeholder:text-app-muted';

/**
 * "Refazer login" (TER-1047, spec 2026-10-08 §2), a modal over the app: the machine runs the CLI's login
 * in a hidden session, the phone opens its page; Claude's code is pasted back here, Codex's device code is
 * typed on that page. The CLI may also finish on the machine itself, in its own browser (TER-1054): the
 * start then ends logged in, or "Já entrei pelo navegador da máquina" checks without a code. Leaving
 * before the end cancels the flow on the machine.
 */
export function AiLoginView({ accountId }: { accountId: string }) {
  // Re-renders on a language change (the copy is read through getters).
  useTranslation();
  const router = useRouter();
  const accounts = useAiLoginStore((s) => s.accounts);
  const loaded = useAiLoginStore((s) => s.loaded);
  const loading = useAiLoginStore((s) => s.loading);
  const load = useAiLoginStore((s) => s.load);
  const row = accounts.find((a) => a.account_id === accountId) ?? null;

  const [flow] = useState(() => makeAiLoginFlow(accountId));
  const phase = flow((s) => s.phase);
  const login = flow((s) => s.login);
  const error = flow((s) => s.error);
  const detail = flow((s) => s.detail);
  const stuckTabs = flow((s) => s.stuckTabs);
  const resume = flow((s) => s.resume);
  const resumed = flow((s) => s.resumed);
  const resumeError = flow((s) => s.resumeError);
  const [code, setCode] = useState('');

  // The status may be stale (a push opened this): read it again.
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => () => flow.getState().close(), [flow]);

  const runnable = row !== null && redoesLogin(row.provider) && row.supported;
  useEffect(() => {
    if (runnable && flow.getState().phase === 'idle') void flow.getState().start();
  }, [runnable, flow]);

  const close = () => router.back();
  const restart = () => {
    setCode('');
    void flow.getState().start();
  };

  const body = () => {
    if (row === null) {
      if (!loaded || loading) return <ActivityIndicator />;
      return <Banner tone="danger" text={AI_LOGIN_MSG.notFound} />;
    }
    if (!redoesLogin(row.provider)) return <AppText>{manualLine(row)}</AppText>;
    if (!row.supported) {
      return (
        <View className="gap-3">
          <Banner tone="danger" text={AI_LOGIN_MSG.notSupported} />
          <Button label={AI_LOGIN_MSG.refresh} variant="secondary" loading={loading} onPress={() => void load(true)} />
        </View>
      );
    }
    if (phase === 'idle' || phase === 'starting') {
      return (
        <View className="items-center gap-3">
          <ActivityIndicator />
          <AppText variant="muted">{AI_LOGIN_MSG.starting}</AppText>
        </View>
      );
    }
    if (phase === 'failed') {
      return (
        <View className="gap-3">
          <Banner tone="danger" text={error ?? AI_LOGIN_MSG.failed} />
          {detail ? (
            <View className="gap-1">
              <AppText variant="muted">{AI_LOGIN_MSG.cliOutput}</AppText>
              <AppText variant="code" selectable>
                {detail}
              </AppText>
            </View>
          ) : null}
          <Button label={AI_LOGIN_MSG.retry} onPress={restart} />
        </View>
      );
    }
    if (phase === 'done') {
      return (
        <View className="gap-4">
          <Banner tone="info" text={AI_LOGIN_MSG.done} />
          {resume === 'ask' || resume === 'resuming' ? (
            <View className="gap-3">
              <AppText className="font-semibold">{resumeQuestion(stuckTabs.length)}</AppText>
              <AppText variant="muted">{stuckTabs.map((tab) => tab.name).join(', ')}</AppText>
              {resumeError ? <Banner tone="danger" text={resumeError} /> : null}
              <Button label={AI_LOGIN_MSG.resume} loading={resume === 'resuming'} onPress={() => void flow.getState().resumeTabs()} />
              <Button label={AI_LOGIN_MSG.later} variant="secondary" disabled={resume === 'resuming'} onPress={() => flow.getState().skipResume()} />
            </View>
          ) : (
            <>
              {resume === 'resumed' ? <AppText>{resumed > 0 ? resumedLine(resumed) : AI_LOGIN_MSG.notResumed}</AppText> : null}
              <Button label={AI_LOGIN_MSG.finish} onPress={close} />
            </>
          )}
        </View>
      );
    }
    // open | verifying
    const verifying = phase === 'verifying';
    return (
      <View className="gap-4">
        {login?.url ? <Button label={AI_LOGIN_MSG.openPage} variant="secondary" onPress={() => void Linking.openURL(login.url!).catch(() => undefined)} /> : null}
        {error ? <Banner tone="danger" text={error} /> : null}
        {login?.needs_code ? (
          <View className="gap-3">
            <AppText variant="muted">{AI_LOGIN_MSG.claudeHint}</AppText>
            <TextInput
              accessibilityLabel={AI_LOGIN_MSG.codeLabel}
              placeholder={AI_LOGIN_MSG.codeLabel}
              value={code}
              onChangeText={setCode}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!verifying}
              maxLength={2000}
              className={INPUT}
            />
            <Button label={AI_LOGIN_MSG.sendCode} loading={verifying} disabled={code.trim() === ''} onPress={() => void flow.getState().submit(code)} />
            <Button label={AI_LOGIN_MSG.finishedOnMachine} variant="ghost" disabled={verifying} onPress={() => void flow.getState().submit(null)} />
          </View>
        ) : (
          <View className="gap-3">
            <AppText variant="muted">{AI_LOGIN_MSG.codexHint}</AppText>
            {login?.user_code ? (
              <AppText variant="code" selectable className="text-center">
                {login.user_code}
              </AppText>
            ) : null}
            <Button label={AI_LOGIN_MSG.authorized} loading={verifying} onPress={() => void flow.getState().submit(null)} />
          </View>
        )}
        {verifying ? <AppText variant="muted">{AI_LOGIN_MSG.verifying}</AppText> : null}
      </View>
    );
  };

  return (
    <Screen scroll>
      <View className="gap-6 pb-10">
        <View className="flex-row items-center gap-2">
          <AppText variant="title" className="flex-1">
            {AI_LOGIN_MSG.title}
          </AppText>
          <Button label={AI_LOGIN_MSG.close} variant="ghost" onPress={close} />
        </View>
        {row ? <AppText variant="muted">{accountLine(row)}</AppText> : null}
        {body()}
      </View>
    </Screen>
  );
}

export function AiLoginScreen() {
  const { accountId } = useLocalSearchParams<{ accountId: string }>();
  return <AiLoginView key={accountId} accountId={accountId ?? ''} />;
}
