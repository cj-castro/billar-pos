import type { ExpoConfig } from 'expo/config';
import { withAppBuildGradle, type ConfigPlugin } from 'expo/config-plugins';
// @ts-expect-error expo's config loader needs the explicit .ts extension
import { APP_BUILD, APP_VERSION } from './src/config/version.ts';

/**
 * Release signing: `expo prebuild` regenerates android/, whose release buildType uses the PUBLIC debug keystore.
 * Rewrite it to read the venue keystore from env at Gradle time (BOLA8_KEYSTORE / _KEYSTORE_PASS / _KEY_ALIAS / _KEY_PASS).
 * Nothing secret is written to disk; scripts/mobile/build-android-release.ps1 refuses to run without them.
 */
const withReleaseSigning: ConfigPlugin = (cfg) =>
  withAppBuildGradle(cfg, (c) => {
    let g = c.modResults.contents;
    if (g.includes('BOLA8_KEYSTORE')) return c;
    g = g.replace(
      /signingConfigs\s*\{/,
      `signingConfigs {
        release {
            if (System.getenv('BOLA8_KEYSTORE')) {
                storeFile file(System.getenv('BOLA8_KEYSTORE'))
                storePassword System.getenv('BOLA8_KEYSTORE_PASS')
                keyAlias System.getenv('BOLA8_KEY_ALIAS')
                keyPassword System.getenv('BOLA8_KEY_PASS')
            }
        }`,
    );
    g = g.replace(/(release\s*\{[^}]*?)signingConfig signingConfigs\.debug/, '$1signingConfig signingConfigs.release');
    c.modResults.contents = g;
    return c;
  });

const config: ExpoConfig = {
  name: 'Bola 8 Staff',
  slug: 'bola8-staff',
  version: APP_VERSION,
  orientation: 'default',
  icon: './assets/images/icon.png',
  scheme: 'bola8staff',
  userInterfaceStyle: 'dark',
  backgroundColor: '#0f172a',
  ios: {
    bundleIdentifier: 'com.bola8.staff',
    supportsTablet: false,
  },
  android: {
    package: 'com.bola8.staff',
    versionCode: APP_BUILD,
    adaptiveIcon: {
      backgroundColor: '#0f172a',
      foregroundImage: './assets/images/android-icon-foreground.png',
    },
    softwareKeyboardLayoutMode: 'resize',
    predictiveBackGestureEnabled: false,
    allowBackup: false, // SEC-15
    // SEC-13: Expo template defaults this app never uses
    blockedPermissions: ['android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE'],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-audio',
    ['expo-notifications', { color: '#0f172a' }],
    [
      'expo-splash-screen',
      { backgroundColor: '#0f172a', image: './assets/images/splash-icon.png', imageWidth: 160 },
    ],
    [
      'expo-build-properties',
      {
        android: {
          // LAN-ONLY: the POS backend is plain http:// on the venue LAN (nginx :8080).
          // Android blocks cleartext by default, so we opt in. ROADMAP: terminate TLS
          // at nginx and drop this flag (see mobile/README.md "Security notes").
          usesCleartextTraffic: true,
        },
      },
    ],
  ],
  experiments: { reactCompiler: true },
};

export default withReleaseSigning(config);
