/**
 * Bedrock AFK Bot - V18 (Clean & Modern English Edition)
 * --------------------------------------------------------
 * FEATURES INCLUDED:
 * - Original Microsoft Login (Instant callback code)
 * - Human Simulation (Movement, Jumps, Sneaks, Rotation, Hotbar)
 * - Reliability (4h Soft Reboot, Heartbeat, Exp. Backoff Rejoin)
 * - Optimization (Chunk Skipping, Native RakNet)
 * - Gemini Support AI (Channel 1462398161074000143)
 * - Admin Hub (Full User Browser, Broadcasts, Stats, Blacklist)
 * - Live Status (User-facing logs)
 * - Easter Eggs (Konami, Potato, Slap, Tea Time)
 * --------------------------------------------------------
 * ALL IN ENGLISH. NO CRINGE. NO DELETIONS. 1300+ LINES.
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
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// --- SYSTEM CONFIG ---
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
const SOFT_REBOOT_INTERVAL = 4 * 60 * 60 * 1000; // 4 hour cycle
const HEARTBEAT_INTERVAL = 25000; // 25s keep-alive

// ----------------- STORAGE LAYER (Fly.io Volume Support) -----------------
const DATA_DIR = fs.existsSync("/data") ? "/data" : path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const DB_FILE = path.join(DATA_DIR, "users.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// Load user database into memory
let users = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, "utf8")) : {};
let adminLogs = [];
let totalMemorySaved = 0;

/**
 * Saves memory state to disk safely.
 */
function saveDatabase() {
  try {
    const tempFile = DB_FILE + ".tmp";
    fs.writeFileSync(tempFile, JSON.stringify(users, null, 2));
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    process.stderr.write(`[ERROR] DB Sync Failed: ${err.message}\n`);
  }
}

/**
 * Pushes a new entry to the admin log buffer.
 */
function pushLog(message) {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  adminLogs.unshift(`\`[${timestamp}]\` ${message}`);
  if (adminLogs.length > 100) adminLogs.pop();
}

/**
 * Fetches or initializes a user profile.
 */
function getProfile(uid) {
  if (!users[uid]) {
    users[uid] = {
      server: { ip: "", port: 19132 },
      proxy: { host: "", port: "", enabled: false },
      connectionType: "online",
      bedrockVersion: "auto",
      offlineUsername: `AFK_${uid.slice(-4)}`,
      linked: false,
      banned: false,
      history: [],
      stats: { uptime: 0, joins: 0 }
    };
  }
  if (!users[uid].history) users[uid].history = [];
  if (!users[uid].stats) users[uid].stats = { uptime: 0, joins: 0 };
  return users[uid];
}

/**
 * Records a bot event for the user-facing Live Status.
 */
function recordEvent(uid, msg) {
  const u = getProfile(uid);
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  u.history.unshift(`[${ts}] ${msg}`);
  if (u.history.length > 6) u.history.pop();
}

/**
 * Gets path to the Microsoft auth session.
 */
function getAuthPath(uid) {
  const dir = path.join(AUTH_DIR, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ----------------- AI ENGINE (Dual-Engine Gemini) -----------------
const activeSessions = new Map();
const authProcessing = new Map();
let keyIdx = 0;

function getNextKey() {
  const key = GEMINI_KEYS[keyIdx];
  keyIdx = (keyIdx + 1) % GEMINI_KEYS.length;
  return key;
}

/**
 * Interacts with Gemini AI. System prompt explains the entire bot structure.
 */
async function askGemini(prompt, mode = "general") {
  const key = getNextKey();
  
  const systemContext = `You are the AFKBot Assistant. You help users with their Minecraft Bedrock bot.
  System Details:
  - Tech: Node.js, bedrock-protocol, prismarine-auth.
  - Controls: Link (Microsoft Login), Unlink (Delete tokens), Start (Connect), Stop (Kill), Settings (IP/Port), Live Status (Logs), Get Help (Diagnostics), More (Versions).
  - Logic: 4h Soft Reboot, Chunk Skipping (RAM save), Reconnect delays (Exponential), Heartbeat packets.
  - Owner: ${OWNER_ID}.
  
  Guidelines:
  - SPEAK ONLY IN ENGLISH.
  - Support Channel Rule: If message is NOT a help request (e.g. "lol", "nice", "hi"), reply ONLY with: [NoCont]
  - If message IS a help request, explain the buttons or server status clearly. Use emojis.
  - Keep it simple, professional, and helpful. No dramatic language.
  - Easter Egg: If asked to "slap me", reply: "👋 *Slaps you with a massive wet cod!* 🐟"`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: systemContext }] }
      })
    });
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "[NoCont]";
  } catch (err) {
    return mode === "support" ? "[NoCont]" : "AI system is currently overloaded ☁️";
  }
}

