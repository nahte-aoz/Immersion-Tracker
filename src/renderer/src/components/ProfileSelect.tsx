import { useEffect, useState } from 'react'

type LanguageOption = Awaited<ReturnType<Window['api']['getSupportedOcrLanguages']>>[number]

interface ProfileSelectProps {
  // Changes when the user may have edited the Settings languages (e.g. the tab changed).
  refreshKey: string
}

// Picks the language profile: "All" tracks every language selected in Settings, otherwise only
// the chosen language is detected and tracked (OCR and audio).
function ProfileSelect({ refreshKey }: ProfileSelectProps): React.JSX.Element {
  const [profile, setProfile] = useState('all')
  const [languages, setLanguages] = useState<LanguageOption[]>([])

  useEffect(() => {
    let active = true
    Promise.all([
      window.api.getSupportedOcrLanguages(),
      window.api.getOcrLanguages(),
      window.api.getActiveProfile()
    ])
      .then(([options, selected, activeProfile]) => {
        if (!active) return
        setLanguages(options.filter((option) => selected.includes(option.code)))
        setProfile(activeProfile)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [refreshKey])

  useEffect(() => window.api.onProfileChanged(setProfile), [])

  return (
    <label className="profile-select">
      <span>Profile</span>
      <select
        onChange={(event) => {
          setProfile(event.target.value)
          void window.api.setActiveProfile(event.target.value)
        }}
        value={profile}
      >
        <option value="all">All</option>
        {languages.map((language) => (
          <option key={language.code} value={language.code}>
            {language.name}
          </option>
        ))}
      </select>
    </label>
  )
}

export default ProfileSelect
