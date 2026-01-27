/**
 * Bedrock & Java AFK Bot - V29 (Final Stability & Java Auth Update) 🛡️
 * ----------------------------------------------------------------------
 * FIXES & UPDATES:
 * - Resolved ReferenceError: client is not defined (Crash fix).
 * - Removed Status, Support, and Advanced buttons for minimalist UI.
 * - Added Microsoft Auth support for Java Edition (Mineflayer).
 * - Implemented multi-stage connection reporting for Java and Bedrock.
 * - Preserved: Physics, Sneaking, 4h Reboot, Microsoft Callbacks, /data Volume.
 * ----------------------------------------------------------------------
 * ALL UI IN ENGLISH. NO CRINGE. ALL LOGIC EXPANDED.
 */

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  Partials
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const mineflayer = require("mineflayer");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// --- INITIALIZE DISCORD CLIENT EARLY (Fixes ReferenceError) ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User]
});

// --- SYSTEM CONFIGURATION ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_KEYS = [
  "AIzaSyAZbj5F2X-FLM6NSqz_3K1sciQMepX6JMA",
  "AIzaSyD51YhFcYCTp5HNOUZOZe14ymIhamILoOg"
];
const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";

const OWNER_ID = "1144987924123881564"; 
const ALLOWED_GUILD_ID = "1462335230345089254";
const SUPPORT_CHANNEL_ID = "1462398161074000143";

const SOFT_REBOOT_INTERVAL = 4 * 60 * 60 * 1000; 
const HEARTBEAT_INTERVAL = 25000;

// ----------------- STORAGE SYSTEM (/data volume) -----------------
const DATA_DIR = "/data"; 
const AUTH_DIR = path.join(DATA_DIR, "auth");
const DB_PATH = path.join(DATA_DIR, "users.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let users = fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH, "utf8")) : {};
let bedrockSessions = new Map(); 
let javaSessions = new Map();

/**
 * Saves database state atomically to /data volume.
 */
function syncStorage() {
  try {
    const tmp = DB_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
    fs.renameSync(tmp, DB_PATH);
  } catch (err) {
    process.stderr.write(`[Sync Error] ${err.message}\n`);
  }
}

/**
 * Gets profile or initializes a clean one.
 */
function fetchProfile(uid) {
  if (!users[uid]) {
    users[uid] = {
      bedrock: { ip: "", port: 19132, version: "auto", name: `AFK_${uid.slice(-4)}` },
      java: { ip: "", port: 25565, version: "auto", name: `AFK_J_${uid.slice(-4)}` },
      linkedBedrock: false,
      linkedJava: false,
      history: []
    };
  }
  if (!users[uid].history) users[uid].history = [];
  return users[uid];
}

/**
 * Pushes event to internal logs.
 */
function recordInternalEvent(uid, msg) {
  const profile = fetchProfile(uid);
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  profile.history.unshift(`[${time}] ${msg}`);
  if (profile.history.length > 5) profile.history.pop();
}

function getAuthFolder(uid, type) {
  const sub = type === "bedrock" ? "bedrock" : "java";
  const dir = path.join(AUTH_DIR, uid, sub);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ----------------- AI INTELLIGENCE -----------------
let keyIdx = 0;
function rotateKey() {
  const k = GEMINI_KEYS[keyIdx];
  keyIdx = (keyIdx + 1) % GEMINI_KEYS.length;
  return k;
}

async function callAI(prompt, mode = "general") {
  const key = rotateKey();
  const context = `You are the AFKBot Support Assistant. 
  Tech: Bedrock & Java engines, Physics Simulation, Microsoft Auth, Fly.io Storage.
  Rules: English ONLY. Professional. If chat is casual, reply [NoCont].
  Egg: If user says "slap me", reply: "👋 *Slaps you with a massive wet cod!* 🐟"`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: context }] }
      })
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "[NoCont]";
  } catch (err) {
    return mode === "support" ? "[NoCont]" : "AI system is offline. ☁️";
  }
}

// ----------------- UI ARCHITECTURE (Clean & Minimalist) -----------------

function getBedrockPanel() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("br_link").setLabel("🔑 Login Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("br_unlink").setLabel("🗑 Logout").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("br_settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("br_start").setLabel("▶ Start Bot").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("br_stop").setLabel("⏹ Stop Bot").setStyle(ButtonStyle.Danger)
    )
  ];
}

