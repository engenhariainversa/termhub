import { useState } from 'react';
import { Linking, Pressable, Switch, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Button, Screen } from '@/ui';
import { effectiveDate, LEGAL_MSG } from '../model/messages';
import { useLegalStore } from '../viewmodel/useLegalStore';

/**
 * The acceptance screen of the Terms of Use and Privacy Policy (TER-742), route `/legal-acceptance`:
 * the redirect holds an unlocked session here while a version in force is not accepted yet. Each
 * pending document shows its version, the date it took effect, its summary and a link to read it;
 * "Continuar" stays off until the consent switch is on, then posts the acceptance. Once nothing is
 * pending, the redirect takes the person back to where they were going.
 */
export function LegalAcceptanceScreen() {
  // Re-renders on a language change; LEGAL_MSG's getters read it.
  useTranslation();
  const pending = useLegalStore((s) => s.pending);
  const accepting = useLegalStore((s) => s.accepting);
  const error = useLegalStore((s) => s.error);
  const accept = useLegalStore((s) => s.accept);
  const [agreed, setAgreed] = useState(false);

  return (
    <Screen scroll>
      <View className="gap-6 pb-10">
        <AppText variant="title">{LEGAL_MSG.title}</AppText>
        <AppText variant="muted">{LEGAL_MSG.intro}</AppText>
        {pending.map((v) => {
          const date = effectiveDate(v.effective_at);
          return (
            <View key={v.id} className="gap-1">
              <AppText className="font-semibold">{LEGAL_MSG.documentName(v.document)}</AppText>
              <AppText variant="muted">{date ? LEGAL_MSG.versionSince(v.version, date) : LEGAL_MSG.versionOnly(v.version)}</AppText>
              {v.summary ? <AppText>{v.summary}</AppText> : null}
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={LEGAL_MSG.openDocument(LEGAL_MSG.documentName(v.document))}
                onPress={() => void Linking.openURL(v.url)}
              >
                <AppText className="text-app-accent underline">{LEGAL_MSG.open}</AppText>
              </Pressable>
            </View>
          );
        })}
        <View className="flex-row items-center justify-between gap-4">
          <AppText className="flex-1">{LEGAL_MSG.consent}</AppText>
          <Switch accessibilityLabel={LEGAL_MSG.consent} value={agreed} onValueChange={setAgreed} disabled={accepting} />
        </View>
        {error ? <AppText className="text-app-danger">{error}</AppText> : null}
        <Button label={LEGAL_MSG.continue} loading={accepting} disabled={!agreed || pending.length === 0} onPress={() => void accept()} />
      </View>
    </Screen>
  );
}
