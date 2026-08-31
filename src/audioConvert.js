const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

/**
 * Decode any ffmpeg-supported audio (mp3/ogg/wav/...) to Discord/Minecraft PCM:
 * 48 kHz stereo signed 16-bit little-endian.
 */
function toPcm48Stereo(inputBuffer, volume = 1) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg-static not found'));
      return;
    }
    if (!inputBuffer || inputBuffer.length === 0) {
      reject(new Error('empty audio buffer'));
      return;
    }

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
    ];
    if (typeof volume === 'number' && volume > 0 && volume !== 1) {
      args.push('-filter:a', `volume=${Math.min(2, volume)}`);
    }
    args.push('pipe:1');

    const ff = spawn(ffmpegPath, args, { windowsHide: true });
    const chunks = [];
    const errChunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => errChunks.push(c));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) {
        const err = Buffer.concat(errChunks).toString('utf8').trim();
        reject(new Error(err || 'ffmpeg failed (' + code + ')'));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    ff.stdin.on('error', () => { /* ignore EPIPE if ffmpeg exits early */ });
    ff.stdin.end(inputBuffer);
  });
}

module.exports = { toPcm48Stereo };