function getJavaPanel() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("jv_link").setLabel("🔑 Login Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("jv_unlink").setLabel("🗑 Logout").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("jv_settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("jv_start").setLabel("▶ Start Java Bot").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("jv_stop").setLabel("⏹ Stop Java Bot").setStyle(ButtonStyle.Danger)
    )
  ];
}

// ----------------- BOT ENGINES (RELIABILITY FOCUS) -----------------

function killBedrock(uid) {
  const s = bedrockSessions.get(uid);
  if (!s) return;
  if (s.intervals) s.intervals.forEach(clearInterval);
  if (s.timers) s.timers.forEach(clearTimeout);
  if (s.client) { s.client.removeAllListeners(); try { s.client.close(); } catch (e) {} }
  bedrockSessions.delete(uid);
}

function killJava(uid) {
  const s = javaSessions.get(uid);
  if (!s) return;
  if (s.intervals) s.intervals.forEach(clearInterval);
  if (s.timers) s.timers.forEach(clearTimeout);
  if (s.client) { s.client.removeAllListeners(); try { s.client.quit(); } catch (e) {} }
  javaSessions.delete(uid);
}

/**
 * BEDROCK ENGINE
 */
async function startBedrock(uid, interaction = null) {
  const u = fetchProfile(uid);
  if (bedrockSessions.has(uid) && !bedrockSessions.get(uid).isReconnecting) {
    if (interaction) await interaction.editReply("⚠️ Session already active.").catch(() => {});
    return;
  }

  const { ip, port } = u.bedrock;
  if (!ip) return interaction?.editReply("⚠️ Please configure Server IP and Port in Settings.");

  if (interaction) await interaction.editReply(`📡 **Phase 1:** Pinging ${ip}:${port}...`).catch(() => {});

  try {
    const p = await bedrock.ping({ host: ip, port: port });
    if ((p.motd || "").toLowerCase().match(/offline|starting|queue/)) {
        if (interaction) await interaction.editReply(`❌ Server is currently offline or in a lobby queue.`);
        return;
    }
    if (interaction) await interaction.editReply(`🤝 **Phase 2:** Protocol Handshake with ${p.motd.slice(0, 10)}...`).catch(() => {});
  } catch (e) {
    if (interaction) await interaction.editReply(`❌ Could not reach ${ip}. Make sure it is Online.`).catch(() => {});
    return;
  }

  const opts = { 
    host: ip, port, connectTimeout: 45000, keepAlive: true,
    version: u.bedrock.version === "auto" ? undefined : u.bedrock.version,
    username: u.bedrock.name || uid,
    offline: !u.linkedBedrock,
    profilesFolder: u.linkedBedrock ? getAuthFolder(uid, "bedrock") : undefined,
    skip_chunk_decoding: true,
    use_native_raknet: true 
  };

  const mc = bedrock.createClient(opts);
  const state = {
    client: mc, connected: false, manualStop: false, isReconnecting: false,
    startTime: Date.now(), intervals: new Map(), timers: new Map(), isSneaking: false
  };
  bedrockSessions.set(uid, state);

  state.timers.set("timeout", setTimeout(async () => {
    if (!state.connected) {
      if (interaction) await interaction.editReply(`❌ **Phase 3 Failed:** Spawn Timeout (Server didn't let us in).`).catch(() => {});
      killBedrock(uid);
    }
  }, 47000));

  mc.on("spawn", () => {
    state.connected = true;
    clearTimeout(state.timers.get("timeout"));
    if (interaction) interaction.editReply(`🟢 **Successfully Connected!**\nPhysics simulation and AFK protocols active.`).catch(() => {});

    state.timers.set("reboot", setTimeout(() => {
      if (state.connected && !state.manualStop) {
        state.isReconnecting = true; killBedrock(uid);
        setTimeout(() => startBedrock(uid), 5000);
      }
    }, SOFT_REBOOT_INTERVAL));

    // Physics Engine (Walk, Sneak, Jump)
    state.intervals.set("physics", setInterval(() => {
      if (!mc.entity?.position) return;
      if (Math.random() < 0.15) {
        state.isSneaking = !state.isSneaking;
        mc.write("player_action", { runtime_id: mc.entityId, action: state.isSneaking ? "start_sneaking" : "stop_sneaking", position: {x:0,y:0,z:0}, result_position: {x:0,y:0,z:0}, face: 0 });
      }
      const pos = { ...mc.entity.position };
      if (Math.random() < 0.25) pos.x += (Math.random() > 0.5 ? 0.45 : -0.45);
      mc.write("move_player", { runtime_id: mc.entityId, position: pos, pitch: (Math.random()*20)-10, yaw: Math.random()*360, head_yaw: Math.random()*360, mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false });
    }, 55000));

    state.intervals.set("heartbeat", setInterval(() => { try { mc.write("tick_sync", { request_time: BigInt(Date.now()), response_time: 0n }); } catch (e) {} }, HEARTBEAT_INTERVAL));
  });

  mc.on("error", () => { if (!state.manualStop && !state.isReconnecting) recoverBedrock(uid, interaction); });
  mc.on("close", () => { if (!state.manualStop && !state.isReconnecting) recoverBedrock(uid, interaction); });
}

