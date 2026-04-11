const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { Logger } = require('../utils/logger');
const { AIVideoGenerator } = require('../utils/ai-video-generator');

class ProductionManagementAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ProductionManagement');
    this.pipeline = [];
    this.assets = new Map();
    this.aiVideoGenerator = new AIVideoGenerator(credentials);
  }

  async initialize() {
    this.logger.info('Initializing Production Management Agent...');
    await this.setupDirectories();
    await this.loadPipeline();
    return true;
  }

  async setupDirectories() {
    const dirs = [
      'data/production',
      'data/assets',
      'data/videos',
      'data/audio',
      'data/scripts',
      'temp/processing'
    ];

    for (const dir of dirs) {
      await fs.mkdir(path.join(__dirname, '..', dir), { recursive: true });
    }
  }

  async loadPipeline() {
    try {
      const pipeline = await this.db.getProductionPipeline();
      this.pipeline = pipeline || [];
    } catch (error) {
      this.logger.warn('No existing pipeline found, starting fresh');
    }
  }

  async processContent(contentData) {
    try {
      this.logger.info('Processing content for production...');
      
      const { strategy, script, thumbnail, seo } = contentData;
      
      // Create production entry
      const productionId = this.generateProductionId();
      
      const productionData = {
        id: productionId,
        strategy,
        script,
        thumbnail,
        seo,
        status: 'processing',
        assets: {
          script: await this.processScript(script),
          thumbnail: await this.processThumbnail(thumbnail, script),
          audio: null, // Will be generated later
          video: null, // Will be generated later
          captions: null // Will be generated later
        },
        timeline: {
          created: new Date().toISOString(),
          scriptReady: new Date().toISOString(),
          thumbnailReady: new Date().toISOString(),
          audioGenerated: null,
          videoGenerated: null,
          captionsGenerated: null,
          readyForUpload: null
        },
        scheduledPublishTime: this.calculatePublishTime(strategy),
        priority: this.calculatePriority(strategy),
        estimatedDuration: script.duration,
        createdAt: new Date().toISOString()
      };
      
      // Add to pipeline
      this.pipeline.push(productionData);
      
      // Save to database
      await this.db.saveProductionData(productionData);
      
      // Generate video content
      await this.generateVideoContent(productionData);
      
      // Generate audio narration
      await this.generateAudioNarration(productionData);

      // Probe real audio duration for accurate caption timing
      const audioFile = productionData.assets.audio?.path;
      if (audioFile && audioFile.endsWith('.mp3')) {
        try {
          const probe = await execAsync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioFile}"`
          );
          const realDuration = parseFloat(probe.stdout.trim());
          if (realDuration > 0) {
            productionData.assets.audio.duration = realDuration;
          }
        } catch (e) {
          this.logger.warn('ffprobe failed, captions will use word-rate estimate:', e.message);
        }
      }

      // Generate captions
      await this.generateCaptions(productionData);
      
      // Final assembly
      await this.assembleVideo(productionData);
      
      // Mark as ready
      productionData.status = 'ready';
      productionData.timeline.readyForUpload = new Date().toISOString();
      
      await this.db.updateProductionData(productionData);
      
      this.logger.info(`Content processing complete: ${productionId}`);
      return productionData;
    } catch (error) {
      this.logger.error('Failed to process content:', error);
      throw error;
    }
  }

  generateProductionId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const extra = Math.random().toString(36).substring(2, 15);
    return `prod_${timestamp}_${random}_${extra}`;
  }

  async processScript(script) {
    const scriptPath = path.join(__dirname, '..', 'data', 'scripts', `${Date.now()}_script.json`);
    
    // Create formatted script for TTS
    const ttsScript = this.formatScriptForTTS(script);
    
    // Save script files
    await fs.writeFile(scriptPath, JSON.stringify(script, null, 2));
    await fs.writeFile(
      scriptPath.replace('.json', '_tts.txt'), 
      ttsScript
    );
    
    return {
      originalPath: scriptPath,
      ttsPath: scriptPath.replace('.json', '_tts.txt'),
      duration: script.duration,
      sections: script.mainContent.sections.length
    };
  }

  formatScriptForTTS(script) {
    let ttsText = '';
    
    // Add hook
    if (script.hook) {
      ttsText += `${script.hook.text}\n\n`;
    }
    
    // Add introduction
    if (script.introduction) {
      ttsText += `${script.introduction.greeting}\n`;
      ttsText += `${script.introduction.topicIntro}\n`;
      ttsText += `${script.introduction.valueProposition}\n`;
      ttsText += `${script.introduction.credibility}\n\n`;
    }
    
    // Add main content
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section, index) => {
        ttsText += `Section ${index + 1}: ${section.title}\n`;
        
        if (Array.isArray(section.content)) {
          section.content.forEach(line => {
            if (typeof line === 'string' && !line.startsWith('[')) {
              ttsText += `${line}\n`;
            }
          });
        } else if (section.steps) {
          section.steps.forEach(step => {
            ttsText += `${step.title}. ${step.description}\n`;
            ttsText += `${step.tip}\n`;
          });
        } else if (section.items) {
          section.items.forEach(item => {
            ttsText += `Number ${item.number}: ${item.title}. ${item.description}\n`;
          });
        } else if (typeof section.content === 'string') {
          ttsText += `${section.content}\n`;
        }
        
        ttsText += '\n';
      });
    }
    
    // Add conclusion
    if (script.conclusion) {
      script.conclusion.recap.forEach(line => {
        if (typeof line === 'string') {
          ttsText += `${line}\n`;
        }
      });
      ttsText += `\n${script.conclusion.finalThought}\n\n`;
    }
    
    // Add CTA
    if (script.callToAction) {
      ttsText += `${script.callToAction.subscribe}\n`;
      ttsText += `${script.callToAction.like}\n`;
      ttsText += `${script.callToAction.comment}\n`;
    }
    
    return ttsText;
  }

  async processThumbnail(thumbnail, script) {
    try {
      // Use the real script title, never the placeholder
      const scriptForThumb = script || thumbnail.script || { title: thumbnail.title || 'Tokns_fi' };
      const aiThumbnail = await this.aiVideoGenerator.generateThumbnail(scriptForThumb, 'cinematic');
      
      return {
        path: aiThumbnail.path,
        originalPath: thumbnail.path,
        dimensions: aiThumbnail.dimensions,
        fileSize: aiThumbnail.fileSize,
        generatedWith: 'AI'
      };
    } catch (error) {
      this.logger.error('AI thumbnail generation failed:', error);
      
      // Fallback to original processing
      const productionThumbnailPath = path.join(
        __dirname, '..', 'data', 'assets', 
        `thumbnail_${Date.now()}.jpg`
      );
      
      if (thumbnail.path && await fs.access(thumbnail.path).then(() => true).catch(() => false)) {
        const originalBuffer = await fs.readFile(thumbnail.path);
        await fs.writeFile(productionThumbnailPath, originalBuffer);
      } else {
        // Create placeholder
        await fs.writeFile(productionThumbnailPath + '.placeholder', 'Thumbnail placeholder');
      }
      
      return {
        path: productionThumbnailPath,
        originalPath: thumbnail.path,
        dimensions: thumbnail.dimensions || { width: 1792, height: 1024 },
        fileSize: thumbnail.fileSize || 0
      };
    }
  }

  calculatePublishTime(strategy) {
    // Use strategy's recommended time or calculate optimal time
    if (strategy.bestPublishTime) {
      return strategy.bestPublishTime;
    }
    
    // Default: next optimal publishing window
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(14, 0, 0, 0); // 2 PM default
    
    return tomorrow.toISOString();
  }

  calculatePriority(strategy) {
    let priority = 50; // Base priority
    
    // Adjust based on estimated views
    if (strategy.estimatedViews > 100000) priority += 30;
    else if (strategy.estimatedViews > 50000) priority += 20;
    else if (strategy.estimatedViews > 10000) priority += 10;
    
    // Adjust based on trend score
    if (strategy.competitorAnalysis && strategy.competitorAnalysis.length > 0) {
      priority += 10;
    }
    
    // Time sensitivity
    const hoursUntilPublish = (new Date(strategy.bestPublishTime) - new Date()) / (1000 * 60 * 60);
    if (hoursUntilPublish < 24) priority += 20;
    else if (hoursUntilPublish < 48) priority += 10;
    
    return Math.min(100, priority);
  }

  async generateVideoContent(productionData) {
    this.logger.info('Generating AI video content...');
    
    try {
      const { strategy, script } = productionData;
      
      // Generate visual assets using DALL-E
      const visualPrompts = this.createVisualPromptsFromScript(script);
      const visualAssets = [];
      
      for (const prompt of visualPrompts) {
        const assets = await this.aiVideoGenerator.generateVisualAssets(prompt, 'ethereal', 1);
        visualAssets.push(...assets);
      }
      
      productionData.assets.video = {
        visualAssets: visualAssets,
        duration: productionData.estimatedDuration,
        format: 'mp4',
        resolution: '1920x1080',
        fps: 30,
        generatedWith: 'AI'
      };
      
      productionData.timeline.videoGenerated = new Date().toISOString();
      
      return visualAssets;
    } catch (error) {
      this.logger.error('AI video content generation failed:', error);
      // Fallback to placeholder
      return await this.createVideoElements(productionData);
    }
  }

  async createVideoElements(productionData) {
    const { script } = productionData;
    const elements = [];
    
    // Title slide
    elements.push({
      type: 'title_slide',
      content: script.title,
      duration: 3,
      style: 'modern',
      animation: 'fade_in'
    });
    
    // Content sections
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section, index) => {
        // Section title
        elements.push({
          type: 'section_title',
          content: section.title,
          duration: 2,
          style: 'minimal',
          animation: 'slide_in'
        });
        
        // Content visuals
        if (section.type === 'list_items' && section.items) {
          section.items.forEach(item => {
            elements.push({
              type: 'list_item',
              content: {
                number: item.number,
                title: item.title,
                description: item.description
              },
              duration: 15,
              style: 'countdown',
              animation: 'zoom_in'
            });
          });
        } else if (section.type === 'solution_steps' && section.steps) {
          section.steps.forEach(step => {
            elements.push({
              type: 'step',
              content: {
                number: step.number,
                title: step.title,
                description: step.description
              },
              duration: 20,
              style: 'tutorial',
              animation: 'step_by_step'
            });
          });
        } else {
          // Generic content slide
          elements.push({
            type: 'content_slide',
            content: section.title,
            duration: section.duration || 30,
            style: 'informative',
            animation: 'fade_transition'
          });
        }
      });
    }
    
    // Conclusion slide
    elements.push({
      type: 'conclusion',
      content: 'Key Takeaways',
      duration: 5,
      style: 'summary',
      animation: 'reveal'
    });
    
    // Subscribe reminder
    elements.push({
      type: 'subscribe_reminder',
      content: 'Subscribe for More!',
      duration: 3,
      style: 'call_to_action',
      animation: 'bounce'
    });
    
    return elements;
  }

  async generateAudioNarration(productionData) {
    this.logger.info('Generating AI audio narration...');
    
    try {
      const { script } = productionData;
      const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_narration.mp3`);
      
      // Read the TTS script
      const ttsText = await fs.readFile(productionData.assets.script.ttsPath, 'utf8');
      
      // Generate audio using AI TTS
      await this.aiVideoGenerator.generateTTSAudio(ttsText, audioPath);
      
      productionData.assets.audio = {
        path: audioPath,
        duration: productionData.estimatedDuration,
        format: 'mp3',
        generatedWith: 'AI',
        quality: 'high'
      };
      
      productionData.timeline.audioGenerated = new Date().toISOString();
      
      return audioPath;
    } catch (error) {
      this.logger.error('AI audio generation failed:', error);
      // Fallback to simulation
      return await this.simulateAudioGeneration(productionData);
    }
  }

  async simulateTTSGeneration(scriptPath, outputPath, config) {
    // This is a simulation - in production, you'd integrate with actual TTS services
    this.logger.info(`Simulating TTS generation: ${config.voice}`);
    
    // Create a placeholder audio file reference
    await fs.writeFile(outputPath + '.info', JSON.stringify({
      message: 'TTS audio would be generated here',
      config,
      timestamp: new Date().toISOString()
    }, null, 2));
  }

  async generateCaptions(productionData) {
    this.logger.info('Generating captions...');
    
    const captionsPath = path.join(__dirname, '..', 'data', 'captions', `${productionData.id}_captions.srt`);
    
    // Generate SRT captions based on script timing
    const captions = await this.createSRTCaptions(productionData);
    
    await fs.mkdir(path.dirname(captionsPath), { recursive: true });
    await fs.writeFile(captionsPath, captions);
    
    productionData.assets.captions = {
      path: captionsPath,
      format: 'srt',
      language: 'en',
      autoGenerated: true
    };
    
    productionData.timeline.captionsGenerated = new Date().toISOString();
    
    return captionsPath;
  }

  async createSRTCaptions(productionData) {
    const { script } = productionData;
    let srt = '';
    let captionIndex = 1;

    const formatSRTTime = (seconds) => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      const ms = Math.floor((seconds % 1) * 1000);
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
    };

    const processText = (text, startTime, duration) => {
      const words = text.split(' ');
      const wordsPerCaption = 3;
      for (let i = 0; i < words.length; i += wordsPerCaption) {
        const captionWords = words.slice(i, i + wordsPerCaption);
        const captionDuration = duration / Math.ceil(words.length / wordsPerCaption);
        const captionStartTime = startTime + (i / words.length) * duration;
        const captionEndTime = captionStartTime + captionDuration;
        srt += `${captionIndex}\n`;
        srt += `${formatSRTTime(captionStartTime)} --> ${formatSRTTime(captionEndTime)}\n`;
        srt += `${captionWords.join(' ')}\n\n`;
        captionIndex++;
      }
    };

    // Collect all sections with their text
    const sections = [];

    if (script.hook && script.hook.text) {
      sections.push({ text: script.hook.text });
    }

    if (script.introduction) {
      const introText = `${script.introduction.greeting} ${script.introduction.topicIntro} ${script.introduction.valueProposition}`;
      sections.push({ text: introText });
    }

    if (script.mainContent && script.mainContent.sections) {
      for (const section of script.mainContent.sections) {
        let sectionText = '';
        if (Array.isArray(section.content)) {
          sectionText = section.content.filter(line =>
            typeof line === 'string' && !line.startsWith('[')
          ).join(' ');
        } else if (section.steps) {
          sectionText = section.steps.map(step =>
            `${step.title}. ${step.description}`
          ).join(' ');
        } else if (section.items) {
          sectionText = section.items.map(item =>
            `Number ${item.number}: ${item.title}. ${item.description}`
          ).join(' ');
        } else if (typeof section.content === 'string') {
          sectionText = section.content;
        }
        if (sectionText) {
          sections.push({ text: sectionText });
        }
      }
    }

    if (script.conclusion) {
      const conclusionText = script.conclusion.recap.join(' ') + ' ' + script.conclusion.finalThought;
      sections.push({ text: conclusionText });
    }

    // Distribute real audio duration proportionally by word count
    const totalWords = sections.reduce((sum, s) => sum + s.text.split(' ').length, 0);
    const totalDuration = productionData.assets.audio?.duration
      || (totalWords / 150) * 60; // 150 wpm fallback

    let currentTime = 0;
    for (const section of sections) {
      const sectionWords = section.text.split(' ').length;
      const sectionDuration = (sectionWords / totalWords) * totalDuration;
      processText(section.text, currentTime, sectionDuration);
      currentTime += sectionDuration;
    }

    return srt;
  }

  async assembleVideo(productionData) {
    this.logger.info('Assembling final AI-generated video...');

    // Guard: don't attempt assembly if audio is a simulation file
    const audioPath = productionData.assets.audio?.path;
    if (!audioPath || !audioPath.endsWith('.mp3')) {
      const reason = audioPath
        ? `audio path is not an MP3 ("${audioPath}") — TTS was simulated`
        : 'no audio path available';
      this.logger.error(`Video assembly skipped: ${reason}. Check TTS API keys in .env.`);
      productionData.assets.finalVideo = { path: null, simulated: true, reason };
      return null;
    }

    // Guard: don't attempt assembly if visual assets are simulation files
    const visualAssets = productionData.assets.video?.visualAssets || [];
    const realImages = visualAssets.filter(p => p && !p.endsWith('.info') && !p.endsWith('.assembly.json'));
    if (realImages.length === 0) {
      const reason = `no real image assets (${visualAssets.length} simulated) — check GROK_API_KEY / OPENAI_API_KEY in .env`;
      this.logger.error(`Video assembly skipped: ${reason}`);
      productionData.assets.finalVideo = { path: null, simulated: true, reason };
      return null;
    }

    try {
      const finalVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_final.mp4`);
      const captionsPath = productionData.assets.captions?.path || null;

      await this.aiVideoGenerator.generateVideo(
        productionData.script,
        visualAssets,
        audioPath,
        finalVideoPath,
        captionsPath
      );

      // Get file stats
      const stats = await fs.stat(finalVideoPath);

      productionData.assets.finalVideo = {
        path: finalVideoPath,
        fileSize: stats.size,
        duration: productionData.estimatedDuration,
        generatedWith: 'AI',
        resolution: '1920x1080',
        format: 'mp4'
      };

      this.logger.info('AI video assembly complete');
      return finalVideoPath;
    } catch (error) {
      this.logger.error('AI video assembly failed:', error.message);
      productionData.assets.finalVideo = { path: null, simulated: true, reason: error.message };
      return null;
    }
  }

  async simulateVideoRendering(instructions) {
    this.logger.info('Simulating video rendering...');
    
    // Create a placeholder that indicates video would be rendered
    await fs.writeFile(instructions.outputPath + '.placeholder', JSON.stringify({
      message: 'Final video would be rendered here',
      instructions,
      timestamp: new Date().toISOString()
    }, null, 2));
  }

  async getPipelineStatus() {
    return this.pipeline.map(item => ({
      id: item.id,
      title: item.script?.title || 'Untitled',
      status: item.status,
      priority: item.priority,
      scheduledPublishTime: item.scheduledPublishTime,
      progress: this.calculateProgress(item)
    }));
  }

  calculateProgress(productionData) {
    const milestones = [
      'scriptReady',
      'thumbnailReady',
      'audioGenerated',
      'videoGenerated',
      'captionsGenerated',
      'readyForUpload'
    ];
    
    const completed = milestones.filter(milestone => 
      productionData.timeline[milestone] !== null
    ).length;
    
    return Math.round((completed / milestones.length) * 100);
  }

  async getNextReadyContent() {
    const ready = this.pipeline
      .filter(item => item.status === 'ready')
      .sort((a, b) => b.priority - a.priority);
    
    return ready[0] || null;
  }

  // Helper method to create visual prompts from script content
  createVisualPromptsFromScript(script) {
    // Parse duration
    let durationSecs = 300;
    if (typeof script.duration === 'number') {
      durationSecs = script.duration;
    } else if (typeof script.duration === 'string' && script.duration.includes(':')) {
      const [m, s] = script.duration.split(':').map(Number);
      durationSecs = m * 60 + (s || 0);
    }

    // 1 image per 20 seconds, min 8, max 20
    const targetCount = Math.min(20, Math.max(8, Math.floor(durationSecs / 20)));
    const prompts = [];

    let vi = 0; // variant index — increments per prompt to force visual variety

    // 1. Opening / title card
    prompts.push(this.buildTitlePrompt(script.title));
    vi++;

    // 2. Hook
    if (script.hook?.text) {
      prompts.push(this.buildContentPrompt(script.hook.text, script.title, vi++));
    }

    // 3. Introduction
    if (script.introduction) {
      const introText = [script.introduction.topicIntro, script.introduction.valueProposition].filter(Boolean).join(' ');
      prompts.push(this.buildContentPrompt(introText, script.title, vi++));
    }

    // 4. Main sections
    if (script.mainContent?.sections) {
      const sections = script.mainContent.sections;
      const remaining = targetCount - prompts.length - 2;
      const perSection = Math.max(2, Math.floor(remaining / sections.length));

      sections.forEach(section => {
        prompts.push(this.buildSectionTitlePrompt(section.title, script.title, vi++));
        const contentLines = this.extractSectionText(section);
        const extras = Math.min(perSection - 1, contentLines.length);
        for (let i = 0; i < extras; i++) {
          prompts.push(this.buildContentPrompt(contentLines[i], script.title, vi++));
        }
      });
    }

    // 5. Conclusion
    if (script.conclusion?.finalThought) {
      prompts.push(this.buildContentPrompt(script.conclusion.finalThought, script.title, vi++));
    }

    // 6. CTA
    prompts.push(this.buildThematicPrompt(script.title, 'cta'));

    // Pad
    while (prompts.length < targetCount) {
      prompts.push(this.buildThematicPrompt(script.title, 'filler', vi++));
    }

    return prompts.slice(0, targetCount);
  }

  // Extract meaningful text lines from a section for prompt generation
  extractSectionText(section) {
    const lines = [];

    if (Array.isArray(section.content)) {
      section.content.forEach(line => {
        if (typeof line === 'string' && !line.startsWith('[') && line.length > 20) {
          lines.push(line);
        }
      });
    } else if (typeof section.content === 'string' && section.content.length > 20) {
      lines.push(section.content);
    }

    if (section.items) {
      section.items.forEach(item => {
        if (item.title) lines.push(`${item.title}: ${item.description || ''}`);
      });
    }

    if (section.steps) {
      section.steps.forEach(step => {
        if (step.title) lines.push(`${step.title}: ${step.description || ''}`);
      });
    }

    if (section.points) {
      section.points.forEach(p => { if (typeof p === 'string') lines.push(p); });
    }

    return lines;
  }

  // Visual style variants — cycle through these to ensure every image looks different
  getVariantSuffix(vi) {
    const variants = [
      'wide cinematic establishing shot',
      'extreme close-up dramatic detail',
      'birds eye view aerial perspective',
      'low angle hero shot looking up',
      'dynamic diagonal composition',
      'split screen dual perspective',
      'abstract geometric visualization',
      'documentary realism style',
      'neon noir dark aesthetic',
      'golden hour warm lighting',
      'deep space cosmic perspective',
      'macro microscopic scale',
    ];
    return variants[vi % variants.length];
  }

  // Generate a prompt from actual content text — most context-aware method
  buildContentPrompt(text, videoTitle, vi = 0) {
    const t = (text + ' ' + videoTitle).toLowerCase();
    const variant = this.getVariantSuffix(vi);

    if (/layer 2|scaling|gas fee|rollup|polygon|arbitrum|optimism/.test(t))
      return `Ethereum Layer 2 scaling network, fast transaction nodes glowing, blockchain infrastructure, ${variant}, cinematic, no text`;
    if (/ai|artificial intelligence|machine learning|prediction market|automated trading/.test(t))
      return `AI neural network merging with blockchain data streams, futuristic cyber brain, neon blue purple, ${variant}, cinematic, no text`;
    if (/defi|yield|stake|staking|farm|liquidity|passive income|earn/.test(t))
      return `DeFi yield farming coins multiplying in digital vault, green profit charts glowing, ${variant}, cinematic, no text`;
    if (/meme coin|volatile|speculation|hype|gamble|risk/.test(t))
      return `volatile crypto market red and green candles surging, rocket and warning symbols, ${variant}, dramatic cinematic, no text`;
    if (/tx ecosystem|tokns\.?fi|coherence/.test(t))
      return `TX blockchain ecosystem purple glowing network, community nodes connecting across globe, ${variant}, cinematic, no text`;
    if (/community|social|engagement|holders|believers|builders/.test(t))
      return `interconnected global crypto community network, glowing nodes representing people collaborating, ${variant}, cinematic, no text`;
    if (/smart contract|protocol|infrastructure|backbone|building/.test(t))
      return `blockchain smart contract code flowing through digital architecture, neon blueprints, ${variant}, cinematic, no text`;
    if (/bitcoin|btc|store of value|digital gold|halving/.test(t))
      return `Bitcoin gold coin glowing with power, digital gold standard rising, ${variant}, cinematic, no text`;
    if (/ethereum|eth|gas|solidity/.test(t))
      return `Ethereum blue hexagonal smart contract network floating, decentralized apps, ${variant}, cinematic, no text`;
    if (/altcoin|portfolio|diversif/.test(t))
      return `diverse cryptocurrency coins constellation, colorful digital assets glowing, strategic portfolio, ${variant}, cinematic, no text`;
    if (/chart|price|bull|candle|market|trade|trading/.test(t))
      return `cryptocurrency trading dashboard green upward candles surge, real-time price action neon, ${variant}, cinematic, no text`;
    if (/wallet|hardware|cold storage|security|protect|safe/.test(t))
      return `crypto hardware wallet security shield glowing, cyberpunk digital lock protection, ${variant}, cinematic, no text`;
    if (/adopt|future|mainstream|institution|mass/.test(t))
      return `futuristic city crypto logos in skyline, mass blockchain adoption vision, ${variant}, cinematic, no text`;
    if (/mindset|discipline|focus|consistent|habit/.test(t))
      return `determined crypto investor studying charts at night, multiple screens focused energy, ${variant}, cinematic, no text`;
    if (/wealth|rich|millionaire|financial freedom|money/.test(t))
      return `financial freedom gold coins digital assets floating, sunrise achievement moment, ${variant}, cinematic, no text`;
    if (/beginner|new|start|learn|education|guide/.test(t))
      return `beginner investor laptop crypto charts learning breakthrough moment, ${variant}, cinematic, no text`;
    if (/mistake|avoid|warning|danger|scam|careful/.test(t))
      return `crypto market warning signal red alert cautious investor dramatic, ${variant}, cinematic, no text`;

    const words = text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 4).slice(0, 4).join(' ');
    return `${words}, cryptocurrency blockchain neon aesthetic, ${variant}, cinematic, no text`;
  }

  buildTitlePrompt(title) {
    const t = title.toLowerCase();
    if (/bitcoin|btc/.test(t)) return 'dramatic golden Bitcoin coin emerging from dark storm, cinematic hero shot, no text';
    if (/ethereum|eth/.test(t)) return 'Ethereum diamond logo floating in electric blue void, cinematic depth, no text';
    if (/altcoin/.test(t)) return 'multiple glowing altcoins exploding outward in constellation pattern, dark background, cinematic, no text';
    if (/tx ecosystem|tokns/.test(t)) return 'futuristic purple TX blockchain network, glowing nodes, cinematic hero shot, no text';
    if (/defi|staking|passive/.test(t)) return 'DeFi golden coins raining into digital vault, cinematic, no text';
    if (/mindset|motivat|discipline|wealth|success/.test(t)) return 'silhouette on mountain at golden sunrise, inspirational cinematic, no text';
    return 'dramatic cryptocurrency market visualization, neon gold and purple, cinematic hero shot, no text';
  }

  buildSectionTitlePrompt(sectionTitle, videoTitle, vi = 0) {
    return this.buildContentPrompt(sectionTitle, videoTitle, vi);
  }

  buildThematicPrompt(videoTitle, role, vi = 0) {
    const t = videoTitle.toLowerCase();
    const isCrypto = /bitcoin|ethereum|crypto|blockchain|tx|defi|altcoin|tokns/.test(t);
    const isMotivation = /mindset|motivat|discipline|wealth|success|routine|millionaire/.test(t);
    const variant = this.getVariantSuffix(vi);

    if (role === 'hook') {
      if (isCrypto) return `dramatic crypto market candles surging red and green, explosive trading energy, ${variant}, cinematic, no text`;
      return `person breaking through barrier explosive motivational energy, ${variant}, cinematic, no text`;
    }
    if (role === 'intro') {
      if (isCrypto) return `global crypto network map glowing connections spanning continents, ${variant}, cinematic, no text`;
      return `inspiring workspace goals board laptop ambition, ${variant}, cinematic, no text`;
    }
    if (role === 'conclusion') {
      if (isCrypto) return `futuristic crypto city skyline mass adoption vision hopeful, ${variant}, cinematic, no text`;
      if (isMotivation) return `person celebrating mountain peak sunrise achievement, ${variant}, cinematic, no text`;
      return `bright digital horizon glowing path forward, ${variant}, cinematic, no text`;
    }
    if (role === 'cta') {
      return `glowing YouTube subscribe bell notification crypto channel call to action, ${variant}, cinematic, no text`;
    }
    if (isCrypto) return `abstract blockchain data streams flowing neon nodes, ${variant}, cinematic, no text`;
    return `abstract energy momentum neon light trails, ${variant}, cinematic, no text`;
  }

  // Fallback simulation methods
  async simulateAudioGeneration(productionData) {
    const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_narration.mp3`);
    
    await fs.writeFile(audioPath + '.info', JSON.stringify({
      message: 'AI TTS audio would be generated here',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    productionData.assets.audio = {
      path: audioPath + '.info',
      duration: productionData.estimatedDuration,
      format: 'mp3',
      simulated: true
    };
    
    return audioPath + '.info';
  }

  async simulateVideoAssembly(productionData) {
    const finalVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_final.mp4`);
    
    const assemblyInstructions = {
      message: 'AI video would be assembled here',
      assets: productionData.assets,
      timestamp: new Date().toISOString()
    };
    
    await fs.writeFile(
      finalVideoPath + '.assembly.json',
      JSON.stringify(assemblyInstructions, null, 2)
    );
    
    productionData.assets.finalVideo = {
      path: finalVideoPath + '.assembly.json',
      fileSize: 0,
      duration: productionData.estimatedDuration,
      simulated: true
    };
    
    return finalVideoPath + '.assembly.json';
  }
}

module.exports = { ProductionManagementAgent };