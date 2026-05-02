# Ask GPT for Chrome

Ask GPT for Chrome is an open-source Manifest V3 extension that brings a page-aware ChatGPT side panel to Chrome. It can read the current tab context, answer questions beside the page, run quick page-analysis prompts, accept voice input, and propose guarded page actions that always require user confirmation.

This project is built for people who want an Atlas-style "Ask ChatGPT about this page" workflow in regular Chrome while keeping the implementation inspectable and self-hostable.

## Features

- Page-aware chat using the current page title, URL, selected text, readable body text, and visible interactive elements.
- Chrome Side Panel UI, plus an optional in-page floating launcher.
- Quick prompts for summary, explanation, structured extraction, and reply drafting.
- Voice input through Chrome Web Speech when the browser and operating system grant microphone access.
- Guarded Agent mode for safe `navigate`, `click`, `fill`, and `scroll` proposals.
- Two auth paths: ChatGPT OAuth device-code login for the Codex backend, or OpenAI API Key mode for the public Responses API.
- Local-first development with no build step.

## Screenshots

Screenshots are not committed yet. Contributions that add current UI screenshots are welcome.

## Install From Source

1. Clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the cloned repository directory.
6. Open the extension options page.
7. Choose either ChatGPT OAuth or OpenAI API Key mode.

The extension is intended for unpacked local installation today. It is not currently published in the Chrome Web Store.

## Configuration

### ChatGPT OAuth

Open the options page, click **获取登录码**, copy the device code, and finish the login flow in the OpenAI authorization page. The extension stores tokens in Chrome extension storage on your machine.

### OpenAI API Key

Choose API Key mode in the options page, enter your key, select a model, and save. API Key mode calls the configured Responses API endpoint directly from the extension.

## Permissions

The extension requests these Chrome permissions:

- `activeTab`, `tabs`, and host access so it can read page context when you ask it to.
- `sidePanel` for the Chrome side-panel experience.
- `contextMenus` for selected-text entry points.
- `storage` for local settings and auth state.
- `contentSettings` so the extension can request microphone access for voice input.

The extension cannot read protected Chrome pages such as `chrome://extensions`, and it cannot add first-party controls inside Chrome's native toolbar area.

## Development

There is no package install step. The source is plain HTML, CSS, and JavaScript.

Run the validation script before committing:

```bash
./scripts/validate.sh
```

For a temporary Chromium profile with the extension loaded:

```bash
ASK_GPT_DEBUG_PORT=9227 ./scripts/dev-chromium.sh https://example.com
```

## Project Layout

- `manifest.json` - Chrome MV3 permissions, side panel, context menus, and content-script wiring.
- `auth.js` - ChatGPT OAuth device-code login, refresh, and local extension token storage.
- `background.js` - toolbar/context-menu routing and guarded page-action execution.
- `content.js` / `content.css` - page context extraction, floating launcher, and DOM action helpers.
- `sidepanel.*` - page-aware chat interface.
- `options.*` - auth, model, endpoint, and UI-entry settings.
- `scripts/validate.sh` - JSON and JavaScript syntax validation.

## Roadmap

- Add current screenshots and a short demo GIF.
- Add automated browser smoke tests for the side panel.
- Package releases for easier unpacked installation.
- Improve provider abstraction beyond the current ChatGPT OAuth and OpenAI API Key paths.

## Security

Please do not open public issues for sensitive security reports. See [SECURITY.md](SECURITY.md) for the reporting policy.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

MIT License. See [LICENSE](LICENSE).

## Disclaimer

This project is not affiliated with OpenAI, Google, Chrome, or ChatGPT Atlas. Product names are used only to describe interoperability and user-facing behavior.
