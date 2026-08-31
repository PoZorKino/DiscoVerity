const {
  Client,
  GatewayIntentBits,
  Events,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const { Readable } = require('stream');
const OpusScript = require('opusscript');
const { pcm16StereoToMonoFloat, resampleFloat } = require('./audio');
const { pcmToWav } = require('./wav');
const { toPcm48Stereo } = require('./audioConvert');

// prism-media resolves ffmpeg-static by name; requiring it here fails fast if missing.
require('ffmpeg-static');

const MAX_UTTERANCE_SECONDS = 20;
const OPUS_POOL_SIZE = 6;

/** Reuse a fixed set of OpusScript instances. Creating a new one per speaker
 *  exhausts the shared WASM heap (`memory access out of bounds`). */
class OpusDecoderPool {
  constructor() {
    this.free = [];
    this.inUse = new Map();
    for (let i = 0; i < OPUS_POOL_SIZE; i++) {
      this.free.push(new OpusScript(48000, 2, OpusScript.Application.AUDIO));
    }
    console.log(`[Discord] Opus decoder pool ready (${OPUS_POOL_SIZE} slots).`);
  }

  acquire(userId) {
    if (this.inUse.has(userId)) return this.inUse.get(userId);
    const dec = this.free.pop();
    if (!dec) return null;
    this.inUse.set(userId, dec);
    return dec;
  }

  release(userId) {
    const dec = this.inUse.get(userId);
    if (!dec) return;
    this.inUse.delete(userId);
    this.free.push(dec);
  }

  destroy() {
    for (const dec of [...this.inUse.values(), ...this.free]) {
      try { dec.delete(); } catch { /* ignore */ }
    }
    this.inUse.clear();
    this.free.length = 0;
  }
}

class DiscordBridgeBot {
  constructor(config, bridge, stt, tts) {
    this.config = config;
    this.bridge = bridge;
    this.stt = stt;
    this.tts = tts;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.connection = null;
    this.player = createAudioPlayer();
    this.speechQueue = [];
    this.speaking = false;
    this.activeSubscriptions = new Set();
    this.textChannel = null;
    this.announceChannels = [];
    this.decoderPool = null;
    this.listening = false;
    this.defaultSounds = new Map();

    this.player.on('stateChange', (oldS, newS) => {
      if (newS.status === 'idle' && oldS.status !== 'idle') {
        this.speaking = false;
        this.playNextInQueue();
      }
    });
    this.player.on('error', (e) => {
      console.warn('[Discord] Audio player error:', e.message);
      if (e.stack) console.warn(e.stack);
      this.speaking = false;
      this.playNextInQueue();
    });
  }

  async start() {
    this.wireBridgeEvents();
    this.wireDiscordEvents();
    await this.client.login(this.config.discordToken);
  }

  // ---------------------------------------------------------------- bridge -> discord

  wireBridgeEvents() {
    this.bridge.on('question', async ({ text, isSystem, timeoutMs }) => {
      const shown = text.length > this.config.maxDiscordPostLength
        ? text.slice(0, this.config.maxDiscordPostLength) + '...'
        : text;

      // Play first so a slow Discord send never blocks the bot's voice.
      if (!isSystem && this.config.speakQuestions) {
        const playerVoice = this.bridge.findPlayerVoice(text);
        if (playerVoice) {
          console.log('[Discord] Playing Minecraft player\'s real voice in the channel.');
          this.enqueuePcm(playerVoice.pcm);
        } else {
          this.enqueueSpeech(this.config.ttsQuestionPrefix + text);
        }
      }

      if (isSystem) {
        await this.postToTextChannel(
          `⚙️ **Verity event** *(auto-skips in ${Math.round(timeoutMs / 1000)}s if ignored)*:\n> ${shown}`
        );
        return;
      }

      await this.postToTextChannel(
        `🎮 **A Minecraft player is talking to Verity:**\n> ${shown}\n` +
        `*Reply here, speak, or play a soundboard sound — that becomes Verity. ` +
        `(${Math.round(timeoutMs / 1000)}s to answer)*`
      );
    });

    this.bridge.on('answered', async ({ answeredBy }) => {
      if (answeredBy) console.log(`[Bridge] Question answered by ${answeredBy}`);
    });

    this.bridge.on('timeout', async () => {
      await this.postToTextChannel(`⏰ *Nobody answered in time — Verity stays silent.*`);
    });

    this.bridge.on('bumped', async () => {
      await this.postToTextChannel(`↪️ *A newer question arrived; the previous one was skipped.*`);
    });

    this.bridge.on('systemSkipped', async ({ text }) => {
      console.log('[Bridge] System event ignored (a question is already pending):', text.slice(0, 80));
    });
  }

  // ---------------------------------------------------------------- discord -> bridge

  wireDiscordEvents() {
    this.client.once(Events.ClientReady, async (c) => {
      console.log(`[Discord] Logged in as ${c.user.tag}`);
      try {
        const textCh = await this.client.channels.fetch(this.config.textChannelId);
        const voiceCh = await this.client.channels.fetch(this.config.voiceChannelId);
        this.textChannel = textCh;
        this.announceChannels = [textCh];
        if (voiceCh && voiceCh.id !== textCh.id && typeof voiceCh.send === 'function') {
          this.announceChannels.push(voiceCh);
        }
        console.log('[Discord] Posting to:', this.announceChannels.map((ch) => '#' + ch.name).join(', '));
        try {
          const defaults = await this.client.rest.get('/soundboard-default-sounds');
          if (Array.isArray(defaults)) {
            for (const s of defaults) this.defaultSounds.set(String(s.sound_id), s);
            console.log(`[Discord] Loaded ${this.defaultSounds.size} default soundboard sound(s).`);
          }
        } catch (e) {
          console.warn('[Discord] Could not fetch default soundboard sounds:', e.message);
        }
        try {
          const guild = await this.client.guilds.fetch(this.config.guildId);
          await guild.soundboardSounds.fetch();
          console.log(`[Discord] Loaded ${guild.soundboardSounds.cache.size} guild soundboard sound(s).`);
        } catch (e) {
          console.warn('[Discord] Could not cache guild soundboard sounds:', e.message);
        }
        await this.joinVoice();
        await this.postToTextChannel(
          '🟢 **Verity bridge online.** Speak, use the soundboard, or type here to become Verity. ' +
          'Minecraft players\' real voices play in this channel.'
        );
      } catch (e) {
        console.error('[Discord] Startup problem (check your channel IDs):', e.message);
      }
    });

    this.client.on(Events.VoiceChannelEffectSend, (effect) => {
      this.handleSoundboard(effect).catch((e) => {
        console.warn('[Discord] Soundboard handling failed:', e.message);
      });
    });

    this.client.on(Events.MessageCreate, async (msg) => {
      if (msg.author.bot) return;
      const allowed = new Set([this.config.textChannelId, this.config.voiceChannelId]);
      if (!allowed.has(msg.channel.id)) return;
      if (!this.config.listenToText) return;

      const content = msg.content.trim();
      if (!content) return;

      if (content.startsWith('!')) {
        await this.handleCommand(content, msg);
        return;
      }

      const answered = this.bridge.submitAnswer(content, msg.member?.displayName || msg.author.username);
      if (answered) {
        await msg.react('✅').catch(() => {});
      } else {
        await msg.react('❓').catch(() => {});
      }
    });
  }

  async handleCommand(content, msg) {
    const cmd = content.split(/\s+/)[0].toLowerCase();
    switch (cmd) {
      case '!skip': {
        const had = this.bridge.skip(msg.author.username);
        await msg.reply(had ? '⏭️ Skipped — Verity will stay silent.' : 'Nothing to skip.').catch(() => {});
        break;
      }
      case '!status': {
        const p = this.bridge.getPending();
        await msg.reply(p
          ? `⏳ Pending question: "${p.text.slice(0, 200)}"`
          : '💤 No pending question. The bridge is listening.'
        ).catch(() => {});
        break;
      }
      case '!join':
        await this.joinVoice();
        await msg.reply('🔊 Joined voice.').catch(() => {});
        break;
      case '!leave':
        if (this.connection) {
          this.connection.destroy();
          this.connection = null;
        }
        await msg.reply('👋 Left voice. Use `!join` to bring me back.').catch(() => {});
        break;
      case '!help':
        await msg.reply(
          '**Verity Bridge commands**\n' +
          '`!skip` — dismiss the current question\n' +
          '`!status` — show the pending question\n' +
          '`!join` / `!leave` — voice channel control\n\n' +
          'To answer as Verity: speak, play a soundboard sound, or type here. Optional tags: `[happy]`, `[evil]`, `[serious_1]`, `[karma:+1]` etc. at the start of your message.'
        ).catch(() => {});
        break;
    }
  }

  // ---------------------------------------------------------------- voice

  async joinVoice() {
    const guild = await this.client.guilds.fetch(this.config.guildId);
    this.connection = joinVoiceChannel({
      channelId: this.config.voiceChannelId,
      guildId: this.config.guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, // must be undeafened to receive audio
      selfMute: false,
    });
    this.connection.subscribe(this.player);

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch (e) {
        console.warn('[Discord] Voice connection lost; use !join to reconnect.');
      }
    });

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20000);
      console.log('[Discord] Voice connection ready.');
      this.listening = false;
      if (this.config.listenToVoice) {
        this.startListening();
      } else {
        console.log('[Discord] Voice STT disabled — type to answer as Verity.');
      }
    } catch (e) {
      console.warn('[Discord] Could not join voice channel:', e.message);
    }
  }

  startListening() {
    if (!this.connection || !this.config.listenToVoice) return;
    if (this.listening) return;
    this.listening = true;
    if (!this.decoderPool) this.decoderPool = new OpusDecoderPool();
    console.log('[Discord] Listening to voice channel (speak to answer as Verity).');

    this.connection.receiver.speaking.on('start', (userId) => {
      if (!this.config.listenToVoice) return;
      if (this.activeSubscriptions.has(userId)) return;

      const member = this.client.guilds.cache.get(this.config.guildId)?.members.cache.get(userId);
      if (member?.user?.bot) return;

      const decoder = this.decoderPool.acquire(userId);
      if (!decoder) {
        console.warn('[Discord] Too many people talking at once; skipped a speaker.');
        return;
      }

      this.activeSubscriptions.add(userId);
      const opusStream = this.connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 900 },
      });

      const chunks = [];
      let bytes = 0;
      const maxBytes = MAX_UTTERANCE_SECONDS * 48000 * 2 * 2; // s16 stereo
      let finished = false;
      const finishDecoder = () => {
        if (finished) return;
        finished = true;
        this.activeSubscriptions.delete(userId);
        this.decoderPool.release(userId);
      };

      opusStream.on('data', (packet) => {
        if (bytes > maxBytes) return;
        try {
          const pcm = decoder.decode(packet);
          chunks.push(Buffer.from(pcm));
          bytes += pcm.length;
        } catch (e) {
          // drop undecodable packet
        }
      });

      opusStream.on('end', () => {
        finishDecoder();
        if (bytes < 4800) return; // ~25ms of audio: ignore blips
        const pcm = Buffer.concat(chunks); // 48 kHz stereo s16le - the real voice
        const mono = pcm16StereoToMonoFloat(pcm);
        const samples16k = resampleFloat(mono, 48000, 16000);
        this.handleUtterance(userId, samples16k, pcm);
      });

      opusStream.on('error', () => {
        finishDecoder();
      });
    });
  }

  async handleUtterance(userId, samples16k, rawPcm48k) {
    if (!this.stt.ready) return;
    const text = this.stt.transcribe(samples16k);
    if (!text) return;

    const name = await this.resolveUserName(userId);
    console.log(`[Voice] ${name}: ${text}`);

    // The recording travels with the transcription: if this answers a pending
    // question, the mod will later "ask for TTS" of this text and receive the
    // real human voice back instead of synthesized speech.
    const answered = this.bridge.submitAnswer(text, name, rawPcm48k);
    if (answered) {
      await this.postToTextChannel(`🎙️ **${name}** *(voice → Verity)*: ${text}`);
    }
    // If nothing is pending, voice chatter is only logged to the console.
  }

  async handleSoundboard(effect) {
    if (!this.config.listenToSoundboard) return;
    if (!effect.soundId) return; // emoji-only voice effects
    if (String(effect.channelId) !== String(this.config.voiceChannelId)) return;

    const def = this.defaultSounds.get(String(effect.soundId));
    const sound = effect.soundboardSound
      || await this.resolveSoundboardSound(effect).catch(() => null);
    const name = (sound && sound.name) || (def && def.name) || String(effect.soundId);
    const url = (sound && sound.url)
      ? sound.url
      : `https://cdn.discordapp.com/soundboard-sounds/${effect.soundId}`;

    const who = await this.resolveUserName(effect.userId);
    console.log(`[Soundboard] ${who} played "${name}"`);

    let file;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('CDN HTTP ' + res.status);
      file = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      console.warn('[Soundboard] Download failed:', e.message);
      return;
    }

    let pcm;
    try {
      pcm = await toPcm48Stereo(file, effect.soundVolume == null ? 1 : effect.soundVolume);
    } catch (e) {
      console.warn('[Soundboard] Decode failed:', e.message);
      return;
    }
    if (!pcm || pcm.length < 1000) return;

    // Discord already plays the clip in the VC. Forward it to Minecraft as Verity.
    const label = `*${name}*`;
    const answered = this.bridge.submitAnswer(label, who, pcm);
    if (answered) {
      await this.postToTextChannel(`🔊 **${who}** *(soundboard → Verity)*: ${name}`);
    }
  }

  async resolveSoundboardSound(effect) {
    const guild = this.client.guilds.cache.get(this.config.guildId)
      || await this.client.guilds.fetch(this.config.guildId);
    const cached = guild.soundboardSounds.cache.get(effect.soundId)
      || guild.soundboardSounds.cache.get(String(effect.soundId));
    if (cached) return cached;
    try {
      return await guild.soundboardSounds.fetch(String(effect.soundId));
    } catch {
      return null;
    }
  }

  async resolveUserName(userId) {
    try {
      const guild = this.client.guilds.cache.get(this.config.guildId);
      const member = guild ? await guild.members.fetch(userId) : null;
      return member?.displayName || userId;
    } catch (e) {
      return userId;
    }
  }

  // ---------------------------------------------------------------- TTS output

  enqueueSpeech(text) {
    if (!this.tts.ready || !this.connection) return;
    const pcm = this.tts.speak(text);
    if (pcm) this.enqueuePcm(pcm);
  }

  enqueuePcm(pcm) {
    if (!pcm || !this.connection) return;
    this.speechQueue.push(pcm);
    if (!this.speaking) this.playNextInQueue();
  }

  playNextInQueue() {
    const pcm = this.speechQueue.shift();
    if (!pcm || !this.connection) {
      this.speaking = false;
      return;
    }
    // StreamType.Raw encodes through opusscript, which throws
    // "offset is out of bounds" after a few voice-receive decoders share its
    // WASM heap. FFmpeg (libopus) is the reliable send path on Windows/Node 24.
    try {
      const wav = pcmToWav(Buffer.from(pcm), 48000, 2);
      const resource = createAudioResource(Readable.from([wav]), {
        inputType: StreamType.Arbitrary,
      });
      this.speaking = true;
      this.player.play(resource);
    } catch (e) {
      console.warn('[Discord] Failed to start playback:', e.message);
      this.speaking = false;
      this.playNextInQueue();
    }
  }

  // ---------------------------------------------------------------- helpers

  async postToTextChannel(content) {
    const channels = this.announceChannels.length
      ? this.announceChannels
      : (this.textChannel ? [this.textChannel] : []);
    if (!channels.length) {
      console.warn('[Discord] No text channel to post to yet.');
      return;
    }
    for (const ch of channels) {
      try {
        await ch.send(content);
      } catch (e) {
        console.warn(`[Discord] Failed to post to #${ch.name || ch.id}:`, e.message);
      }
    }
  }

  async stop() {
    if (this.connection) this.connection.destroy();
    if (this.decoderPool) {
      this.decoderPool.destroy();
      this.decoderPool = null;
    }
    this.client.destroy();
  }
}

module.exports = { DiscordBridgeBot };
