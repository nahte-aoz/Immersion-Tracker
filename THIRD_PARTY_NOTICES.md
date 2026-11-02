# Third-party notices

Immersion Tracker bundles and depends on the following open-source software. Each component is
used under its own license; the license text of each is available at the linked upstream
repository and, where noted, shipped inside the installed application.

## Bundled programs and models

### OwOCR — GNU GPL v3.0
- Project: https://github.com/AuroraWright/owocr — © AuroraWright and contributors.
- Version bundled: **1.26.8**, the unmodified prebuilt Windows release
  (`owocr-windows.zip`, SHA-256 `b095ae2ffbda9392300407decfbfb7d47ed0fa6502c91902ec419978b55df628`).
- Corresponding source code: https://github.com/AuroraWright/owocr/tree/1.26.8
- License text: installed as `resources\owocr\LICENSE.txt` (GPL-3.0).
- OwOCR runs as a separate program that Immersion Tracker starts and talks to over a local
  WebSocket; it is distributed alongside, not linked into, Immersion Tracker. OwOCR itself bundles
  further open-source Python packages, each under its own license (see the OwOCR repository and
  its dependency list).
- OwOCR's *OneOCR* engine uses the text-recognition component of Microsoft's Snipping Tool that is
  already installed on the user's Windows; Microsoft's component is not redistributed here.

### Whisper (language identification) — MIT / Apache-2.0
- OpenAI Whisper: https://github.com/openai/whisper — MIT License, © OpenAI.
- ONNX export `Xenova/whisper-base` (revision `64da57285918e20ea79ea5c88eed7197933abaa8`):
  https://huggingface.co/Xenova/whisper-base — Apache License 2.0.
- Installed with a notice at `resources\speech\NOTICE.txt`.

### Silero VAD (voice activity detection) — MIT
- https://github.com/snakers4/silero-vad (v6.2.3) — MIT License, © Silero Team.

## Libraries

| Component | License | Link |
| --- | --- | --- |
| Electron (includes Chromium and Node.js; their notices ship as `LICENSES.chromium.html`) | MIT | https://github.com/electron/electron |
| React / React DOM | MIT | https://github.com/facebook/react |
| ONNX Runtime (`onnxruntime-node`) | MIT | https://github.com/microsoft/onnxruntime |
| loopback-capture (WerdoxDev) | MIT | https://github.com/WerdoxDev/loopback-capture |
| better-sqlite3 | MIT | https://github.com/WiseLibs/better-sqlite3 |
| franc-min | MIT | https://github.com/wooorm/franc |
| electron-vite / Vite | MIT | https://github.com/alex8088/electron-vite |
| @electron-toolkit/* | MIT | https://github.com/alex8088/electron-toolkit |

## Inspiration

- [GameSentenceMiner](https://github.com/bpwhelan/GameSentenceMiner) (GPL-3.0) — the idea of
  OCR-driven immersion tracking and the README structure. No code from it is included.
- [Anki](https://github.com/ankitects/anki) — the statistics chart design. No code from it is
  included.

If you believe a notice is missing or incorrect, please open an issue.
