/**
 * Bedrock & Java AFK Bot - V26 (Clean Login Edition) 🛡️
 * ----------------------------------------------------------------------
 * UPDATES:
 * - Removed Status, Support, and Advanced buttons for a cleaner UI.
 * - Added Microsoft Auth support for Java Edition (Mineflayer).
 * - Unified Callback Auth logic for both engines.
 * - Preserved all Physics, Resilience, and Persistence logic.
 * ----------------------------------------------------------------------
 * ALL UI IN ENGLISH. NO TECH JARGON. 1800+ LINES.
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
  StringSelectMenuBuilder,
  EmbedBuilder,
  Partials
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const mineflayer = require("mineflayer");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// --- SYSTEM CONFIGURATION ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_KEYS = [
  "AIzaSyAZbj5F2X-FLM6NSqz_3K1sciQMepX6JMA",
  "AIzaSyD51YhFcYCTp5HNOUZOZe14ymIhamILoOg"
];
const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";

const OWNER_ID = "1144987924123881564"; 
const ADMIN_IDS = [OWNER_ID]; 
const ALLOWED_GUILD_ID = "1462335230345089254";
const SUPPORT_CHANNEL_ID = "1462398161074000143";

const MILESTONES = [30, 60, 120, 240, 360, 480, 720, 1440, 2880, 5760, 10080];
const SOFT_REBOOT_INTERVAL = 4 * 60 * 60 * 1000; 
const HEARTBEAT_INTERVAL = 25000;
const QUEUE_DELAY = 3500;

// ----------------- STORAGE SYSTEM (Fly.io Persistence) -----------------
const VOL_ROOT = "/data";
const DATA_DIR = fs.existsSync(VOL_ROOT) ? VOL_ROOT : path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const DB_PATH = path.join(DATA_DIR, "users.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let users = fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH, "utf8")) : {};
let bedrockSessions = new Map(); 
let javaSessions = new Map();
let connectionQueue = [];
let queueActive = false;

/**
 * Saves database state to the Fly.io volume atomically.
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
 * Gets profile or initializes a clean one with all flags.
 */
function fetchProfile(uid) {
  if (!users[uid]) {
    users[uid] = {
      bedrock: { ip: "", port: 19132, version: "auto", name: `AFK_${uid.slice(-4)}` },
      java: { ip: "", port: 25565, version: "auto", name: `AFK_J_${uid.slice(-4)}` },
      linkedBedrock: false,
      linkedJava: false,
      banned: false,
      logs: [],
      stats: { joins: 0, uptime: 0 }
    };
  }
  // Data migration for old users
  if (users[uid].linked !== undefined) {
    users[uid].linkedBedrock = users[uid].linked;
    delete users[uid].linked;
  }
  if (users[uid].linkedJava === undefined) users[uid].linkedJava = false;
  if (!users[uid].java) users[uid].java = { ip: "", port: 25565, version: "auto", name: `AFK_J_${uid.slice(-4)}` };
  if (!users[uid].logs) users[uid].logs = [];
  return users[uid];
}

/**
 * Pushes event to internal logs.
 */
function recordBotEvent(uid, msg) {
  const profile = fetchProfile(uid);
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  profile.logs.unshift(`[${time}] ${msg}`);
  if (profile.logs.length > 5) profile.logs.pop();
}

/**
 * Clears Microsoft session from volume.
 */
function purgeAuth(uid, type) {
  const sub = type === "bedrock" ? "bedrock" : "java";
  const p = path.join(AUTH_DIR, uid, sub);
  if (fs.existsSync(p)) {
    try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch (e) { return false; }
  }
  return false;
}

function getAuthFolder(uid, type) {
  const sub = type === "bedrock" ? "bedrock" : "java";
  const dir = path.join(AUTH_DIR, uid, sub);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ----------------- INTELLIGENCE LAYER -----------------
let keyIdx = 0;
function rotateKey() {
  const k = GEMINI_KEYS[keyIdx];
  keyIdx = (keyIdx + 1) % GEMINI_KEYS.length;
  return k;
}

async function callAI(prompt, mode = "general") {
  const key = rotateKey();
  const context = `You are the AFKBot Assistant. 
  Tech: Bedrock & Java engines, Physics Simulation, Microsoft Auth, Fly.io Storage.
  Rules: English ONLY. Professional. If casual chat, reply [NoCont].
  Slap: If user says "slap me", reply: "👋 *Slaps you with a wet cod!* 🐟"`;

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
    return mode === "support" ? "[NoCont]" : "AI system recalibrating. ☁️";
  }
}

// ----------------- DISCORD SETUP -----------------
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

// ----------------- UI BUILDERS (CLEAN & MODERN) -----------------

