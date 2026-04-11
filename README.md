# Tokns_fi — YouTube Automation Agent

Fully automated YouTube channel management for **Tokns_fi** — crypto education, TX blockchain ecosystem, and motivation content. The system generates, produces, and publishes videos daily using a multi-agent AI pipeline.

See [CHANGELOG.md](CHANGELOG.md) for a full history of changes.

---

## What This Does

Runs 24/7 to:
- Research and select niche topics (Bitcoin, altcoins, TX ecosystem, tokns.fi, motivation/mindset)
- Write complete video scripts using Claude / Grok / OpenAI (with template fallback)
- Generate cinematic thumbnails and visual assets via Grok Aurora or DALL-E 3
- Produce narrated videos with ElevenLabs, Google Cloud TTS, OpenAI TTS, or macOS TTS
- Burn-in captions and assemble final MP4
- Upload and schedule to YouTube with proper SEO metadata

---

## Agent Pipeline

```
ContentStrategy → ScriptWriter → ProductionManagement → Publishing → Analytics
                                       ↑
                              (Thumbnail + Audio + Visuals + Captions)
```

| Agent | File | Responsibility |
|---|---|---|
| Content Strategy | `agents/content-strategy-agent.js` | Picks niche topic, generates angle |
| Script Writer | `agents/script-writer-agent.js` | AI or template script generation |
| Production Management | `agents/production-management-agent.js` | Coordinates audio, visuals, captions, video assembly |
| Publishing & Scheduling | `agents/publishing-scheduling-agent.js` | YouTube upload + scheduling |
| Analytics | `agents/analytics-optimization-agent.js` | Performance tracking |

---

## Quick Start

### Prerequisites

- Node.js 18+
- YouTube Data API v3 credentials (OAuth2)
- At least one AI provider key (see below)

### Installation

```bash
git clone <repo>
cd youtube-automation-agent
npm install
cp .env.example .env
# Fill in your keys, then:
npm run setup
npm start
```

Dashboard: `http://localhost:3456`

---

## AI Providers

### Script Generation (pick one, priority order)

| Provider | Env Var | Notes |
|---|---|---|
| **Anthropic Claude** (recommended) | `ANTHROPIC_API_KEY` | Best quality; model via `ANTHROPIC_MODEL` (default `claude-opus-4-6`) |
| **Grok / xAI** | `GROK_API_KEY` | Uses `grok-3` model |
| **OpenAI** | `OPENAI_API_KEY` | Falls back to template if none set |

### Image Generation (pick one)

| Provider | Env Var | Notes |
|---|---|---|
| **Grok Aurora** | `GROK_API_KEY` | xAI image model, preferred |
| **DALL-E 3** | `OPENAI_API_KEY` | 1792×1024 HD, ~$0.08/image |

### Text-to-Speech (automatic fallback chain)

