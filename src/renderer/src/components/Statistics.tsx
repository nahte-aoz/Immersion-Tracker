import { useEffect, useState } from 'react'
import StudyChart from './StudyChart'

type TimerStatistics = Awaited<ReturnType<Window['api']['getTimerStatistics']>>
type LanguageOption = Awaited<ReturnType<Window['api']['getSupportedOcrLanguages']>>[number]

const unspecifiedLanguage = 'unknown'

const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds} sec`
  const totalMinutes = Math.floor(seconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${totalMinutes} min`
  return `${hours} hr ${minutes} min`
}

const formatFullDate = (date: string): string =>
  new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date(`${date}T12:00:00`))

const toDateKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

const formatSessionDate = (date: string | null): string => {
  if (!date) return 'Date unavailable'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(date))
}

const getActivityLevel = (seconds: number): number => {
  if (seconds === 0) return 0
  if (seconds < 600) return 1
  if (seconds < 1800) return 2
  if (seconds < 3600) return 3
  return 4
}

function Statistics(): React.JSX.Element {
  const [statistics, setStatistics] = useState<TimerStatistics | null>(null)
  const [error, setError] = useState(false)
  const [selectedYear, setSelectedYear] = useState(() => new Date().getFullYear())
  // 'all' adds every language up; otherwise statistics for one language.
  const [language, setLanguage] = useState('all')
  const [reloadKey, setReloadKey] = useState(0)
  const [confirmingId, setConfirmingId] = useState<number | null>(null)
  const [languageOptions, setLanguageOptions] = useState<LanguageOption[]>([])

  useEffect(() => {
    window.api
      .getSupportedOcrLanguages()
      .then(setLanguageOptions)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let active = true
    window.api
      .getTimerStatistics(language)
      .then((result) => {
        if (active) setStatistics(result)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [language, reloadKey])

  // Close the "are you sure" pop-up when clicking elsewhere or pressing Escape.
  useEffect(() => {
    if (confirmingId === null) return
    const close = (): void => setConfirmingId(null)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [confirmingId])

  const deleteSession = async (id: number): Promise<void> => {
    setConfirmingId(null)
    try {
      await window.api.deleteSession(id)
      setReloadKey((key) => key + 1)
    } catch {
      setError(true)
    }
  }

  if (error) {
    return (
      <section className="statistics-view" aria-labelledby="statistics-title">
        <h1 id="statistics-title">Statistics</h1>
        <p className="state-message" role="alert">
          Unable to load statistics.
        </p>
      </section>
    )
  }

  if (!statistics) {
    return (
      <section className="statistics-view" aria-labelledby="statistics-title">
        <h1 id="statistics-title">Statistics</h1>
        <p className="state-message" aria-live="polite">
          Loading...
        </p>
      </section>
    )
  }

  const currentYear = new Date().getFullYear()
  const earliestYear = statistics.calendar.length
    ? Number(statistics.calendar[0].date.slice(0, 4))
    : currentYear
  const activityByDate = new Map(statistics.calendar.map((day) => [day.date, day]))
  const yearStart = new Date(selectedYear, 0, 1)
  const calendarOffset = yearStart.getDay()
  const daysInYear = Math.round(
    (new Date(selectedYear + 1, 0, 1).getTime() - yearStart.getTime()) / 86400000
  )
  const calendarWeekCount = Math.ceil((daysInYear + calendarOffset) / 7)
  const calendarCells = Array.from({ length: calendarWeekCount * 7 }, (_, index) => {
    const dayIndex = index - calendarOffset
    if (dayIndex < 0 || dayIndex >= daysInYear) return null
    const date = toDateKey(new Date(selectedYear, 0, 1 + dayIndex))
    return activityByDate.get(date) ?? { date, seconds: 0, sessions: 0 }
  })
  const monthMarkers = Array.from({ length: 12 }, (_, month) => {
    const dayIndex = Math.round(
      (new Date(selectedYear, month, 1).getTime() - yearStart.getTime()) / 86400000
    )
    return {
      label: new Intl.DateTimeFormat(undefined, { month: 'short' }).format(
        new Date(selectedYear, month, 1)
      ),
      week: Math.floor((calendarOffset + dayIndex) / 7)
    }
  })
  const languageName = (code: string): string =>
    code === unspecifiedLanguage
      ? 'Unspecified'
      : (languageOptions.find((option) => option.code === code)?.name ?? code)
  // Only languages that have recorded time.
  const languageChoices = statistics.byLanguage.map((entry) => ({
    code: entry.language,
    name: languageName(entry.language)
  }))
  const maxLanguageSeconds = Math.max(...statistics.byLanguage.map((entry) => entry.seconds), 1)
  return (
    <section className="statistics-view" aria-labelledby="statistics-title">
      <div className="statistics-heading">
        <h1 id="statistics-title">Statistics</h1>
        <div className="statistics-controls">
          <label className="profile-select">
            <span>Language</span>
            <select onChange={(event) => setLanguage(event.target.value)} value={language}>
              <option value="all">All languages (total)</option>
              {languageChoices.map((choice) => (
                <option key={choice.code} value={choice.code}>
                  {choice.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <StudyChart statistics={statistics} />

      {language === 'all' && statistics.byLanguage.length > 0 && (
        <section className="language-section" aria-labelledby="language-title">
          <h2 id="language-title">Time by language</h2>
          <div className="language-list">
            {statistics.byLanguage.map((entry) => (
              <div className="language-row" key={entry.language}>
                <button
                  className="language-name"
                  onClick={() => setLanguage(entry.language)}
                  type="button"
                >
                  {languageName(entry.language)}
                </button>
                <span className="language-bar">
                  <span style={{ width: `${(entry.seconds / maxLanguageSeconds) * 100}%` }} />
                </span>
                <span className="language-time">{formatDuration(entry.seconds)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="activity-section" aria-labelledby="activity-title">
        <div className="section-heading-row">
          <h2 id="activity-title">Study activity</h2>
          <div className="year-nav">
            <button
              type="button"
              className="year-button"
              aria-label="Previous year"
              disabled={selectedYear <= earliestYear}
              onClick={() => setSelectedYear((year) => year - 1)}
            >
              ‹
            </button>
            <span className="year-label" aria-live="polite">
              {selectedYear}
            </span>
            <button
              type="button"
              className="year-button"
              aria-label="Next year"
              disabled={selectedYear >= currentYear}
              onClick={() => setSelectedYear((year) => year + 1)}
            >
              ›
            </button>
          </div>
        </div>
        <div className="calendar-scroll">
          <div className="activity-calendar">
            <div className="calendar-months">
              {monthMarkers.map((month) => (
                <span key={`${month.label}-${month.week}`} style={{ left: `${month.week * 13}px` }}>
                  {month.label}
                </span>
              ))}
            </div>
            <div className="calendar-layout">
              <div className="calendar-weekdays" aria-hidden="true">
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
                  <span key={`${day}-${index}`}>{day}</span>
                ))}
              </div>
              <div
                className="calendar-days"
                role="img"
                aria-label={`Daily study time in ${selectedYear}`}
                style={{ gridAutoColumns: '10px' }}
              >
                {calendarCells.map((day, index) =>
                  day ? (
                    <span
                      key={day.date}
                      className={`calendar-cell level-${getActivityLevel(day.seconds)}`}
                      title={`${formatFullDate(day.date)}: ${formatDuration(day.seconds)}`}
                      aria-label={`${formatFullDate(day.date)}: ${formatDuration(day.seconds)}`}
                    />
                  ) : (
                    <span
                      key={`padding-${index}`}
                      className="calendar-cell is-padding"
                      aria-hidden="true"
                    />
                  )
                )}
              </div>
            </div>
            <div className="calendar-legend" aria-label="Study time intensity: less to more">
              <span>Less</span>
              <span className="calendar-cell level-0" />
              <span className="calendar-cell level-1" />
              <span className="calendar-cell level-2" />
              <span className="calendar-cell level-3" />
              <span className="calendar-cell level-4" />
              <span>More</span>
            </div>
          </div>
        </div>
      </section>

      <section className="recent-section" aria-labelledby="recent-title">
        <div className="section-heading-row recent-heading">
          <h2 id="recent-title">Recent sessions</h2>
        </div>
        {statistics.recent.length > 0 ? (
          <div className="session-list">
            {statistics.recent.map((session) => (
              <div className="session-row" key={session.id}>
                <span className="session-marker" aria-hidden="true" />
                <span className="session-date">{formatSessionDate(session.stoppedAt)}</span>
                <span className="session-duration">{formatDuration(session.seconds)}</span>
                <div className="session-delete" onClick={(event) => event.stopPropagation()}>
                  <button
                    aria-label="Delete session"
                    className="session-delete-button"
                    onClick={() => setConfirmingId(confirmingId === session.id ? null : session.id)}
                    type="button"
                  >
                    ✕
                  </button>
                  {confirmingId === session.id && (
                    <div className="session-confirm" role="alertdialog">
                      <p>Are you sure? This cannot be undone.</p>
                      <div className="session-confirm-actions">
                        <button
                          className="session-confirm-delete"
                          onClick={() => void deleteSession(session.id)}
                          type="button"
                        >
                          Delete
                        </button>
                        <button
                          className="session-confirm-cancel"
                          onClick={() => setConfirmingId(null)}
                          type="button"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-sessions">No sessions yet.</p>
        )}
      </section>
    </section>
  )
}

export default Statistics
