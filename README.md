# Pi Extensions

Small, independently installable [Pi](https://github.com/Badlogic/pi-mono)
extensions, including optional integrations for [Herdr](https://github.com/Smaths/herdr).

## Extensions

| Extension | Preview | Description |
| --- | --- | --- |
| [`@snarfum/pi-git-status`](pi-git-status/) | <img src="img/pi-git-status.png" alt="Pi Git status footer" width="360"> | Shows repository state, session usage, context usage, and the active model in Pi’s footer. This extension does not require Herdr. |
| [`@snarfum/pi-auto-session-name`](pi-auto-session-name/) | <img src="img/pi-auto-session-name.png" alt="Illustration of a prompt becoming a short session name" width="360"> | Names new sessions with a minimal, verb-first action title of up to three words. |
| [`@snarfum/pi-herdr-runtime-metadata`](pi-herdr-runtime-metadata/) | <img src="img/pi-herdr-runtime-metadata.png" alt="Herdr Pi runtime metadata" width="360"> | Reports Pi’s active model and thinking level as display-only Herdr metadata. |
| [`@snarfum/pi-herdr-session-name`](pi-herdr-session-name/) | <img src="img/pi-herdr-session-name.png" alt="Herdr Pi session name" width="360"> | Publishes Pi’s session name as the Herdr pane title and for an optional third Agent sidebar row. |

Each extension has its own `index.ts`, `package.json`, and concise README.
The two `pi-herdr-*` packages are the only Herdr-specific extensions.

## Installation

Install every extension from GitHub with Pi:

```sh
pi install git:github.com/Smaths/pi-extensions
```

Run `pi update --extensions` to pull the latest changes. To load only some
extensions, disable the others with `pi config`, or filter the package in
`~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/Smaths/pi-extensions",
      "extensions": ["pi-git-status/index.ts", "pi-auto-session-name/index.ts"]
    }
  ]
}
```

The Herdr extensions stay inactive outside Herdr, so installing them is harmless.

For local development, install one package from this repository with
`pi install --local ./<extension-directory>` or load it temporarily with
`pi -e ./<extension-directory>`.

## Local development

Link all extension packages into Pi’s extension directory:

```sh
./link-extensions.sh
```

The Herdr integrations are active only when Herdr sets `HERDR_ENV=1`,
`HERDR_SOCKET_PATH`, and `HERDR_PANE_ID`. Herdr manages the agent-state
integration; do not install a duplicate copy.

Each extension directory is also a standalone package that can be versioned
and published independently. The root `package.json` only exists for git
installs and must stay private.

## License

[MIT](LICENSE)
