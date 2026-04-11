const OpenAI = require('openai');
const Replicate = require('replicate');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');
const { Logger } = require('./logger');

const execAsync = promisify(exec);

class AIVideoGenerator {
  constructor(credentials) {
    this.logger = new Logger('AIVideoGenerator');
    
    // Initialize AI services with graceful fallback
    const grokKey = credentials.grok?.apiKey || process.env.GROK_API_KEY;
    const openaiKey = credentials.openai?.apiKey || process.env.OPENAI_API_KEY;
    const replicateKey = credentials.replicate?.apiKey || process.env.REPLICATE_API_KEY;

    // Grok client — used for image generation (Aurora model)
    if (grokKey) {
      this.grokClient = new OpenAI({ apiKey: grokKey, baseURL: 'https://api.x.ai/v1' });
      this.logger.info('Grok (xAI) image service initialized');
    }

    // OpenAI client — used for TTS; images only if no Grok key
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
      this.useGrok = false;
      this.logger.info('OpenAI service initialized');
    }

    if (!grokKey && !openaiKey) {
      this.logger.warn('No AI API key found - AI features will be simulated');
    }
    
    if (replicateKey) {
      this.replicate = new Replicate({ auth: replicateKey });
      this.logger.info('Replicate service initialized');
    } else {
      this.logger.warn('Replicate API key not found - advanced video generation unavailable');
    }
    
    // ElevenLabs configuration
    this.elevenLabsApiKey = credentials.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY;
    this.elevenLabsVoiceId = credentials.elevenLabs?.voiceId || process.env.ELEVENLABS_VOICE_ID;

    // Google Cloud TTS
    this.googleTTSApiKey = credentials.google?.ttsApiKey || process.env.GOOGLE_TTS_API_KEY;
    this.googleTTSVoice = process.env.GOOGLE_TTS_VOICE || 'en-US-Neural2-J';
    this.googleTTSLanguage = process.env.GOOGLE_TTS_LANGUAGE || 'en-US';

    // Azure Speech configuration
    this.azureSpeechKey = credentials.azure?.speechKey || process.env.AZURE_SPEECH_KEY;
    this.azureSpeechRegion = credentials.azure?.speechRegion || process.env.AZURE_SPEECH_REGION;

