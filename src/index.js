const { loadConfig } = require('./config');
const { Bridge } = require('./bridge');
const { startServer } = require('./server');
const { SttEngine } = require('./stt');
const { TtsEngine } = require('./tts');
const { DiscordBridgeBot } = require('./discordBot');

async function main() {
  console.log('=== Verity Discord Bridge ===');
  console.log('Real humans on Discord answer instead of an AI.\n');

  const config = loadConfig();
  const bridge = new Bridge(config);

  const stt = new SttEngine(config);
  const tts = new TtsEngine(config);

  if (config.listenToVoice || config.transcribeMinecraft) {
    stt.init();
  } else {
    console.log('[STT] Whisper off — Discord answers are typed; Minecraft chat is not transcribed.');
  }
  tts.init();

  startServer(config, bridge, tts, stt);

  const bot = new DiscordBridgeBot(config, bridge, stt, tts);
  await bot.start();

  const shutdown = async () => {
    console.log('\n[Bridge] Shutting down...');
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
