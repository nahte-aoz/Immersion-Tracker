import Timer from './components/Timer'
import Statistics from './components/Statistics'
import { useState } from 'react'

type Tab = 'study' | 'statistics'

function App(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<Tab>('study')
  const [isRunning, setIsRunning] = useState(false)

  const startTimer = async (): Promise<void> => {
    await window.api.startTimer()
    setIsRunning(true)
  }

  const stopTimer = async (): Promise<void> => {
    await window.api.stopTimer()
    setIsRunning(false)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"></div>
        <nav className="primary-nav" aria-label="Main navigation">
          <button
            className={activeTab === 'study' ? 'nav-tab is-active' : 'nav-tab'}
            onClick={() => setActiveTab('study')}
            type="button"
          >
            Study
          </button>
          <button
            className={activeTab === 'statistics' ? 'nav-tab is-active' : 'nav-tab'}
            onClick={() => setActiveTab('statistics')}
            type="button"
          >
            Statistics
          </button>
        </nav>
      </header>

      <main className="main-content">
        {activeTab === 'study' ? (
          <section className="study-view" aria-labelledby="study-title">
            <h1 id="study-title">Study</h1>
            <div className="timer-panel">
              <div className="timer-reading">
                <Timer />
              </div>
              <div className="timer-actions">
                <button
                  className="button button-primary"
                  disabled={isRunning}
                  onClick={() => void startTimer()}
                  type="button"
                >
                  Start session
                </button>
                <button
                  className="button button-secondary"
                  disabled={!isRunning}
                  onClick={() => void stopTimer()}
                  type="button"
                >
                  Stop and save
                </button>
              </div>
            </div>
          </section>
        ) : (
          <Statistics />
        )}
      </main>
    </div>
  )
}

export default App