    // Chatterbox TTS (self-hosted voice clone)
    this.chatterboxApiUrl = credentials.chatterbox?.apiUrl || process.env.CHATTERBOX_API_URL;
    this.chatterboxApiKey = credentials.chatterbox?.apiKey || process.env.CHATTERBOX_API_KEY;
    this.chatterboxVoiceRef = process.env.CHATTERBOX_VOICE_REF || 'default';
    if (this.chatterboxApiUrl) {
      this.logger.info(`Chatterbox TTS configured at ${this.chatterboxApiUrl}`);
    }
  }

  async generateTTSAudio(text, outputPath) {
    this.logger.info('Generating TTS audio...');

    // Each provider is wrapped individually so a failure falls through to the next one.

    // 0. Chatterbox (own voice clone, self-hosted)
    if (this.chatterboxApiUrl) {
      try {
        return await this.generateChatterboxTTS(text, outputPath);
      } catch (e) {
        this.logger.warn(`Chatterbox TTS failed (${e.message}), trying next provider...`);
      }
    }

    // 1. ElevenLabs (best quality)
    if (this.elevenLabsApiKey && this.elevenLabsVoiceId) {
      try {
        return await this.generateElevenLabsTTS(text, outputPath);
      } catch (e) {
        this.logger.warn(`ElevenLabs TTS failed (${e.message}), trying next provider...`);
      }
    }

    // 2. Google Cloud TTS (free 1M chars/mo)
    if (this.googleTTSApiKey) {
      try {
        return await this.generateGoogleTTS(text, outputPath);
      } catch (e) {
        this.logger.warn(`Google Cloud TTS failed (${e.response?.status || e.message}), trying next provider...`);
      }
    }

    // 3. OpenAI TTS
    if (this.openai && !this.useGrok) {
      try {
        return await this.generateOpenAITTS(text, outputPath);
      } catch (e) {
        this.logger.warn(`OpenAI TTS failed (${e.message}), trying next provider...`);
      }
    }

    // 4. macOS built-in TTS (free, offline — always available on Mac)
    try {
      return await this.generateMacOSTTS(text, outputPath);
    } catch (e) {
      this.logger.error(`macOS TTS failed (${e.message}). Is ffmpeg installed? Run: brew install ffmpeg`);
      throw new Error('All TTS providers failed. See logs for details.');
    }
  }

  async generateElevenLabsTTS(text, outputPath) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}`;
    
    const data = {
      text: text,
      model_id: "eleven_monolingual_v1",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.0,
        use_speaker_boost: true
      }
    };

    const response = await axios({
      method: 'POST',
      url: url,
      data: data,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': this.elevenLabsApiKey
      },
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        this.logger.info('ElevenLabs TTS generation complete');
        resolve(outputPath);
      });
      writer.on('error', reject);
    });
  }

  async generateGoogleTTS(text, outputPath) {
    const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${this.googleTTSApiKey}`;
    const CHUNK_SIZE = 4500; // Google TTS limit is 5000 bytes

    // Split text into chunks at sentence boundaries
    const chunks = [];
    let remaining = text;
    while (remaining.length > CHUNK_SIZE) {
      let splitAt = remaining.lastIndexOf('. ', CHUNK_SIZE);
      if (splitAt === -1) splitAt = remaining.lastIndexOf(' ', CHUNK_SIZE);
      if (splitAt === -1) splitAt = CHUNK_SIZE;
      chunks.push(remaining.slice(0, splitAt + 1).trim());
      remaining = remaining.slice(splitAt + 1).trim();
    }
    if (remaining.length > 0) chunks.push(remaining);

    const audioBuffers = [];
    for (const chunk of chunks) {
      const response = await axios.post(url, {
        input: { text: chunk },
        voice: { languageCode: this.googleTTSLanguage, name: this.googleTTSVoice, ssmlGender: 'MALE' },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0, pitch: 0, volumeGainDb: 0 }
      });
      audioBuffers.push(Buffer.from(response.data.audioContent, 'base64'));
    }

    await fs.writeFile(outputPath, Buffer.concat(audioBuffers));
    this.logger.info(`Google Cloud TTS generation complete (${chunks.length} chunk${chunks.length > 1 ? 's' : ''})`);
    return outputPath;
  }

  async generateOpenAITTS(text, outputPath) {
    const response = await this.openai.audio.speech.create({
      model: "tts-1-hd",
      voice: "nova",
      input: text,
      speed: 1.0
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);
    
    this.logger.info('OpenAI TTS generation complete');
    return outputPath;
  }

  async generateMacOSTTS(text, outputPath) {
    const aiffPath = outputPath.replace(/\.[^.]+$/, '.aiff');
    await execAsync(`say -o "${aiffPath}" "${text.replace(/"/g, '\\"')}"`);
    await execAsync(`ffmpeg -y -i "${aiffPath}" "${outputPath}"`);
    await fs.unlink(aiffPath).catch(() => {});
    this.logger.info('macOS TTS generation complete');
    return outputPath;
  }

  async generateChatterboxTTS(text, outputPath) {
    // Quick health check — fail fast if VPS is down
    await axios.get(`${this.chatterboxApiUrl}/health`, { timeout: 3000 });

    const response = await axios.post(
      `${this.chatterboxApiUrl}/v1/tts`,
      { text, voice_ref: this.chatterboxVoiceRef, temperature: 0.8 },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.chatterboxApiKey || ''
        },
        responseType: 'arraybuffer',
        timeout: 120000
      }
    );

    // Server returns WAV; convert to MP3 for downstream compatibility
    const wavPath = outputPath.replace(/\.mp3$/, '_raw.wav');
    await fs.writeFile(wavPath, Buffer.from(response.data));
    await execAsync(`ffmpeg -y -i "${wavPath}" -codec:a libmp3lame -qscale:a 2 "${outputPath}"`);
    await fs.unlink(wavPath).catch(() => {});

    this.logger.info('Chatterbox TTS generation complete (voice clone)');
    return outputPath;
  }

  // ── Image cache ──────────────────────────────────────────────────────────

  get cacheDir() {
    return path.join(__dirname, '..', 'data', 'assets', 'cache');
  }

  get cacheIndexPath() {
    return path.join(this.cacheDir, 'index.json');
  }

  hashPrompt(prompt) {
    return crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 10);
  }

  promptToSlug(prompt) {
    return prompt
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, 6)
      .join('-');
  }

  async loadCacheIndex() {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const raw = await fs.readFile(this.cacheIndexPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  async saveCacheIndex(index) {
    await fs.writeFile(this.cacheIndexPath, JSON.stringify(index, null, 2));
  }

  async getCachedImage(enhancedPrompt) {
    const index = await this.loadCacheIndex();
    const key = this.hashPrompt(enhancedPrompt);
    const entry = index[key];
    if (!entry) return null;
    // Verify file still exists
    try {
      await fs.access(entry.path);
      return entry.path;
    } catch {
      // Stale entry — remove it
      delete index[key];
      await this.saveCacheIndex(index);
      return null;
    }
  }

  async cacheImage(enhancedPrompt, originalPrompt, imagePath) {
    const index = await this.loadCacheIndex();
    const key = this.hashPrompt(enhancedPrompt);
    index[key] = {
      path: imagePath,
      prompt: originalPrompt,
      enhancedPrompt,
      created: new Date().toISOString()
    };
    await this.saveCacheIndex(index);
  }

  // ── Visual asset generation ───────────────────────────────────────────────

  async generateVisualAssets(prompt, style = "ethereal", count = 1) {
    this.logger.info(`Generating ${count} visual asset(s): "${prompt.slice(0, 60)}..."`);

    try {
      if (!this.grokClient && !this.openai) {
        return await this.simulateVisualAssets(prompt, style, count);
      }

      const enhancedPrompt = this.enhanceVisualPrompt(prompt, style);

      // Check cache first
      const cached = await this.getCachedImage(enhancedPrompt);
      if (cached) {
        this.logger.info(`  → Cache hit, reusing: ${path.basename(cached)}`);
        return [cached];
      }

      // Generate new image
      let response;
      if (this.grokClient) {
        response = await this.grokClient.images.generate({
          model: 'grok-imagine-image',
          prompt: enhancedPrompt,
          n: count
        });
      } else {
        response = await this.openai.images.generate({
          model: 'dall-e-3', prompt: enhancedPrompt, n: count,
          size: '1792x1024', quality: 'hd', style: 'natural'
        });
      }

      await fs.mkdir(this.cacheDir, { recursive: true });
      const localPaths = [];

      for (let i = 0; i < response.data.length; i++) {
        const slug = this.promptToSlug(prompt);
        const hash = this.hashPrompt(enhancedPrompt + i);
        const imagePath = path.join(this.cacheDir, `${slug}_${hash}.png`);
        await this.downloadImage(response.data[i].url, imagePath);
        await this.cacheImage(enhancedPrompt, prompt, imagePath);
        localPaths.push(imagePath);
        this.logger.info(`  → Saved: ${path.basename(imagePath)}`);
      }

      this.logger.info(`Generated and cached ${localPaths.length} visual asset(s)`);
      return localPaths;
    } catch (error) {
      this.logger.error('Visual asset generation failed:', error);
      return await this.simulateVisualAssets(prompt, style, count);
    }
  }

  enhanceVisualPrompt(prompt, style) {
    const styleEnhancements = {
      ethereal: "ethereal, dreamy, mystical, soft lighting, floating particles, cosmic background",
      modern: "modern, clean, minimalist, professional, sleek design, contemporary",
      animated: "animated style, cartoon, vibrant colors, expressive, dynamic",
      cinematic: "cinematic lighting, dramatic, movie poster style, high contrast",
      abstract: "abstract art, geometric shapes, gradient colors, artistic composition"
    };

    const enhancement = styleEnhancements[style] || styleEnhancements.ethereal;
    return `${prompt}, ${enhancement}, high quality, 16:9 aspect ratio, digital art`;
  }

  async downloadImage(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async generateVideo(script, visualAssets, audioPath, outputPath, captionsPath = null) {
    this.logger.info('Generating video from assets...');

    try {
      if (this.replicate && this.replicate.auth) {
        return await this.generateReplicateVideo(script, visualAssets, audioPath, outputPath);
      }
      return await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath, captionsPath);
    } catch (error) {
      this.logger.error('Video generation failed:', error.message || error);
      if (error.stderr) this.logger.error('ffmpeg stderr:', error.stderr.slice(-500));
      return await this.simulateVideoGeneration(script, visualAssets, audioPath, outputPath);
    }
  }

  async generateReplicateVideo(script, visualAssets, audioPath, outputPath) {
    // Use Stable Video Diffusion or similar model
    const output = await this.replicate.run(
      "stability-ai/stable-video-diffusion:3f0457e4619daac51203dedb1a4f46e66251bb3bfb18edd25d728dda8aa28ab7",
      {
        input: {
          cond_aug: 0.02,
          decoding_t: 7,
          input_image: visualAssets[0], // Use first image as base
          video_length: "14_frames_with_svd",
          sizing_strategy: "maintain_aspect_ratio",
          motion_bucket_id: 127,
          fps_id: 6
        }
      }
    );

    // Download the generated video
    if (output && output.length > 0) {
      await this.downloadVideo(output[0], outputPath);
      
      // Add audio track
      await this.addAudioToVideo(outputPath, audioPath, outputPath);
    }

    return outputPath;
  }

  async generateSlideshowVideo(script, visualAssets, audioPath, outputPath, captionsPath = null) {
    this.logger.info('Creating slideshow video with ffmpeg...');

    const realImages = (visualAssets || []).filter(p => p && !p.endsWith('.info') && !p.endsWith('.assembly.json'));
    if (realImages.length === 0) throw new Error('No real image assets available for video assembly');

    // Get audio duration
    let audioDuration = 60;
    try {
      const probe = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`);
      audioDuration = parseFloat(probe.stdout.trim()) || 60;
    } catch (_) {}

    const secPerSlide = audioDuration / realImages.length;

    // Build per-frame list with word-by-word caption frames
    // frames = [{path, duration, isTemp}]
    let frames;
    if (captionsPath) {
      try {
        frames = await this.generateCaptionFrames(realImages, captionsPath, secPerSlide, audioDuration, outputPath);
        this.logger.info(`Generated ${frames.length} caption frames from ${realImages.length} slides`);
      } catch (e) {
        this.logger.warn('Caption frame generation failed, using plain slides:', e.message);
        frames = realImages.map(p => ({ path: p, duration: secPerSlide, isTemp: false }));
      }
    } else {
      frames = realImages.map(p => ({ path: p, duration: secPerSlide, isTemp: false }));
    }

    // Build concat file with per-frame durations
    const concatPath = outputPath.replace('.mp4', '_concat.txt');
    const concatLines = frames.map(f => `file '${f.path}'\nduration ${f.duration.toFixed(3)}`).join('\n');
    const lastFrame = frames[frames.length - 1];
    await fs.writeFile(concatPath, concatLines + `\nfile '${lastFrame.path}'`);

    const silentVideo = outputPath.replace('.mp4', '_silent.mp4');
    const baseVf = `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1`;

    // Step 1: build silent slideshow
    try {
      await execAsync(`ffmpeg -y -f concat -safe 0 -i "${concatPath}" -vf "${baseVf}" -c:v libx264 -pix_fmt yuv420p -r 30 "${silentVideo}"`);
    } catch (e) {
      this.logger.error('Slideshow ffmpeg failed:', e.message);
      if (e.stderr) this.logger.error('stderr:', e.stderr.slice(-800));
      throw e;
    }

    // Step 2: merge with audio
    try {
      await execAsync(`ffmpeg -y -i "${silentVideo}" -i "${audioPath}" -c:v copy -c:a aac -shortest "${outputPath}"`);
    } catch (e) {
      this.logger.error('Audio merge failed:', e.message);
      throw e;
    }

    // Cleanup
    await fs.unlink(concatPath).catch(() => {});
    await fs.unlink(silentVideo).catch(() => {});
    for (const f of frames) {
      if (f.isTemp) await fs.unlink(f.path).catch(() => {});
    }

    this.logger.info(`Slideshow assembled: ${realImages.length} bg images → ${frames.length} frames, ${Math.round(audioDuration)}s, captions: ${captionsPath ? 'yes' : 'no'}`);
    return outputPath;
  }

  // Generate one frame per SRT entry — word-by-word caption pop style
  async generateCaptionFrames(images, captionsPath, secPerSlide, totalDuration, outputBase) {
    const srtContent = await fs.readFile(captionsPath, 'utf8');
    const captions = this.parseSRT(srtContent);
    const frames = [];

    for (let i = 0; i < images.length; i++) {
      const slideStart = i * secPerSlide;
      const slideEnd = Math.min(slideStart + secPerSlide, totalDuration);
      const slideEntries = captions.filter(c => c.end > slideStart && c.start < slideEnd);

      if (slideEntries.length === 0) {
        frames.push({ path: images[i], duration: slideEnd - slideStart, isTemp: false });
        continue;
      }

      let prevTime = slideStart;
      for (let j = 0; j < slideEntries.length; j++) {
        const entry = slideEntries[j];
        const entryStart = Math.max(entry.start, slideStart);
        const entryEnd = Math.min(entry.end, slideEnd);

        // Gap before this entry (background only, no text)
        if (entryStart > prevTime + 0.05) {
          frames.push({ path: images[i], duration: entryStart - prevTime, isTemp: false });
        }

        // Render word-by-word caption frame
        const outPath = outputBase.replace('.mp4', `_s${i}_c${j}_cap.jpg`);
        await this.renderCaptionFrame(images[i], entry.text, outPath);
        frames.push({ path: outPath, duration: Math.max(0.1, entryEnd - entryStart), isTemp: true });

        prevTime = entryEnd;
      }

      // Trailing gap after last entry
      if (prevTime < slideEnd - 0.05) {
        frames.push({ path: images[i], duration: slideEnd - prevTime, isTemp: false });
      }
    }

    return frames;
  }

  // Render one caption frame: background image + styled word-by-word text overlay
  async renderCaptionFrame(bgImagePath, text, outPath) {
    const sharp = require('sharp');
    const W = 1920, H = 1080;

    // All-caps for impact
    const displayText = text.toUpperCase();
    const escaped = this.escapeXml(displayText);

    // Scale font down for longer phrases (4+ words or long words)
    const charCount = displayText.length;
    const fontSize = charCount > 24 ? 68 : charCount > 16 ? 76 : 86;
    const strokeW = Math.round(fontSize / 9);
    const textY = H - 120;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs>
        <linearGradient id="vg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#000" stop-opacity="0"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0.55"/>
        </linearGradient>
      </defs>
      <!-- Bottom vignette for readability on any background -->
      <rect x="0" y="${H - 280}" width="${W}" height="280" fill="url(#vg)"/>
      <!-- Drop shadow -->
      <text x="${W / 2 + 5}" y="${textY + 7}"
            font-family="Arial Black, Impact, Arial, sans-serif"
            font-size="${fontSize}" font-weight="900"
            fill="rgba(0,0,0,0.6)"
            text-anchor="middle" dominant-baseline="alphabetic">${escaped}</text>
      <!-- Black stroke (outline) -->
      <text x="${W / 2}" y="${textY}"
            font-family="Arial Black, Impact, Arial, sans-serif"
            font-size="${fontSize}" font-weight="900"
            fill="none" stroke="black" stroke-width="${strokeW}" stroke-linejoin="round"
            text-anchor="middle" dominant-baseline="alphabetic">${escaped}</text>
      <!-- Yellow fill -->
      <text x="${W / 2}" y="${textY}"
            font-family="Arial Black, Impact, Arial, sans-serif"
            font-size="${fontSize}" font-weight="900"
            fill="#FFE600"
            text-anchor="middle" dominant-baseline="alphabetic">${escaped}</text>
    </svg>`;

    await sharp(bgImagePath)
      .resize(W, H, { fit: 'cover' })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 92 })
      .toFile(outPath);
  }

  createSlideshowHTML(script, visualAssets) {
    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            margin: 0;
            padding: 0;
            width: 1920px;
            height: 1080px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            font-family: 'Arial', sans-serif;
            overflow: hidden;
        }
        
        .slide {
            position: absolute;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 2s ease-in-out;
        }
        
        .slide.active {
            opacity: 1;
        }
        
        .content {
            text-align: center;
            color: white;
            max-width: 80%;
        }
        
        h1 {
            font-size: 72px;
            margin-bottom: 30px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        h2 {
            font-size: 48px;
            margin-bottom: 20px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        p {
            font-size: 36px;
            line-height: 1.4;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
        }
        
        .background-image {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            opacity: 0.3;
            z-index: -1;
        }
        
        .particles {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            z-index: -1;
        }
        
        .particle {
            position: absolute;
            background: rgba(255,255,255,0.8);
            border-radius: 50%;
            animation: float 6s ease-in-out infinite;
        }
        
        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-20px); }
        }
    </style>
