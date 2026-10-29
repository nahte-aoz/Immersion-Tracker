import React, { useState, useEffect } from 'react'

const Timer: React.FC = () => {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    window.api.getSeconds().then(setSeconds)
    return window.api.onTick(setSeconds)
  }, [])

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainingSeconds = seconds % 60
  const time = [hours, minutes, remainingSeconds]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')

  return <div aria-label={`${seconds} seconds elapsed`}>{time}</div>
}

export default Timer