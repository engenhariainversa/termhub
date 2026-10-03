// The universal build (spec 2026-09-28 iPad §2.1, §2.2): Expo's `withRequiresFullScreen` writes every
// iPad orientation when the tablet is supported and full screen is not required; the iPhone keeps
// `orientation`'s portrait.
const { expo } = require('../app.json') as { expo: { orientation: string; ios: Record<string, unknown> } };

describe('app.json', () => {
  it('builds for the iPad too, with multitasking (no full-screen requirement)', () => {
    expect(expo.ios.supportsTablet).toBe(true);
    expect(expo.ios.requireFullScreen).toBeUndefined();
    expect(expo.ios.isTabletOnly).toBeUndefined();
  });

  it('keeps the iPhone in portrait', () => {
    expect(expo.orientation).toBe('portrait');
  });
});

type Plugin = string | [string, Record<string, unknown>];
const plugins = (require('../app.json') as { expo: { plugins: Plugin[] } }).expo.plugins;
const pluginOptions = (name: string) => (plugins.find((p) => (Array.isArray(p) ? p[0] : p) === name) as [string, Record<string, unknown>] | undefined)?.[1];

describe('ad measurement (permission prompts spec §3.5)', () => {
  it('asks ATT with a pt-BR reason, and builds Firebase with the advertising id', () => {
    expect(pluginOptions('expo-tracking-transparency')?.userTrackingPermission).toMatch(/identificador de publicidade/);
    expect((pluginOptions('@react-native-firebase/analytics')?.ios as { withoutAdIdSupport?: boolean }).withoutAdIdSupport).toBe(false);
  });

  it('denies the ad signals by default, before any JS runs, and keeps analytics', () => {
    const rn = (require('../firebase.json') as { 'react-native': Record<string, boolean> })['react-native'];
    expect(rn).toEqual({
      analytics_default_allow_analytics_storage: true,
      analytics_default_allow_ad_storage: false,
      analytics_default_allow_ad_user_data: false,
      analytics_default_allow_ad_personalization_signals: false,
    });
  });

  it('only uses keys RNFirebase knows (an unknown key is silently ignored and the signal stays granted)', () => {
    // The package's `exports` hides the schema from require(), so reach it by path (hoisted to the root).
    const schema = require('../../../node_modules/@react-native-firebase/app/firebase-schema.json') as {
      properties: { 'react-native': { properties: Record<string, unknown> } };
    };
    const known = Object.keys(schema.properties['react-native'].properties);
    const rn = (require('../firebase.json') as { 'react-native': Record<string, boolean> })['react-native'];
    for (const key of Object.keys(rn)) expect(known).toContain(key);
  });
});

// Store declarations (TER-733). With `useFrameworks: "static"` Apple does not reliably read the
// PrivacyInfo.xcprivacy of each pod, so the app's own manifest repeats every required reason.
type AccessedApi = { NSPrivacyAccessedAPIType: string; NSPrivacyAccessedAPITypeReasons: string[] };
type CollectedData = {
  NSPrivacyCollectedDataType: string;
  NSPrivacyCollectedDataTypeLinked: boolean;
  NSPrivacyCollectedDataTypeTracking: boolean;
  NSPrivacyCollectedDataTypePurposes: string[];
};
const app = (require('../app.json') as {
  expo: {
    ios: {
      privacyManifests: {
        NSPrivacyTracking: boolean;
        NSPrivacyTrackingDomains: string[];
        NSPrivacyAccessedAPITypes: AccessedApi[];
        NSPrivacyCollectedDataTypes: CollectedData[];
      };
    };
    android: { permissions: string[] };
  };
}).expo;
const manifest = app.ios.privacyManifests;

