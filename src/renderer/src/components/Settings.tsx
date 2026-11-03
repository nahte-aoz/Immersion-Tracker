import { useEffect, useState } from 'react'

type GeneralSettings = Awaited<ReturnType<Window['api']['getGeneralSettings']>>
type AudioSettings = Awaited<ReturnType<Window['api']['getAudioSettings']>>
type OcrLanguageCode = Awaited<ReturnType<Window['api']['getOcrLanguages']>>[number]
type OcrLanguageOption = Awaited<ReturnType<Window['api']['getSupportedOcrLanguages']>>[number]

function Settings(): React.JSX.Element {
  const [options, setOptions] = useState<OcrLanguageOption[]>([])
  const [selectedLanguages, setSelectedLanguages] = useState<OcrLanguageCode[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')
  const [general, setGeneral] = useState<GeneralSettings | null>(null)
  const [audio, setAudio] = useState<AudioSettings | null>(null)

  useEffect(() => {
    Promise.all([window.api.getGeneralSettings(), window.api.getAudioSettings()])
      .then(([generalSettings, audioSettings]) => {
        setGeneral(generalSettings)
        setAudio(audioSettings)
      })
      .catch(() => setError('Unable to load settings.'))
  }, [])

  const saveGeneral = async (changes: Partial<GeneralSettings>): Promise<void> => {
    setGeneral((current) => (current ? { ...current, ...changes } : current))
    try {
      setGeneral(await window.api.setGeneralSettings(changes))
    } catch {
      setError('Unable to save settings.')
    }
  }

  const saveAlwaysListen = async (alwaysListen: boolean): Promise<void> => {
    setAudio((current) => (current ? { ...current, alwaysListen } : current))
    try {
      setAudio(await window.api.setAudioSettings({ alwaysListen }))
    } catch {
      setError('Unable to save settings.')
    }
  }

  useEffect(() => {
    let active = true
    Promise.all([window.api.getSupportedOcrLanguages(), window.api.getOcrLanguages()])
      .then(([availableLanguages, savedLanguages]) => {
        if (!active) return
        setOptions(availableLanguages)
        setSelectedLanguages(savedLanguages)
      })
      .catch(() => {
        if (active) setError('Unable to load OCR language settings.')
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  const updateLanguage = async (language: OcrLanguageCode, checked: boolean): Promise<void> => {
    const nextLanguages = checked
      ? [...selectedLanguages, language]
      : selectedLanguages.filter((selected) => selected !== language)

    if (nextLanguages.length === 0) {
      setError('Select at least one OCR language.')
      return
    }

    setError('')
    setIsSaving(true)
    try {
      setSelectedLanguages(await window.api.setOcrLanguages(nextLanguages))
    } catch {
      setError('Unable to save OCR languages.')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section className="settings-view" aria-labelledby="settings-title">
      <h1 id="settings-title">Settings</h1>
      <div className="general-settings">
        <label className="toggle-row">
          <input
            checked={general?.minimizeToTray ?? false}
            disabled={!general}
            onChange={(event) => void saveGeneral({ minimizeToTray: event.target.checked })}
            role="switch"
            type="checkbox"
          />
          <span>Minimize to tray</span>
        </label>
                <label className="toggle-row">
          <input
            checked={general?.runOcrOnStart ?? false}
            disabled={!general}
            onChange={(event) => void saveGeneral({ runOcrOnStart: event.target.checked })}
            role="switch"
            type="checkbox"
          />
          <span>Run OCR on start</span>
        </label>
        <div className="tooltip-host">
          <label className="toggle-row">
            <input
              aria-describedby="always-listen-tooltip"
              checked={audio?.alwaysListen ?? false}
              disabled={!audio}
              onChange={(event) => void saveAlwaysListen(event.target.checked)}
              role="switch"
              type="checkbox"
            />
            <span>Always listen to audio</span>
          </label>
          <span className="tooltip" id="always-listen-tooltip" role="tooltip">
            Always resumes the timer whenever audio in the target languages is heard
          </span>
        </div>
      </div>

      <details className="setting-collapsible">
        <summary>OCR languages</summary>
        <fieldset className="setting-group" disabled={isLoading || isSaving}>
          <div className="setting-list">
            {options.map((option) => (
              <label className="setting-row" key={option.code}>
                <input
                  checked={selectedLanguages.includes(option.code)}
                  onChange={(event) => void updateLanguage(option.code, event.target.checked)}
                  type="checkbox"
                />
                <span>{option.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </details>
      {isLoading && <p className="settings-message">Loading...</p>}
      {isSaving && <p className="settings-message">Saving...</p>}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

export default Settings
