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

  // STT is used for Discord voice answers AND for the Minecraft player's mic
  // (the mod uploads the recording here instead of transcribing locally).
  stt.init();
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
