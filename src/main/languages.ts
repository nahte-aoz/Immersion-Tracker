// Whisper's language codes, keyed by the Tesseract-style codes the app stores.
export const whisperLanguageCodes: Record<string, string> = {
  eng: 'en',
  jpn: 'ja',
  chi_sim: 'zh',
  chi_tra: 'zh',
  kor: 'ko',
  rus: 'ru',
  spa: 'es',
  fra: 'fr',
  deu: 'de',
  ita: 'it',
  por: 'pt',
  ara: 'ar',
  hin: 'hi'
}

// franc (the text detector used for OCR) names Chinese 'cmn'; the rest match the stored codes.
export const toDetectorLanguage = (language: string): string =>
  language === 'chi_sim' || language === 'chi_tra' ? 'cmn' : language

// Maps a language code from OCR (franc) or speech (Whisper) back to the stored app code,
// among the candidate languages. Returns null when none matches.
export const toAppLanguage = (code: string, candidates: string[]): string | null =>
  candidates.find(
    (candidate) =>
      toDetectorLanguage(candidate) === code || whisperLanguageCodes[candidate] === code
  ) ?? null
