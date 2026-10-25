# InterviewCopilot Pro

Your single-file prototype, turned into a deployable app: a static site plus one Netlify Function that keeps your Gemini API key off the browser.

All original features are kept: dual speech engine (interviewer stream + "Log My Answer" mic), auto-answer after N seconds of silence (VAD, 1-7 s), Technical / Behavioral / System Design / Custom tracks, teleprompter bullets + detailed answer + keywords + edge cases, conversation memory fed back into follow-ups, candidate profile editor, Stealth View + opacity slider, screen-share tips, copy and export.

```
public/                  static site (this is what Netlify publishes)
  index.html
  assets/app.js          all app logic
  assets/pcm-worklet.js  AudioWorklet for tab-audio capture
netlify/functions/
  gemini.mjs             API proxy at /api/gemini (holds the key, optional access code)
tests/                   unit tests for the function (npm test)
netlify.toml             publish dir + functions dir + security headers
```

## 1. Put it in Git

```bash
cd interview-copilot
git init
git add .
git commit -m "InterviewCopilot Pro"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`.env` is git-ignored, so keys never get committed.

## 2. Deploy on Netlify

1. Netlify → **Add new site → Import an existing project** → pick the repo.
2. Build settings are read from `netlify.toml` (no build command, publish dir `public`). Leave them as detected.
3. **Before or right after the first deploy**, open *Site configuration → Environment variables* and add:

   | Variable | Value |
   |---|---|
   | `GEMINI_API_KEY` | your key from https://aistudio.google.com/apikey |
   | `APP_ACCESS_CODE` | a passphrase only you know (**strongly recommended**) |
   | `GEMINI_MODEL` | optional, defaults to `gemini-3-flash-preview` |

4. Trigger a redeploy after adding variables (*Deploys → Trigger deploy*).

Why `APP_ACCESS_CODE`: your site URL is public. Without a code, anyone who finds it can spend your Gemini quota. With it set, the app shows an **Access Code** box in the sidebar (enter it once; it is remembered in your browser).

When it works, the sidebar footer shows a green dot: `Gemini connected · <model>`.
Amber = key missing on the server. Red = the function isn't reachable (e.g. not deployed via Netlify).

## 3. Run locally

```bash
cp .env.example .env     # fill in GEMINI_API_KEY
npx netlify-cli dev      # http://localhost:8888
npm test                 # function unit tests
```

Use `localhost` or HTTPS; browsers block microphone and screen capture on plain HTTP.

## Using it on your PC

- Use **Chrome or Edge** on desktop. The microphone speech engine is the browser's Web Speech API.
- In Chrome/Edge you can **install it** (address bar → install icon) to get its own window, handy for placing beside your meeting.
- **Listen** uses your microphone (speakers instead of headphones, or a virtual audio cable as your default input, if you want it to hear the interviewer that way).
- **Capture Tab / Meeting Audio** is the cleaner route. Pick the meeting tab (or *Entire Screen* on Windows for system audio) and tick **Share audio**. The audio is split into spoken segments in the page, each segment is transcribed by Gemini, and the text lands in the question box; the silence timer then triggers the answer. Press the button again to stop.
- After an auto-answer the listener stops (same as the original). Press **Listen** again for the next question; the question box is cleared when you do.

## Things worth knowing

- **Stealth View is a layout mode, not invisibility.** A web page cannot hide itself from screen capture. What actually keeps it off a shared screen is sharing a single window/tab rather than the entire screen (see the in-app "Screen Share Tips").
- **Privacy:** Chrome's Web Speech sends mic audio to Google for recognition. Tab-audio mode sends short audio clips to Gemini. Transcripts are never saved by the app (only settings are, in your browser's localStorage). Export is a manual JSON download.
- **Your own API key** (sidebar override) is stored in your browser's localStorage and used to call Google directly. Leave it empty to use the server key.
- **Model name:** `gemini-3-flash-preview` is carried over from your original file. If Google renames or retires it, change `GEMINI_MODEL` in Netlify; for the direct own-key path also change `CONFIG.model` at the top of `public/assets/app.js`.
- **Function timeouts:** if answers time out on a slow day, check the Netlify function timeout in your site settings.
- The page loads Tailwind (Play CDN) and Lucide icons from CDNs, version-pinned. That's fine for a personal tool; swap to a Tailwind build step if you ever want to remove the CDN dependency.
