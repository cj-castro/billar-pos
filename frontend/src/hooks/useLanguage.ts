import { useTranslation } from 'react-i18next'

export function useLanguage() {
  const { i18n } = useTranslation()

  const setLanguage = (lang: 'es' | 'en') => {
    i18n.changeLanguage(lang)
    localStorage.setItem('lang', lang)
  }

  return {
    lang: i18n.language as 'es' | 'en',
    setLanguage,
    isSpanish: i18n.language === 'es',
    isEnglish: i18n.language === 'en',
  }
}
