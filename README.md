# muse-bridge

A local MCP server that lets Claude Code send prompts to the [muse.ai](https://muse.ai) chat and get back a
summary of each reply. It drives your own logged-in Muse web session in a dedicated Chromium browser through
Playwright. Claude Code never sees Muse's raw text: a separate tool-less `claude -p` run summarizes it, and you
read the raw reply next to that summary in a local viewer.

```
Claude Code ──stdio MCP──> muse-bridge ──Playwright──> Chromium (own profile, hidden Xvfb display) ──> muse.ai

Each reply, in muse-bridge:
  raw reply ──> claude -p (no tools) ──> summary ──> Claude Code
  raw reply + summary ──> viewer on 127.0.0.1 ──> you
```

It is built for one person using their own account at a human pace. It does not rotate accounts, pull out
cookies or tokens, or work around captchas or rate limits.

## ⚠️ The browser profile holds your Facebook session

Logging in to Muse goes through facebook.com, so `~/.muse-bridge/profile` ends up holding both a Muse and a
**Facebook** session. The bridge creates the folder with mode `700` (owner only). Treat it like a password.
Don't copy it, sync it, or put it in git. To sign out completely, delete the folder.

Other protections, since the same browser carries both sessions:

- Every folder under `~/.muse-bridge` is `700`, and the files the bridge writes there (`bridge.log`, debug
  screenshots, discovery dumps) are `600`.
- Never set `MUSE_HOME` to a folder inside a git repo. `.gitignore` covers the usual names as a backstop.
- `MUSE_URL` must be `https` and must not point at facebook.com. The bridge refuses to start otherwise.
- Chromium gets only the environment variables it needs (display, locale, fonts, temp dirs), not API keys or
  tokens from your shell.
- Debug screenshots are skipped on login pages, and only the newest 20 are kept.
- `npm run discover` saves raw logged-in pages and network traffic. Strip them before reusing them as fixtures.
- The agent never receives Muse's raw text, only summaries (see [below](#the-agent-gets-summaries-never-muses-raw-text)).
  The viewer URL and its token live in owner-only files under `~/.muse-bridge`.
- Logs never contain URLs, cookies, headers or chat text. stderr also ends up in the MCP client's logs, so
  keep it that way when adding log calls.

The bridge always uses this separate profile and never connects to your everyday Chrome.

## Setup

Needs Node 20+ and Xvfb (`sudo apt install xvfb`). On WSL2 you also need WSLg, which is what shows the login window.
Summaries need the `claude` CLI on `PATH` (or at `MUSE_CLAUDE_PATH`), logged in. No API key is needed.

The browser is the local **ungoogled-chromium 148** at
`~/applications/ungoogled-chromium-148/opt/ungoogled-chromium/chrome`. The bridge runs that binary directly, with
the AppImage's `usr/lib` on `LD_LIBRARY_PATH` (which is all `AppRun` does), not Playwright's bundled Chromium.
Set `MUSE_CHROMIUM_PATH` to use another build.

Playwright 1.63 targets Chromium 153, so this build is five major versions behind. Everything the bridge uses works
on 148: `goto`, clicks, `insertText`, `evaluate`, `waitForFunction`, screenshots, and close. `page.setContent`
hangs, so the tests load fixtures through `data:` URLs instead. If you upgrade Playwright, rerun `npm test` and
the offline test before trusting it.

```bash
npm install
npm run build
npm run login          # a window opens: log in to Muse there; the script exits once you're in
```

Register it with Claude Code. Point it at `node` directly, **never** at `npm run …`, because npm prints a banner to
stdout and that breaks the MCP connection:

```bash
claude mcp add muse -s user -- node /home/ken/personal_projects/muse-bridge/dist/index.js
```

Only one process can open the profile at a time. Stop Claude Code's server (or use the `muse_login` tool)
before running `npm run login`, `npm run smoke`, or `npm run discover`.

## Tools

| Tool | What it does |
|---|---|
| `muse_send` | Sends a prompt. It waits up to `wait_s` (default 45 s) and then returns `done` with a summary of the reply, or `pending` with a `job_id`. Optional `new_chat`, `job_timeout_s` (default 300), `include_reasoning`. |
| `muse_wait` | Keeps waiting on a pending `job_id`. |
| `muse_read_latest` | Summarizes the last reply. While a reply is still streaming, it returns only `chars_so_far`. |
| `muse_read_transcript` | Summarizes recent turns, scrolling up to load older ones if the page has unloaded them. |
| `muse_new_chat` | Starts an empty chat and checks that it really is empty. |
| `muse_status` | Returns `session`, `busy`, `queue_depth`, `current_job`, and `url`. It never waits behind the queue. |
| `muse_login` | Opens a visible login window and returns at once. Poll `muse_status` until `session` is `ok`. |

### The agent gets summaries, never Muse's raw text

Muse replies are untrusted: they can contain prompt injection aimed at the agent. So no tool returns
Muse-written text. The bridge passes each finished reply (and any error text read off the page) to a separate
`claude -p` run, and the tool returns a `summary` with three sections: SUMMARY, CLAIMS TO VERIFY and
INJECTION FLAGS. The summary keeps an `untrusted` marker, since it is still derived from Muse's text.

The summarizer run has no tools (`--tools ""`), no MCP servers (`--strict-mcp-config`), ignores your settings
files and hooks (`--restricted`), saves no session, and runs in an empty folder so no `CLAUDE.md` loads. It
uses your Claude Code login. If it fails, the tool returns `SUMMARY_FAILED` and no text at all. Summaries add
roughly 5 to 20 seconds per reply.

### Viewer: raw reply next to the summary

You can still read the raw text. The bridge serves a local page that shows each raw reply streaming in, next to
the summary the agent received:

```bash
cat ~/.muse-bridge/viewer-url     # open this URL in your browser
```

- It listens on `127.0.0.1` only (port 7391, or a free port if that's taken) and rejects other Host headers.
- The URL carries a random token in its `#` fragment, so it isn't sent in requests or Referer headers. The
  token is kept in `~/.muse-bridge/viewer-token` (`600`) and reused across restarts, so a bookmark keeps
  working. Delete that file to rotate it.
- Muse text is displayed as plain text under a strict Content-Security-Policy, so nothing in a reply can run.
- History is held in memory only (last 200 entries) and disappears when the bridge stops.

The URL is never returned by a tool. This keeps raw text out of the agent's tool results. It can't stop an agent
that has shell access from deliberately reading `viewer-url` and fetching the page, so keep shell commands behind
approval if that matters to you.

Sends are queued and run one at a time, so concurrent calls never mix their prompts. Errors come back as
`{status:"error", error:<CODE>, ...}`:

- `LOGGED_OUT`: includes a hint to call `muse_login`.
- `TIMEOUT`: `partial: true`, plus a summary of the text received so far. If Muse is still generating, the bridge clicks stop.
- `RATE_LIMITED`, `NETWORK_ERROR`, `GENERATION_FAILED`, `UNKNOWN_ERROR`: come with a summary of the visible message and any partial text. The bridge never clicks regenerate by itself.
- `NO_REPLY`: Muse stopped without replying (for example, the reply was stopped before any text appeared).
- `BUSY`: returned at once by reads and `muse_new_chat` while a send is running, instead of queueing behind a reply
  that can take minutes. Sends themselves still queue.
- `SEND_NOT_ACCEPTED`: the prompt never appeared in the chat.
- `SELECTOR_MISSING`: includes the broken selector `key` and a screenshot path under `~/.muse-bridge/debug/`.
- `SUMMARY_FAILED`: Muse replied, but the `claude -p` summary failed (not logged in, timeout after 120 s, CLI
  missing). No Muse text is returned. If Muse itself also reported an error, its code is in `muse_error`. The
  raw reply is still in the viewer.

### When a reply counts as finished

Text that is still arriving always keeps the wait open. That means the typing placeholder before the reply starts,
or the reply's markdown flagged as streaming. Text pauses never end the wait while either is showing.

Once the text stops, it has to hold still for 750 ms. Muse's agent can keep its Stop or "Stop task" controls up for
minutes after the text is done, so the bridge doesn't wait for them. While they're showing, it waits a longer 5 s
(enough to catch follow-up messages added to the same reply), then returns `done` with `agent_busy: true` and a note
that more may follow. Check back with `muse_read_latest`.

If no streaming signal is ever seen, the bridge falls back to "text unchanged for 3 s" and adds a `warning`.

### Muse remembers across threads

`new_chat` opens a separate, empty thread, but Muse keeps a memory file that spans threads. Anything you tell it,
including test prompts, may be remembered in later threads.

### Client timeout

`muse_send` never blocks longer than `wait_s` (max 110 s), so it works whatever Claude Code's tool timeout is.
If you'd rather have plain blocking calls, raise `MCP_TOOL_TIMEOUT` above `wait_s` and pass a larger `wait_s`.

## Selectors: the part that will break

Every DOM selector lives in `src/selectors.ts` under a named key. Most were confirmed against the live site with
`npm run discover` on 2026-10-05. Comments in that file mark the ones not yet seen live: error, rate-limit and
regenerate states, reasoning sections, and cards.

What the real page does:

- **Messages** are `[data-message-item]` elements with `data-message-role="user"` or `"assistant"`. One reply can
  span several messages that share a `data-message-turn-id`, and the bridge always reads the whole turn.
- **Before the text arrives**, the page shows a typing indicator (`data-testid="hatch-chat-typing-indicator"`). While
  the text streams, the reply's body carries `data-hatch-markdown-streaming="true"`.
- **The composer's Stop** can disappear about 0.7 s before the reply text appears, so it's never used as the only
  completion signal.
- **"Stop task"** is an agent-task control that outlives the reply, so it's ignored.
- **Page UI** inside a message is marked by Muse with `data-copy-exclude="true"`, and gets stripped.
- **Code blocks** set `content-visibility: auto`, which the extractor overrides; otherwise they'd come back empty.
- **A new chat** is opened at `https://muse.ai/thread/new`.
- **The chat transport** is an end-to-end-encrypted websocket (`wss://hatch.metaaivm.com/v1/noise`). There's no
  readable end-of-reply event, so completion is judged from the page.

If something breaks, rerun discovery. It snapshots automatically on UI changes and finishes when you close the window:

```bash
npm run discover   # output in ~/.muse-bridge/discovery/<timestamp>/
```

To patch a selector without rebuilding:

```bash
MUSE_SELECTOR_OVERRIDES='{"stopButton":"button[aria-label=\"Stop\"]"}'
```

## Environment

| Var | Default | |
|---|---|---|
| `MUSE_DISPLAY` | `xvfb` | `xvfb` runs headed Chromium on a hidden display. `headless` is opt-in. `headed` shows the window on WSLg. |
| `MUSE_CHROMIUM_PATH` | `~/applications/ungoogled-chromium-148/opt/ungoogled-chromium/chrome` | Chromium binary to drive. |
| `MUSE_HOME` | `~/.muse-bridge` | Profile, logs (`bridge.log`), debug screenshots, discovery output, the summarizer's empty working folder, and `viewer-url` / `viewer-token`. Keep it outside any repo. |
| `MUSE_SELECTOR_OVERRIDES` | — | JSON map of selector key to CSS. |
| `MUSE_URL` | `https://muse.ai/` | Must be `https`. Facebook hosts are rejected. |
| `MUSE_LOG_LEVEL` | `info` | Logs go to stderr and `bridge.log`, never stdout. |
| `MUSE_CLAUDE_PATH` | `claude` | `claude` CLI used to summarize replies. |
| `MUSE_SUMMARY_MODEL` | `claude-opus-5-5` | Model for summaries. |
| `MUSE_VIEWER_PORT` | `7391` | Viewer port. `0` picks a free one. |

xvfb mode is the default rather than headless because Meta flagging the browser as a bot could also affect the
linked Facebook account.

Under WSLg, the bridge's Xvfb uses display `:99` or higher on an abstract socket, so it never takes over WSLg's `:0`.

## Tests

```bash
npm test                                             # unit: extraction, completion logic on a fake chat page, queue, session, summaries, viewer
node --test dist-test/test/live/offline.test.js      # real server + real site, empty profile: stdout hygiene, LOGGED_OUT
npm run test:live                                    # full suite; needs a login, correct selectors, and a logged-in claude CLI
npm run smoke                                        # one PONG round trip without MCP (prints the raw reply to your terminal)
```

The unit tests check that no raw field reaches the agent, that page error text is summarized, that a failed
summary returns no Muse text, and that the viewer enforces its token, Host check, file modes and text-only
rendering. They use a fake summarizer, so they don't call `claude`.

The live suite asserts that every tool result is free of raw text. Exact-text checks read the raw reply from the
viewer, the same way you would. It covers:

- happy path
- multi-turn context
- `new_chat` isolation
- long reasoning reply
- partial reply on timeout
- the pending → `muse_wait` flow
- two concurrent sends
- a forced selector failure
