export type SpeechWorkerRequest =
  | { type: 'init'; modelDir: string }
  | { type: 'frames'; samples: Float32Array }
  // Capture these applications (by process id) in the worker instead of receiving frames.
  | { type: 'capture-apps'; pids: number[] }
  | { type: 'capture-stop' }
  | { type: 'reset' }

export type SpeechWorkerResponse =
  | { type: 'ready' }
  | { type: 'probe-start' }
  | {
      type: 'result'
      language: string
      confidence: number
      speechSeconds: number
      elapsedMs: number
    }
  | { type: 'level'; rms: number }
  | { type: 'capture-error'; message: string }
  | { type: 'error'; message: string }
