const http = require('http');
const { pcmToWav, parseWav } = require('./wav');
const {
  pcm16MonoToFloat,
  pcm16StereoToMonoFloat,
  resampleFloat,
  floatToPcm16Stereo,
} = require('./audio');

/**
 * OpenAI-compatible endpoints the Verity mod talks to:
 *  - POST /v1/chat/completions     the "brain"
 *  - POST /v1/audio/speech         Discord voice → Minecraft (real recording or Piper)
 *  - POST /v1/audio/transcriptions Minecraft mic → Discord (real recording + Whisper)
 */
function startServer(config, bridge, tts, stt) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        service: 'verity-discord-bridge',
        pending: bridge.hasPending(),
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname.includes('audio/transcriptions')) {
      collectBuffer(req, 4_000_000, (err, body) => {
        if (err) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err.message } }));
          return;
        }
        handleTranscription(res, body, req.headers['content-type'] || '', bridge, stt);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname.includes('audio/speech')) {
      collectBuffer(req, 1_000_000, (err, body) => {
        if (err) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err.message } }));
          return;
        }
        handleSpeech(res, body, bridge, tts);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      collectBuffer(req, 2_000_000, async (err, body) => {
        if (err) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err.message } }));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
          return;
        }

        try {
          const verityJson = await bridge.ask(parsed.messages || []);
          const payload = {
            id: 'chatcmpl-verity-' + Date.now(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: parsed.model || 'discord-humans',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: verityJson },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        } catch (e) {
          console.error('[Server] Failed to build answer:', e);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Bridge error: ' + e.message } }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
  });

  server.listen(config.httpPort, config.httpHost, () => {
    console.log(`[Server] Listening on http://${config.httpHost}:${config.httpPort}/v1/`);
  });

  return server;
}

function collectBuffer(req, maxBytes, cb) {
  const chunks = [];
  let size = 0;
  let done = false;
  const finish = (err, buf) => {
    if (done) return;
    done = true;
    cb(err, buf);
  };
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      req.destroy();
      finish(new Error('Body too large'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => finish(null, Buffer.concat(chunks)));
  req.on('error', (e) => finish(e));
}

function handleSpeech(res, body, bridge, tts) {
  let input = '';
  try {
    input = String(JSON.parse(body.toString('utf8')).input || '');
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
    return;
  }

  const voice = bridge.findVoiceAudio(input);
  if (voice) {
    console.log(`[Server] Serving real Discord voice from ${voice.author} for: "${input.slice(0, 60)}"`);
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(pcmToWav(voice.pcm, 48000, 2));
    return;
  }

  if (tts && tts.ready && input.trim()) {
    const pcm = tts.speak(input);
    if (pcm) {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(pcmToWav(pcm, 48000, 2));
      return;
    }
  }

  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'No audio available' } }));
}

function handleTranscription(res, body, contentType, bridge, stt) {
  if (!stt || !stt.ready) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'STT engine not ready' } }));
    return;
  }

  const wavBuf = extractWavFromBody(body, contentType);
  if (!wavBuf) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'No audio file in request' } }));
    return;
  }

  const wav = parseWav(wavBuf);
  if (!wav) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Could not parse WAV' } }));
    return;
  }

  const monoFloat = wav.channels === 1
    ? pcm16MonoToFloat(wav.data)
    : pcm16StereoToMonoFloat(wav.data);
  const samples16k = resampleFloat(monoFloat, wav.sampleRate, 16000);
  const text = stt.transcribe(samples16k);

  // Convert the original mic clip to Discord's 48 kHz stereo so it can be
  // played back later when the transcribed question arrives.
  if (text) {
    const samples48k = resampleFloat(monoFloat, wav.sampleRate, 48000);
    const pcm48 = floatToPcm16Stereo(samples48k);
    bridge.rememberPlayerVoice(text, pcm48);
    console.log(`[Server] Minecraft player voice stored (${(pcm48.length / 4 / 48000).toFixed(2)}s): "${text}"`);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ text: text || '' }));
}

function extractWavFromBody(body, contentType) {
  if (body.length >= 12 && body.toString('ascii', 0, 4) === 'RIFF') return body;

  const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!bm) {
    const riff = body.indexOf(Buffer.from('RIFF'));
    return riff !== -1 ? body.subarray(riff) : null;
  }

  const boundary = '--' + (bm[1] || bm[2]).trim();
  const boundBuf = Buffer.from(boundary, 'utf8');
  let start = body.indexOf(boundBuf);
  while (start !== -1) {
    const next = body.indexOf(boundBuf, start + boundBuf.length);
    if (next === -1) break;
    const part = body.subarray(start + boundBuf.length, next);
    let i = 0;
    if (part[0] === 0x0d && part[1] === 0x0a) i = 2;
    const headerEnd = indexOfBuf(part, Buffer.from('\r\n\r\n'), i);
    if (headerEnd === -1) {
      start = next;
      continue;
    }
    const headers = part.subarray(i, headerEnd).toString('utf8');
    let data = part.subarray(headerEnd + 4);
    if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
      data = data.subarray(0, data.length - 2);
    }
    const nameM = /name="([^"]+)"/i.exec(headers);
    const filenameM = /filename="([^"]*)"/i.exec(headers);
    const isFile = (nameM && nameM[1] === 'file') || (filenameM && filenameM[1]);
    if (isFile && data.length > 0) return data;
    start = next;
  }

  const riff = body.indexOf(Buffer.from('RIFF'));
  return riff !== -1 ? body.subarray(riff) : null;
}

function indexOfBuf(buf, needle, from) {
  return buf.indexOf(needle, from);
}

module.exports = { startServer };