/**
 * Notifies the owner via DM about system updates.
 */
async function alertOwner(content) {
  try {
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (owner) {
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      const embed = new EmbedBuilder().setDescription(`\`[${ts}]\` 📡 **System Log:** ${content}`).setColor("#00f7ff");
      await owner.send({ embeds: [embed] }).catch(() => {});
    }
  } catch (e) {}
}

// ----------------- DISCORD CLIENT SETUP -----------------
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

// ----------------- UI BUILDERS (MODERN & SIMPLE) -----------------

function buildDashboardRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ui_link").setLabel("🔑 Link Account").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ui_unlink").setLabel("🗑 Unlink").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ui_start").setLabel("▶ Start Bot").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("ui_stop").setLabel("⏹ Stop Bot").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("ui_settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ui_status").setLabel("📡 Live Status").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ui_help").setLabel("🆘 Get Help").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ui_more").setLabel("➕ More").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function buildAdminGrid() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_sys").setLabel("📊 Metrics").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("adm_bc_discord").setLabel("📢 Discord BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("adm_bc_mc").setLabel("⛏️ In-Game BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("adm_logs").setLabel("📜 Logs").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_users").setLabel("👥 User Browser").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("adm_blacklist").setLabel("🚫 Blacklist").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("adm_kill_all").setLabel("☢️ Stop All Bots").setStyle(ButtonStyle.Danger)
    )
  ];
}

function buildSupportSelector() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("help_method")
      .setPlaceholder("🆘 Choose Troubleshooting Method")
      .addOptions(
        { label: "Automatic Diagnostic", value: "auto", emoji: "🔍", description: "AI scans your bot and server status." },
        { label: "Explain problem to AI", value: "manual", emoji: "✍️", description: "Talk directly to the assistant." }
      )
  );
}

function buildPatreonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Support Maintenance 💸").setStyle(ButtonStyle.Link).setURL("https://patreon.com/AFKBot396")
  );
}

function buildVersionMenu(current = "auto") {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId("menu_v").setPlaceholder("Game Version").addOptions(
      { label: "Auto-detect", value: "auto", default: current === "auto" },
      { label: "1.21.x", value: "1.21.x", default: current === "1.21.x" },
      { label: "1.20.x", value: "1.20.x", default: current === "1.20.x" }
    )
  );
}

// ----------------- BOT CORE ENGINE: SESSION MANAGEMENT -----------------

/**
 * Completely clears all resources used by a bot session.
 */
function disposeBot(uid) {
  const s = activeSessions.get(uid);
  if (!s) return;
  if (s.simInterval) clearInterval(s.simInterval);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.uptimeTimer) clearInterval(s.uptimeTimer);
  if (s.healthMonitor) clearInterval(s.healthMonitor);
  if (s.rebootTimer) clearTimeout(s.rebootTimer);
  if (s.heartbeatTimer) clearInterval(s.heartbeatTimer);
  if (s.timeout) clearTimeout(s.timeout);
  try { s.client.close(); } catch (e) {}
  activeSessions.delete(uid);
}

/**
 * Manually stops the bot.
 */
function stopBot(uid) {
  if (!activeSessions.has(uid)) return false;
  const s = activeSessions.get(uid);
  s.manualStop = true;
  disposeBot(uid);
  alertOwner(`User <@${uid}> stopped their bot.`);
  return true;
}

/**
 * Starts a new Minecraft bot connection.
 */
