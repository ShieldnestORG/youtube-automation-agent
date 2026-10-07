# Changelog

All notable changes to Tokns_fi YouTube Automation are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased] — v1.1.0

> These changes are staged but not yet committed. Run `git commit` when ready to cut the release.

### Fixed

#### Captions — timing sync with audio
- **Caption timing now uses real audio duration** instead of hardcoded section estimates (5/15/60/30s) — captions no longer drift ahead or behind the narration
- `createSRTCaptions()` rewritten to distribute time proportionally by word count across all script sections
- Added `ffprobe` probe after TTS generation to measure actual audio length before caption generation
- Falls back to 150 wpm word-rate estimate when ffprobe is unavailable (still far more accurate than fixed constants)

### Added

#### ScriptWriter — AI-powered script generation
- **Multi-provider AI** initialization in `ScriptWriterAgent`: priority order is Claude (Anthropic) → Grok (xAI) → OpenAI
- `generateScriptWithAI()` — sends a full JSON-structured prompt to the configured AI; falls back to template generation on any API error
- Added `@anthropic-ai/sdk` and model env var `ANTHROPIC_MODEL` (default `claude-opus-4-6`)
- Grok support via `GROK_API_KEY` + `https://api.x.ai/v1` base URL

#### ContentStrategy — niche topic pool
- `getNicheTopic()` — hardcoded 30-topic pool covering Bitcoin/altcoins, TX blockchain ecosystem, and motivation/mindset
- `isQualityTopic()` filter — rejects vague/celebrity topics by keyword list
- `generateAngle()` — context-aware angle templates for: comparisons, how-to, price/prediction, motivation, TX ecosystem, DeFi; dynamic year injection

#### Production — smarter visual prompts
- `createVisualPromptsFromScript()` completely rewritten:
  - Image count scaled to video duration (1 per 20 s, clamped 8–20)
  - Structured pass: title card → hook → introduction → main sections → conclusion → CTA
  - `getVariantSuffix()` — 12 rotating camera/composition styles to prevent duplicate-looking visuals
  - `buildContentPrompt()` — 18 crypto/motivation keyword rules → specific cinematic scene descriptions
  - `buildTitlePrompt()`, `buildSectionTitlePrompt()`, `buildThematicPrompt()` helpers
- `extractSectionText()` — parses `content[]`, `items[]`, `steps[]`, `points[]` from script sections