</head>
<body>
    <div class="particles"></div>
    
    <!-- Title Slide -->
    <div class="slide active">
        ${visualAssets[0] ? `<img class="background-image" src="${visualAssets[0]}" />` : ''}
        <div class="content">
            <h1>${script.title}</h1>
            <p>Ethereal Dreamscript</p>
        </div>
    </div>
    
    ${this.generateContentSlides(script, visualAssets).join('')}
    
    <!-- Subscribe Slide -->
    <div class="slide">
        <div class="content">
            <h2>✨ Subscribe for More Stories ✨</h2>
            <p>New content daily at 2:00 PM</p>
        </div>
    </div>
    
    <script>
        // Create floating particles
        function createParticles() {
            const container = document.querySelector('.particles');
            for (let i = 0; i < 20; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.top = Math.random() * 100 + '%';
                particle.style.width = (Math.random() * 4 + 2) + 'px';
                particle.style.height = particle.style.width;
                particle.style.animationDelay = Math.random() * 6 + 's';
                container.appendChild(particle);
            }
        }
        
        let currentSlide = 0;
        const slides = document.querySelectorAll('.slide');
        
        function advanceAnimation() {
            slides[currentSlide].classList.remove('active');
            currentSlide = (currentSlide + 1) % slides.length;
            slides[currentSlide].classList.add('active');
        }
        
        window.advanceAnimation = advanceAnimation;
        createParticles();
    </script>
