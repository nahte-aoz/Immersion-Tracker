import { useEffect, useState } from 'react'

type TimerStatistics = Awaited<ReturnType<Window['api']['getTimerStatistics']>>

const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds} sec`
  const totalMinutes = Math.floor(seconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${totalMinutes} min`
  return `${hours} hr ${minutes} min`
}

const formatDay = (date: string): string => {
  const parsed = new Date(`${date}T12:00:00`)
  return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(parsed)
}

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

  useEffect(() => {
    let active = true
    window.api
      .getTimerStatistics()
      .then((result) => {
        if (active) setStatistics(result)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [])

  if (error) {
    return (
      <section className="statistics-view" aria-labelledby="statistics-title">
        <h1 id="statistics-title">Statistics</h1>
        <p className="state-message" role="alert">Unable to load statistics.</p>
      </section>
    )
  }

  if (!statistics) {
    return (
      <section className="statistics-view" aria-labelledby="statistics-title">
        <h1 id="statistics-title">Statistics</h1>
        <p className="state-message" aria-live="polite">Loading...</p>
      </section>
    )
  }

  const maxDailySeconds = Math.max(...statistics.daily.map((day) => day.seconds), 60)
  const today = statistics.daily[statistics.daily.length - 1]
  const calendarOffset = new Date(`${statistics.calendar[0].date}T12:00:00`).getDay()
  const calendarWeekCount = Math.ceil((statistics.calendar.length + calendarOffset) / 7)
  const calendarCells = Array.from(
    { length: calendarWeekCount * 7 },
    (_, index) => statistics.calendar[index - calendarOffset] ?? null
  )
  const monthMarkers: Array<{ label: string; week: number }> = []
  let previousMonth = ''
  statistics.calendar.forEach((day, index) => {
    const monthKey = day.date.slice(0, 7)
    if (monthKey !== previousMonth) {
      if (index > 0 || day.date.endsWith('-01')) {
        monthMarkers.push({
          label: new Intl.DateTimeFormat(undefined, { month: 'short' }).format(
            new Date(`${day.date}T12:00:00`)
          ),
          week: Math.floor((calendarOffset + index) / 7)
        })
      }
      previousMonth = monthKey
    }
  })
  const metrics = [
    {
      label: 'Total study time',
      value: formatDuration(statistics.totalSeconds)
    },
    {
      label: 'Sessions',
      value: statistics.totalSessions.toLocaleString()
    },
    {
      label: 'Average session',
      value: formatDuration(Math.round(statistics.averageSeconds))
    },
    {
      label: 'Today',
      value: formatDuration(today?.seconds ?? 0)
    }
  ]

  return (
    <section className="statistics-view" aria-labelledby="statistics-title">
      <div className="statistics-heading">
        <h1 id="statistics-title">Statistics</h1>
        <span className="range-label">7 days</span>
      </div>

      <div className="metrics-grid" aria-label="Lifetime study summary">
        {metrics.map((metric) => (
          <div className="metric" key={metric.label}>
            <span className="metric-label">{metric.label}</span>
            <strong className="metric-value">{metric.value}</strong>
          </div>
        ))}
      </div>

      <section className="activity-section" aria-labelledby="activity-title">
        <h2 id="activity-title">Study activity</h2>
        <div className="calendar-scroll">
          <div className="activity-calendar">
            <div className="calendar-months">
              {monthMarkers.map((month) => (
                <span key={`${month.label}-${month.week}`} style={{ left: `${month.week * 15}px` }}>
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
                aria-label="Daily study time during the past year"
                style={{ gridAutoColumns: '10px' }}
              >
                {calendarCells.map((day, index) =>
                  day ? (
                    <span
                      key={day.date}
                      className={`calendar-cell level-${getActivityLevel(day.seconds)}`}
                      title={`${day.date}: ${formatDuration(day.seconds)}`}
                      aria-label={`${day.date}: ${formatDuration(day.seconds)}`}
                    />
                  ) : (
                    <span key={`padding-${index}`} className="calendar-cell is-padding" aria-hidden="true" />
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

      <section className="chart-section" aria-labelledby="weekly-title">
        <div className="section-heading-row">
          <div>
            <h2 id="weekly-title">Daily study time</h2>
          </div>
        </div>
        <div className="chart" role="img" aria-label="Study time during the last seven days">
          {statistics.daily.map((day) => {
            const height = day.seconds > 0 ? Math.max((day.seconds / maxDailySeconds) * 100, 4) : 0
            return (
              <div className="chart-day" key={day.date}>
                <span className="chart-value">
                  {day.seconds > 0 ? formatDuration(day.seconds) : ''}
                </span>
                <div className="chart-track">
                  <div
                    className={day.seconds > 0 ? 'chart-bar has-time' : 'chart-bar'}
                    style={{ height: `${height}%` }}
                    title={`${day.seconds} seconds across ${day.sessions} sessions`}
                  />
                </div>
                <span className="chart-label">{formatDay(day.date)}</span>
              </div>
            )
          })}
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