#### AI Video Generator — TTS & image improvements
- **Chatterbox TTS** (`generateChatterboxTTS`): self-hosted zero-shot voice clone via FastAPI wrapper on VPS; sends text to `CHATTERBOX_API_URL`, receives WAV, converts to MP3 via ffmpeg; uses your own voice from a short reference recording. New top-priority TTS provider.
- **chatterbox-server/** — standalone FastAPI + Docker deployment for Chatterbox TurboTTS: sentence chunking, asyncio.Lock for GPU serialization, API key auth, multi-voice support via `voices/` directory
- **Google Cloud TTS** (`generateGoogleTTS`): chunked at 4 500-char sentence boundaries, writes merged MP3; uses `GOOGLE_TTS_API_KEY` + `GOOGLE_TTS_VOICE`/`GOOGLE_TTS_LANGUAGE` env vars
- **macOS built-in TTS** fallback (`generateMacOSTTS`): `say` → AIFF → ffmpeg MP3 conversion; zero-cost, works offline
- TTS priority chain: **Chatterbox** → ElevenLabs → Google Cloud TTS → OpenAI TTS → macOS TTS
- **Grok (Aurora) image generation** — `GROK_API_KEY` enables xAI image model; falls back to OpenAI DALL-E if unavailable
- **Image cache system**: SHA-1 keyed `data/assets/cache/index.json`; stale-entry auto-cleanup on miss
- Added `sharp` package for image processing

#### Publishing — YouTube upload hardening
- YouTube tag sanitization: strip `_` → space, remove special chars, enforce length 2–100, reject no-letter tokens, deduplicate, cap at 30 tags
- Smart `publishAt` logic: only sets `publishAt` + `private` for times >1 min in the future; uses `public` immediately otherwise (fixes YouTube API rejection of past `publishAt` dates)
- Title capped at 100 chars, description at 5 000 chars
- `getVideoStream()` replaced simulation with real `fs.createReadStream()` + empty-file guard
- Better queue-not-found error message: lists all current queue IDs

#### Dashboard
- Added **Publish Queue** panel with inline "▶ Publish Now" buttons per video
- `GET /queue` REST endpoint — exposes `id`, `productionId`, `title`, `status`, `publishTime`, `videoPath`
- Isolated `try/catch` blocks per dashboard section (health, schedule, analytics, queue) — one failure no longer kills the whole load
- Schedule shows 5 upcoming items (was 3); date display falls back through `publish_time` → `publishTime` → `scheduledTime`

#### Auth
- `modern-auth.js` fixed OAuth port from random 8000–9000 → stable `8080`
- Auto-opens browser (`open`) on macOS when OAuth URL is ready

### Changed
- `selectOptimalTopic()` — removed generic scoring algorithm; always delegates to `getNicheTopic()`
- `extractKeywords()` — minimum word length raised from 3 → 4 chars; expanded stop-word list with YouTube title junk words (official, video, music, remix, etc.)
- `processThumbnail()` — now receives the real `script` object; uses `cinematic` style (was `ethereal`); never falls back to `Ethereal Dreamscript Video` placeholder
- `assembleVideo()` — passes `captionsPath` to `aiVideoGenerator.generateVideo()`
- Dashboard rebranded from "Ethereal Dreamscript" → "Tokns_fi"; channel focus updated to Crypto / TX Blockchain / Motivation
- `database/db.js` queue rows now expose `productionId` and `publishTime` fields
- `index.js` loads `dotenv` at startup
- **OAuth credential and token file paths are now overridable** via `YOUTUBE_CREDENTIALS_PATH` and `YOUTUBE_TOKENS_PATH` — both default to `config/credentials.json` and `config/tokens.json`, so existing installs are unaffected. Lets the live credential files sit outside the repo directory
- `authenticate.js`, `modern-auth.js`, `oauth-server.js`, `simple-auth.js` and `utils/credential-manager.js` now load `dotenv` at startup — each is a standalone entry point (`npm run setup`, `npm run credentials:setup`, `node modern-auth.js`) that previously never read `.env`, so the new path vars would have been ignored there

### Fixed
- Thumbnail generation was using a hardcoded placeholder title instead of the video's real title
- `publishAt` API errors caused by passing past timestamps with `public` privacy status
- Dashboard health-check errors were silently breaking schedule and analytics sections
- Queue lookup was failing when `id` ≠ `productionId` (now checks both fields, `id` first)
- **"Processing abandoned" YouTube upload bug** — simulated `.assembly.json` / `.info` files were being streamed to YouTube as if they were real MP4s. Three-layer fix:
  - `assembleVideo()` now detects simulated audio (`.mp3.info`) and simulated images upfront and exits early with a clear log message instead of silently falling through to `simulateVideoAssembly`
  - `scheduleContent()` refuses to add a video to the publish queue when `finalVideo.simulated === true` or path is null; logs the specific reason
  - `getVideoStream()` validates path ends in `.mp4` and checks MP4 magic bytes (`ftyp`/`moov`/`mdat`) before streaming; throws a human-readable error pointing to the missing API key
- **TTS provider fallback chain** — `generateTTSAudio()` now wraps each provider (ElevenLabs → Google Cloud TTS → OpenAI → macOS) in its own try/catch so a `400` or other error from one provider falls through to the next instead of aborting the whole chain
- **Word-by-word caption pop style** — captions now display 3 words at a time (was 8) with TikTok/Shorts-style visual treatment: all-caps bold yellow text, black stroke outline, drop shadow, bottom vignette gradient. Each 3-word group gets its own frame timed exactly to the SRT entry so words pop in sync with the audio. Removed the old static text-block-per-slide approach (`burnCaptionsToImages` → replaced by `generateCaptionFrames` + `renderCaptionFrame`)

---

## [1.0.0] — 2026-04-07

Initial commit: YouTube Automation Agent

### Added
- Multi-agent pipeline: ContentStrategy → ScriptWriter → ThumbnailDesigner → SEO → ProductionManagement → PublishingScheduling → Analytics
- SQLite database with WAL mode
- Express dashboard on port 3456
- ElevenLabs + OpenAI TTS
- DALL-E 3 image generation
- YouTube Data API v3 upload + scheduling
- OAuth2 flow via `modern-auth.js`
- Cron-based daily automation scheduler
- `generate-now.js` for manual single-video runs

---

## TODO / Upcoming

- [ ] Bump `package.json` version to `1.1.0` once changes are committed
- [ ] Add Google Cloud TTS setup instructions to README
- [ ] Add Grok/xAI API setup instructions to README
- [x] Add `.env` example entries for `GROK_API_KEY`, `GOOGLE_TTS_API_KEY`, `ANTHROPIC_API_KEY`, `CHATTERBOX_API_URL`
- [ ] Wire `isQualityTopic()` into the competitor analysis filter
- [ ] Add unit tests for `buildContentPrompt()` keyword rules
- [ ] Add `/publish/:id` endpoint docs to README
