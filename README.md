# temp-electron-vite

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

## Screen OCR Languages

Set `IMMERSION_OCR_LANGUAGES` to a comma-separated list of Tesseract language model codes before launching. The default is `eng,jpn`.

```powershell
$env:IMMERSION_OCR_LANGUAGES = 'eng,jpn,rus'
npm run dev
```

While a live screen scan is running, recognized text in the selected OCR languages starts or renews study-time tracking, even when OCR recognizes the same wording again. A 20-second grace period absorbs slow OCR processing and brief missed frames; without another positive OCR result, tracking stops. Manual and OCR tracking share one clock, so overlapping activity is not double-counted. The Study tab's timer buttons reflect automatic OCR tracking, and "Stop and save" ends the timer and the active OCR scan.

If a screen area has been selected, starting a manual timer also starts OCR scanning unless a scan is already running. Stopping the timer stops the scan but keeps the selected area available for the next start.
