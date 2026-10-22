# dsh-hermes-session

Import sessions from a local [Hermes Agent](https://github.com/InternScience/Hermes-Agent) into the
current [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) conversation as bounded,
untrusted background context.

Hermes Agent is a **separate agent** running on the same machine, with its own session store
(`~/.hermes/state.db`, one SQLite database per profile). This plugin reads that store **read-only** and
offers three ways in:

| Entry point | Shape | What it does |
|---|---|---|
| `/hermes` | Slash command (interactive) | Opens a searchable list of sessions across every profile; pick one and it is imported into the current conversation |
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
  POST /api/hermes.import                                   (one collapsed row)
```

- **Read-only by construction.** The helper opens SQLite with `mode=ro`; it never writes to Hermes's
  store, and it never starts the Hermes process (that one self-checks on startup and fails on read-only
  filesystems).
- **Multi-profile aware.** Hermes keeps one database per profile. The default database holds only the
  `default` profile, so reading it alone would miss every other profile's sessions. The plugin scans all
  of them and labels each result with its source profile.
- **Bounded.** Message bodies are clipped, older messages are dropped first, and the truncation is
  reported in the injected header rather than hidden.

## The injected context

The imported snapshot is injected as a **collapsed context row**, not as an expanded message bubble:
the conversation shows the source session's title, and expanding it reveals the transcript in a bounded,
scrollable code-style body. This mirrors how the harness renders its own session references.

## Development

```sh
node --check src/*.js && node --check client.js   # syntax
node selftest/run.mjs && node selftest/clientid.mjs
```

The self-tests run against a real Hermes store (read-only) and assert the plugin's invariants: the
client module id matches the package name, the HTTP routes are registered with the right methods, the
import goes through `agent.steer()` (so it is consumed even when no turn is running), and the injected
message carries the `form: 'recall'` source shape the chat renderer expects.

## Privacy

The plugin only reads. It never writes to the Hermes store, never sends session content anywhere, and
runs entirely on the machine where Hermes already lives.

## License

MIT
