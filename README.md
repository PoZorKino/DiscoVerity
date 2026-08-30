# Verity Discord Bridge

Replaces Verity's AI brain with **real humans on Discord**. Both directions
use **real recorded voices**, not text-to-speech:

- Discord hears the Minecraft player's actual microphone
- Minecraft hears the Discord user's actual voice, coming from Verity

The mod is never modified. It has three built-in "custom server" options, and
this bridge pretends to be all of them:

| Mod option | Pretends to be | Used for |
|---|---|---|
| `use_ollama` + `ollama_url` | OpenAI-compatible LLM | Verity's "brain" (questions in, answers out) |
| `use_kokoro` + `ollama_tts_url` | OpenAI-compatible TTS | Discord voice → Minecraft (real recording) |
| `use_local_whisper` + `ollama_stt_url` | OpenAI-compatible STT | Minecraft mic → Discord (real recording) |

## How it works

```
 MC player holds push-to-talk and speaks
          │
          ▼   mod uploads the WAV → POST /v1/audio/transcriptions
 Bridge transcribes it (offline Whisper) AND keeps the recording
          │
          ▼   mod sends the transcription as chat
          ▼   then POST /v1/chat/completions (the "question")
 ┌─────────────────────────┐
 │   verity-discord-bridge │
 └─────────────────────────┘
          │  Discord voice channel plays the REAL mic recording
          │  (typed MC chat has no recording → Piper TTS fallback)
          │  Text channel posts the transcription
          ▼
   Discord humans answer:
     • by VOICE → recorded + transcribed (offline Whisper)
     • by text  → used as-is (Piper voice in Minecraft)
          │
          ▼   bridge → mod: reply text
   Mod shows "<Verity> ..." in chat, then fetches the audio:
          │
          ▼   POST /v1/audio/speech
   Bridge returns the REAL Discord recording as WAV
          │
          ▼
   MC player hears the actual human from Verity's position
   (mod's built-in 3D positional audio: distance + pan)
```

