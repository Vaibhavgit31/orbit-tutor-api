# Solaris tutor API

The AI tutor API for the Unity "AI Solar System" lesson, on Google Gemini. It holds the Gemini
key and answers the routes the WebGL player calls; learners never see or enter a key. This copy
contains only the server (no dependencies), so it deploys in seconds. The player itself is on
GitHub Pages and calls this service across sites.

## Deploy on Render (free)

The service already exists as `orbit-tutor-api` (https://orbit-tutor-api.onrender.com):

1. Resume the service if it is suspended (Render dashboard → the service → **Resume**).
2. **Environment** → add the variable below → **Save changes**:

   | Name | Value |
   |---|---|
   | `GEMINI_API_KEY` | your Google Gemini key (paste it yourself, never commit it) |

   The old `OPENAI_*` variables are no longer read and can be deleted.
3. **Manual Deploy → Deploy latest commit** (or push to the branch Render watches).
4. Open `https://orbit-tutor-api.onrender.com/health`: it should show `"provider":"gemini"`,
   `"aiConfigured":true` and `"voiceMode":"realtime"`.

Creating it from scratch instead: render.com → **New → Blueprint** → this repository
(`render.yaml` sets the start command, the health check and asks for `GEMINI_API_KEY`).
By hand: **New → Web Service**, build command `npm install`, start command `node server.mjs`,
health check path `/health`, then the environment variable above.

The free plan sleeps after 15 minutes without requests and takes about a minute to wake. `.github/workflows/keep-awake.yml` pings `/health` every 10 minutes so a resumed service never sleeps (run it once by hand from the Actions tab after resuming; GitHub pauses schedules after 60 days without commits). The
player pings `/health` the moment its page opens (the download and the opening video cover the
wake-up) and every few minutes while the lesson is in use. Until the API answers, Solaris uses
her offline knowledge and the browser's voice; nothing is shown to the learner.

## Optional settings

| Name | Effect |
|---|---|
| `ACCESS_CODE` | any phrase: the site then asks for it once per device (open the site with `?code=...` to skip the question). Unset = open to everyone. |
| `CORS_ORIGIN` | extra sites allowed to call the API, comma separated (`*` = any). GitHub Pages (`https://vaibhavgit31.github.io`) and localhost are always allowed. |
| `LIVE_WORDS=0` | switch off the learner's words on screen while they speak (a second, transcription-only Live session per talking learner). |
| `GEMINI_TEXT_MODELS`, `GEMINI_TTS_MODELS`, `GEMINI_LIVE_MODEL`, `GEMINI_WORDS_MODEL`, `GEMINI_VOICE` | override the models (comma-separated lists are tried in order) and the voice (`Leda`). |
| `ANSWER_BANK=0` | stop remembering answers to repeated questions. |
| `VOICE_DEBUG=1` | development only: saves every recorded turn and opens `/chat` and `/voice-debug`. |

## Routes

| Route | Purpose |
|---|---|
| `/health` | cheap status, always open (Render's probe and the page's wake-up ping); never contains the key |
| `/api/realtime/session` | Gemini Live settings plus short-lived tokens (4 session starts within 28 minutes, locked to Solaris's own setup); the key never leaves the server |
| `/api/tutor/stream` | the answer, streamed word by word (server-sent events) |
| `/api/tutor` | the same answer in one piece |
| `/api/speech` | Solaris's voice (WAV), cached by text; past the day's text-to-speech allowance the Live model reads the line in the same voice (needs Node 22, `NODE_VERSION` in `render.yaml`) |
| `/api/transcribe` | speech to text |
| `/api/report` | the teacher's session assessment |
| `/api/access` | checks the access code when one is set |

## Why it is fast

- Solaris's voice conversation goes from the browser straight to Gemini Live; this server only
  issues the token, so there is no extra hop in the conversation.
- One kept-alive connection pool to Google: questions do not pay for a new TLS handshake, and
  `/health` keeps a connection warm.
- Repeated questions come from an in-memory cache (and `answer-bank.json`), spoken lines from a
  48 MB cache; two requests for the same line share one call to Google.
- A model that answers "quota" is rested for the time Google asks, so the next request fails in
  milliseconds and the player switches to its fallback at once instead of waiting.
- JSON over 1 KB is brotli/gzip compressed; CORS preflights are cached for two hours.

## Testing locally

```
cd Backend            # in the Unity project
GEMINI_API_KEY=... node server.mjs
```

or put `GEMINI_API_KEY=...` in `Backend/.env` (gitignored). The project's QA harness starts the
server with the key from `~/.solaris/gemini.key` and checks every route plus a spoken
conversation: `Tools/QA/backend-test.cjs`.

## Serving the player from here too

If you also copy the Unity output into a `Build/WebGL` folder beside this one and set
`WEBGL_ROOT` to it, this single service serves the game and the API together. A data file
committed in parts (`Build/data-parts.json`) is rebuilt in the background after start-up.

Keep `.env` out of the repository. It is gitignored here, and the deployed service takes its key
from the host's environment variables instead.