function recoverBedrock(uid, interaction) {
  const s = bedrockSessions.get(uid); if (!s || s.manualStop || s.reconnectTimer) return;
  s.isReconnecting = true; s.connected = false; s.retryCount = (s.retryCount || 0) + 1;
  const wait = Math.min(30000 * Math.pow(1.5, s.retryCount - 1), 300000);
  s.reconnectTimer = setTimeout(() => {
    if (bedrockSessions.has(uid) && !s.manualStop) startBedrock(uid, interaction);
  }, wait);
}

/**
 * JAVA ENGINE (Fixed Auth)
 */
async function startJava(uid, interaction = null) {
  const u = fetchProfile(uid);
  if (javaSessions.has(uid)) {
    if (interaction) await interaction.editReply("⚠️ Java Session already active.").catch(() => {});
    return;
  }

  const { ip, port, name } = u.java;
  if (!ip) return interaction?.editReply("⚠️ Set IP/Port in Settings first.");

  if (interaction) await interaction.editReply(`📡 **Java Phase 1:** Resolving ${ip}:${port || 25565}...`).catch(() => {});

  const botOptions = {
    host: ip,
    port: port || 25565,
    username: name || uid,
    version: false,
    hideErrors: true,
    connectTimeout: 30000
  };

  if (u.linkedJava) {
    botOptions.auth = 'microsoft';
    botOptions.profilesFolder = getAuthFolder(uid, "java");
  }

  try {
    const bot = mineflayer.createBot(botOptions);
    const state = { client: bot, connected: false, intervals: new Map(), startTime: Date.now() };
    javaSessions.set(uid, state);

    bot.on("spawn", () => {
      state.connected = true;
      if (interaction) interaction.editReply(`🟢 **Java Bot Connected!**\nAFK movements initialized.`).catch(() => {});

      state.intervals.set("move", setInterval(() => {
        if (!bot.entity) return;
        bot.look(Math.random()*Math.PI*2, (Math.random()-0.5)*Math.PI*0.2);
        if (Math.random() < 0.2) { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 500); }
      }, 60000));
    });

    bot.on("error", () => killJava(uid));
    bot.on("end", () => killJava(uid));
  } catch (e) {
    if (interaction) await interaction.editReply(`❌ Java Initialization Failed.`).catch(() => {});
  }
}

// ----------------- DISCORD HANDLERS -----------------

