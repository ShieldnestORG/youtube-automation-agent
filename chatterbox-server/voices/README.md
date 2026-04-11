# Voice Reference Files

Place your voice reference WAV files here. The file named `default.wav` is used
when no specific voice is requested.

## Recording a good reference clip

1. **Duration**: 5-10 seconds of natural speech (read a short paragraph)
2. **Format**: WAV, mono, 16 kHz or higher sample rate
3. **Environment**: Quiet room, no background noise or echo
4. **Content**: Speak naturally at your normal pace and tone
5. **Avoid**: Whispering, shouting, music, or multiple speakers

## Quick recording (macOS)

```bash
# Record 10 seconds from your mic
ffmpeg -f avfoundation -i ":0" -t 10 -ar 16000 -ac 1 default.wav
```

## Quick recording (Linux)

```bash
ffmpeg -f pulse -i default -t 10 -ar 16000 -ac 1 default.wav
```

## Multiple voices

Name files by their purpose:
- `default.wav` — main narration voice
- `narrator.wav` — alternative style
- `character1.wav` — for different segments

Select a voice via the `CHATTERBOX_VOICE_REF` env var or the `voice_ref` API field.
