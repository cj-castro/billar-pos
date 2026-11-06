import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Bola 8 Staff',
  slug: 'bola8-staff',
  version: '0.1.0',
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
    adaptiveIcon: {
      backgroundColor: '#0f172a',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    allowBackup: false, // SEC-15
    // SEC-13: Expo template defaults this app never uses
    blockedPermissions: ['android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE'],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-splash-screen',
      { backgroundColor: '#0f172a', image: './assets/images/splash-icon.png', imageWidth: 76 },
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

export default config;