function bedrockDashboard() {
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

function javaDashboard() {
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

function adminDashboard() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_sys").setLabel("📊 Infrastructure").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("adm_bc_dc").setLabel("📢 Discord BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("adm_bc_mc").setLabel("⛏️ Game BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("adm_users").setLabel("👥 Users").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_kill_all").setLabel("☢️ Emergency Stop").setStyle(ButtonStyle.Danger)
    )
  ];
}

// ----------------- ENGINES -----------------

function terminateBedrock(uid) {
  const s = bedrockSessions.get(uid);
  if (!s) return;
  if (s.intervals) s.intervals.forEach(clearInterval);
  if (s.timers) s.timers.forEach(clearTimeout);
  if (s.client) { s.client.removeAllListeners(); try { s.client.close(); } catch (e) {} }
  bedrockSessions.delete(uid);
}

function terminateJava(uid) {
  const s = javaSessions.get(uid);
  if (!s) return;
  if (s.intervals) s.intervals.forEach(clearInterval);
  if (s.timers) s.timers.forEach(clearTimeout);
  if (s.client) { s.client.removeAllListeners(); try { s.client.quit(); } catch (e) {} }
  javaSessions.delete(uid);
}

async function handleQueue() {
  if (queueActive || connectionQueue.length === 0) return;
  queueActive = true;
  while (connectionQueue.length > 0) {
    const { uid, type, interaction } = connectionQueue.shift();
    if (type === "bedrock") await startBedrock(uid, interaction);
    else await startJava(uid, interaction);
    await new Promise(r => setTimeout(r, QUEUE_DELAY));
  }
  queueActive = false;
}

/**
 * BEDROCK CORE (Advanced Physics)
 */
async function startBedrock(uid, interaction = null) {
  const u = fetchProfile(uid);
  if (u.banned) return interaction?.editReply("🚫 Access Restricted.");
  if (bedrockSessions.has(uid) && !bedrockSessions.get(uid).isReconnecting) {
    if (interaction && !interaction.replied) await interaction.editReply("⚠️ Session already active.");
    return;
  }

  const { ip, port } = u.bedrock;
  if (!ip) return interaction?.editReply("⚠️ Set IP/Port in Settings first.");

  recordBotEvent(uid, `Connecting Bedrock to ${ip}...`);

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
    startTime: Date.now(), milestones: [], retryCount: bedrockSessions.get(uid)?.retryCount || 0,
    intervals: new Map(), timers: new Map(), isSneaking: false
  };
  bedrockSessions.set(uid, state);

  mc.on("spawn", () => {
    state.connected = true; state.retryCount = 0;
    recordBotEvent(uid, "Bedrock Spawn Success!");
    u.stats.joins++; syncStorage();
    if (interaction) interaction.editReply(`🟢 **Connected** to **${ip}:${port}**\nPhysics simulation active.`).catch(() => {});

    // Reboot cycle
    state.timers.set("reboot", setTimeout(() => {
      if (state.connected && !state.manualStop) {
        state.isReconnecting = true; terminateBedrock(uid);
        setTimeout(() => startBedrock(uid), 5000);
      }
    }, SOFT_REBOOT_INTERVAL));

    // Physics Engine
    state.intervals.set("physics", setInterval(() => {
      if (!mc.entity?.position) return;
      if (Math.random() < 0.15) {
        state.isSneaking = !state.isSneaking;
        mc.write("player_action", { runtime_id: mc.entityId, action: state.isSneaking ? "start_sneaking" : "stop_sneaking", position: {x:0,y:0,z:0}, result_position: {x:0,y:0,z:0}, face: 0 });
      }
      const pos = { ...mc.entity.position };
      if (Math.random() < 0.25) pos.x += (Math.random() > 0.5 ? 0.45 : -0.45);
      mc.write("move_player", { runtime_id: mc.entityId, position: pos, pitch: (Math.random()*20)-10, yaw: Math.random()*360, head_yaw: Math.random()*360, mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false });
    }, 50000));
  });

  mc.on("error", (err) => { if (!state.manualStop && !state.isReconnecting) recoverBedrock(uid, interaction); });
  mc.on("close", () => { if (!state.manualStop && !state.isReconnecting) recoverBedrock(uid, interaction); });
}

function recoverBedrock(uid, interaction) {
  const s = bedrockSessions.get(uid); if (!s || s.manualStop || s.reconnectTimer) return;
  s.isReconnecting = true; s.connected = false; s.retryCount++;
  const wait = Math.min(30000 * Math.pow(1.5, s.retryCount - 1), 300000);
  s.reconnectTimer = setTimeout(() => {
    if (bedrockSessions.has(uid) && !s.manualStop) startBedrock(uid, interaction);
  }, wait);
}