// Firebase iOS pods come from CocoaPods, not node_modules: their manifests as published for
// FirebaseCore/FirebaseCoreInternal/FirebaseInstallations 12.18.0 and GoogleUtilities 8.1.0
// (nanopb, PromisesObjC and GoogleAppMeasurement declare no API; GoogleAppMeasurement ships no
// manifest at all). Re-check when @react-native-firebase moves to another Firebase iOS SDK.
const FIREBASE_PODS: Record<string, string[]> = {
  NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1', '1C8F.1', 'C56D.1'],
  NSPrivacyAccessedAPICategoryFileTimestamp: ['C617.1'],
};

// The app's tsconfig has no Node types: just what the scan below uses.
type Fs = {
  readdirSync(dir: string): string[];
  readdirSync(dir: string, options: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
};
type Path = { join(...parts: string[]): string; resolve(...parts: string[]): string };
declare const __dirname: string;

/** Every PrivacyInfo.xcprivacy shipped by the native packages installed in node_modules. */
function nodeModulesReasons(): Record<string, Set<string>> {
  const fs = require('fs') as Fs;
  const path = require('path') as Path;
  const root = path.resolve(__dirname, '../../../node_modules');
  const packages = fs.readdirSync(root).flatMap((name: string) =>
    name.startsWith('@') ? fs.readdirSync(path.join(root, name)).map((sub: string) => path.join(root, name, sub)) : [path.join(root, name)],
  );
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') walk(full);
      else if (entry.name.endsWith('.xcprivacy')) files.push(full);
    }
  };
  for (const pkg of packages) {
    for (const sub of ['ios', 'apple', 'React', 'ReactCommon', 'third-party-podspecs']) {
      if (fs.existsSync(path.join(pkg, sub))) walk(path.join(pkg, sub));
    }
  }
  const out: Record<string, Set<string>> = {};
  for (const file of files) {
    const xml = fs.readFileSync(file, 'utf8');
    const entries = xml.matchAll(/<key>NSPrivacyAccessedAPIType<\/key>\s*<string>([^<]+)<\/string>\s*<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>([\s\S]*?)<\/array>/g);
    for (const [, type = '', reasons = ''] of entries) {
      for (const [, reason = ''] of reasons.matchAll(/<string>([^<]+)<\/string>/g)) (out[type] ??= new Set()).add(reason);
    }
  }
  return out;
}

describe('iOS privacy manifest (TER-733)', () => {
  it('declares every required reason of the native packages and the Firebase pods', () => {
    const declared = Object.fromEntries(manifest.NSPrivacyAccessedAPITypes.map((a) => [a.NSPrivacyAccessedAPIType, a.NSPrivacyAccessedAPITypeReasons]));
    const needed = nodeModulesReasons();
    expect(Object.keys(needed).length).toBeGreaterThan(0); // the scan found the packages
    for (const [type, reasons] of Object.entries(FIREBASE_PODS)) for (const r of reasons) (needed[type] ??= new Set()).add(r);
    for (const [type, reasons] of Object.entries(needed)) expect({ type, reasons: declared[type] ?? [] }).toEqual({ type, reasons: expect.arrayContaining([...reasons]) });
  });

  it('tracks only through the IDFA, matching ATT: the ad domain is listed, first-party analytics is not', () => {
    expect(manifest.NSPrivacyTracking).toBe(true);
    expect(manifest.NSPrivacyTrackingDomains).toContain('googleadservices.com');
    // Listing app-measurement.com would make iOS block screen views of everyone who denies ATT.
    expect(manifest.NSPrivacyTrackingDomains).not.toContain('app-measurement.com');
  });

  it('marks as tracking exactly the data used with the IDFA', () => {
    const tracking = manifest.NSPrivacyCollectedDataTypes.filter((d) => d.NSPrivacyCollectedDataTypeTracking).map((d) => d.NSPrivacyCollectedDataType);
    expect(tracking.sort()).toEqual(['NSPrivacyCollectedDataTypeDeviceID', 'NSPrivacyCollectedDataTypeProductInteraction']);
  });
});

describe('Android advertising id (TER-733)', () => {
  it('declares AD_ID itself instead of relying on the Firebase manifest merge', () => {
    expect(app.android.permissions).toContain('com.google.android.gms.permission.AD_ID');
  });
});
