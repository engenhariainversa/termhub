import { Linking, Pressable, View } from 'react-native';
import { AppText } from '@/ui';
import { LEGAL_LINKS } from '../model/legal-urls';

/** "Termos de uso · Política de privacidade", opened in the browser (no in-app web view). */
export function LegalLinks() {
  return (
    <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
      {LEGAL_LINKS.map((link, i) => (
        <View key={link.url} className="flex-row items-center gap-x-2">
          {i > 0 ? <AppText variant="muted">·</AppText> : null}
          <Pressable accessibilityRole="link" accessibilityLabel={link.label} hitSlop={8} onPress={() => void Linking.openURL(link.url)}>
            <AppText variant="muted" className="text-app-accent">
              {link.label}
            </AppText>
          </Pressable>
        </View>
      ))}
    </View>
  );
}