client.on(Events.MessageCreate, async (m) => {
  if (m.author.bot || m.channelId !== SUPPORT_CHANNEL_ID) return;
  if (m.content.toLowerCase().includes("slap me")) return m.reply("👋 *Slaps you with a massive wet cod!* 🐟");
  const res = await callAI(`User: <@${m.author.id}> says: ${m.content}`, "support");
  if (res.includes("[NoCont]")) return;
  await m.reply({ content: res });
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    const uid = i.user.id;
    if (i.guildId !== ALLOWED_GUILD_ID && i.inGuild() && uid !== OWNER_ID) return i.reply({ content: "Restricted Access ⛔️", ephemeral: true });

    if (i.isButton()) {
      if (i.customId === "br_start") { await i.deferReply({ ephemeral: true }); return startBedrock(uid, i); }
      if (i.customId === "jv_start") { await i.deferReply({ ephemeral: true }); return startJava(uid, i); }
      
      if (i.customId === "br_stop") { killBedrock(uid); return i.reply({ ephemeral: true, content: "⏹ **Bedrock Stopped.**" }); }
      if (i.customId === "jv_stop") { killJava(uid); return i.reply({ ephemeral: true, content: "⏹ **Java Stopped.**" }); }

      if (i.customId === "br_unlink") { 
        const u = fetchProfile(uid); if (!u.linkedBedrock) return i.reply({ ephemeral: true, content: "❌ Not linked." });
        try { fs.rmSync(getAuthFolder(uid, "bedrock"), { recursive: true, force: true }); } catch(e) {}
        u.linkedBedrock = false; syncStorage(); return i.reply({ ephemeral: true, content: "🗑 Logout success." });
      }

      if (i.customId === "jv_unlink") { 
        const u = fetchProfile(uid); if (!u.linkedJava) return i.reply({ ephemeral: true, content: "❌ Not linked." });
        try { fs.rmSync(getAuthFolder(uid, "java"), { recursive: true, force: true }); } catch(e) {}
        u.linkedJava = false; syncStorage(); return i.reply({ ephemeral: true, content: "🗑 Logout success." });
      }

      // ORIGINAL CALLBACKS (LOCKED)
      if (i.customId === "br_link") {
        await i.deferReply({ ephemeral: true });
        const flow = new Authflow(uid, getAuthFolder(uid, "bedrock"), { flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo" }, async (data) => {
          const msg = `🔐 **Bedrock Login Required**\n\n1️⃣ **Link:** [Click to login](${data.verification_uri})\n2️⃣ **Code:** \`${data.user_code}\`\n\n⚠️ Return here after browser login!`;
          await i.editReply({ content: msg, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Link").setStyle(ButtonStyle.Link).setURL(data.verification_uri))] });
        });
        await flow.getMsaToken();
        const u = fetchProfile(uid); u.linkedBedrock = true; syncStorage();
        return i.followUp({ ephemeral: true, content: "✅ **Linked!**" });
      }

      if (i.customId === "jv_link") {
        await i.deferReply({ ephemeral: true });
        const flow = new Authflow(uid, getAuthFolder(uid, "java"), { flow: "live", authTitle: Titles.MinecraftJava, deviceType: "Nintendo" }, async (data) => {
          const msg = `🔐 **Java Login Required**\n\n1️⃣ **Link:** [Click to login](${data.verification_uri})\n2️⃣ **Code:** \`${data.user_code}\`\n\n⚠️ Return here after browser login!`;
          await i.editReply({ content: msg, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Link").setStyle(ButtonStyle.Link).setURL(data.verification_uri))] });
        });
        await flow.getMsaToken();
        const u = fetchProfile(uid); u.linkedJava = true; syncStorage();
        return i.followUp({ ephemeral: true, content: "✅ **Linked!**" });
      }

      if (i.customId === "br_settings") {
        const u = fetchProfile(uid);
        const m = new ModalBuilder().setCustomId("br_set_mod").setTitle("Bedrock Settings");
        m.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.bedrock.ip).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("pt").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.bedrock.port)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("nm").setLabel("Name (Cracked)").setStyle(TextInputStyle.Short).setValue(u.bedrock.name))
        );
        return i.showModal(m);
      }

      if (i.customId === "jv_settings") {
        const u = fetchProfile(uid);
        const m = new ModalBuilder().setCustomId("jv_set_mod").setTitle("Java Settings");
        m.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.java.ip).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("pt").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.java.port)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("nm").setLabel("Username (Cracked)").setStyle(TextInputStyle.Short).setValue(u.java.name).setRequired(true))
        );
        return i.showModal(m);
      }
    }

    if (i.isModalSubmit()) {
      if (i.customId === "br_set_mod") {
        const u = fetchProfile(uid); u.bedrock.ip = i.fields.getTextInputValue("ip"); u.bedrock.port = parseInt(i.fields.getTextInputValue("pt")); u.bedrock.name = i.fields.getTextInputValue("nm");
        syncStorage(); return i.reply({ ephemeral: true, content: "✅ Saved." });
      }
      if (i.customId === "jv_set_mod") {
        const u = fetchProfile(uid); u.java.ip = i.fields.getTextInputValue("ip"); u.java.port = parseInt(i.fields.getTextInputValue("pt")); u.java.name = i.fields.getTextInputValue("nm");
        syncStorage(); return i.reply({ ephemeral: true, content: "✅ Saved." });
      }
    }

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return i.reply({ content: "🎛 **Bedrock Dashboard**", components: getBedrockPanel() });
      if (i.commandName === "javapanel") return i.reply({ content: "🎛 **Java Dashboard**", components: getJavaPanel() });
    }
  } catch (err) { process.stderr.write(`[ERR] ${err.message}\n`); }
});

// --- LIFECYCLE ---
client.once("ready", async () => {
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Access Bedrock Dashboard"),
    new SlashCommandBuilder().setName("javapanel").setDescription("Access Java Dashboard")
  ];
  await client.application.commands.set(cmds);
  console.log("🟢 System Online. V29 operational.");
});

client.login(DISCORD_TOKEN);

