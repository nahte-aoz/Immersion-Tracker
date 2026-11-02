import { useState } from 'react'

type TimerStatistics = Awaited<ReturnType<Window['api']['getTimerStatistics']>>

type Range = 'day' | 'week' | 'month' | 'quarter' | 'year'

const ranges: Array<{ id: Range; label: string; days: number }> = [
  { id: 'day', label: '1 day', days: 1 },
  { id: 'week', label: '7 days', days: 7 },
  { id: 'month', label: '1 month', days: 30 },
  { id: 'quarter', label: '3 months', days: 90 },
  { id: 'year', label: '1 year', days: 365 }
]

interface Bar {
  label: string
  seconds: number
}

const width = 760
const height = 300
const margin = { top: 14, right: 62, bottom: 30, left: 52 }
const plotWidth = width - margin.left - margin.right
const plotHeight = height - margin.top - margin.bottom

const toDateKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

const formatDuration = (seconds: number): string => {
  const rounded = Math.round(seconds)
  if (rounded < 60) return `${rounded} sec`
  const totalMinutes = Math.floor(rounded / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours === 0 ? `${totalMinutes} min` : `${hours} hr ${minutes} min`
}

// A round step (1, 2, 5 x 10^n) so the axis ends on a tidy value.
const niceStep = (max: number, targetTicks: number): number => {
  const raw = max / targetTicks
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalised = raw / magnitude
  return (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10) * magnitude
}

interface Axis {
  unit: string
  perUnit: number
  max: number
  ticks: number[]
}

const buildAxis = (maxSeconds: number): Axis => {
  const [unit, perUnit] =
    maxSeconds >= 3600 ? ['hr', 3600] : maxSeconds >= 60 ? ['min', 60] : ['sec', 1]
  const step = niceStep(Math.max(maxSeconds / perUnit, 1), 4)
  const top = Math.max(step, Math.ceil(maxSeconds / perUnit / step) * step)
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step)
  return { unit, perUnit, max: top, ticks }
}

function StudyChart({ statistics }: { statistics: TimerStatistics }): React.JSX.Element {
  const [range, setRange] = useState<Range>('week')
  const selected = ranges.find((option) => option.id === range) ?? ranges[1]

  const bars: Bar[] =
    range === 'day'
      ? statistics.hourly.map((seconds, hour) => ({ label: `${hour}:00`, seconds }))
      : (() => {
          const secondsByDate = new Map(statistics.calendar.map((day) => [day.date, day.seconds]))
          const today = new Date()
          today.setHours(0, 0, 0, 0)
          return Array.from({ length: selected.days }, (_, index) => {
            const date = new Date(today)
            date.setDate(today.getDate() - (selected.days - 1 - index))
            return {
              label: new Intl.DateTimeFormat('en-US', {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                year: 'numeric'
              }).format(date),
              seconds: secondsByDate.get(toDateKey(date)) ?? 0
            }
          })
        })()

  const total = bars.reduce((sum, bar) => sum + bar.seconds, 0)
  const studied = bars.filter((bar) => bar.seconds > 0).length
  const axis = buildAxis(Math.max(...bars.map((bar) => bar.seconds), 1))
  const slot = plotWidth / bars.length
  const barWidth = Math.max(1, slot * 0.78)
  const yOf = (seconds: number): number =>
    margin.top + plotHeight - (seconds / (axis.max * axis.perUnit)) * plotHeight

  // Running total, drawn behind the bars and read against the right-hand axis.
  let running = 0
  const cumulative = bars.map((bar, index) => {
    running += bar.seconds
    return {
      x: margin.left + slot * index + slot / 2,
      y: margin.top + plotHeight - (total > 0 ? (running / total) * plotHeight : 0)
    }
  })
  const areaPath =
    total > 0
      ? `M${margin.left},${margin.top + plotHeight} ${cumulative.map((p) => `L${p.x},${p.y}`).join(' ')} L${cumulative[cumulative.length - 1].x},${margin.top + plotHeight} Z`
      : ''

  const xTickEvery = range === 'day' ? 3 : Math.ceil(bars.length / (range === 'week' ? 7 : 6))
  const unitLabel = range === 'day' ? 'hours' : 'days'
  const average = bars.length ? total / bars.length : 0

  return (
    <section className="study-chart" aria-labelledby="study-chart-title">
      <h2 id="study-chart-title">Study time</h2>
      <p className="study-chart-subtitle">The time you have spent studying.</p>
      <div className="range-options" role="radiogroup" aria-label="Time range">
        {ranges.map((option) => (
          <label key={option.id}>
            <input
              checked={range === option.id}
              name="stats-range"
              onChange={() => setRange(option.id)}
              type="radio"
            />
            {option.label}
          </label>
        ))}
      </div>

      <svg
        aria-label={`Study time over the last ${selected.label}`}
        className="study-chart-svg"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        {axis.ticks.map((tick) => (
          <g key={tick}>
            <line
              className="chart-grid"
              x1={margin.left}
              x2={margin.left + plotWidth}
              y1={yOf(tick * axis.perUnit)}
              y2={yOf(tick * axis.perUnit)}
            />
            <text
              className="chart-axis"
              textAnchor="end"
              x={margin.left - 8}
              y={yOf(tick * axis.perUnit) + 4}
            >
              {tick}
              {tick === axis.ticks[axis.ticks.length - 1] ? ` ${axis.unit}` : ''}
            </text>
          </g>
        ))}

        {areaPath && <path className="chart-cumulative" d={areaPath} />}
        {[0, 0.5, 1].map((fraction) => (
          <text
            className="chart-axis"
            key={fraction}
            x={margin.left + plotWidth + 8}
            y={margin.top + plotHeight - fraction * plotHeight + 4}
          >
            {total > 0
              ? formatDuration(total * fraction)
                  .replace(' min', 'm')
                  .replace(' hr ', 'h ')
                  .replace(' sec', 's')
              : '0'}
          </text>
        ))}

        {bars.map((bar, index) => {
          const top = yOf(bar.seconds)
          return (
            <rect
              className="chart-bar-rect"
              height={Math.max(0, margin.top + plotHeight - top)}
              key={index}
              width={barWidth}
              x={margin.left + slot * index + (slot - barWidth) / 2}
              y={top}
            >
              <title>{`${bar.label}: ${formatDuration(bar.seconds)}`}</title>
            </rect>
          )
        })}

        {bars.map((bar, index) =>
          index % xTickEvery === 0 || index === bars.length - 1 ? (
            <text
              className="chart-axis"
              key={`x-${index}`}
              textAnchor="middle"
              x={margin.left + slot * index + slot / 2}
              y={height - 8}
            >
              {range === 'day' ? bar.label : index - bars.length + 1}
            </text>
          ) : null
        )}
      </svg>

      <dl className="study-chart-summary">
        <dt>{range === 'day' ? 'Hours studied:' : 'Days studied:'}</dt>
        <dd>
          {studied} of {bars.length} ({((studied / bars.length) * 100).toFixed(2)}%)
        </dd>
        <dt>Total:</dt>
        <dd>{formatDuration(total)}</dd>
        <dt>Average over period:</dt>
        <dd>
          {formatDuration(average)}/{unitLabel === 'days' ? 'day' : 'hour'}
        </dd>
        <dt>{`Average for ${unitLabel} studied:`}</dt>
        <dd>
          {formatDuration(studied ? total / studied : 0)}/{unitLabel === 'days' ? 'day' : 'hour'}
        </dd>
      </dl>
    </section>
  )
}

export default StudyChart
