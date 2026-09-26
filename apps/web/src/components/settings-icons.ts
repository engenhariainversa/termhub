import { Bot, ClipboardList, Cpu, Folder, KeyRound, ListChecks, Map as MapIcon, Plug, Shield, ShieldCheck, Smartphone, User as UserIcon, Users, type LucideIcon } from 'lucide-react';
import type { SettingsSection } from '../lib/settings-sections';

/** Each settings section's line icon (spec 2026-09-23 app chrome §2), for the settings sidebar and the rail. */
export const SETTINGS_ICONS: Record<SettingsSection, LucideIcon> = {
  profile: UserIcon,
  city: MapIcon,
  integrations: Plug,
  'api-tokens': KeyRound,
  devices: Smartphone,
  'chat-grants': ShieldCheck,
  ai: Bot,
  hardware: Cpu,
  users: Users,
  waitlist: ClipboardList,
  roles: Shield,
  permissions: ListChecks,
  uploads: Folder,
};
