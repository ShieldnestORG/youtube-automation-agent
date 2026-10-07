# CLAUDE.md — AI Assistant Rules for Tokns_fi YouTube Automation

This file governs how Claude Code should behave when working in this repository.
It is loaded automatically at the start of every session.

---

## Project Identity

- **Channel**: Tokns_fi
- **Niche**: Crypto education, TX blockchain ecosystem (txecosystem, tokns.fi, coherencedaddy.com), Bitcoin, altcoins, motivation/mindset
- **Stack**: Node.js 18+, Express, SQLite, multi-agent AI pipeline
- **Primary AI**: Anthropic Claude (`claude-opus-4-6`) for script writing; Grok Aurora for images

---

## Mandatory Rules

### 1. Always Update CHANGELOG.md

After making **any** code change, you MUST update [CHANGELOG.md](CHANGELOG.md) before finishing.

- New feature → add under `[Unreleased] → ### Added`
- Bug fix → add under `[Unreleased] → ### Fixed`
- Behavior change → add under `[Unreleased] → ### Changed`
- Removed code → add under `[Unreleased] → ### Removed`

When the user commits or asks to cut a release:
1. Move everything from `[Unreleased]` to a new `[x.y.z] — YYYY-MM-DD` section
2. Bump `version` in `package.json` accordingly
3. Leave a fresh empty `[Unreleased]` section at the top

**Versioning guide**:
- Patch `x.y.Z` — bug fixes, typo corrections, small tweaks
- Minor `x.Y.0` — new features, new AI provider support, new endpoints
- Major `X.0.0` — breaking changes, full rewrites, architecture changes

### 2. Keep README.md Current

Update [README.md](README.md) when:
- A new env var is added — add it to the "Environment Variables" table
- A new REST endpoint is added — add it to the "REST API" table
- A new AI provider is supported — update the "AI Providers" section
- An agent's responsibilities change — update the "Agent Pipeline" table
- A known error/fix is relevant — add it to "Troubleshooting"

Do not rewrite the entire README for small changes — do targeted edits only.

### 3. Track TODOs Properly

- Use `TodoWrite` for in-session multi-step task tracking
- For persistent project-level TODOs, use the `## TODO / Upcoming` section in CHANGELOG.md
- Never leave `// TODO` comments in source code — either fix it now or add it to CHANGELOG.md's TODO section

### 4. Secrets and Security

- Never commit `.env` (it's gitignored — verify before any `git add`)
- Never commit `config/credentials.json` or any `client_secret_*.json`
- Never log or print full API keys, OAuth tokens, or secrets to console
- Only validate user/external input at system boundaries; trust internal agent calls

### 5. Code Style

- JavaScript files use 2-space indentation; keep consistent with existing code
- Use `const` and `let`; no `var`
- Use `async/await`; avoid raw Promise chains
- Do not add JSDoc or type annotations unless the function signature is genuinely ambiguous
- Favor editing existing files over creating new ones

### 6. Agent Changes

When modifying any agent (`agents/*.js`):
- Do not change the public interface (method signatures) without updating all callers
- AI provider initialization order is: Anthropic → Grok → OpenAI → simulation
- Any new env var must be added to `.env.example`

---

## Useful Commands

```bash
npm start                        # Start full server + agents
npm run setup                    # Interactive credential setup + OAuth
node generate-now.js             # Generate one video immediately
npm run db:init                  # Re-initialize SQLite schema
NODE_ENV=development npm start   # Debug mode with verbose logging
```

```bash
# Check what's uncommitted
git diff --stat

# See what changed since last commit
git diff HEAD

# Cut a new commit
git add -p                       # Stage interactively (avoid accidental secrets)
git commit -m "feat: ..."
```

---

## Commit Message Format

```
type: short description (max 72 chars)

Optional longer explanation if needed.
```

Types: `feat` | `fix` | `chore` | `refactor` | `docs` | `style`

Examples:
```
feat: add Google Cloud TTS with chunked sentence splitting
fix: publishAt rejected for past timestamps — use public immediately
docs: update CHANGELOG and README for v1.1.0
```

---

## File Quick Reference

| What you want | Where to look |
|---|---|
| Topic selection / angle generation | `agents/content-strategy-agent.js` → `getNicheTopic()`, `generateAngle()` |
| AI script generation | `agents/script-writer-agent.js` → `generateScriptWithAI()` |
| Visual prompt building | `agents/production-management-agent.js` → `createVisualPromptsFromScript()` |
| TTS generation | `utils/ai-video-generator.js` → `generateNarration()` |
| Image generation + cache | `utils/ai-video-generator.js` → `generateVisualAsset()`, `getCachedImage()` |
| YouTube upload + tag sanitization | `agents/publishing-scheduling-agent.js` → `uploadToYouTube()` |
| REST endpoints | `index.js` |
| Dashboard HTML | `dashboard/index.html` |
| SQLite queries | `database/db.js` |
| OAuth flow | `modern-auth.js` |

---

## Content Rules (Channel-Specific)

- Topic pool is in `getNicheTopic()` — add new topics there, not in `selectOptimalTopic()`
- Angles must include the current year using `new Date().getFullYear()` — never hardcode a year
- Visual prompts must always end with `, cinematic, no text` to prevent text artifacts in AI images
- Thumbnail style is always `cinematic` — never `ethereal` or other placeholder styles
- Channel references: mention `tokns.fi` or `coherencedaddy.com` naturally in scripts, not forced

---

## When to Ask Before Proceeding

- Changing the AI provider priority order
- Modifying the SQLite schema (breaking change for existing data)
- Adding a new cron job or automation schedule
- Any `git push` to remote
- Deleting data files under `data/`
