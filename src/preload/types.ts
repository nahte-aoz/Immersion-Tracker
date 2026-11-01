export interface TimerStatistics {
  totalSessions: number
  totalSeconds: number
  averageSeconds: number
  longestSeconds: number
  daily: Array<{ date: string; seconds: number; sessions: number }>
  calendar: Array<{ date: string; seconds: number; sessions: number }>
  recent: Array<{ id: number; seconds: number; stoppedAt: string | null }>
}

export interface ScreenRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface ScreenPreview {
  dataUrl: string
  width: number
  height: number
}

export interface ScreenOcrResult {
  text: string
  language: string
  confidence: number
}

export const OCR_LANGUAGE_OPTIONS = [
  { code: 'eng', name: 'English' },
  { code: 'jpn', name: 'Japanese' },
  { code: 'chi_sim', name: 'Chinese (Simplified)' },
  { code: 'chi_tra', name: 'Chinese (Traditional)' },
  { code: 'kor', name: 'Korean' },
  { code: 'rus', name: 'Russian' },
  { code: 'spa', name: 'Spanish' },
  { code: 'fra', name: 'French' },
  { code: 'deu', name: 'German' },
  { code: 'ita', name: 'Italian' },
  { code: 'por', name: 'Portuguese' },
  { code: 'ara', name: 'Arabic' },
  { code: 'hin', name: 'Hindi' }
] as const

export type OcrLanguageCode = (typeof OCR_LANGUAGE_OPTIONS)[number]['code']
export type OcrLanguageOption = (typeof OCR_LANGUAGE_OPTIONS)[number]

export interface SpeechLanguageResult {
  language: string
  confidence: number
  isTarget: boolean
}

export interface AudioApp {
  exe: string
  name: string
}

export interface AudioSettings {
  alwaysListen: boolean
  apps: AudioApp[]
}

export interface AudioAppInfo extends AudioApp {
  playing: boolean
}

export interface AudioAppList {
  // False when Windows is too old for per-application audio capture.
  supported: boolean
  apps: AudioAppInfo[]
}
