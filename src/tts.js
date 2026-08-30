const fs = require('fs');
const path = require('path');
const { resampleFloat, floatToPcm16Stereo } = require('./audio');

/**
 * Offline Piper TTS via sherpa-onnx, reusing the en_US-ryan-medium voice
 * the Verity mod bundles (extracted from the jar into models/piper).
 * Output is converted to Discord's format: 48 kHz stereo s16le PCM.
 */
class TtsEngine {
  constructor(config) {
    this.config = config;
    this.tts = null;
    this.sampleRate = 22050;
  }

  init() {
    const model = path.join(this.config.piperDir, 'en_US-ryan-medium.onnx');
    const tokens = path.join(this.config.piperDir, 'tokens.txt');
    const dataDir = path.join(this.config.piperDir, 'espeak-ng-data');

    for (const f of [model, tokens, dataDir]) {
      if (!fs.existsSync(f)) {
        console.warn('[TTS] Model file missing:', f);
        return false;
      }
    }

    try {
      const sherpa = require('sherpa-onnx-node');
      this.tts = new sherpa.OfflineTts({
        model: {
          vits: { model, tokens, dataDir },
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
        maxNumSentences: 1,
      });
      // sherpa exposes the rate either as a property or a method depending on version
      const sr = typeof this.tts.sampleRate === 'function' ? this.tts.sampleRate() : this.tts.sampleRate;
      if (typeof sr === 'number' && sr > 0) this.sampleRate = sr;
      console.log(`[TTS] Piper engine ready (offline, ${this.sampleRate} Hz source).`);
      return true;
    } catch (e) {
      console.warn('[TTS] Failed to init sherpa-onnx:', e.message);
      console.warn('[TTS] Voice speaking will be disabled; questions will still be posted as text.');
      this.tts = null;
      return false;
    }
  }

  get ready() {
    return this.tts !== null;
  }

  /**
   * Synthesize text -> s16le 48 kHz stereo PCM Buffer ready for Discord.
   * Returns null on failure.
   */
  speak(text) {
    if (!this.tts || !text) return null;
    try {
      const audio = this.tts.generate({ text, sid: 0, speed: 1.0, enableExternalBuffer: false });
      if (!audio || !audio.samples || audio.samples.length === 0) return null;
      const srcRate = audio.sampleRate || this.sampleRate;
      const samples = audio.samples instanceof Float32Array ? audio.samples : Float32Array.from(audio.samples);
      const resampled = resampleFloat(samples, srcRate, 48000);
      return floatToPcm16Stereo(resampled);
    } catch (e) {
      console.warn('[TTS] Generation failed:', e.message);
      return null;
    }
  }
}

module.exports = { TtsEngine };