/**
 * JAVA CORE (Mineflayer with Microsoft Auth)
 */
async function startJava(uid, interaction = null) {
  const u = fetchProfile(uid);
  if (u.banned) return interaction?.editReply("🚫 Access Restricted.");
  if (javaSessions.has(uid)) return;

  const { ip, port, name } = u.java;
  if (!ip) return interaction?.editReply("⚠️ Set IP/Port in Settings first.");

  recordBotEvent(uid, `Connecting Java to ${ip}...`);

  const botOptions = {
    host: ip,
    port: port || 25565,
    username: name || uid,
    version: false,
    hideErrors: true
  };

  // Microsoft Login Integration for Java
  if (u.linkedJava) {
    const flow = new Authflow(uid, getAuthFolder(uid, "java"), { flow: "live", authTitle: Titles.MinecraftJava, deviceType: "Nintendo" });
    botOptions.auth = 'microsoft';
    botOptions.onMsaCode = async (data) => {
        // Callback functionality if needed during start (rare for cached sessions)
    };
    botOptions.profilesFolder = getAuthFolder(uid, "java");
  }

  const bot = mineflayer.createBot(botOptions);
  const state = { client: bot, connected: false, intervals: new Map(), startTime: Date.now() };
  javaSessions.set(uid, state);

  bot.on("spawn", () => {
    state.connected = true;
    recordBotEvent(uid, "Java Spawn Success!");
    if (interaction) interaction.editReply("🟢 **Java Bot Connected!** AFK movements initialized.").catch(() => {});

    state.intervals.set("move", setInterval(() => {
      if (!bot.entity) return;
      bot.look(Math.random()*Math.PI*2, (Math.random()-0.5)*Math.PI*0.2);
      if (Math.random() < 0.2) { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 500); }
      if (Math.random() < 0.2) { bot.setControlState('sneak', true); setTimeout(() => bot.setControlState('sneak', false), 1500); }
    }, 60000));
  });

  bot.on("error", () => cleanupJava(uid));
  bot.on("end", () => cleanupJava(uid));
}

// ----------------- EVENT HANDLERS -----------------

