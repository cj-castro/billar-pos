import AsyncStorage from '@react-native-async-storage/async-storage';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { mobileEn, mobileEs } from './mobile';
import en from './web/en';
import es from './web/es';

export const LANG_KEY = 'bola8.lang';
export type Lang = 'es' | 'en';

// Web resources are the default `translation` namespace (identical keys to the web POS);
// app-only strings live in the `mobile` namespace: t('mobile:login.title').
i18n.use(initReactI18next).init({
  resources: {
    es: { translation: es, mobile: mobileEs },
    en: { translation: en, mobile: mobileEn },
  },
  lng: 'es',
  fallbackLng: 'es',
  defaultNS: 'translation',
  ns: ['translation', 'mobile'],
  interpolation: { escapeValue: false },
});

/** Apply the persisted language (call once at boot). */
export async function loadLanguage(): Promise<Lang> {
  try {
    const saved = await AsyncStorage.getItem(LANG_KEY);
    if (saved === 'es' || saved === 'en') {
      await i18n.changeLanguage(saved);
      return saved;
    }
  } catch {
    // fall through to default
  }
  return 'es';
}

export async function setLanguage(lang: Lang): Promise<void> {
  await i18n.changeLanguage(lang);
  await AsyncStorage.setItem(LANG_KEY, lang).catch(() => {});
}

export default i18n;
