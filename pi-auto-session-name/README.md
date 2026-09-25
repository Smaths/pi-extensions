# Pi auto session name

Names a new, unnamed Pi session after the first text-only user prompt, once the
first agent run settles. Resumed and manually named sessions are never renamed.
Names are short (at most 40 characters), and the default heuristic runs entirely
locally: it does not send the prompt to another model.

Install with `pi install --local ./pi-auto-session-name` from the repository root,
or load temporarily with `pi -e ./pi-auto-session-name`.

For long or ambiguous prompts only, opt in to a separate, low-effort model call:

```sh
PI_AUTO_SESSION_NAME_MODE=hybrid pi -e ./pi-auto-session-name
```

The default model is `openai/gpt-6-luna`; override with
`PI_AUTO_SESSION_NAME_MODEL=provider/model-id`. Pi must list the model and have
configured authentication. Hybrid mode sends up to 1,200 characters of the
first text prompt to that provider. If unavailable, unauthenticated, timed out,
or unsuccessful, it uses the local title. The active model and conversation are
unchanged. Set the environment variables before launching Pi.
