# dsh-hermes-session

Import sessions from a local [Hermes Agent](https://github.com/InternScience/Hermes-Agent) into the
current [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) conversation as bounded,
untrusted background context.

Hermes Agent is a **separate agent** running on the same machine, with its own session store
(`~/.hermes/state.db`, one SQLite database per profile). This plugin reads that store **read-only** and
offers three ways in:

| Entry point | Shape | What it does |
|---|---|---|
| `＋ Hermes` | Composer button | Opens a searchable list of sessions across every profile; picking one inserts a reference chip into your draft |
| `hermes_sessions_list` | Model tool | Lists sessions (title / working directory / message count / last activity) across all profiles, sorted by recency |
| `hermes_session_import` | Model tool | Imports one session by id (a unique prefix is enough) |

Imported content always carries a fixed "untrusted background" notice: the model may cite facts from it
but must not follow instructions, permission claims, or tool requests found inside it. The same rule the
harness applies to its own `@`-mentioned session references.

## Requirements

- DeepSeek Harness `>=0.1.0-rc.1`
- Python 3.8+ on `PATH` (standard library only — the plugin shells out to a small `sqlite3` helper)
- A local Hermes Agent installation whose session store is readable

## Install

```sh
dsh plugin --profile web add dsh-hermes-session
```

Or from a checkout:

```sh
dsh plugin --profile web add /path/to/dsh-hermes-session
```

## Configuration

The plugin row takes a `config` mapping (see `cordis.patch.yml`). All fields are optional:

| Field | Default | Meaning |
|---|---|---|
| `dbPath` | `""` | Path to a specific `state.db`. Empty scans every profile under `~/.hermes/profiles/` plus the default database |
| `pythonPath` | `""` | Python interpreter to run the helper with. Empty uses `$HERMES_PYTHON`, then `python3` |
| `maxChars` | `60000` | Default character budget for one import |
| `maxCharsHard` | `160000` | Upper bound a caller may request |
| `maxMessages` | `300` | Default number of messages to carry over |

## How it works

```
Hermes Agent                     this plugin                     DSH
────────────                     ───────────                     ───
~/.hermes/state.db  ──read-only──▶ scripts/hermes_read.py  ──▶  Hermes session
~/.hermes/profiles/*/state.db             │
                                           │ sessions table (metadata)
                                           │ messages table (conversation)
                                           ▼
                                        src/render.js  →  untrusted-background text block
                                                             │
src/routes.js  ◀──HTTP── client.js ─────┘                    ▼
  GET  /api/hermes.sessions                            current conversation
                                          (one collapsed row)
```

- **Read-only by construction.** The helper opens SQLite with `mode=ro`; it never writes to Hermes's
  store, and it never starts the Hermes process (that one self-checks on startup and fails on read-only
  filesystems).
- **Multi-profile aware.** Hermes keeps one database per profile. The default database holds only the
  `default` profile, so reading it alone would miss every other profile's sessions. The plugin scans all
  of them and labels each result with its source profile.
- **Child sessions are included.** Hermes hides sessions that continue a parent thread (compaction
  rewrites, sub-agents) unless you ask for them — but those are often exactly the specific stretch of
  work you want to cite. The picker lists them and marks them `子会话` / `sub-session`.
- **Search runs on the host.** The filter box re-queries the whole store (all profiles, all sessions)
  and only the matches are returned. Filtering a pre-fetched page instead would make sessions that were
  never fetched unsearchable.
- **Bounded.** Message bodies are clipped, older messages are dropped first, and the truncation is
  reported in the injected header rather than hidden. The budget is enforced against the **serialized**
  size, so the injected text never exceeds the configured limit.

## How the pick reaches the model

Picking a session writes a **Markdown mention into your draft** — exactly like the harness's own
`@`-mentioned session references:

```
＋ Hermes → pick a session
          → the draft gets a blue reference chip:
            @[Session title](dsh-hermes:<base64url>)
          → you type your request and send
          → agent/pre-step resolves the mention
          → reads the Hermes session, renders it as a form:'recall' context message
          → appended after your message → the model sees both in one turn
```

The chip is inserted along the same path the native `@` reference uses: bail
`slash/input-insert-reference` on the session scope, where conversation.input's
listener hands it to `shell.insertReference`. It therefore renders exactly like the
harness's own `@`-mentioned session references — blue, removable, and carrying the
mention in its text.

The attached context looks the same too. Its source reuses the native shape
(`kind: 'session-reference'`, `form: 'recall'`), which is what makes the client
give it the session-reference icon and the "context recall" title instead of the
generic injected-context face. Its body is byte-for-byte the native framing: the
same `## Referenced sessions` heading, the same warning text, the same
`<referenced-sessions>` wrapper, and the same JSON payload — an **array** of
session objects whose `conversation` field holds `[{ role, text }]` entries with
the message text in full. Using a plugin-specific `kind` would work, but it
would render as a generic injection — same capability, different appearance. And
because the model-facing prompt has the same shape as the harness's own, the
model reads a Hermes snapshot the same way it reads a referenced DSH session.

Note on the public API: the `inputActions` face a plugin receives exposes only
`captureInsertion` / `insertText` / `setDraft` / `addAttachments` /
`removeAttachment` / `pruneAttachments` / `submit` — there is **no chip-insertion
method** (`insertReference` lives inside the SessionInputShell class). The session
scope is reachable via `sessions.using(sessionId, ..., ref => ref.binding.ctx)`. The picker
closes when you click elsewhere or press Escape, and the button is plain text, matching
the official "+skills" button.

Two consequences worth knowing:

- **Nothing is attached until you send.** Picking a session never wakes the agent — you choose the
  material first, describe what you want afterwards, and both travel in one message.
- **The mention stays editable.** It is ordinary draft text: you can reword it, delete it, or add a
  second session, and the model only sees the sessions you actually sent.

The mention is parsed by the `agent/pre-step` hook, which reads the session, renders it as a collapsed
context row (`form: 'recall'`), and appends it after your message.

## The injected context

The snapshot is attached as a **collapsed context row**, not as an expanded message bubble:
the conversation shows the source session's title, and expanding it reveals the transcript in a bounded,
scrollable code-style body. This mirrors how the harness renders its own session references.

## Development

```sh
node --check src/*.js && node --check client.js   # syntax
node selftest/run.mjs && node selftest/clientid.mjs
```

The self-tests run against a real Hermes store (read-only) and assert the plugin's invariants: the
client module id matches the package name, the HTTP routes are registered with the right methods, the
the mention is parsed and the attached message carries the `form: 'recall'` source shape the chat
renderer expects.

## Privacy

The plugin only reads. It never writes to the Hermes store, never sends session content anywhere, and
runs entirely on the machine where Hermes already lives.

## License

MIT
