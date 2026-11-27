import { useRouter, type Href } from 'expo-router';
import { Alert, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Button } from '@/ui';
import { AI_LOGIN_MSG, aiLoginRoute, expiredLine, needsLogin } from '../model/ai-login';
import { useAiLoginStore } from '../viewmodel/useAiLoginStore';

/**
 * The red warning on the main screens (TER-1047): one line per account whose CLI login expired, each with
 * "Refazer login", "Dispensar" (hides it until the login works again, saved on the server) and "Remover
 * conta" (TER-1212). Nothing at all while every login is fine, and nothing for an account the person
 * dismissed or that nothing uses any more. The screen that shows it loads the status when it gains focus;
 * the store also reloads on every return to the foreground.
 */
export function AiLoginBanner() {
  // Re-renders on a language change (the copy is read through getters).
  useTranslation();
  const router = useRouter();
  const accounts = useAiLoginStore((s) => s.accounts);
  const dismiss = useAiLoginStore((s) => s.dismiss);
  const remove = useAiLoginStore((s) => s.remove);
  const expired = needsLogin(accounts);
  if (expired.length === 0) return null;
  const confirmRemove = (accountId: string) =>
    Alert.alert(AI_LOGIN_MSG.removeTitle, AI_LOGIN_MSG.removeBody, [
      { text: AI_LOGIN_MSG.cancel, style: 'cancel' },
      { text: AI_LOGIN_MSG.remove, style: 'destructive', onPress: () => void remove(accountId) },
    ]);
  return (
    <View className="gap-2">
      {expired.map((row) => (
        <View key={row.account_id} className="gap-2 rounded-xl border border-app-danger bg-app-surface2 px-4 py-3">
          <AppText className="text-app-danger">{expiredLine(row)}</AppText>
          <Button label={AI_LOGIN_MSG.title} variant="danger" onPress={() => router.push(aiLoginRoute(row.account_id) as Href)} />
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Button label={AI_LOGIN_MSG.dismiss} variant="secondary" onPress={() => void dismiss(row.account_id)} />
            </View>
            <View className="flex-1">
              <Button label={AI_LOGIN_MSG.remove} variant="secondary" onPress={() => confirmRemove(row.account_id)} />
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}