1. **Chatterbox** — `CHATTERBOX_API_URL` — self-hosted voice clone via [Chatterbox TTS](https://github.com/ShieldnestORG/chatterbox); uses your own voice from a short reference recording. See `chatterbox-server/` for deployment.
2. **ElevenLabs** — `ELEVENLABS_API_KEY` — best quality
3. **Google Cloud TTS** — `GOOGLE_TTS_API_KEY` — free 1M chars/month; voice via `GOOGLE_TTS_VOICE` (default `en-US-Neural2-J`)
4. **OpenAI TTS** — `OPENAI_API_KEY` — good quality
5. **macOS built-in** — no key needed — free offline fallback (Mac only)

---

## Environment Variables

```env
# Server
PORT=3456
NODE_ENV=production
LOG_LEVEL=info

# AI — Script Generation (first found is used)
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-opus-4-6
GROK_API_KEY=
OPENAI_API_KEY=

# AI — TTS (Chatterbox = own voice clone, self-hosted)
CHATTERBOX_API_URL=http://your-vps-ip:8321
CHATTERBOX_API_KEY=
CHATTERBOX_VOICE_REF=default
ELEVENLABS_API_KEY=
GOOGLE_TTS_API_KEY=
GOOGLE_TTS_VOICE=en-US-Neural2-J
GOOGLE_TTS_LANGUAGE=en-US

# YouTube
YOUTUBE_REGION=US
DEFAULT_PRIVACY_STATUS=public

# Channel Identity
CHANNEL_NAME=Tokns_fi
TARGET_AUDIENCE=crypto investors, TX ecosystem followers, self-improvement seekers
POSTING_FREQUENCY=daily
```

---

## Content Strategy

The channel covers three pillars:

**Crypto & Bitcoin** — price predictions, buy guides, portfolio strategy, DeFi, chart reading, common mistakes  
**TX Blockchain Ecosystem** — TX explained, tokns.fi, txecosystem, coherencedaddy.com, staking guides  
**Motivation & Mindset** — morning routines, discipline, financial freedom, investor mindset

Topic selection rotates through a curated pool of 30 niche topics. Angles are generated contextually based on topic type (comparison, how-to, price/prediction, motivation, TX ecosystem, DeFi/staking).

---

## Dashboard

Open `http://localhost:3456` to see:

- System health and uptime
- Upcoming schedule (next 5 items)
- Publish queue with **"▶ Publish Now"** buttons per video
- Analytics metrics
- Channel configuration overview

---

## REST API

| Method | Path | Description |
|---|---|---|
| GET | `/health` | System status |
| GET | `/schedule` | Upcoming schedule |
| GET | `/queue` | Publish queue with IDs |
| GET | `/analytics` | Performance metrics |
| POST | `/generate` | Trigger video generation |
| POST | `/publish/:id` | Publish queued video immediately |

### Generate a video manually

```bash
curl -X POST http://localhost:3456/generate \
  -H "Content-Type: application/json" \
  -d '{"topic": "Bitcoin price prediction 2026", "style": "explainer"}'
```

---

## File Structure

```
youtube-automation-agent/
├── agents/                   # All AI agents
│   ├── content-strategy-agent.js
│   ├── script-writer-agent.js
│   ├── production-management-agent.js
│   ├── publishing-scheduling-agent.js
│   └── analytics-optimization-agent.js
├── config/                   # credentials.json, channel config
├── dashboard/                # index.html frontend
├── database/                 # SQLite + db.js wrapper
├── data/
│   ├── assets/               # Generated images + cache/
│   ├── audio/                # Generated MP3 narrations
│   ├── captions/             # SRT caption files
│   └── videos/               # Final assembled MP4s
├── logs/                     # Winston log files
├── schedules/                # Cron automation scripts
├── utils/
│   └── ai-video-generator.js # TTS + image + video assembly
├── uploads/                  # Temporary YouTube upload staging
├── .env                      # Local secrets (never commit)
├── .env.example              # Template for new installs
├── CHANGELOG.md              # Version history
├── CLAUDE.md                 # AI assistant rules for this project
└── index.js                  # Express server + agent orchestration
```

---

## Automation Schedule

| Time | Task |
|---|---|
| 6:00 AM | Generate new video (strategy → script → production) |
| Every 15 min | Process publishing queue |
| 9:00 AM | Collect YouTube analytics |
| 10:00 PM | Run optimization tasks |
| Weekly | Strategy review and performance analysis |

---

## Troubleshooting

**YouTube API quota exceeded** — Check Google Cloud Console; reduce posting frequency if needed.

**Script generation failed** — Verify `ANTHROPIC_API_KEY` / `GROK_API_KEY` / `OPENAI_API_KEY` in `.env`; check `logs/`.

**Publishing failed** — Re-run OAuth (`npm run setup`); verify video file exists at the path shown in the queue.

**TTS silent / no audio** — If on Mac and all keys are missing, ensure `ffmpeg` is installed (`brew install ffmpeg`).

**`publishAt` API error** — Fixed in v1.1.0. Past-dated schedule entries now upload as `public` immediately.

**Dashboard shows all red** — Each panel is now isolated. Check `logs/` for the specific failing section.

### Debug mode

```bash
NODE_ENV=development DEBUG_MODE=true npm start
```

---

## OAuth Setup (YouTube)

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → Create Project
2. Enable **YouTube Data API v3**
3. Create OAuth 2.0 credentials → Desktop App → download JSON
4. Save as `config/credentials.json`
5. Run `npm run setup` — browser opens automatically for authorization

---

## License

MIT — see [LICENSE](LICENSE)
