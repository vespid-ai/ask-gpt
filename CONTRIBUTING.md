# Contributing

Thanks for helping improve Ask GPT for Chrome.

## Development Setup

1. Clone the repository.
2. Load it as an unpacked extension from `chrome://extensions`.
3. Make changes directly in the source files.
4. Reload the extension from `chrome://extensions`.
5. Run validation before opening a pull request:

```bash
./scripts/validate.sh
```

## Pull Request Guidelines

- Keep changes focused and explain the user-visible behavior in the PR body.
- Do not commit API keys, OAuth tokens, browser profiles, or generated local artifacts.
- Update `README.md` when changing setup, permissions, or major behavior.
- Prefer small, inspectable JavaScript changes over introducing a build system.

## Code Style

- Use plain JavaScript, HTML, and CSS.
- Keep browser-extension APIs behind clear helper functions when the behavior is non-obvious.
- Favor explicit user confirmation for actions that affect the current page.
