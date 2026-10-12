import { getAnalytics, logScreenView, setAnalyticsCollectionEnabled, setConsent } from '@react-native-firebase/analytics';

/** The person's measurement consent as last applied; screen views wait for a yes (TER-583). */
let granted = false;

/** Logs a `screen_view` for an expo-router route pattern, e.g. `/chat/[id]`, once the person
 * accepted measurement. Never throws. */
export function logScreen(route: string): void {
  if (!granted) return;
  try {
    logScreenView(getAnalytics(), { screen_name: route, screen_class: route }).catch(() => undefined);
  } catch {
    // Native module missing (e.g. an old dev client): analytics must never break the app.
  }
}

/** The one measurement consent (permission prompts spec §3.3, TER-583): Google's three ad signals
 * and usage analytics all follow the person's choice, and collection stays off until a yes (the
 * native SDK keeps that switch across launches). Never throws. */
export async function setAdConsent(next: boolean): Promise<void> {
  granted = next;
  try {
    const analytics = getAnalytics();
    await setConsent(analytics, { ad_storage: next, ad_user_data: next, ad_personalization: next, analytics_storage: next });
    await setAnalyticsCollectionEnabled(analytics, next);
  } catch {
    // Native module missing: the defaults in firebase.json stay in force.
  }
}
