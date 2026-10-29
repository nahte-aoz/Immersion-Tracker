export interface TimerStatistics {
  totalSessions: number
  totalSeconds: number
  averageSeconds: number
  longestSeconds: number
  daily: Array<{ date: string; seconds: number; sessions: number }>
  calendar: Array<{ date: string; seconds: number; sessions: number }>
  recent: Array<{ id: number; seconds: number; stoppedAt: string | null }>
}