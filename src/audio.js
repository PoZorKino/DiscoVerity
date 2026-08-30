/**
 * Audio conversion helpers.
 * Discord voice: 48 kHz, stereo, signed 16-bit little-endian PCM (in Opus packets).
 * Whisper STT:   16 kHz, mono, float32 samples in [-1, 1].
 * Piper TTS:     mono float32 at the model's own rate (22050 Hz for ryan-medium).
 */

/** s16le mono Buffer -> Float32Array. */
function pcm16MonoToFloat(buf) {
  const frames = Math.floor(buf.length / 2);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    out[i] = buf.readInt16LE(i * 2) / 32768;
  }
  return out;
}

/** s16le stereo Buffer -> mono Float32Array (downmix L+R). */
function pcm16StereoToMonoFloat(buf) {
  const frames = Math.floor(buf.length / 4);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const l = buf.readInt16LE(i * 4);
    const r = buf.readInt16LE(i * 4 + 2);
    out[i] = (l + r) / 2 / 32768;
  }
  return out;
}

/** Linear-interpolation resample of a mono float signal. */
function resampleFloat(samples, srcRate, dstRate) {
  if (srcRate === dstRate) return samples;
  const ratio = srcRate / dstRate;
  const outLen = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = samples[Math.min(idx, samples.length - 1)];
    const b = samples[Math.min(idx + 1, samples.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Mono Float32Array [-1,1] -> s16le stereo Buffer (duplicated channels). */
function floatToPcm16Stereo(samples) {
  const out = Buffer.alloc(samples.length * 4);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const v = Math.round(clamped * 32767);
    out.writeInt16LE(v, i * 4);
    out.writeInt16LE(v, i * 4 + 2);
  }
  return out;
}

/** Mono Float32Array -> s16le mono Buffer. */
function floatToPcm16Mono(samples) {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return out;
}

module.exports = {
  pcm16MonoToFloat,
  pcm16StereoToMonoFloat,
  resampleFloat,
  floatToPcm16Stereo,
  floatToPcm16Mono,
};