</body>
</html>`;
  }

  generateContentSlides(script, visualAssets) {
    const slides = [];
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section, index) => {
        const assetIndex = Math.min(index + 1, visualAssets.length - 1);
        
        slides.push(`
        <div class="slide">
            ${visualAssets[assetIndex] ? `<img class="background-image" src="${visualAssets[assetIndex]}" />` : ''}
            <div class="content">
                <h2>${section.title}</h2>
                ${this.formatSectionContent(section)}
            </div>
        </div>`);
      });
    }
    
    return slides;
  }

  formatSectionContent(section) {
    if (section.items && Array.isArray(section.items)) {
      return section.items.slice(0, 3).map(item => 
        `<p>${item.number}. ${item.title}</p>`
      ).join('');
    }
    
    if (section.steps && Array.isArray(section.steps)) {
      return section.steps.slice(0, 3).map(step => 
        `<p>${step.title}</p>`
      ).join('');
    }
    
    if (typeof section.content === 'string') {
      return `<p>${section.content.slice(0, 200)}${section.content.length > 200 ? '...' : ''}</p>`;
    }
    
    return '<p>Content coming soon...</p>';
  }

  calculateScriptDuration(script) {
    // Estimate duration based on word count (average 150 words per minute)
    let totalWords = 0;
    
    if (script.hook) totalWords += script.hook.text.split(' ').length;
    if (script.introduction) {
      totalWords += (script.introduction.greeting || '').split(' ').length;
      totalWords += (script.introduction.topicIntro || '').split(' ').length;
    }
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        if (typeof section.content === 'string') {
          totalWords += section.content.split(' ').length;
        }
        if (section.items) {
          section.items.forEach(item => {
            totalWords += (item.title + ' ' + item.description).split(' ').length;
          });
        }
        if (section.steps) {
          section.steps.forEach(step => {
            totalWords += (step.title + ' ' + step.description).split(' ').length;
          });
        }
      });
    }
    
    if (script.conclusion) {
      totalWords += script.conclusion.finalThought.split(' ').length;
    }
    
    // Convert to duration (150 words per minute)
    return Math.max(30, Math.ceil((totalWords / 150) * 60));
  }

  async addAudioToVideo(videoPath, audioPath, outputPath) {
    const command = `ffmpeg -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a aac -shortest "${outputPath}"`;
    await execAsync(command);
    this.logger.info('Audio added to video successfully');
  }

  async downloadVideo(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async cleanupDirectory(dirPath) {
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        await fs.unlink(path.join(dirPath, file));
      }
      await fs.rmdir(dirPath);
    } catch (error) {
      this.logger.warn('Cleanup failed:', error.message);
    }
  }

  // Parse SRT subtitle file into [{start, end, text}]
  parseSRT(srtContent) {
    const entries = [];
    const blocks = srtContent.trim().split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 3) continue;
      const timeLine = lines[1];
      const match = timeLine.match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
      if (!match) continue;
      const toSecs = t => {
        const [h, m, s] = t.replace(',', '.').split(':').map(Number);
        return h * 3600 + m * 60 + s;
      };
      entries.push({
        start: toSecs(match[1]),
        end: toSecs(match[2]),
        text: lines.slice(2).join(' ').replace(/<[^>]+>/g, '').trim()
      });
    }
    return entries;
  }

  // Escape XML special chars for SVG
  escapeXml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  buildThumbnailPrompt(title) {
    const t = title.toLowerCase();
    // NO text in image — Grok renders requested text literally, which ruins the thumbnail
    // We generate a vivid background; text gets added separately by the thumbnail designer
    if (/bitcoin|btc/.test(t))
      return 'dramatic golden Bitcoin coin glowing against dark storm clouds, cinematic lighting, hyper-realistic, 16:9, no text';
    if (/ethereum|eth/.test(t))
      return 'Ethereum diamond logo floating in neon blue digital void, cinematic depth of field, hyper-realistic, 16:9, no text';
    if (/altcoin|altcoins/.test(t))
      return 'multiple glowing cryptocurrency coins exploding outward against dark background, dramatic lighting, cinematic, 16:9, no text';
    if (/tx ecosystem|tokns/.test(t))
      return 'futuristic purple blockchain network nodes glowing, dark space background, cinematic, hyper-realistic, 16:9, no text';
    if (/defi|staking|passive/.test(t))
      return 'golden coins raining into a digital vault, green financial charts, cinematic, 16:9, no text';
    if (/mindset|motivat|discipline|success|wealth/.test(t))
      return 'person silhouette on mountain summit at sunrise, dramatic rays of light, cinematic landscape, 16:9, no text';
    if (/chart|price|prediction|bull|market/.test(t))
      return 'dramatic green crypto price chart surging upward, dark trading terminal background, cinematic, 16:9, no text';
    // Generic crypto fallback
    return 'dramatic cryptocurrency market scene, neon green and gold on dark background, cinematic lighting, hyper-realistic, 16:9, no text';
  }

  async generateThumbnail(script, style = "cinematic") {
    this.logger.info('Generating custom thumbnail...');

    try {
      if (!this.grokClient && !this.openai) {
        return await this.simulateThumbnailGeneration(script, style);
      }

      const prompt = this.buildThumbnailPrompt(script.title);

      // Check cache
      const cached = await this.getCachedImage(prompt);
      if (cached) {
        this.logger.info(`Thumbnail cache hit: ${path.basename(cached)}`);
        const stats = await fs.stat(cached);
        return { path: cached, url: null, dimensions: { width: 1792, height: 1024 }, fileSize: stats.size };
      }

      let response;
      if (this.grokClient) {
        response = await this.grokClient.images.generate({
          model: 'grok-imagine-image', prompt, n: 1
        });
      } else {
        response = await this.openai.images.generate({
          model: 'dall-e-3', prompt, n: 1, size: '1792x1024', quality: 'hd'
        });
      }

      const slug = this.promptToSlug(script.title);
      const hash = this.hashPrompt(prompt);
      const thumbnailPath = path.join(this.cacheDir, `thumb_${slug}_${hash}.png`);
      await fs.mkdir(this.cacheDir, { recursive: true });

      await this.downloadImage(response.data[0].url, thumbnailPath);
      await this.cacheImage(prompt, script.title, thumbnailPath);

      return {
        path: thumbnailPath,
        url: response.data[0].url,
        dimensions: { width: 1792, height: 1024 },
        fileSize: await this.getFileSize(thumbnailPath)
      };
    } catch (error) {
      this.logger.error('Thumbnail generation failed:', error);
      return await this.simulateThumbnailGeneration(script, style);
    }
  }

  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  // Simulation methods for when APIs are not available
  async simulateTTSGeneration(text, outputPath) {
    this.logger.info('Simulating TTS generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI TTS audio would be generated here',
      text: text.substring(0, 100) + '...',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateVisualAssets(prompt, style, count) {
    this.logger.info(`Simulating ${count} visual assets...`);
    
    const paths = [];
    for (let i = 0; i < count; i++) {
      const assetPath = path.join(__dirname, '..', 'data', 'assets', `visual_sim_${Date.now()}_${i}.info`);
      
      await fs.writeFile(assetPath, JSON.stringify({
        message: 'AI visual asset would be generated here',
        prompt: prompt,
        style: style,
        timestamp: new Date().toISOString()
      }, null, 2));
      
      paths.push(assetPath);
    }
    
    return paths;
  }

  async simulateVideoGeneration(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Simulating video generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI video would be generated here',
      script: script.title,
      visualAssets: visualAssets.length,
      audioPath: audioPath,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateThumbnailGeneration(script, style) {
    this.logger.info('Simulating thumbnail generation...');
    
    const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_sim_${Date.now()}.info`);
    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
    
    await fs.writeFile(thumbnailPath, JSON.stringify({
      message: 'AI thumbnail would be generated here',
      title: script.title,
      style: style,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return {
      path: thumbnailPath,
      dimensions: { width: 1792, height: 1024 },
      fileSize: 1024,
      simulated: true
    };
  }
}

module.exports = { AIVideoGenerator };