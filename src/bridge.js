const { EventEmitter } = require('events');

// Faces Verity can show. Anything else is coerced to the configured default.
const ALLOWED_VARIANTS = new Set([
  'default', 'happy', 'happy_talking', 'neutral', 'neutral_talking',
  'happy_sleep', 'crazy', 'crazy_talking',
  'serious_1', 'serious_2', 'serious_3', 'serious_talking',
  'evil', 'evil_talking', 'smiling_evil', 'noface',
]);

/**
 * Holds at most one pending question from the Minecraft mod and resolves it
 * with a JSON string in the exact schema the mod expects:
 * { "variant": "...", "karma_change": 0.0, "actions": [...], "message": "..." }
 */
class Bridge extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.pending = null; // { id, text, isSystem, createdAt, timer, resolve }
    this.nextId = 1;
    // Recent voice recordings from Discord, so the mod's TTS request can be
    // answered with the real human voice instead of synthesized speech.
    this.voiceAnswers = new Map(); // normalizedText -> { pcm, at, author }
    // Minecraft player's mic recordings, so Discord hears the real voice
    // instead of TTS of the transcription.
    this.playerVoices = new Map(); // normalizedText -> { pcm, at }
    this.latestPlayerVoice = null;
  }

  buildVerityJson(message, variant, karmaChange) {
    const v = ALLOWED_VARIANTS.has(variant) ? variant : this.config.defaultVariant;
    return JSON.stringify({
      variant: v,
      karma_change: typeof karmaChange === 'number' ? karmaChange : 0,
      actions: [{ action: 'answer' }],
      message: String(message),
    });
  }

  fallbackJson() {
    return this.buildVerityJson(this.config.fallbackMessage, this.config.defaultVariant, 0);
  }

  /**
   * Extract the text the player "said" from the OpenAI-style messages array.
   * The mod sends [system prompt, ...history, latest user message].
   */
  extractQuestion(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'user' && typeof messages[i].content === 'string') {
        return messages[i].content.trim();
      }
    }
    return '';
  }

  /**
   * Called by the HTTP server for every chat/completions request.
   * Returns a Promise<string> that resolves with the Verity JSON string.
   */
  ask(messages) {
    const text = this.extractQuestion(messages);
    const isSystem = text.startsWith('[SYSTEM OVERRIDE');

    // A system event (idle chatter / damage reaction) never disturbs a
    // pending real question - it just gets an instant fallback.
    if (this.pending && isSystem) {
      this.emit('systemSkipped', { text });
      return Promise.resolve(this.fallbackJson());
    }

    // A real player question bumps whatever was pending before.
    if (this.pending) {
      this.emit('bumped', { text: this.pending.text, by: text });
      this.resolvePending(this.fallbackJson(), null);
    }

    const timeoutMs = isSystem ? this.config.systemEventTimeoutMs : this.config.answerTimeoutMs;

    return new Promise((resolve) => {
      const entry = {
        id: this.nextId++,
        text,
        isSystem,
        createdAt: Date.now(),
        resolve,
        timer: setTimeout(() => {
          if (this.pending && this.pending.id === entry.id) {
            this.emit('timeout', { text });
            this.resolvePending(this.fallbackJson(), null);
          }
        }, timeoutMs),
      };
      this.pending = entry;
      console.log(`[Bridge] Question from Minecraft${isSystem ? ' (system)' : ''}: "${text.slice(0, 120)}"`);
      this.emit('question', { id: entry.id, text, isSystem, timeoutMs });
    });
  }

  resolvePending(json, answeredBy) {
    const entry = this.pending;
    if (!entry) return false;
    this.pending = null;
    clearTimeout(entry.timer);
    entry.resolve(json);
    if (answeredBy) {
      this.emit('answered', { id: entry.id, text: entry.text, answeredBy });
    }
    return true;
  }

  /**
   * A human answered (voice STT or text channel).
   * Supports optional prefix tags: [happy] [evil] [karma:+1] [karma:-2] ...
   * voicePcm: optional 48 kHz stereo s16le recording of the answer.
   * Returns true if a pending question was answered.
   */
  submitAnswer(rawText, authorName, voicePcm) {
    if (!this.pending) return false;

    let text = String(rawText).trim();
    let variant = null;
    let karma = 0;

    const tagRe = /^\[([^\]]+)\]\s*/;
    let m;
    while ((m = text.match(tagRe)) !== null) {
      const tag = m[1].trim().toLowerCase();
      if (tag.startsWith('karma:')) {
        const v = parseFloat(tag.slice(6));
        if (!Number.isNaN(v)) karma = v;
      } else if (ALLOWED_VARIANTS.has(tag)) {
        variant = tag;
      }
      text = text.slice(m[0].length).trim();
    }

    if (!text) return false;
    if (text.length > 1500) text = text.slice(0, 1500);

    if (voicePcm && voicePcm.length > 0) {
      this.rememberVoice(text, voicePcm, authorName);
    }

    return this.resolvePending(this.buildVerityJson(text, variant, karma), authorName);
  }

  rememberVoice(text, pcm, authorName) {
    const key = Bridge.normalizeText(text);
    this.voiceAnswers.set(key, { pcm, at: Date.now(), author: authorName });
    // keep the map small
    while (this.voiceAnswers.size > 10) {
      const oldest = this.voiceAnswers.keys().next().value;
      this.voiceAnswers.delete(oldest);
    }
  }

  /**
   * The mod asks the bridge to "synthesize" a message. If that message was a
   * human's voice answer, hand back the real recording (48 kHz stereo s16le).
   * Exact (normalized) text match only: the message we send to the mod is the
   * same string we stored, so anything that doesn't match is Verity's own line
   * and must be synthesized instead. Returns { pcm, author } or null.
   */
  findVoiceAudio(inputText) {
    const window_ = this.config.voiceAnswerWindowMs || 60000;
    const key = Bridge.normalizeText(inputText);
    const exact = this.voiceAnswers.get(key);
    if (exact && Date.now() - exact.at <= window_) return exact;
    return null;
  }

  /**
   * Store a Minecraft player's mic recording (already converted to 48 kHz
   * stereo s16le for Discord). Keyed by the transcription so the later
   * chat/completions question can play this clip instead of TTS.
   * Also stored under the first 256 chars: the mod truncates chat to 256.
   */
  rememberPlayerVoice(text, pcm48kStereo) {
    if (!pcm48kStereo || pcm48kStereo.length === 0) return;
    const entry = { pcm: pcm48kStereo, at: Date.now() };
    this.latestPlayerVoice = entry;
    if (!text) return;
    const keys = new Set([Bridge.normalizeText(text)]);
    if (text.length > 256) keys.add(Bridge.normalizeText(text.slice(0, 256)));
    for (const key of keys) this.playerVoices.set(key, entry);
    while (this.playerVoices.size > 12) {
      const oldest = this.playerVoices.keys().next().value;
      this.playerVoices.delete(oldest);
    }
  }

  /**
   * Look up the Minecraft player's real mic clip for a question about to be
   * spoken in Discord. Prefers an exact text match; otherwise the most recent
   * clip (so PTT still plays in Discord when Whisper is disabled).
   */
  findPlayerVoice(inputText) {
    const window_ = this.config.voiceAnswerWindowMs || 60000;
    const key = Bridge.normalizeText(inputText);
    const exact = this.playerVoices.get(key);
    if (exact && Date.now() - exact.at <= window_) return exact;
    // When Whisper is off there is no text key — play the most recent mic clip.
    if (this.config && this.config.transcribeMinecraft === false) {
      const latest = this.latestPlayerVoice;
      if (latest && Date.now() - latest.at <= window_) return latest;
    }
    return null;
  }

  static normalizeText(s) {
    return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /** Resolve the pending question with the fallback message. Returns true if one existed. */
  skip(answeredBy) {
    return this.resolvePending(this.fallbackJson(), answeredBy || null);
  }

  hasPending() {
    return this.pending !== null;
  }

  getPending() {
    return this.pending
      ? { id: this.pending.id, text: this.pending.text, isSystem: this.pending.isSystem, createdAt: this.pending.createdAt }
      : null;
  }
}

module.exports = { Bridge, ALLOWED_VARIANTS };
