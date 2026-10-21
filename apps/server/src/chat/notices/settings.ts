import type { ConciergePushSettings } from '@termhub/mobile-api';
import type { Repositories } from '../../db/repositories/index.js';
import { zoneOrUtc } from '../../lib/local-time.js';
import { noticeSettingsOf } from './rules.js';

/**
 * TER-1101: saves the person's rules for the concierge's notices (web and phone). Quiet hours are read on the
 * person's clock: the client's zone is kept with them when it is a real one, so a person who never set a
 * zone elsewhere (the automation's summary hour, TER-1088) gets their own instead of UTC.
 */
export async function saveConciergePush(repos: Pick<Repositories, 'users'>, userId: string, settings: ConciergePushSettings, timeZone?: string): Promise<void> {
  await repos.users.setConciergePush(userId, noticeSettingsOf(settings));
  if (settings.quiet_start && timeZone && zoneOrUtc(timeZone) === timeZone) await repos.users.setTimeZone(userId, timeZone);
}
