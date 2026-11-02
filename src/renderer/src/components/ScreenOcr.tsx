import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react'

type ScreenDisplay = Awaited<ReturnType<Window['api']['getScreenDisplays']>>[number]
type ScreenPreview = Awaited<ReturnType<Window['api']['getScreenPreview']>>
type ScreenArea = Parameters<Window['api']['setScreenAreas']>[1][number]
type ScreenOcrResult = Parameters<Parameters<Window['api']['onScreenScanResult']>[0]>[0]
type Point = { x: number; y: number }
type DraftSelection = { start: Point; current: Point }

interface ScreenOcrProps {
  active: boolean
}

// Areas below this size (in preview pixels) are treated as accidental clicks.
const minimumAreaPixels = 8
const fullScreenArea: ScreenArea = { x: 0, y: 0, width: 1, height: 1 }

const toArea = (first: Point, second: Point): ScreenArea => ({
  x: Math.min(first.x, second.x),
  y: Math.min(first.y, second.y),
  width: Math.abs(second.x - first.x),
  height: Math.abs(second.y - first.y)
})

function ScreenOcr({ active }: ScreenOcrProps): React.JSX.Element {
  const [displays, setDisplays] = useState<ScreenDisplay[]>([])
  const [displayId, setDisplayId] = useState<number | null>(null)
  const [areas, setAreas] = useState<ScreenArea[]>([])
  const [preview, setPreview] = useState<ScreenPreview | null>(null)
  const [draft, setDraft] = useState<DraftSelection | null>(null)
  const [isSelecting, setIsSelecting] = useState(false)
  const [isScanning, setIsScanning] = useState(false)
  const [result, setResult] = useState<ScreenOcrResult | null>(null)
  const [error, setError] = useState('')
  const imageRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    const unsubscribeResult = window.api.onScreenScanResult(setResult)
    const unsubscribeResultLog = window.api.onScreenScanResult((result) => {
      console.info('[screen-ocr]', result)
    })
    const unsubscribeError = window.api.onScreenScanError((message) => {
      setError(message)
    })
    const unsubscribeStopped = window.api.onScreenScanStopped(() => {
      setIsScanning(false)
    })
    const unsubscribeStarted = window.api.onScreenScanStarted(() => {
      setIsScanning(true)
    })
    return () => {
      unsubscribeResult()
      unsubscribeResultLog()
      unsubscribeError()
      unsubscribeStopped()
      unsubscribeStarted()
    }
  }, [])

  // A scan may already be running (e.g. started by "Run OCR on start" before this page loaded).
  useEffect(() => {
    window.api
      .isScreenScanRunning()
      .then(setIsScanning)
      .catch(() => undefined)
  }, [])

  // Saved monitor and areas persist across restarts.
  useEffect(() => {
    Promise.all([window.api.getScreenDisplays(), window.api.getScreenOcrSettings()])
      .then(([availableDisplays, settings]) => {
        const selected =
          availableDisplays.find((display) => display.id === settings.displayId) ??
          availableDisplays.find((display) => display.isPrimary) ??
          availableDisplays[0]
        setDisplays(availableDisplays)
        setDisplayId(selected?.id ?? null)
        setAreas(selected ? (settings.areas[String(selected.id)] ?? []) : [])
      })
      .catch(() => setError('Unable to load the screen settings.'))
  }, [])

  const saveAreas = (nextAreas: ScreenArea[]): void => {
    setAreas(nextAreas)
    if (displayId === null) return
    window.api.setScreenAreas(displayId, nextAreas).catch(() => {
      setError('Unable to save the selected screen areas.')
    })
  }

  const loadPreview = async (forDisplayId: number | null): Promise<boolean> => {
    try {
      setPreview(await window.api.getScreenPreview(forDisplayId))
      return true
    } catch {
      setError('Unable to capture the selected screen.')
      return false
    }
  }

  const startSelecting = async (): Promise<void> => {
    setError('')
    setResult(null)
    setDraft(null)
    setIsSelecting(await loadPreview(displayId))
  }

  const finishSelecting = (): void => {
    setIsSelecting(false)
    setDraft(null)
    setPreview(null)
  }

  const changeDisplay = async (nextDisplayId: number): Promise<void> => {
    setError('')
    setResult(null)
    setDraft(null)
    try {
      const settings = await window.api.setScreenDisplay(nextDisplayId)
      setDisplayId(nextDisplayId)
      setAreas(settings.areas[String(nextDisplayId)] ?? [])
      if (isSelecting) await loadPreview(nextDisplayId)
    } catch {
      setError('Unable to switch screens.')
    }
  }

  // Ctrl + A selects the whole screen.
  useEffect(() => {
    if (!active || !isSelecting || isScanning) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setError('')
        saveAreas([fullScreenArea])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, isSelecting, isScanning, displayId])

  const getPoint = (event: PointerEvent<HTMLImageElement>): Point | null => {
    const image = imageRef.current
    if (!image) return null
    const bounds = image.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
    }
  }

  const onPointerDown = (event: PointerEvent<HTMLImageElement>): void => {
    if (!isSelecting || isScanning) return
    const point = getPoint(event)
    if (!point) return

    // Right click deletes the topmost (most recently drawn) area under the cursor.
    if (event.button === 2) {
      event.preventDefault()
      const index = areas.findLastIndex(
        (area) =>
          point.x >= area.x &&
          point.x <= area.x + area.width &&
          point.y >= area.y &&
          point.y <= area.y + area.height
      )
      if (index >= 0) saveAreas(areas.filter((_, areaIndex) => areaIndex !== index))
      return
    }

    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDraft({ start: point, current: point })
  }

  const onPointerMove = (event: PointerEvent<HTMLImageElement>): void => {
    if (!draft) return
    const point = getPoint(event)
    if (point) setDraft({ ...draft, current: point })
  }

  const onPointerUp = (event: PointerEvent<HTMLImageElement>): void => {
    if (!draft || !preview || event.button !== 0) return
    const area = toArea(draft.start, getPoint(event) ?? draft.current)
    setDraft(null)
    if (
      area.width * preview.width < minimumAreaPixels ||
      area.height * preview.height < minimumAreaPixels
    ) {
      setError('Select a larger area.')
      return
    }
    setError('')
    saveAreas([...areas, area])
  }

  const onContextMenu = (event: MouseEvent<HTMLImageElement>): void => event.preventDefault()

  const startScanning = async (): Promise<void> => {
    if (areas.length === 0) return
    setError('')
    setResult(null)
    setIsScanning(true)
    try {
      await window.api.startScreenScan()
    } catch {
      setIsScanning(false)
      setError('Screen scan failed to start.')
    }
  }

  const stopScanning = async (): Promise<void> => {
    await window.api.stopScreenScan()
    setIsScanning(false)
  }

  const draftArea = draft ? toArea(draft.start, draft.current) : null
  const canEdit = isSelecting && !isScanning

  return (
    <section className="screen-ocr-view" aria-labelledby="screen-ocr-title" hidden={!active}>
      <h1 id="screen-ocr-title">Screen OCR</h1>
      <div className="ocr-actions">
        <label className="monitor-select">
          <span>Monitor</span>
          <select
            disabled={isScanning || displays.length === 0}
            onChange={(event) => void changeDisplay(Number(event.target.value))}
            value={displayId ?? ''}
          >
            {displays.map((display) => (
              <option key={display.id} value={display.id}>
                {display.label} ({display.width}×{display.height}
                {display.isPrimary ? ', primary' : ''})
              </option>
            ))}
          </select>
        </label>
        {isSelecting ? (
          <button className="button button-secondary" onClick={finishSelecting} type="button">
            Save and Close
          </button>
        ) : (
          <button
            className="button button-tertiary"
            disabled={isScanning}
            onClick={() => void startSelecting()}
            type="button"
          >
            Select areas
          </button>
        )}
        {isScanning ? (
          <button
            className="button button-secondary"
            onClick={() => void stopScanning()}
            type="button"
          >
            Stop scanning
          </button>
        ) : (
          <button
            className="button button-primary"
            disabled={areas.length === 0}
            onClick={() => void startScanning()}
            type="button"
          >
            Start scanning
          </button>
        )}
      </div>
      <p className="ocr-hint">
        {areas.length === 0
          ? 'No areas selected for this monitor.'
          : `${areas.length} area${areas.length === 1 ? '' : 's'} selected on this monitor.`}
      </p>

      {preview && (
        <div className="ocr-preview-wrap">
          <div className="screen-preview">
            <img
              ref={imageRef}
              alt="Screen preview"
              className={canEdit ? 'screen-preview-image is-selecting' : 'screen-preview-image'}
              draggable={false}
              onContextMenu={onContextMenu}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              src={preview.dataUrl}
            />
            {areas.map((area, index) => (
              <span
                className="screen-selection"
                key={`${index}-${area.x}-${area.y}`}
                style={{
                  left: `${area.x * 100}%`,
                  top: `${area.y * 100}%`,
                  width: `${area.width * 100}%`,
                  height: `${area.height * 100}%`
                }}
              />
            ))}
            {draftArea && (
              <span
                className="screen-selection is-draft"
                style={{
                  left: `${draftArea.x * 100}%`,
                  top: `${draftArea.y * 100}%`,
                  width: `${draftArea.width * 100}%`,
                  height: `${draftArea.height * 100}%`
                }}
              />
            )}
            {canEdit && (
              <div className="selection-guide">
                <strong>Controls</strong>
                <ul>
                  <li>
                    <kbd>Left Click</kbd> + drag to create selection areas
                  </li>
                  <li>
                    <kbd>Ctrl</kbd> + <kbd>A</kbd> to select the full screen
                  </li>
                  <li>
                    <kbd>Right Click</kbd> an area to delete it
                  </li>
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {isScanning && (
        <p className="ocr-status" aria-live="polite">
          Scanning live screen. New selected-language text starts study-time tracking.
        </p>
      )}
      {error && (
        <p className="ocr-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="ocr-result" aria-live="polite">
          <div className="ocr-result-language">{result.language}</div>
          <p>{result.text}</p>
        </div>
      )}
    </section>
  )
}

export default ScreenOcr
