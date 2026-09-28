# Pi auto session name

Names a new, unnamed Pi session from its first user prompt as soon as the first
agent run starts, without delaying the run. Resumed and manually named sessions
are never renamed, and a `/name` set before the title arrives is kept.
Names use a minimal commit-style format: an action verb first, followed by up
to two words of context. They are capped at three words and 40 characters. For
every eligible prompt, the extension requests a concise rewrite from a separate
low-effort model. If that call fails, it falls back to a local title.

Only the prompt's text is used: attached images are ignored, and `/skill:name
args` or `/template args` is named from its arguments. A prompt with no usable
text (a bare command or an image alone) leaves the session unnamed until the
next prompt. If the session closes before the title model answers, the local
title is used.

Install with `pi install npm:@snarfum/pi-auto-session-name`, or install locally
with `pi install --local ./pi-auto-session-name` from the repository root. You
can load it temporarily with `pi -e ./pi-auto-session-name`.

The default title model is `openai-codex/gpt-6-luna`; override it by setting
`PI_AUTO_SESSION_NAME_MODEL=provider/model-id` before launching Pi. The title
prompt asks for an imperative verb-first name such as “Fix login timeout” rather
than copying request wording verbatim.

Pi must list the model and have configured authentication. **Every eligible first prompt
sends up to 1,200 characters of its text to the title model**, so avoid loading the
extension where that disclosure is inappropriate. If the model is unavailable,
unauthenticated, times out after five seconds, or fails, the local title is
used instead. This does not change the active conversation model or insert the
title request into the conversation.
