import workletUrl from './pcmCaptureWorklet.js?url&no-inline'

interface CaptureHandlers {
  onFrames: (samples: Float32Array) => void
  onEnded: () => void
}

// Captures what Windows is playing (loopback, not the microphone) as 16 kHz mono PCM blocks.
// The main process answers getDisplayMedia with a loopback audio track; the screen video track
// that comes with it is stopped right away.
export class SystemAudioCapture {
  private stream: MediaStream | undefined
  private context: AudioContext | undefined

  async start(handlers: CaptureHandlers): Promise<void> {
    this.stop()

    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    stream.getVideoTracks().forEach((track) => track.stop())
    const audioTrack = stream.getAudioTracks()[0]
    if (!audioTrack) {
      stream.getTracks().forEach((track) => track.stop())
      throw new Error('Windows did not provide a system audio stream.')
    }
    this.stream = stream

    try {
      const context = new AudioContext({ sampleRate: 16000 })
      this.context = context
      await context.audioWorklet.addModule(workletUrl)

      const source = context.createMediaStreamSource(new MediaStream([audioTrack]))
      const capture = new AudioWorkletNode(context, 'pcm-capture', {
        numberOfOutputs: 1,
        outputChannelCount: [1]
      })
      capture.port.onmessage = (event: MessageEvent<Float32Array>) => handlers.onFrames(event.data)

      // The graph must reach the destination to be pulled; the gain keeps it inaudible.
      const mute = context.createGain()
      mute.gain.value = 0
      source.connect(capture)
      capture.connect(mute)
      mute.connect(context.destination)

      audioTrack.addEventListener('ended', () => {
        if (this.stream === stream) handlers.onEnded()
      })
    } catch (error) {
      this.stop()
      throw error
    }
  }

  stop(): void {
    const stream = this.stream
    const context = this.context
    this.stream = undefined
    this.context = undefined
    stream?.getTracks().forEach((track) => track.stop())
    void context?.close().catch(() => undefined)
  }
}
