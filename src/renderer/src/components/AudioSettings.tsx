import { useEffect, useState } from 'react'

type AudioSettingsValue = Awaited<ReturnType<Window['api']['getAudioSettings']>>
type AudioAppInfo = Awaited<ReturnType<Window['api']['listAudioApps']>>['apps'][number]

interface AudioAppRow extends AudioAppInfo {
  running: boolean
}

interface AudioSettingsProps {
  active: boolean
}

const appRefreshIntervalMs = 3000

function AudioSettings({ active }: AudioSettingsProps): React.JSX.Element {
  const [settings, setSettings] = useState<AudioSettingsValue | null>(null)
  const [detectedApps, setDetectedApps] = useState<AudioAppInfo[]>([])
  const [isSupported, setIsSupported] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    window.api
      .getAudioSettings()
      .then(setSettings)
      .catch(() => setError('Unable to load audio settings.'))
  }, [])

  // The list of applications is refreshed while this tab is open, since apps come and go.
  useEffect(() => {
    if (!active) return
    let cancelled = false

    const refresh = (): void => {
      window.api
        .listAudioApps()
        .then((list) => {
          if (cancelled) return
          setIsSupported(list.supported)
          setDetectedApps(list.apps)
          setError('')
        })
        .catch((listError: unknown) => {
          if (!cancelled) {
            setError(
              listError instanceof Error && listError.message
                ? listError.message
                : 'Unable to list applications.'
            )
          }
        })
    }

    refresh()
    const timer = setInterval(refresh, appRefreshIntervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [active])

  const save = async (changes: Partial<AudioSettingsValue>): Promise<void> => {
    setIsSaving(true)
    try {
      setSettings(await window.api.setAudioSettings(changes))
      setError('')
    } catch {
      setError('Unable to save audio settings.')
    } finally {
      setIsSaving(false)
    }
  }

  const selectedApps = settings?.apps ?? []
  const rowsByExe = new Map<string, AudioAppRow>()
  for (const app of detectedApps) {
    rowsByExe.set(app.exe.toLowerCase(), { ...app, running: true })
  }
  // Keep saved selections visible (and removable) even when the application isn't running.
  for (const app of selectedApps) {
    if (!rowsByExe.has(app.exe.toLowerCase())) {
      rowsByExe.set(app.exe.toLowerCase(), { ...app, playing: false, running: false })
    }
  }
  const rows = [...rowsByExe.values()].sort(
    (first, second) =>
      Number(second.playing) - Number(first.playing) || first.name.localeCompare(second.name)
  )
  const isSelected = (exe: string): boolean =>
    selectedApps.some((app) => app.exe.toLowerCase() === exe.toLowerCase())

  const toggleApp = (app: AudioAppRow, checked: boolean): void => {
    const apps = checked
      ? [...selectedApps, { exe: app.exe, name: app.name }]
      : selectedApps.filter((selected) => selected.exe.toLowerCase() !== app.exe.toLowerCase())
    void save({ apps })
  }

  return (
    <div className="audio-settings">
      <h1 id="audio-settings-title">Settings</h1>

      <div className="tooltip-host">
        <label className="toggle-row">
          <input
            aria-describedby="always-listen-tooltip"
            checked={settings?.alwaysListen ?? false}
            disabled={!settings || isSaving}
            onChange={(event) => void save({ alwaysListen: event.target.checked })}
            role="switch"
            type="checkbox"
          />
          <span>Always listen to audio</span>
        </label>
        <span className="tooltip" id="always-listen-tooltip" role="tooltip">
          Resumes the timer whenever audio in the target languages is heard.
        </span>
      </div>

      <fieldset
        aria-labelledby="audio-apps-title"
        className="setting-group audio-apps"
        disabled={!settings || isSaving || !isSupported}
      >
        <legend id="audio-apps-title">Applications to listen to</legend>
        <p className="settings-message">
          {isSupported
            ? 'Only the checked applications are heard. With none checked, all system audio is used. Applications appear here once they have played sound.'
            : 'Listening to specific applications needs Windows 10 version 2004 or later.'}
        </p>
        {isSupported && (
          <div className="setting-list">
            {rows.length === 0 && <p className="settings-message">No applications found yet.</p>}
            {rows.map((app) => (
              <label className="setting-row" key={app.exe.toLowerCase()}>
                <input
                  checked={isSelected(app.exe)}
                  onChange={(event) => toggleApp(app, event.target.checked)}
                  type="checkbox"
                />
                <span className="audio-app-name">{app.name}</span>
                <span className="audio-app-status">
                  {!app.running ? 'Not running' : app.playing ? 'Playing audio' : 'Idle'}
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export default AudioSettings
