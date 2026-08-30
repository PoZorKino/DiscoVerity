const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('[Config] config.json not found at', CONFIG_PATH);
    process.exit(1);
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('[Config] config.json is not valid JSON:', e.message);
    process.exit(1);
  }

  // Allow the token to come from an environment variable instead of the file.
  if (!cfg.discordToken || cfg.discordToken === 'PUT_YOUR_BOT_TOKEN_HERE') {
    if (process.env.DISCORD_TOKEN) {
      cfg.discordToken = process.env.DISCORD_TOKEN;
    }
  }

  const missing = [];
  if (!cfg.discordToken || cfg.discordToken === 'PUT_YOUR_BOT_TOKEN_HERE') missing.push('discordToken (or DISCORD_TOKEN env var)');
  if (!cfg.guildId || cfg.guildId === 'PUT_YOUR_SERVER_ID_HERE') missing.push('guildId');
  if (!cfg.voiceChannelId || cfg.voiceChannelId === 'PUT_YOUR_VOICE_CHANNEL_ID_HERE') missing.push('voiceChannelId');
  if (!cfg.textChannelId || cfg.textChannelId === 'PUT_YOUR_TEXT_CHANNEL_ID_HERE') missing.push('textChannelId');

  cfg.httpHost = cfg.httpHost || '127.0.0.1';
  cfg.httpPort = Number(cfg.httpPort) || 4100;
  cfg.answerTimeoutMs = Number(cfg.answerTimeoutMs) || 120000;
  cfg.systemEventTimeoutMs = Number(cfg.systemEventTimeoutMs) || 45000;
  cfg.fallbackMessage = typeof cfg.fallbackMessage === 'string' ? cfg.fallbackMessage : '...';
  cfg.speakQuestions = cfg.speakQuestions !== false;
  cfg.ttsQuestionPrefix = typeof cfg.ttsQuestionPrefix === 'string' ? cfg.ttsQuestionPrefix : '';
  cfg.listenToVoice = cfg.listenToVoice !== false;
  cfg.listenToText = cfg.listenToText !== false;
  cfg.defaultVariant = cfg.defaultVariant || 'neutral';
  cfg.maxDiscordPostLength = Number(cfg.maxDiscordPostLength) || 1800;
  cfg.voiceAnswerWindowMs = Number(cfg.voiceAnswerWindowMs) || 60000;

  cfg.modelsDir = path.join(__dirname, '..', 'models');
  cfg.whisperDir = path.join(cfg.modelsDir, 'whisper');
  cfg.piperDir = path.join(cfg.modelsDir, 'piper');

  if (missing.length > 0) {
    console.error('[Config] Missing required settings in config.json:');
    for (const m of missing) console.error('   - ' + m);
    console.error('[Config] See README.md for how to fill these in.');
    process.exit(1);
  }

  return cfg;
}

module.exports = { loadConfig };
