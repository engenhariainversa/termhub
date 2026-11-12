import { Linking, Pressable, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText } from '@/ui';
import { LEGAL_ENTITY, LEGAL_LINKS } from '../model/legal-urls';

/** "Termos de uso · Política de privacidade", opened in the browser (no in-app web view), and the publisher under them. */
export function LegalLinks() {
  const { t } = useTranslation();
  return (
    <View className="gap-y-1">
      <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
        {LEGAL_LINKS.map((link, i) => (
          <View key={link.url} className="flex-row items-center gap-x-2">
            {i > 0 ? <AppText variant="muted">·</AppText> : null}
            <Pressable accessibilityRole="link" accessibilityLabel={t(link.label)} hitSlop={8} onPress={() => void Linking.openURL(link.url)}>
              <AppText variant="muted" className="text-app-accent">
                {t(link.label)}
              </AppText>
            </Pressable>
          </View>
        ))}
      </View>
      <AppText variant="muted">{LEGAL_ENTITY}</AppText>
    </View>
  );
}