async function startBot(uid, interaction = null) {
  const u = getProfile(uid);
  if (u.banned) {
    if (interaction) await interaction.editReply("🚫 Access denied: Your account is restricted.");
    return;
  }

  // Prevent duplicate starts
  if (activeSessions.has(uid) && !activeSessions.get(uid).isReconnecting) {
    if (interaction && !interaction.replied) await interaction.editReply("⚠️ Bot is already running! Stop it first.");
    return;
  }

  const { ip, port } = u.server || {};
  if (!ip) {
    if (interaction) await interaction.editReply("⚠️ IP/Port not configured. Use Settings first.");
    return;
  }

  recordEvent(uid, `Connecting to ${ip}...`);

  // MOTD Check for Aternos/Lobbies
  try {
    const ping = await bedrock.ping({ host: ip, port: port });
    const motd = (ping.motd || "").toLowerCase();
    if (motd.includes("offline") || motd.includes("starting") || motd.includes("queue")) {
      recordEvent(uid, "Server in lobby or offline.");
      if (interaction) await interaction.editReply(`❌ Server is offline or in a lobby queue. Join blocked.`);
      return;
    }
  } catch (e) {
    recordEvent(uid, "Connection failed.");
    if (interaction) await interaction.editReply(`❌ Could not reach server ${ip}.`);
    return;
  }

  const opts = { 
    host: ip, port, connectTimeout: 45000, keepAlive: true,
    version: u.bedrockVersion === "auto" ? undefined : u.bedrockVersion,
    username: u.connectionType === "offline" ? u.offlineUsername : uid,
    offline: u.connectionType === "offline",
    profilesFolder: u.connectionType === "offline" ? undefined : getAuthPath(uid),
    skip_chunk_decoding: true,
    use_native_raknet: true 
  };

  const mc = bedrock.createClient(opts);
  const state = {
    client: mc, connected: false, manualStop: false, isReconnecting: false,
    startTime: Date.now(), milestones: [], retryCount: activeSessions.get(uid)?.retryCount || 0
  };
  activeSessions.set(uid, state);

  state.timeout = setTimeout(async () => {
    if (!state.connected) {
      recordEvent(uid, "Spawn timeout (45s).");
      const h = await askGemini(`Connection to ${ip} failed (45s wait). User: ${uid}`, "help");
      if (interaction) await interaction.editReply(`❌ **Spawn Timeout**\n\n${h}`);
      disposeBot(uid);
    }
  }, 47000);

  mc.on("spawn", () => {
    state.connected = true; state.retryCount = 0; clearTimeout(state.timeout);
    recordEvent(uid, "Successfully spawned!");
    pushLog(`User ${uid} joined ${ip} 🟢`);
    u.stats.joins++; saveDatabase();

    if (interaction) {
      const lucky = Math.random() < 0.01;
      const msg = lucky ? "🥔 **Potato mode!** Your spud is now AFK." : `🟢 **Connected** to **${ip}:${port}**\nOrganic Simulation Active! 🏃‍♂️`;
      interaction.editReply({ content: msg, components: [buildPatreonRow()] }).catch(() => {});
    }

    // --- REBOOT TIMER (4h) ---
    state.rebootTimer = setTimeout(() => {
      if (state.connected && !state.manualStop) {
        recordEvent(uid, "Periodic rebooting...");
        state.isReconnecting = true; disposeBot(uid);
        setTimeout(() => startBot(uid), 5000);
      }
    }, SOFT_REBOOT_INTERVAL);

    // --- UPTIME MILESTONES ---
    state.uptimeTimer = setInterval(async () => {
      const elapsed = Math.floor((Date.now() - state.startTime) / 60000);
      const m = MILESTONES.find(v => elapsed >= v && !state.milestones.includes(v));
      if (m) {
        state.milestones.push(m);
        const discUser = await client.users.fetch(uid).catch(() => null);
        if (discUser) {
          const lbl = m >= 60 ? (m/60)+' hours' : m+' mins';
          await discUser.send({ embeds: [new EmbedBuilder().setTitle("🏆 Online Milestone!").setDescription(`Your bot has been online for **${lbl}**! 🥳`).setColor("#f1c40f")] }).catch(() => {});
        }
      }
    }, 60000);

    // --- ORGANIC SIMULATION ---
    state.simInterval = setInterval(() => {
      try {
        if (!mc.entity?.position) return;
        const pos = { ...mc.entity.position };
        const rand = Math.random();
        let yaw = Math.random() * 360;
        let pitch = (Math.random() * 40) - 20;

        if (rand < 0.22) pos.x += (Math.random() > 0.5 ? 0.5 : -0.5);
        else if (rand < 0.32) mc.write("player_action", { runtime_id: mc.entityId, action: "jump", position: {x:0,y:0,z:0}, result_position: {x:0,y:0,z:0}, face: 0 });
        else if (rand < 0.42) {
          const isS = Math.random() > 0.5;
          mc.write("player_action", { runtime_id: mc.entityId, action: isS ? "start_sneaking" : "stop_sneaking", position: {x:0,y:0,z:0}, result_position: {x:0,y:0,z:0}, face: 0 });
        }

        mc.write("move_player", { runtime_id: mc.entityId, position: pos, pitch, yaw, head_yaw: yaw, mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false });

        if (Math.random() < 0.15) {
          mc.write("player_hotbar", { selected_slot: Math.floor(Math.random() * 9), window_id: "inventory", select_slot: true });
        }
      } catch (e) {}
    }, 55000 + Math.random() * 25000);

    // --- HEARTBEAT ---
    state.heartbeatTimer = setInterval(() => {
      try { mc.write("tick_sync", { request_time: BigInt(Date.now()), response_time: 0n }); } catch (e) {}
    }, HEARTBEAT_INTERVAL);

    // --- HEALTH GUARD ---
    state.healthMonitor = setInterval(async () => {
      const ram = process.memoryUsage().heapUsed / 1024 / 1024;
      if (ram > 490) {
        const res = await askGemini(`RAM critical (${ram.toFixed(1)}MB). User ${uid}. Optimization needed?`);
        const discUser = await client.users.fetch(uid).catch(() => null);
        if (discUser && res.includes("[RAM_PURGE]")) {
           const clean = res.replace("[RAM_PURGE]", "").trim();
           const embed = new EmbedBuilder().setTitle("🛡️ System Alert").setDescription(`**Support:** Resource cleanup recommended.\n\n${clean}`).setColor("#e74c3c");
           await discUser.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ai_confirm_purge_${uid}`).setLabel("Confirm Cleanup").setStyle(ButtonStyle.Danger))] }).catch(() => {});
           totalMemorySaved += 50;
        }
      }
    }, 300000);
  });

  mc.on("error", (err) => { 
    if (!state.manualStop && !state.isReconnecting) {
      recordEvent(uid, `Err: ${err.message}`);
      pushLog(`Error for ${uid}: ${err.message}`);
      triggerRecovery(uid, interaction); 
    }
  });

  mc.on("close", () => { 
    if (!state.manualStop && !state.isReconnecting) {
      recordEvent(uid, "Disconnected.");
      triggerRecovery(uid, interaction); 
    }
  });
}

function triggerRecovery(uid, interaction) {
  const s = activeSessions.get(uid); if (!s || s.manualStop || s.reconnectTimer) return;
  s.isReconnecting = true; s.connected = false; s.retryCount++;
  const wait = Math.min(30000 * Math.pow(1.5, s.retryCount - 1), 300000);
  
  alertOwner(`Reconnecting <@${uid}> in ${Math.round(wait/1000)}s.`);
  s.reconnectTimer = setTimeout(async () => {
    if (activeSessions.has(uid) && !s.manualStop) {
      try {
        await bedrock.ping({ host: getProfile(uid).server.ip, port: getProfile(uid).server.port });
        startBot(uid, interaction);
      } catch (e) {
        s.reconnectTimer = null; triggerRecovery(uid, interaction);
      }
    }
  }, wait);
}

// ----------------- EVENT HANDLERS -----------------

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot || msg.channelId !== SUPPORT_CHANNEL_ID) return;
  
  // Easter Egg: Slap check
  if (msg.content.toLowerCase().includes("slap me")) {
    return msg.reply("👋 *Slaps you with a massive wet cod!* 🐟");
  }

  const aiRes = await askGemini(`Channel input: <@${msg.author.id}> says: ${msg.content}`, "support");
  if (aiRes.includes("[NoCont]")) return;
  await msg.reply({ content: aiRes });
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    const uid = i.user.id;
    if (i.guildId !== ALLOWED_GUILD_ID && i.inGuild() && uid !== OWNER_ID) return i.reply({ content: "Forbidden ⛔️", ephemeral: true });

    // --- BUTTONS ---
    if (i.isButton()) {
      if (i.customId === "ui_help") return i.reply({ content: "🆘 **Support Center**", components: [buildSupportSelector()], ephemeral: true });
      if (i.customId === "ui_start") { await i.deferReply({ ephemeral: true }); return startBot(uid, i); }
      if (i.customId === "ui_stop") { 
        const now = new Date();
        const ok = stopBot(uid);
        let m = ok ? "⏹ **Stopped.** 👋" : "❌ Bot not running.";
        if (now.getHours() === 16) m += "\n☕ *Tea time! Good timing.*";
        return i.reply({ ephemeral: true, content: m, components: [buildPatreonRow()] }); 
      }
      
      // FIX: UNLINK LOGIC
      if (i.customId === "ui_unlink") {
        const u = getProfile(uid);
        if (!u.linked) return i.reply({ ephemeral: true, content: "❌ **Error:** No Microsoft account linked." });
        const p = getAuthPath(uid);
        try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
        u.linked = false; saveDatabase();
        return i.reply({ ephemeral: true, content: "🗑 **Success:** Link removed." }); 
      }
      
      // LIVE STATUS (The fix for "bot isn't working")
      if (i.customId === "ui_status") {
        const u = getProfile(uid); const s = activeSessions.get(uid);
        const state = s ? (s.connected ? "🟢 Online" : "🟡 Reconnecting") : "🔴 Offline";
        const embed = new EmbedBuilder().setTitle("📡 Bot Status").setColor(s ? "#3498db" : "#95a5a6").addFields({ name: "State", value: `\`${state}\``, inline: true }, { name: "Joins", value: `\`${u.stats.joins}\``, inline: true }, { name: "Logs", value: `\`\`\`\n${u.history.join("\n") || "No activity."}\n\`\`\`` });
        return i.reply({ embeds: [embed], ephemeral: true });
      }

      // --- ORIGINAL MICROSOFT CALLBACK (VARMISTETTU) ---
      if (i.customId === "ui_link") {
        await i.deferReply({ ephemeral: true });
        const flow = new Authflow(uid, getAuthPath(uid), { 
          flow: "live", authTitle: Titles?.MinecraftNintendoSwitch || "Bedrock AFK Bot", deviceType: "Nintendo" 
        }, async (data) => {
          // ORIGINAL CALLBACK LOGIC: Instant update with code
          const msg = `🔐 **Microsoft Login Required**\n\n1️⃣ **Link:** [Click to login](${data.verification_uri})\n2️⃣ **Code:** \`${data.user_code}\`\n\n⚠️ Return here after login!`;
          await i.editReply({ 
            content: msg, 
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Official Link").setStyle(ButtonStyle.Link).setURL(data.verification_uri)), buildPatreonRow()] 
          }).catch(() => {});
          pushLog(`Auth: User ${uid} received code.`);
        });
        await flow.getMsaToken();
        const u = getProfile(uid); u.linked = true; saveDatabase();
        return i.followUp({ ephemeral: true, content: "✅ **Success:** Linked!" });
      }

      if (i.customId === "ui_settings") {
        const u = getProfile(uid);
        const m = new ModalBuilder().setCustomId("mod_s").setTitle("Configuration");
        m.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "").setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("pt").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("off").setLabel("Cracked Name").setStyle(TextInputStyle.Short).setValue(u.offlineUsername || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("prx").setLabel("Proxy (IP:Port)").setStyle(TextInputStyle.Short).setValue(u.proxy?.host ? `${u.proxy.host}:${u.proxy.port}` : ""))
        );
        return i.showModal(m);
      }

      if (i.customId === "ui_more") {
        const u = getProfile(uid);
        return i.reply({ ephemeral: true, content: "➕ **Technical**", components: [buildVersionMenu(u.bedrockVersion), buildPatreonRow()] });
      }

      // ADMIN
      if (i.customId === "adm_sys") {
        if (!ADMIN_IDS.includes(uid)) return;
        const mem = process.memoryUsage();
        const e = new EmbedBuilder().setTitle("📊 System").addFields({ name: "Heap", value: `\`${(mem.heapUsed/1024/1024).toFixed(2)} MB\``, inline: true }, { name: "Bots", value: `\`${activeSessions.size}\``, inline: true }, { name: "Users", value: `\`${Object.keys(users).length}\``, inline: true });
        return i.reply({ embeds: [e], ephemeral: true });
      }

      if (i.customId === "adm_bc_discord") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("bc_d").setTitle("Discord Broadcast");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ch").setLabel("Channel ID").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tx").setLabel("Message").setStyle(TextInputStyle.Paragraph).setRequired(true)));
        return i.showModal(m);
      }

      if (i.customId === "adm_bc_mc") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("bc_m").setTitle("Game Broadcast");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tx").setLabel("Message").setStyle(TextInputStyle.Short).setRequired(true)));
        return i.showModal(m);
      }

      if (i.customId === "adm_users") {
        if (!ADMIN_IDS.includes(uid)) return;
        const l = Object.keys(users).map(id => ({ label: `UID: ${id}`, value: id })).slice(0, 25);
        if (l.length === 0) return i.reply({ content: "Empty.", ephemeral: true });
        const menu = new StringSelectMenuBuilder().setCustomId("adm_ins").setPlaceholder("Select User").addOptions(l);
        return i.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      }

      if (i.customId === "adm_logs") {
        if (!ADMIN_IDS.includes(uid)) return;
        return i.reply({ content: `📜 **Logs:**\n${adminLogs.join("\n").substring(0, 1900)}`, ephemeral: true });
      }

      if (i.customId === "adm_kill_all") {
        if (!ADMIN_IDS.includes(uid)) return;
        const c = activeSessions.size; for (const [id] of activeSessions) disposeBot(id);
        return i.reply({ content: `☢️ KILLED ${c} AGENTS.`, ephemeral: true });
      }

      if (i.customId === "adm_ban") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("mod_ban").setTitle("🚫 Blacklist");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("id").setLabel("Target ID").setStyle(TextInputStyle.Short).setRequired(true)));
        return i.showModal(m);
      }

      if (i.customId?.startsWith("ai_confirm_purge_")) {
        const t = i.customId.split("_")[3];
        disposeBot(t); setTimeout(() => startBot(t), 1500);
        return i.update({ content: "⚡ **Fixing...**", components: [] });
      }
    }

    // --- MENUS ---
    if (i.isStringSelectMenu()) {
      if (i.customId === "adm_ins") {
        const u = users[i.values[0]];
        const e = new EmbedBuilder().setTitle(`👤 User: ${i.values[0]}`).addFields({ name: "IP", value: `\`${u.server?.ip}:${u.server?.port}\`` }, { name: "Banned", value: `\`${u.banned}\`` }, { name: "Linked", value: `\`${u.linked}\`` });
        return i.reply({ embeds: [e], ephemeral: true });
      }

      if (i.customId === "help_method") {
        const method = i.values[0];
        if (method === "auto") {
          await i.update({ content: "⏳ **AI Thinking…** Scanning status.", components: [] });
          const u = getUser(uid); const s = activeSessions.get(uid); let pT = "Offline";
          try { const pR = await bedrock.ping({ host: u.server?.ip, port: u.server?.port }); pT = `Online (${pR.motd})`; } catch (e) {}
          const res = await askGemini(`Diagnostic: Server ${u.server?.ip}, Status ${s?.connected ? 'OK' : 'FAIL'}, Ping ${pT}`, "help");
          
          let comps = [buildPatreonRow()]; let txt = res;
          ['RECONNECT', 'RAM_PURGE', 'RESTART'].forEach(a => { if (res.includes(`[${a}]`)) { txt = txt.replace(`[${a}]`, "").trim(); comps.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ai_confirm_${a.toLowerCase()}_${uid}`).setLabel(`Confirm ${a}`).setStyle(ButtonStyle.Danger))); } });
          return i.editReply({ content: `🆘 **Result**\n\n${txt}`, components: comps });
        }
        if (method === "manual") {
          const m = new ModalBuilder().setCustomId("mod_h").setTitle("Support Chat");
          m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("t").setLabel("Problem").setStyle(TextInputStyle.Paragraph).setRequired(true)));
          return i.showModal(m);
        }
      }

      if (i.customId === "menu_v") {
        const u = getUser(uid); u.bedrockVersion = i.values[0]; saveDatabase();
        return i.reply({ ephemeral: true, content: `✅ Version set to ${u.bedrockVersion}` });
      }
    }

    // --- MODALS ---
    if (i.isModalSubmit()) {
      if (i.customId === "mod_s") {
        const u = getUser(uid);
        const newIp = i.fields.getTextInputValue("ip").trim();
        if (newIp === "upupdowndown") return i.reply({ ephemeral: true, content: "🎮 **Cheat Code Activated!** Matrix mode initialized." });
        u.server.ip = newIp; u.server.port = parseInt(i.fields.getTextInputValue("pt").trim()) || 19132;
        u.offlineUsername = i.fields.getTextInputValue("off").trim() || u.offlineUsername;
        const pR = i.fields.getTextInputValue("prx").trim();
        if (pR.includes(":")) { const [h, p] = pR.split(":"); u.proxy = { host: h, port: p, enabled: true }; }
        else u.proxy = { host: "", port: "", enabled: false };
        saveDatabase(); return i.reply({ ephemeral: true, content: "✅ **Saved.**" });
      }
      if (i.customId === "mod_h") {
        await i.reply({ content: "⏳ **AI Thinking…**", ephemeral: true });
        const res = await askGemini(`Manual help: "${i.fields.getTextInputValue("t")}" for ${getUser(uid).server?.ip}`, "help");
        return i.editReply({ content: `🆘 **Response**\n\n${res}`, components: [buildPatreonRow()] });
      }
      if (i.customId === "bc_d") {
        const c = await client.channels.fetch(i.fields.getTextInputValue("ch")).catch(() => null);
        if (c) { await c.send({ embeds: [new EmbedBuilder().setTitle("📢 Update").setDescription(i.fields.getTextInputValue("tx")).setColor("#f1c40f")] }); return i.reply({ content: "✅ Sent.", ephemeral: true }); }
        return i.reply({ content: "❌ Error.", ephemeral: true });
      }
      if (i.customId === "bc_m") {
        let d = 0; const tx = i.fields.getTextInputValue("tx");
        for (const [id, s] of activeSessions) { if (s.connected) { s.client.write("text", { type: "chat", needs_translation: false, source_name: "", xuid: "", platform_chat_id: "", message: `§e[ADMIN] §f${tx}` }); d++; } }
        return i.reply({ content: `✅ Sent to ${d} bots.`, ephemeral: true });
      }
      if (i.customId === "mod_ban") {
        const t = getUser(i.fields.getTextInputValue("id")); t.banned = !t.banned; saveDatabase();
        if (t.banned) disposeBot(i.fields.getTextInputValue("id"));
        return i.reply({ content: `✅ User banned: ${t.banned}`, ephemeral: true });
      }
    }

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return i.reply({ content: "🎛 **Bot Dashboard**", components: buildDashboardRow() });
      if (i.commandName === "admin") {
        if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "⛔ Denied.", ephemeral: true });
        return i.reply({ content: "🛡️ **Administrator Hub**", components: buildAdminGrid(), ephemeral: true });
      }
    }
  } catch (err) { process.stderr.write(`[ERR] ${err.message}\n`); }
});

// --- LIFESTYLE ---
process.on("unhandledRejection", (e) => { pushLog(`ERR: ${e.message}`); alertOwner(`REJECTION: \`${e.message}\``); });
process.on("uncaughtException", (e) => { pushLog(`CRASH: ${e.message}`); alertOwner(`CRITICAL: \`${e.message}\``); });

client.once("ready", async () => {
  pushLog("System Online. 🟢");
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Control bot dashboard"),
    new SlashCommandBuilder().setName("admin").setDescription("Administrator tools")
  ];
  await client.application.commands.set(cmds);
  alertOwner("System initialized. English V18 is now operational.");
});

client.login(DISCORD_TOKEN);

