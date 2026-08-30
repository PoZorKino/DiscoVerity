const fs = require('fs');
const path = require('path');

/**
 * Offline Whisper STT via sherpa-onnx, reusing the exact tiny.en model
 * the Verity mod bundles (extracted from the jar into models/whisper).
 */
class SttEngine {
  constructor(config) {
    this.config = config;
    this.recognizer = null;
  }

  init() {
    const encoder = path.join(this.config.whisperDir, 'tiny.en-encoder.int8.onnx');
    const decoder = path.join(this.config.whisperDir, 'tiny.en-decoder.int8.onnx');
    const tokens = path.join(this.config.whisperDir, 'tiny.en-tokens.txt');

    for (const f of [encoder, decoder, tokens]) {
      if (!fs.existsSync(f)) {
        console.warn('[STT] Model file missing:', f);
        return false;
      }
    }

    try {
      const sherpa = require('sherpa-onnx-node');
      this.recognizer = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          whisper: { encoder, decoder },
          tokens,
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
      });
      console.log('[STT] Whisper engine ready (offline, tiny.en).');
      return true;
    } catch (e) {
      console.warn('[STT] Failed to init sherpa-onnx:', e.message);
      console.warn('[STT] Voice listening will be disabled; text channel answers still work.');
      this.recognizer = null;
      return false;
    }
  }

  get ready() {
    return this.recognizer !== null;
  }

  /**
   * Transcribe 16 kHz mono float32 samples. Returns '' on failure/silence.
   */
  transcribe(samples16k) {
    if (!this.recognizer || !samples16k || samples16k.length < 1600) return '';
    try {
      const stream = this.recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples: samples16k });
      this.recognizer.decode(stream);
      const result = this.recognizer.getResult(stream);
      const text = (result && result.text ? result.text : '').trim();
      return text === '.' ? '' : text;
    } catch (e) {
      console.warn('[STT] Transcription failed:', e.message);
      return '';
    }
  }
}

module.exports = { SttEngine };