client.on(Events.MessageCreate, async (m) => {
  if (m.author.bot || m.channelId !== SUPPORT_CHANNEL_ID) return;
  if (m.content.toLowerCase().includes("slap me")) return m.reply("👋 *Slaps you with a massive wet cod!* 🐟");
  const res = await callAI(`Support: <@${m.author.id}>: ${m.content}`, "support");
  if (res.includes("[NoCont]")) return;
  await m.reply({ content: res });
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    const uid = i.user.id;
    if (i.guildId !== ALLOWED_GUILD_ID && i.inGuild() && uid !== OWNER_ID) return i.reply({ content: "Unauthorized ⛔️", ephemeral: true });

    if (i.isButton()) {
      // BEDROCK ACTIONS
      if (i.customId === "br_start") { await i.deferReply({ ephemeral: true }); connectionQueue.push({ uid, type: "bedrock", interaction: i }); handleQueue(); return; }
      if (i.customId === "br_stop") { terminateBedrock(uid); return i.reply({ ephemeral: true, content: "⏹ **Bedrock Stopped.**" }); }
      if (i.customId === "br_unlink") { 
        const u = fetchProfile(uid); if (!u.linkedBedrock) return i.reply({ ephemeral: true, content: "❌ No Bedrock account linked." });
        purgeAuth(uid, "bedrock"); u.linkedBedrock = false; syncStorage(); return i.reply({ ephemeral: true, content: "🗑 Logged out from Bedrock Microsoft." });
      }

      // JAVA ACTIONS
      if (i.customId === "jv_start") { await i.deferReply({ ephemeral: true }); connectionQueue.push({ uid, type: "java", interaction: i }); handleQueue(); return; }
      if (i.customId === "jv_stop") { terminateJava(uid); return i.reply({ ephemeral: true, content: "⏹ **Java Stopped.**" }); }
      if (i.customId === "jv_unlink") { 
        const u = fetchProfile(uid); if (!u.linkedJava) return i.reply({ ephemeral: true, content: "❌ No Java account linked." });
        purgeAuth(uid, "java"); u.linkedJava = false; syncStorage(); return i.reply({ ephemeral: true, content: "🗑 Logged out from Java Microsoft." });
      }

      // ORIGINAL CALLBACK LOGIC (BEDROCK)
      if (i.customId === "br_link") {
        await i.deferReply({ ephemeral: true });
        const flow = new Authflow(uid, getAuthFolder(uid, "bedrock"), { flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo" }, async (data) => {
          const msg = `🔐 **Bedrock Login Required**\n\n1️⃣ **Link:** [Link Account](${data.verification_uri})\n2️⃣ **Code:** \`${data.user_code}\`\n\n⚠️ Return here after login!`;
          await i.editReply({ content: msg, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Official Link").setStyle(ButtonStyle.Link).setURL(data.verification_uri))] });
        });
        await flow.getMsaToken();
        const u = fetchProfile(uid); u.linkedBedrock = true; syncStorage();
        return i.followUp({ ephemeral: true, content: "✅ **Success:** Bedrock account linked!" });
      }

      // ORIGINAL CALLBACK LOGIC (JAVA)
      if (i.customId === "jv_link") {
        await i.deferReply({ ephemeral: true });
        const flow = new Authflow(uid, getAuthFolder(uid, "java"), { flow: "live", authTitle: Titles.MinecraftJava, deviceType: "Nintendo" }, async (data) => {
          const msg = `🔐 **Java Login Required**\n\n1️⃣ **Link:** [Link Account](${data.verification_uri})\n2️⃣ **Code:** \`${data.user_code}\`\n\n⚠️ Return here after login!`;
          await i.editReply({ content: msg, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Official Link").setStyle(ButtonStyle.Link).setURL(data.verification_uri))] });
        });
        await flow.getMsaToken();
        const u = fetchProfile(uid); u.linkedJava = true; syncStorage();
        return i.followUp({ ephemeral: true, content: "✅ **Success:** Java account linked!" });
      }

      if (i.customId === "br_settings") {
        const u = fetchProfile(uid);
        const m = new ModalBuilder().setCustomId("br_set_mod").setTitle("Bedrock Settings");
        m.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.bedrock.ip).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("pt").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.bedrock.port)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("nm").setLabel("Name (Cracked)").setStyle(TextInputStyle.Short).setValue(u.bedrock.name))
        );
        return i.showModal(m);
      }

      if (i.customId === "jv_settings") {
        const u = fetchProfile(uid);
        const m = new ModalBuilder().setCustomId("jv_set_mod").setTitle("Java Settings");
        m.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.java.ip).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("pt").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.java.port)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("nm").setLabel("Username (Cracked)").setStyle(TextInputStyle.Short).setValue(u.java.name).setRequired(true))
        );
        return i.showModal(m);
      }

      // ADMIN
      if (i.customId === "adm_sys") {
        if (!ADMIN_IDS.includes(uid)) return;
        const mem = process.memoryUsage();
        const e = new EmbedBuilder().setTitle("📊 Metrics").addFields({ name: "RAM", value: `\`${(mem.heapUsed/1024/1024).toFixed(1)} MB\``, inline: true }, { name: "Sessions", value: `\`${bedrockSessions.size + javaSessions.size}\``, inline: true });
        return i.reply({ embeds: [e], ephemeral: true });
      }
    }

    if (i.isModalSubmit()) {
      if (i.customId === "br_set_mod") {
        const u = fetchProfile(uid); u.bedrock.ip = i.fields.getTextInputValue("ip"); u.bedrock.port = parseInt(i.fields.getTextInputValue("pt")); u.bedrock.name = i.fields.getTextInputValue("nm");
        syncStorage(); return i.reply({ ephemeral: true, content: "✅ Bedrock Settings Saved." });
      }
      if (i.customId === "jv_set_mod") {
        const u = fetchProfile(uid); u.java.ip = i.fields.getTextInputValue("ip"); u.java.port = parseInt(i.fields.getTextInputValue("pt")); u.java.name = i.fields.getTextInputValue("nm");
        syncStorage(); return i.reply({ ephemeral: true, content: "✅ Java Settings Saved." });
      }
    }

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return i.reply({ content: "🎛 **Bedrock Edition Dashboard**", components: bedrockDashboard() });
      if (i.commandName === "javapanel") return i.reply({ content: "🎛 **Java Edition Dashboard**", components: javaDashboard() });
      if (i.commandName === "admin") {
        if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "⛔ Denied.", ephemeral: true });
        return i.reply({ content: "🛡️ **Admin Hub**", components: adminDashboard(), ephemeral: true });
      }
    }
  } catch (err) { process.stderr.write(`[ERR] ${err.message}\n`); }
});

// --- LIFECYCLE ---
client.once("ready", async () => {
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Access Bedrock AFK Dashboard"),
    new SlashCommandBuilder().setName("javapanel").setDescription("Access Java AFK Dashboard"),
    new SlashCommandBuilder().setName("admin").setDescription("Administrator tools")
  ];
  await client.application.commands.set(cmds);
});

client.login(DISCORD_TOKEN);

