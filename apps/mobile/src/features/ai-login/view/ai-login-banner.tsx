import { useRouter, type Href } from 'expo-router';
import { View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Button } from '@/ui';
import { AI_LOGIN_MSG, aiLoginRoute, expiredLine, needsLogin } from '../model/ai-login';
import { useAiLoginStore } from '../viewmodel/useAiLoginStore';

/**
 * The red warning on the main screens (TER-1047): one line per account whose CLI login expired, each with
 * "Refazer login". Nothing at all while every login is fine. The screen that shows it loads the status
 * when it gains focus; the store also reloads on every return to the foreground.
 */
export function AiLoginBanner() {
  // Re-renders on a language change (the copy is read through getters).
  useTranslation();
  const router = useRouter();
  const accounts = useAiLoginStore((s) => s.accounts);
  const expired = needsLogin(accounts);
  if (expired.length === 0) return null;
  return (
    <View className="gap-2">
      {expired.map((row) => (
        <View key={row.account_id} className="gap-2 rounded-xl border border-app-danger bg-app-surface2 px-4 py-3">
          <AppText className="text-app-danger">{expiredLine(row)}</AppText>
          <Button label={AI_LOGIN_MSG.title} variant="danger" onPress={() => router.push(aiLoginRoute(row.account_id) as Href)} />
        </View>
      ))}
    </View>
  );
}
