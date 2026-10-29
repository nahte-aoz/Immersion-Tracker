import React, { useState, useEffect } from 'react'

const Timer: React.FC = () => {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    window.api.getSeconds().then(setSeconds)
    return window.api.onTick(setSeconds)
  }, [])

  return <div>{seconds} seconds</div>
}

export default Timer