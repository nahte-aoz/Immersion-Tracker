import { useEffect, useRef, useState, type PointerEvent } from 'react'

type ScreenPreview = Awaited<ReturnType<Window['api']['getScreenPreview']>>
type ScreenRegion = Parameters<Window['api']['startScreenScan']>[0]
type ScreenOcrResult = Parameters<Parameters<Window['api']['onScreenScanResult']>[0]>[0]
type Point = { x: number; y: number }
type DraftSelection = { start: Point; current: Point }

interface ScreenOcrProps {
  active: boolean
}

function ScreenOcr({ active }: ScreenOcrProps): React.JSX.Element {
  const [preview, setPreview] = useState<ScreenPreview | null>(null)
  const [region, setRegion] = useState<ScreenRegion | null>(null)
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
    return () => {
      unsubscribeResult()
      unsubscribeResultLog()
      unsubscribeError()
    }
  }, [])

  const selectScreenArea = async (): Promise<void> => {
    setError('')
    setResult(null)
    setRegion(null)
    setDraft(null)
    setIsSelecting(false)
    try {
      setPreview(await window.api.getScreenPreview())
      setIsSelecting(true)
    } catch {
      setError('Unable to capture the primary screen.')
    }
  }

  const getPoint = (event: PointerEvent<HTMLImageElement>): Point | null => {
    const image = imageRef.current
    if (!preview || !image) return null
    const bounds = image.getBoundingClientRect()
    return {
      x: Math.max(
        0,
        Math.min(
          preview.width,
          Math.round(((event.clientX - bounds.left) * preview.width) / bounds.width)
        )
      ),
      y: Math.max(
        0,
        Math.min(
          preview.height,
          Math.round(((event.clientY - bounds.top) * preview.height) / bounds.height)
        )
      )
    }
  }

  const onPointerDown = (event: PointerEvent<HTMLImageElement>): void => {
    if (!isSelecting) return
    const point = getPoint(event)
    if (!point) return
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
    if (!draft || !preview) return
    const end = getPoint(event) ?? draft.current
    const nextRegion = {
      x: Math.min(draft.start.x, end.x),
      y: Math.min(draft.start.y, end.y),
      width: Math.abs(end.x - draft.start.x),
      height: Math.abs(end.y - draft.start.y)
    }
    setDraft(null)
    if (nextRegion.width < 8 || nextRegion.height < 8) {
      setError('Select a larger area.')
      return
    }
    if (nextRegion.width * nextRegion.height > preview.width * preview.height * 0.8) {
      setError('Select a smaller area around the text, not the full screen.')
      return
    }
    setError('')
    setRegion(nextRegion)
    setIsSelecting(false)
  }

  const startScanning = async (): Promise<void> => {
    if (!region) return
    setError('')
    setResult(null)
    setIsScanning(true)
    try {
      await window.api.startScreenScan(region)
    } catch {
      setIsScanning(false)
      setError('Screen scan failed to start.')
    }
  }

  const stopScanning = async (): Promise<void> => {
    await window.api.stopScreenScan()
    setIsScanning(false)
  }

  const selection = draft
    ? {
        x: Math.min(draft.start.x, draft.current.x),
        y: Math.min(draft.start.y, draft.current.y),
        width: Math.abs(draft.current.x - draft.start.x),
        height: Math.abs(draft.current.y - draft.start.y)
      }
    : region

  return (
    <section className="screen-ocr-view" aria-labelledby="screen-ocr-title" hidden={!active}>
      <h1 id="screen-ocr-title">Screen OCR</h1>
      <div className="ocr-actions">
        <button
          className="button button-secondary"
          disabled={isScanning}
          onClick={() => void selectScreenArea()}
          type="button"
        >
          Select area
        </button>
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
            disabled={!region}
            onClick={() => void startScanning()}
            type="button"
          >
            Start scanning
          </button>
        )}
      </div>

      {preview && (
        <div className="ocr-preview-wrap">
          <div className="screen-preview">
            <img
              ref={imageRef}
              alt="Primary screen preview"
              className={isSelecting ? 'screen-preview-image is-selecting' : 'screen-preview-image'}
              draggable={false}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              src={preview.dataUrl}
            />
            {selection && (
              <span
                className="screen-selection"
                style={{
                  left: `${(selection.x / preview.width) * 100}%`,
                  top: `${(selection.y / preview.height) * 100}%`,
                  width: `${(selection.width / preview.width) * 100}%`,
                  height: `${(selection.height / preview.height) * 100}%`
                }}
              />
            )}
          </div>
          {isSelecting && <p className="ocr-hint">Drag over the text area.</p>}
        </div>
      )}

      {isScanning && (
        <p className="ocr-status" aria-live="polite">
          Scanning live screen. Stop scanning to end.
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
