import { useEffect, useRef, useState } from 'react'
import { SystemAudioCapture } from '../audio/systemAudioCapture'
import AudioSettings from './AudioSettings'

type SpeechLanguageResult = Parameters<Parameters<Window['api']['onAudioResult']>[0]>[0]

interface AudioDetectionProps {
  active: boolean
}

const levelUpdateIntervalMs = 200
const maxRestartAttempts = 3
const languageNames = new Intl.DisplayNames(['en'], { type: 'language' })

const formatLanguage = (code: string): string => {
  try {
    return languageNames.of(code) ?? code
  } catch {
    return code
  }
}

// 0..1 meter position for an RMS level, on a dB scale (-60 dB .. 0 dB).
const toMeterLevel = (rms: number): number =>
  rms <= 0 ? 0 : Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60))

function AudioDetection({ active }: AudioDetectionProps): React.JSX.Element {
  const [isListening, setIsListening] = useState(false)
  const [level, setLevel] = useState(0)
  const [result, setResult] = useState<SpeechLanguageResult | null>(null)
  const [error, setError] = useState('')
  const isCapturingRef = useRef(false)
  const lastLevelUpdateRef = useRef(0)

  useEffect(() => {
    const capture = new SystemAudioCapture()

    const handleFrames = (samples: Float32Array): void => {
      if (!isCapturingRef.current) return
      window.api.sendAudioFrames(samples)

      const now = performance.now()
      if (now - lastLevelUpdateRef.current < levelUpdateIntervalMs) return
      lastLevelUpdateRef.current = now
      let sum = 0
      for (const sample of samples) sum += sample * sample
      setLevel(toMeterLevel(Math.sqrt(sum / samples.length)))
    }

    // If the stream drops (e.g. the output device changes), try to re-acquire it before giving up.
    const handleEnded = async (): Promise<void> => {
      for (let attempt = 1; attempt <= maxRestartAttempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
        if (!isCapturingRef.current) return
        try {
          await capture.start({ onFrames: handleFrames, onEnded: () => void handleEnded() })
          return
        } catch {
          // Try again.
        }
      }
      if (isCapturingRef.current) {
        window.api.reportAudioCaptureError('System audio capture was interrupted.')
      }
    }

    const stopCapture = (): void => {
      isCapturingRef.current = false
      capture.stop()
      setLevel(0)
    }

    const startCapture = async (): Promise<void> => {
      isCapturingRef.current = true
      try {
        await capture.start({ onFrames: handleFrames, onEnded: () => void handleEnded() })
      } catch (captureError) {
        stopCapture()
        window.api.reportAudioCaptureError(
          captureError instanceof Error && captureError.message
            ? `Unable to capture system audio: ${captureError.message}`
            : 'Unable to capture system audio.'
        )
      }
    }

    const unsubscribers = [
      window.api.onAudioCapture((capturing) => {
        if (capturing) void startCapture()
        else stopCapture()
      }),
      window.api.onAudioResult((speechResult) => {
        console.info('[speech-language]', speechResult)
        setResult(speechResult)
      }),
      window.api.onAudioLevel((rms) => setLevel(toMeterLevel(rms))),
      window.api.onAudioError(setError),
      window.api.onAudioStarted(() => setIsListening(true)),
      window.api.onAudioStopped(() => {
        setIsListening(false)
        stopCapture()
      })
    ]
    window.api
      .isAudioDetectionRunning()
      .then(setIsListening)
      .catch(() => undefined)
    // Listeners are in place, so the main process can start "always listen" or re-request capture.
    void window.api.audioRendererReady().catch(() => undefined)

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe())
      isCapturingRef.current = false
      capture.stop()
    }
  }, [])

  const startListening = async (): Promise<void> => {
    setError('')
    setResult(null)
    setIsListening(true)
    try {
      await window.api.startAudioDetection()
    } catch {
      setIsListening(false)
      setError('Audio detection failed to start.')
    }
  }

  const stopListening = async (): Promise<void> => {
    await window.api.stopAudioDetection()
    setIsListening(false)
  }

  return (
    <section className="audio-view" aria-labelledby="audio-title" hidden={!active}>
      <h1 id="audio-title">Audio</h1>
      <div className="ocr-actions">
        {isListening ? (
          <button
            className="button button-secondary"
            onClick={() => void stopListening()}
            type="button"
          >
            Stop listening
          </button>
        ) : (
          <button
            className="button button-primary"
            onClick={() => void startListening()}
            type="button"
          >
            Start listening
          </button>
        )}
      </div>

      <p className="ocr-hint">
        Listens to the sound your computer is playing, not the microphone. Everything is analysed on
        this device and no audio is saved or uploaded.
      </p>

      {isListening && (
        <>
          <div
            aria-label="System audio level"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(level * 100)}
            className="audio-meter"
            role="meter"
          >
            <span className="audio-meter-fill" style={{ width: `${level * 100}%` }} />
          </div>
          <p className="ocr-status" aria-live="polite">
            Listening to system audio. Speech in a selected language starts study-time tracking.
          </p>
        </>
      )}
      {error && (
        <p className="ocr-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="ocr-result" aria-live="polite">
          <div className="ocr-result-language">{formatLanguage(result.language)}</div>
          <p>
            {result.confidence}% confidence
            {result.isTarget ? ' — counts toward study time' : ' — not a selected language'}
          </p>
        </div>
      )}
      <AudioSettings active={active} />
    </section>
  )
}

export default AudioDetection
