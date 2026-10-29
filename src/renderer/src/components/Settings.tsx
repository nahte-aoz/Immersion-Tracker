import { useEffect, useState } from 'react'

type OcrLanguageCode = Awaited<ReturnType<Window['api']['getOcrLanguages']>>[number]
type OcrLanguageOption = Awaited<ReturnType<Window['api']['getSupportedOcrLanguages']>>[number]

function Settings(): React.JSX.Element {
  const [options, setOptions] = useState<OcrLanguageOption[]>([])
  const [selectedLanguages, setSelectedLanguages] = useState<OcrLanguageCode[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')

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
      <fieldset className="setting-group" disabled={isLoading || isSaving}>
        <legend>OCR languages</legend>
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