Everything runs offline except Discord itself. STT (Whisper tiny.en) and the
fallback TTS voice (Piper `en_US-ryan-medium` — Verity's actual voice) are the
exact models the mod bundles, extracted from the jar into `models/`.

## Requirements

- Node.js ≥ 18 (developed on Node 24, Windows x64)
- ~300 MB disk for the already-extracted models in `models/`
- A Discord server where you can add a bot
- Minecraft Forge 1.20.1 with Verity + its dependencies
  (`yet_another_config_lib_v3`, `geckolib`)

## 1. Create the Discord bot

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy the token.
3. Same tab, **Privileged Gateway Intents**: enable **Message Content Intent**
   and **Server Members Intent**. Save.
4. **OAuth2 → URL Generator**: scope `bot`, permissions: **Connect**, **Speak**,
   **View Channels**, **Send Messages**, **Read Message History**, **Add Reactions**.
5. Open the generated URL and invite the bot to your server.

## 2. Configure the bridge

Copy `config.example.json` to `config.json` and fill it in. Voice models live in
`models/` (extracted from the Verity jar; they are not in this git repo).

| Key | Required | What to put |
|---|---|---|
| `discordToken` | ✅ | Bot token from step 1 (or set env var `DISCORD_TOKEN` instead) |
| `guildId` | ✅ | Server ID (Discord settings → Advanced → Developer Mode, then right-click server → Copy Server ID) |
| `voiceChannelId` | ✅ | Voice channel the bot sits in (right-click → Copy Channel ID) |
| `textChannelId` | ✅ | Text channel where questions/answers are posted |
| `httpHost` / `httpPort` | | Where the mod reaches the bridge. Default `127.0.0.1:4100` |
| `answerTimeoutMs` | | How long humans get to answer a real question. Default `120000` (2 min) |
| `systemEventTimeoutMs` | | Same for Verity's idle chatter / reactions. Default `45000` |
| `fallbackMessage` | | What Verity says when nobody answers. Default `"..."` |
| `speakQuestions` | | Play the MC player's question in the voice channel. Default `true` |
| `ttsQuestionPrefix` | | Spoken before a question **only when there is no mic recording** (typed chat). Default `"Minecraft player says: "` |
| `listenToVoice` | | Accept voice answers (offline STT). Default `true` |
| `listenToText` | | Accept text answers. Default `true` |
| `defaultVariant` | | Verity's face when no tag is given. Default `"neutral"` |
| `voiceAnswerWindowMs` | | How long a voice recording stays matched to its text. Default `60000` |
| `maxDiscordPostLength` | | Truncation for long questions in Discord. Default `1800` |

## 3. Point the mod at the bridge

Launch Minecraft with the mod once so config files are generated, then edit
**both** `config/verity-client.toml` **and** `config/verity-common.toml`
(the mod registers the same config twice — keep them identical).

In the `[AISettings]` section of both files:

```toml
use_ollama = true         # send the "brain" to the bridge instead of Groq
ollama_url = "http://127.0.0.1:4100/v1/"
ollama_ai_model = "discord-humans"

# Minecraft player mic → Discord (real voice)
useLocalStt = false       # MUST be false or the WAV never leaves the client
use_local_whisper = true  # upload the recording to the bridge
ollama_stt_url = "http://127.0.0.1:4100/v1/"   # trailing slash matters!
ollama_stt_model = "discord-stt"

# Discord voice → Minecraft (real voice)
useLocalTts = false
useNativeTts = false
use_kokoro = true
ollama_tts_url = "http://127.0.0.1:4100/v1/"   # trailing slash matters!
ollama_tts_model = "discord-voice"
ollama_tts_voice = "human"
```

`apiKey` can stay empty — the bridge doesn't check it.

> **Real voices in both directions need all three flags:**
> - `use_ollama = true` (brain)
> - `useLocalStt = false` + `use_local_whisper = true` (MC mic upload)
> - `useLocalTts = false` + `use_kokoro = true` (Discord voice playback)
>
> If the bridge is offline: Verity has no brain and no voice, and push-to-talk
> transcription also fails.

> Playing on a dedicated server? The bridge must be reachable by the **server**
> (`ollama_url`, chat) **and by every client** (`ollama_tts_url` + `ollama_stt_url`,
> audio). For single-player all three are just `127.0.0.1`.

## 4. Run

```bash
npm install   # once
copy config.example.json config.json   # then fill in tokens/IDs
npm start     # every session, before or while Minecraft is running
```

Expected output: `Listening on http://127.0.0.1:4100/...`, `Whisper engine ready`,
`Piper engine ready`, `Logged in as YourBot`, `Voice connection ready`.

Then play. **Hold the push-to-talk key and speak** — Discord hears your real
voice. Whoever answers first (by voice) becomes Verity's reply, in their real
voice, from Verity's position in Minecraft.

Typing in Minecraft chat still works; Discord will hear Piper TTS of that text
instead of a recording.

## 5. Answering as Verity

- **Voice:** talk in the voice channel — **your actual voice recording is played
  in Minecraft** from Verity's position, and the offline transcription appears
  as Verity's chat text (like subtitles). Max ~20 seconds per answer.
- **Text:** just type in the configured text channel. ✅ = accepted,
  ❓ = no pending question. Typed answers are spoken in-game with Verity's
  synthesized (Piper) voice.
- **Face tags** at the start of your message pick Verity's expression:
  `[happy]`, `[neutral]`, `[serious_1]`, `[serious_2]`, `[serious_3]`,
  `[crazy]`, `[evil]`, `[smiling_evil]`, `[happy_sleep]`, `[noface]`, ...
- **Karma tag:** `[karma:+1]` or `[karma:-1]` (affects the mod's karma system).
- Example: `[happy] [karma:+1] Don't worry, I'll protect you!`
- Bot commands: `!skip` (dismiss current question), `!status`, `!join`,
  `!leave`, `!help`.

## Behavior details / limitations

- **One question at a time.** A new real question bumps a pending one (it gets
  the fallback answer). Verity's idle chatter / damage reactions (marked ⚙️)
  never interrupt a pending player question and time out quickly if ignored.
- **First answer wins.** After that, the question is closed.
- **Voice matching is by text.** A recording is played when the later request
  uses the exact transcribed text. Typed answers/questions get Piper.
- **Push-to-talk is required for real MC → Discord voice.** Typed chat in
  Minecraft has no audio to forward.
- **Humans can't initiate.** Verity only speaks when the mod asks something
  (player chat, idle chatter, reactions). The idle prompts are the closest
  thing to humans starting a conversation.
- The mod's storyline mechanics (karma, day count, demon transformation) still
  work — humans can steer karma with the `[karma:...]` tag.

## Troubleshooting

- **"AI connection error" in MC** → bridge isn't running, `ollama_url` is
  wrong, or you edited only one of the two TOML files.
- **Verity is mute / no voice at all** → bridge is down, or
  `useLocalTts`/`use_kokoro` not set as above, or missing trailing slash in
  `ollama_tts_url`.
- **Robot voice in Minecraft instead of the Discord user's voice** → the
  answer was typed, not spoken; or the recording expired
  (`voiceAnswerWindowMs`); or the question was answered before you finished
  speaking.
- **Robot voice in Discord instead of the Minecraft player's voice** → the
  player typed in chat instead of using push-to-talk; or `useLocalStt` is
  still `true` (WAV never uploaded); or `ollama_stt_url` is wrong / missing
  trailing slash.
- **Push-to-talk does nothing** → bridge down, or `use_local_whisper` not
  enabled, or `useLocalStt` still true.
- **Bot online but hears nothing** → it must not be self-deafened (the bridge
  sets `selfDeaf: false`); check channel permissions: Connect + Speak.
- **Bot can't read messages** → enable the **Message Content Intent** in the
  dev portal.
- **Verify the bridge directly:** `curl http://127.0.0.1:4100/health`
- **Re-run the self-check:** `node smoke-test.js` (no Discord needed).

## Project structure

```
verity-discord-bridge/
├── config.json        # ← your settings (token, channel IDs)
├── models/            # whisper (STT) + piper (TTS), extracted from the mod jar
├── src/
│   ├── index.js       # entry point
│   ├── config.js      # config loading/validation
│   ├── bridge.js      # pending-question manager + voice recording stores
│   ├── server.js      # OpenAI-compatible HTTP API the mod talks to
│   ├── discordBot.js  # voice listen/speak + text channel
│   ├── stt.js         # offline Whisper (sherpa-onnx)
│   ├── tts.js         # offline Piper (sherpa-onnx)
│   ├── audio.js       # resampling / format conversion
│   └── wav.js         # PCM ↔ WAV
└── smoke-test.js      # end-to-end self-check (no Discord needed)
```
