# ORBIT tutor API

The AI tutor gateway for the Unity "AI Solar System" lesson: it holds the OpenAI key
and exposes the routes the WebGL player calls. This copy contains only the server, so
it deploys in seconds instead of cloning the Unity project's art history.

## Deploy on Render (free)

1. Publish this folder as a repository (GitHub Desktop → Add local repository → Publish).
2. render.com → **New → Web Service** → pick that repository.
3. Settings:
   - Root directory: *(leave empty — the server is at the top level here)*
   - Build command: *(leave empty)*
   - Start command: `node server.mjs`
4. Environment variables:

   | Name | Value |
   |---|---|
   | `OPENAI_API_KEY` | your key (paste it yourself, never commit it) |
   | `ACCESS_CODE` | any phrase; the site asks for it once per device |

5. Open `https://<your-service>.onrender.com/chat?code=<your access code>` to test the
   chatbot on its own, with no Unity build involved.

The free plan sleeps after inactivity, so the first request after a quiet period takes
about a minute. Later ones are normal speed.

## Routes

| Route | Purpose |
|---|---|
| `/health` | status and model check; always open, so Render can probe it |
| `/api/tutor/stream` | the answer, streamed word by word |
| `/api/tutor` | the same answer in one piece |
| `/api/transcribe` | speech to text |
| `/api/speech` | ORBIT's spoken reply |
| `/chat` | a bench for testing the chatbot without Unity |

## Serving the player from here too

If you also copy the Unity output into a `Build/WebGL` folder beside this one and set
`WEBGL_ROOT=../Build/WebGL`, this single service serves the game and the API together,
and the player needs no changes because it already calls same-origin `/api/...`.

Keep `.env` out of the repository. It is gitignored here, and the deployed service takes
its key from the host's environment variables instead.
