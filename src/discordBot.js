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

const MAX_UTTERANCE_SECONDS = 20;

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

    this.player.on('stateChange', (oldS, newS) => {
      if (newS.status === 'idle' && oldS.status !== 'idle') {
        this.speaking = false;
        this.playNextInQueue();
      }
    });
    this.player.on('error', (e) => {
      console.warn('[Discord] Audio player error:', e.message);
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

      if (isSystem) {
        await this.postToTextChannel(
          `⚙️ **Verity event** *(auto-skips in ${Math.round(timeoutMs / 1000)}s if ignored)*:\n> ${shown}`
        );
        // Don't TTS-spam the voice channel for background events.
        return;
      }

      await this.postToTextChannel(
        `🎮 **A Minecraft player is talking to Verity:**\n> ${shown}\n` +
        `*Reply in this channel or speak in voice — your words become Verity's. ` +
        `(${Math.round(timeoutMs / 1000)}s to answer)*`
      );

      if (this.config.speakQuestions) {
        const playerVoice = this.bridge.findPlayerVoice(text);
        if (playerVoice) {
          console.log('[Discord] Playing Minecraft player\'s real voice in the channel.');
          this.enqueuePcm(playerVoice.pcm);
        } else {
          this.enqueueSpeech(this.config.ttsQuestionPrefix + text);
        }
      }
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
        this.textChannel = await this.client.channels.fetch(this.config.textChannelId);
        await this.joinVoice();
        await this.postToTextChannel(
          '🟢 **Verity bridge online.** Speak in voice or type here to become Verity. Minecraft players\' real voices will play in this channel.'
        );
      } catch (e) {
        console.error('[Discord] Startup problem (check your channel IDs):', e.message);
      }
    });

    this.client.on(Events.MessageCreate, async (msg) => {
      if (msg.author.bot) return;
      if (msg.channel.id !== this.config.textChannelId) return;
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
          'To answer as Verity: just type or speak. Optional tags: `[happy]`, `[evil]`, `[serious_1]`, `[karma:+1]` etc. at the start of your message.'
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
      this.startListening();
    } catch (e) {
      console.warn('[Discord] Could not join voice channel:', e.message);
    }
  }

  startListening() {
    if (!this.connection) return;
    this.connection.receiver.speaking.on('start', (userId) => {
      if (!this.config.listenToVoice) return;
      if (this.activeSubscriptions.has(userId)) return;

      const member = this.client.guilds.cache.get(this.config.guildId)?.members.cache.get(userId);
      if (member?.user?.bot) return;

      this.activeSubscriptions.add(userId);
      const opusStream = this.connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 900 },
      });

      const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
      const chunks = [];
      let bytes = 0;
      const maxBytes = MAX_UTTERANCE_SECONDS * 48000 * 2 * 2; // s16 stereo

      opusStream.on('data', (packet) => {
        if (bytes > maxBytes) return;
        try {
          const pcm = decoder.decode(packet);
          chunks.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
          bytes += pcm.byteLength;
        } catch (e) {
          // drop undecodable packet
        }
      });

      opusStream.on('end', () => {
        this.activeSubscriptions.delete(userId);
        if (bytes < 4800) return; // ~25ms of audio: ignore blips
        const pcm = Buffer.concat(chunks); // 48 kHz stereo s16le - the real voice
        const mono = pcm16StereoToMonoFloat(pcm);
        const samples16k = resampleFloat(mono, 48000, 16000);
        this.handleUtterance(userId, samples16k, pcm);
      });

      opusStream.on('error', () => {
        this.activeSubscriptions.delete(userId);
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
    const stream = new Readable({
      read() {
        this.push(pcm);
        this.push(null);
      },
    });
    const resource = createAudioResource(stream, { inputType: StreamType.Raw });
    this.speaking = true;
    this.player.play(resource);
  }

  // ---------------------------------------------------------------- helpers

  async postToTextChannel(content) {
    if (!this.textChannel) return;
    try {
      await this.textChannel.send(content);
    } catch (e) {
      console.warn('[Discord] Failed to post to text channel:', e.message);
    }
  }

  async stop() {
    if (this.connection) this.connection.destroy();
    this.client.destroy();
  }
}

module.exports = { DiscordBridgeBot };
