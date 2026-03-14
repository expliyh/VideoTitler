import type { SupportedLanguage } from '@videotitler/core';

import { en } from './en';
import { fr } from './fr';
import type { UiText } from './types';
import { zh } from './zh';

const DICTIONARY: Record<SupportedLanguage, UiText> = {
  en,
  zh,
  fr
};

export function resolveSystemLanguage(value: string): SupportedLanguage {
  const normalized = value.toLowerCase();
  if (normalized.startsWith('zh')) {
    return 'zh';
  }
  if (normalized.startsWith('fr')) {
    return 'fr';
  }
  return 'en';
}

export function getUiText(language: SupportedLanguage): UiText {
  return DICTIONARY[language];
}
