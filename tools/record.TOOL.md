# Tool: record

CLI, not an MCP tool: `node tools/record.mjs`. The hub runs it after a deploy. Contract written from the hands template (.claude/skills/hands/templates/TOOL.md); its JSON test is test/record.test.mjs.

## Name

`record`

## Description

Records the deployed board in use (open-board, ack-incident, watch-board as a viewer in Berlin, then the same board as a viewer in Auckland) into one H.264 mp4, and writes timeline.json with each moment's mm:ss, the sha the page shows and the ack receipt the page logged. It does not upload the video or send a report.

## Input schema

Each input is its own argument (no shell string). The board URL is fetched by Chromium; the page may reach only the board's host and `--api-host`.

```json input-schema
{
  "type": "object",
  "properties": {
    "url": { "type": "string", "description": "The board, https for a deployed board (http only on 127.0.0.1), e.g. https://<user>.github.io/show-me-when/" },
    "out": { "type": "string", "description": "Folder for recording.mp4, timeline.json and raw/; use s03e04/challenge/private/rec-<step> (git-ignored)" },
    "expectSha": { "type": "string", "description": "40-hex sha of the deployed build; the run fails if meta or footer name another" },
    "ack": { "type": "string", "description": "top (first open row), none, or an incident id like INC-5056" },
    "watchS": { "type": "number", "description": "seconds to keep watching for a new incident, 0-600, default 45" },
    "yesAck": { "type": "boolean", "description": "required to press Ack on a board not on 127.0.0.1 (a real ack); only with Greg's yes" },
    "apiHost": { "type": "string", "description": "the API host the page may call, default hq.mega.dev" }
  },
  "required": ["url", "out", "expectSha"],
  "additionalProperties": false
}
```

## Output schema

One JSON line on stdout. The hub next makes the report from `timeline` (tools/report.mjs) and uploads `video`.

```json output-schema
{
  "type": "object",
  "properties": {
    "ok": { "type": "boolean", "description": "true when the recording and the timeline were written" },
    "video": { "type": "string", "description": "path of recording.mp4" },
    "timeline": { "type": "string", "description": "path of timeline.json" },
    "durationS": { "type": "number", "description": "video length in seconds" },
    "bytes": { "type": "number", "description": "video size in bytes" },
    "events": { "type": "number", "description": "number of recorded moments" }
  },
  "required": ["ok", "video", "timeline", "durationS", "bytes", "events"],
  "additionalProperties": false
}
```

## Result budget

Budget: 400 bytes for the stdout line, measured on the local rehearsal (test/record.test.mjs). The video and the timeline go to files; the line carries their paths and sizes only.

## Errors

Exit 2: a wrong call, nothing opened. Exit 1: a check failed during the run; nothing more is sent after it. Each prints `{"ok":false,"field":...,"error":...}`.

| Field | Wrong call | Text the agent reads |
|---|---|---|
| `--yes-ack` | Ack on a deployed board without it | `pressing Ack on a deployed board sends a real ack to the course. Add --yes-ack only with your human's yes for it` |
| `--expect-sha` | not 40 hex, or the page names another build | `must be the 40-hex sha of the deployed build. Send the sha the deploy printed` / `the page names build <meta> (meta) / <footer> (footer), not <sha>` |
| `--url` | not a URL, not http(s), or http for a deployed board | `"<value>" is not a URL. Send the deployed board, like https://<host>/` |
| `--out` | missing | `missing. Send a folder for the video and timeline, like private/rec-step1` |
| `--ack` | not top, none or an id | `must be top, none or an incident id like INC-5056` |
| `receipt` | the page logged no ack line after the click | `no "ack <id> ..." console line with a receipt after the click` |
| `recording` | the board did not load in 15 s, or another browser error | the Playwright message, first 300 characters; check the URL and run again |

## Check

`sideEffects`: true when `--yes-ack` is given (a real ack on the course); the test runs it only against the fake course (test/fake-course.mjs), the stub of the course API.

```json check
{
  "tool": "record",
  "budgetBytes": 400,
  "sideEffects": true,
  "good": { "url": "http://127.0.0.1:<fake port>/", "out": "<tmp>/rec", "expectSha": "fedcba9876543210fedcba9876543210fedcba98", "watchS": 15 },
  "wrong": [
    { "field": "--yes-ack", "args": { "url": "https://board.example/", "out": "/tmp/x-rec", "expectSha": "fedcba9876543210fedcba9876543210fedcba98" } },
    { "field": "--expect-sha", "args": { "url": "https://board.example/", "out": "/tmp/x-rec", "expectSha": "abc", "ack": "none" } },
    { "field": "--url", "args": { "url": "http://board.example/", "out": "/tmp/x-rec", "expectSha": "fedcba9876543210fedcba9876543210fedcba98", "ack": "none" } }
  ]
}
```
