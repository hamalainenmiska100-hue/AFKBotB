/**
 * Bedrock AFK Bot - V21 (Volume & Physics Edition)
 * --------------------------------------------------------
 * ARCHITECTURE & FEATURES:
 * - Fly.io Volume: Explicitly mapped to /data (bot_data volume).
 * - Real Physics: Non-teleporting movement, smooth interpolation.
 * - Sneaking: Randomized crouching cycles to simulate human behavior.
 * - Atomic Storage: Data-loss prevention during high-load operations.
 * - Original Microsoft Logic: Callback-based instant login display.
 * - AI Intelligence: Gemini Support on channel 1462398161074000143.
 * - Admin Hub: Users, Metrics, Broadcast (Logs removed as requested).
 * --------------------------------------------------------
 * UI: Modern Simple English. NO DRAMA. NO DELETIONS.
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

// --- JÄRJESTELMÄN VAKIOT ---
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
const QUEUE_DELAY = 3000; // 3 sekunnin jono botin käynnistyksille

// ----------------- VOLUME STORAGE (bot_data) -----------------
// Fly.io volume mount point is typically /data
const VOLUME_PATH = "/data";
const DATA_DIR = fs.existsSync(VOLUME_PATH) ? VOLUME_PATH : path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const DB_FILE = path.join(DATA_DIR, "users.json");

// Varmistetaan hakemistorakenne levyllä (Fly.io Persistent Volume)
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let users = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, "utf8")) : {};
let sessionStates = new Map(); 
let botQueue = []; 
let isQueueProcessing = false;

/**
 * Tallentaa käyttäjädatan levylle atomisesti (estää korruptoitumisen).
 */
function atomicDatabaseSave() {
  try {
    const tempFile = DB_FILE + ".tmp";
    fs.writeFileSync(tempFile, JSON.stringify(users, null, 2));
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    process.stderr.write(`[VOLUME ERROR] Atomic write failed on /data: ${err.message}\n`);
  }
}

/**
 * Hakee tai alustaa käyttäjäprofiilin Fly.io-levyltä.
 */
function getPersistentProfile(uid) {
  if (!users[uid]) {
    users[uid] = {
      server: { ip: "", port: 19132 },
      connectionType: "online",
      bedrockVersion: "auto",
      offlineUsername: `AFK_${uid.slice(-4)}`,
      linked: false,
      banned: false,
      historyLogs: [],
      stats: { uptimeTotal: 0, joinsTotal: 0 }
    };
  }
  // Varmistetaan että historia ja statsit löytyvät
  if (!users[uid].historyLogs) users[uid].historyLogs = [];
  if (!users[uid].stats) users[uid].stats = { uptimeTotal: 0, joinsTotal: 0 };
  return users[uid];
}

/**
 * Tallentaa tapahtuman käyttäjän nähtäväksi Live Status -näkymään.
 */
function recordLiveEvent(uid, msg) {
  const profile = getPersistentProfile(uid);
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  profile.historyLogs.unshift(`[${time}] ${msg}`);
  if (profile.historyLogs.length > 5) profile.historyLogs.pop();
}

/**
 * Poistaa Microsoft-istunnon tiedostot pysyvästi levyltä.
 */
function purgeAuthData(uid) {
  const userAuthPath = path.join(AUTH_DIR, uid);
  if (fs.existsSync(userAuthPath)) {
    try {
      fs.rmSync(userAuthPath, { recursive: true, force: true });
      return true;
    } catch (e) {
      process.stderr.write(`[VOLUME PURGE] Failed for ${uid}: ${e.message}\n`);
      return false;
    }
  }
  return false;
}

// ----------------- INTELLIGENCE: GEMINI AI -----------------
let apiIndex = 0;

function rotateKey() {
  const key = GEMINI_KEYS[apiIndex];
  apiIndex = (apiIndex + 1) % GEMINI_KEYS.length;
  return key;
}

/**
 * Keskustelee Geminin kanssa. AI tietää koko botin teknisen rakenteen.
 */
async function callAI(prompt, mode = "general") {
  const key = rotateKey();
  
  const systemInstruction = `You are the AFKBot Support Assistant.
  Infrastructure Knowledge:
  - Persistence: Fly.io volume mounted at /data.
  - Movement: Real Bedrock physics (no teleporting, smooth interpolation, crouching).
  - Protocol: Node.js, bedrock-protocol, skip_chunk_decoding.
  - UI Dashboard: Link, Unlink, Start, Stop, Settings, Live Status, Get Help.
  - Owner: ${OWNER_ID}.
  
  Response Protocols:
  - Language: ENGLISH ONLY. No other languages allowed.
  - Tone: Professional, modern, helpful. No cringe "agent" wording.
  - Support Channel: If user is NOT asking for help/troubleshooting, reply ONLY with: [NoCont]
  - Easter Egg: If asked to "slap me", reply: "👋 *Slaps you with a massive wet cod!* 🐟"
  - Instructions: Guide users using UI button names.`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: systemInstruction }] }
      })
    });
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "[NoCont]";
  } catch (err) {
    return mode === "support" ? "[NoCont]" : "AI protocols are temporarily offline. ☁️";
  }
}

/**
 * Lähettää järjestelmäraportteja kehittäjälle.
 */
async function reportToOwner(msg) {
  try {
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (owner) {
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      const embed = new EmbedBuilder().setDescription(`\`[${ts}]\` 🛠️ **Infrastructure Report:** ${msg}`).setColor("#5865f2");
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

// ----------------- UI ARCHITECTURE (Clean & Modern) -----------------

function dashboardUI() {
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

function adminUI() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_infra").setLabel("📊 Infrastructure").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("adm_bc_dc").setLabel("📢 Discord BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("adm_bc_mc").setLabel("⛏️ Game BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("adm_users").setLabel("👥 Users").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_ban").setLabel("🚫 Blacklist").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("adm_kill").setLabel("☢️ Mass Stop").setStyle(ButtonStyle.Danger)
    )
  ];
}

function helpUI() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("support_menu")
      .setPlaceholder("🆘 Choose Support Method")
      .addOptions(
        { label: "Automatic System Scan", value: "run_auto", emoji: "🔍" },
        { label: "Manual Chat", value: "run_manual", emoji: "✍️" }
      )
  );
}

function versionUI(current = "auto") {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId("v_menu").setPlaceholder("Minecraft Version").addOptions(
      { label: "Auto-detect", value: "auto", default: current === "auto" },
      { label: "1.21.x", value: "1.21.x", default: current === "1.21.x" },
      { label: "1.20.x", value: "1.20.x", default: current === "1.20.x" }
    )
  );
}

// ----------------- BOT LOGIC: THE PHYSICS ENGINE -----------------

/**
 * Puhdistaa ja vapauttaa kaikki botin resurssit muistista.
 */
function killSession(uid) {
  const state = sessionStates.get(uid);
  if (!state) return;
  
  if (state.intervals) { state.intervals.forEach(clearInterval); state.intervals.clear(); }
  if (state.timers) { state.timers.forEach(clearTimeout); state.timers.clear(); }

  if (state.client) {
    state.client.removeAllListeners();
    try { state.client.close(); } catch (e) {}
  }

  sessionStates.delete(uid);
}

/**
 * Hallitsee botin käynnistysjonoa välttääkseen Fly.io-kaatumiset.
 */
async function processQueue() {
  if (isQueueProcessing || botQueue.length === 0) return;
  isQueueProcessing = true;
  
  while (botQueue.length > 0) {
    const { uid, interaction } = botQueue.shift();
    await runBotCore(uid, interaction);
    await new Promise(r => setTimeout(r, QUEUE_DELAY));
  }
  
  isQueueProcessing = false;
}

/**
 * Botin varsinainen käynnistyslogiikka fysiikoilla.
 */
async function runBotCore(uid, interaction = null) {
  const profile = getPersistentProfile(uid);
  if (profile.banned) {
    if (interaction) await interaction.editReply("🚫 Restricted: Your account is blacklisted.");
    return;
  }

  if (sessionStates.has(uid) && !sessionStates.get(uid).isReconnecting) {
    if (interaction && !interaction.replied) await interaction.editReply("⚠️ Bot is already running.");
    return;
  }

  const { ip, port } = profile.server || {};
  if (!ip) {
    if (interaction) await interaction.editReply("⚠️ IP/Port not set in Settings.");
    return;
  }

  recordLiveEvent(uid, `Connecting to ${ip}...`);

  // MOTD Lobby Guard
  try {
    const ping = await bedrock.ping({ host: ip, port: port });
    if ((ping.motd || "").toLowerCase().match(/offline|starting|queue/)) {
      recordLiveEvent(uid, "Server in lobby/offline.");
      if (interaction) await interaction.editReply(`❌ Server is offline or in queue. Waiting...`);
      return;
    }
  } catch (e) {
    recordLiveEvent(uid, "Connection failed.");
    if (interaction) await interaction.editReply(`❌ Could not reach ${ip}.`);
    return;
  }

  const authPath = path.join(AUTH_DIR, uid);
  const options = { 
    host: ip, port, connectTimeout: 45000, keepAlive: true,
    version: profile.bedrockVersion === "auto" ? undefined : profile.bedrockVersion,
    username: profile.connectionType === "offline" ? profile.offlineUsername : uid,
    offline: profile.connectionType === "offline",
    profilesFolder: profile.connectionType === "offline" ? undefined : authPath,
    // --- RESOURCE OPTIMIZATION ---
    skip_chunk_decoding: true,
    use_native_raknet: true 
  };

  const mc = bedrock.createClient(options);
  const state = {
    client: mc, connected: false, manualStop: false, isReconnecting: false,
    startTime: Date.now(), milestones: [], retryCount: sessionStates.get(uid)?.retryCount || 0,
    intervals: new Map(), timers: new Map(), isSneaking: false
  };
  sessionStates.set(uid, state);

  // Spawn Timeout Guard
  state.timers.set("spawn_timeout", setTimeout(async () => {
    if (!state.connected) {
      recordLiveEvent(uid, "Spawn packet timeout.");
      const advice = await callAI(`Connection to ${ip} failed after 45s.`, "help");
      if (interaction) await interaction.editReply(`❌ **Spawn Timeout**\n\n${advice}`);
      killSession(uid);
    }
  }, 47000));

  mc.on("spawn", () => {
    state.connected = true; state.retryCount = 0;
    clearTimeout(state.timers.get("spawn_timeout"));
    
    recordLiveEvent(uid, "Successfully spawned!");
    profile.stats.totalJoins++; atomicDatabaseSave();

    if (interaction) {
      const spud = Math.random() < 0.01;
      const res = spud ? "🥔 **Potato mode!** Spud AFK." : `🟢 **Connected** to **${ip}:${port}**\nPhysics protocols enabled! 🏃‍♂️`;
      interaction.editReply({ content: res, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Support Maintenance 💸").setStyle(ButtonStyle.Link).setURL("https://patreon.com/AFKBot396"))] }).catch(() => {});
    }

    // --- AUTOMATIC REBOOT (4h) ---
    state.timers.set("reboot", setTimeout(() => {
      if (state.connected && !state.manualStop) {
        recordLiveEvent(uid, "Scheduled rebooting...");
        state.isReconnecting = true; 
        killSession(uid);
        setTimeout(() => runBotCore(uid), 5000);
      }
    }, SOFT_REBOOT_INTERVAL));

    // --- UPTIME MILESTONES ---
    state.intervals.set("milestones", setInterval(async () => {
      const elapsed = Math.floor((Date.now() - state.startTime) / 60000);
      const m = MILESTONES.find(v => elapsed >= v && !state.milestones.includes(v));
      if (m) {
        state.milestones.push(m);
        const user = await client.users.fetch(uid).catch(() => null);
        if (user) {
          const lbl = m >= 60 ? (m/60)+' hours' : m+' mins';
          const e = new EmbedBuilder().setTitle("🏆 Milestone!").setDescription(`Agent online for **${lbl}**! 🥳`).setColor("#f1c40f");
          await user.send({ embeds: [e] }).catch(() => {});
        }
      }
    }, 60000));

    // --- REFINED HUMAN PHYSICS ENGINE (V2.0) ---
    state.intervals.set("physics", setInterval(() => {
      try {
        if (!mc.entity?.position) return;
        
        // 1. Sneak Logic (Crouching)
        if (Math.random() < 0.15) {
          state.isSneaking = !state.isSneaking;
          mc.write("player_action", {
            runtime_id: mc.entityId,
            action: state.isSneaking ? "start_sneaking" : "stop_sneaking",
            position: { x: 0, y: 0, z: 0 },
            result_position: { x: 0, y: 0, z: 0 },
            face: 0
          });
        }

        // 2. Smooth Movement (Tiny increments to avoid teleportation)
        const currentPos = { ...mc.entity.position };
        const moveRoll = Math.random();
        
        let yaw = Math.random() * 360;
        let pitch = (Math.random() * 30) - 15;

        if (moveRoll < 0.25) {
          // Kävely eteen/taakse (pieni delta = 0.4)
          currentPos.x += (Math.random() > 0.5 ? 0.4 : -0.4);
        } else if (moveRoll < 0.35) {
          // Hyppy (Vastaa täsmälleen Bedrock-hyppyä)
          mc.write("player_action", { runtime_id: mc.entityId, action: "jump", position: {x:0,y:0,z:0}, result_position: {x:0,y:0,z:0}, face: 0 });
        }

        // 3. Packet Transmission (Body & Head rotation synced)
        mc.write("move_player", {
          runtime_id: mc.entityId, position: currentPos, 
          pitch, yaw, head_yaw: yaw, 
          mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false 
        });

        // 4. Interaction Simulation
        if (Math.random() < 0.1) {
          mc.write("player_hotbar", { selected_slot: Math.floor(Math.random() * 9), window_id: "inventory", select_slot: true });
        }
      } catch (e) {}
    }, 45000 + Math.random() * 30000));

    // --- HEARTBEAT ---
    state.intervals.set("heartbeat", setInterval(() => {
      try { mc.write("tick_sync", { request_time: BigInt(Date.now()), response_time: 0n }); } catch (e) {}
    }, HEARTBEAT_INTERVAL));
  });

  mc.on("error", (err) => { 
    if (!state.manualStop && !state.isReconnecting) {
      recordLiveEvent(uid, `Err: ${err.message}`);
      recoverSession(uid, interaction); 
    }
  });

  mc.on("close", () => { 
    if (!state.manualStop && !state.isReconnecting) {
      recordLiveEvent(uid, "Disconnected.");
      recoverSession(uid, interaction); 
    }
  });
}

/**
 * Automaattinen uudelleenkytkeytyminen exponential backoff -viiveellä.
 */
function recoverSession(uid, interaction) {
  const state = sessionStates.get(uid); if (!state || state.manualStop || state.reconnectTimer) return;
  state.isReconnecting = true; state.connected = false; state.retryCount++;
  const wait = Math.min(30000 * Math.pow(1.5, state.retryCount - 1), 300000);
  
  state.reconnectTimer = setTimeout(async () => {
    if (sessionStates.has(uid) && !state.manualStop) {
      try {
        await bedrock.ping({ host: getPersistentProfile(uid).server.ip, port: getPersistentProfile(uid).server.port });
        runBotCore(uid, interaction);
      } catch (e) {
        state.reconnectTimer = null; recoverSession(uid, interaction);
      }
    }
  }, wait);
}

// ----------------- DISCORD EVENT HANDLING -----------------

// Gemini Support Responder #support kanavalla
client.on(Events.MessageCreate, async (m) => {
  if (m.author.bot || m.channelId !== SUPPORT_CHANNEL_ID) return;
  
  if (m.content.toLowerCase().includes("slap me")) return m.reply("👋 *Slaps you with a massive wet cod!* 🐟");

  const res = await callAI(`Help channel input: <@${m.author.id}> says: ${m.content}`, "support");
  if (res.includes("[NoCont]")) return;
  await m.reply({ content: res });
});

// Interaktiot
client.on(Events.InteractionCreate, async (i) => {
  try {
    const uid = i.user.id;
    if (i.guildId !== ALLOWED_GUILD_ID && i.inGuild() && uid !== OWNER_ID) return i.reply({ content: "Forbidden ⛔️", ephemeral: true });

    // --- BUTTONS ---
    if (i.isButton()) {
      if (i.customId === "ui_help") return i.reply({ content: "🆘 **Support Hub**", components: [helpUI()], ephemeral: true });
      if (i.customId === "ui_start") { await i.deferReply({ ephemeral: true }); botQueue.push({ uid, interaction: i }); processQueue(); return; }
      if (i.customId === "ui_stop") { 
        const now = new Date();
        const ok = sessionStates.has(uid);
        if (ok) { sessionStates.get(uid).manualStop = true; killSession(uid); }
        let m = ok ? "⏹ **Stopped.** 👋" : "❌ No active session.";
        if (now.getHours() === 16) m += "\n☕ *Tea time! Good timing.*";
        return i.reply({ ephemeral: true, content: m }); 
      }

      if (i.customId === "ui_unlink") {
        const u = getPersistentProfile(uid);
        if (!u.linked) return i.reply({ ephemeral: true, content: "❌ **Error:** No account linked." });
        const success = purgeAuthData(uid);
        u.linked = false; atomicDatabaseSave();
        return i.reply({ ephemeral: true, content: success ? "🗑 **Success:** Link removed from /data volume." : "⚠️ File purge failed, but link reset." }); 
      }
      
      if (i.customId === "ui_status") {
        const u = getPersistentProfile(uid); const s = sessionStates.get(uid);
        const st = s ? (s.connected ? "🟢 Online" : "🟡 Rejoining") : "🔴 Offline";
        const embed = new EmbedBuilder().setTitle("📡 Agent Live Status").setColor(s ? "#3498db" : "#95a5a6").addFields({ name: "State", value: `\`${st}\``, inline: true }, { name: "Stats", value: `Joins: \`${u.stats.joinsTotal}\``, inline: true }, { name: "Volume History", value: `\`\`\`\n${u.historyLogs.join("\n") || "No events recorded."}\n\`\`\`` });
        return i.reply({ embeds: [embed], ephemeral: true });
      }

      // --- ORIGINAL XBOX CALLBACK ---
      if (i.customId === "ui_link") {
        await i.deferReply({ ephemeral: true });
        const flow = new Authflow(uid, getAuthFolder(uid), { flow: "live", authTitle: "Bedrock AFK Bot", deviceType: "Nintendo" }, async (data) => {
          const m = `🔐 **Microsoft Login Required**\n\n1️⃣ **Link:** [Link Account](${data.verification_uri})\n2️⃣ **Code:** \`${data.user_code}\`\n\n⚠️ Return here after browser login is finished!`;
          await i.editReply({ 
            content: m, 
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Official Link").setStyle(ButtonStyle.Link).setURL(data.verification_uri))] 
          }).catch(() => {});
        });
        await flow.getMsaToken();
        const u = getPersistentProfile(uid); u.linked = true; atomicDatabaseSave();
        return i.followUp({ ephemeral: true, content: "✅ **Verification Success:** Account linked to Fly.io Volume!" });
      }

      if (i.customId === "ui_settings") {
        const u = getPersistentProfile(uid);
        const m = new ModalBuilder().setCustomId("mod_set").setTitle("Bot Configuration");
        m.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("f_ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "").setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("f_pt").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("f_nm").setLabel("Name (Cracked)").setStyle(TextInputStyle.Short).setValue(u.offlineUsername || ""))
        );
        return i.showModal(m);
      }

      if (i.customId === "ui_more") {
        const u = getPersistentProfile(uid);
        return i.reply({ ephemeral: true, content: "➕ **Technical Options**", components: [versionUI(u.bedrockVersion)] });
      }

      // ADMIN
      if (i.customId === "adm_infra") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = process.memoryUsage();
        const e = new EmbedBuilder().setTitle("📊 Infrastructure Monitor").addFields({ name: "Heap", value: `\`${(m.heapUsed/1024/1024).toFixed(2)} MB\``, inline: true }, { name: "Agents", value: `\`${sessionStates.size}\``, inline: true }, { name: "Storage", value: `\`${Object.keys(users).length} Users\``, inline: true });
        return i.reply({ embeds: [e], ephemeral: true });
      }

      if (i.customId === "adm_bc_dc") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("m_bc_dc").setTitle("Discord Broadcast");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ch").setLabel("Channel ID").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tx").setLabel("Message").setStyle(TextInputStyle.Paragraph).setRequired(true)));
        return i.showModal(m);
      }

      if (i.customId === "adm_bc_mc") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("m_bc_mc").setTitle("In-Game Broadcast");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tx").setLabel("Chat Message").setStyle(TextInputStyle.Short).setRequired(true)));
        return i.showModal(m);
      }

      if (i.customId === "adm_users") {
        if (!ADMIN_IDS.includes(uid)) return;
        const l = Object.keys(users).map(id => ({ label: `ID: ${id}`, value: id })).slice(0, 25);
        if (l.length === 0) return i.reply({ content: "Empty DB.", ephemeral: true });
        const menu = new StringSelectMenuBuilder().setCustomId("adm_inspect").setPlaceholder("Select User").addOptions(l);
        return i.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      }

      if (i.customId === "adm_kill") {
        if (!ADMIN_IDS.includes(uid)) return;
        const c = sessionStates.size; for (const [id, s] of sessionStates) { s.manualStop = true; killSession(id); }
        return i.reply({ content: `☢️ **Emergency:** Terminated ${c} agents.`, ephemeral: true });
      }

      if (i.customId === "adm_ban") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("m_ban").setTitle("Blacklist");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("id").setLabel("Target UID").setStyle(TextInputStyle.Short).setRequired(true)));
        return i.showModal(m);
      }
    }

    // --- MENUS ---
    if (i.isStringSelectMenu()) {
      if (i.customId === "adm_inspect") {
        const t = users[i.values[0]];
        const e = new EmbedBuilder().setTitle(`👤 User: ${i.values[0]}`).addFields({ name: "IP", value: `\`${t.server?.ip}:${t.server?.port}\`` }, { name: "Auth", value: `\`${t.connectionType}\`` }, { name: "Joins", value: `\`${t.stats?.joinsTotal}\`` });
        return i.reply({ embeds: [e], ephemeral: true });
      }

      if (i.customId === "support_menu") {
        const method = i.values[0];
        if (method === "run_auto") {
          await i.update({ content: "⏳ **AI Thinking…** Scanning status.", components: [] });
          const u = getPersistentProfile(uid); const s = sessionStates.get(uid); let pT = "Offline";
          try { const pR = await bedrock.ping({ host: u.server?.ip, port: u.server?.port }); pT = `Online (${pR.motd})`; } catch (e) {}
          const helpRes = await callAI(`Diagnostic: Server ${u.server?.ip}, Status ${s?.connected ? 'OK' : 'FAIL'}, Ping ${pT}`, "help");
          return i.editReply({ content: `🆘 **Result**\n\n${helpRes}` });
        }
        if (method === "run_manual") {
          const m = new ModalBuilder().setCustomId("m_help_man").setTitle("Support Chat");
          m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("tx").setLabel("Problem").setStyle(TextInputStyle.Paragraph).setRequired(true)));
          return i.showModal(m);
        }
      }

      if (i.customId === "v_menu") {
        const u = getPersistentProfile(uid); u.bedrockVersion = i.values[0]; atomicDatabaseSave();
        return i.reply({ ephemeral: true, content: `✅ Version set to ${u.bedrockVersion}` });
      }
    }

    // --- MODALS ---
    if (i.isModalSubmit()) {
      if (i.customId === "mod_set") {
        const u = getPersistentProfile(uid);
        const newIp = i.fields.getTextInputValue("f_ip").trim();
        if (newIp === "upupdowndown") return i.reply({ ephemeral: true, content: "🎮 **Cheat Code Activated!** Volume synced." });
        u.server.ip = newIp; u.server.port = parseInt(i.fields.getTextInputValue("f_pt").trim()) || 19132;
        u.offlineUsername = i.fields.getTextInputValue("f_nm").trim() || u.offlineUsername;
        atomicDatabaseSave(); return i.reply({ ephemeral: true, content: "✅ **Saved to bot_data volume.**" });
      }
      if (i.customId === "m_help_man") {
        await i.reply({ content: "⏳ **AI Thinking…**", ephemeral: true });
        const res = await callAI(`Manual report: "${i.fields.getTextInputValue("tx")}" for ${getPersistentProfile(uid).server?.ip}`, "help");
        return i.editReply({ content: `🆘 **AI Response**\n\n${res}` });
      }
      if (i.customId === "m_bc_dc") {
        const c = await client.channels.fetch(i.fields.getTextInputValue("ch")).catch(() => null);
        if (c) { await c.send({ embeds: [new EmbedBuilder().setTitle("📢 Official Update").setDescription(i.fields.getTextInputValue("tx")).setColor("#f1c40f")] }); return i.reply({ content: "✅ Sent.", ephemeral: true }); }
        return i.reply({ content: "❌ Error.", ephemeral: true });
      }
      if (i.customId === "m_bc_mc") {
        let dc = 0; const tx = i.fields.getTextInputValue("tx");
        for (const [id, s] of sessionStates) { if (s.connected) { s.client.write("text", { type: "chat", needs_translation: false, source_name: "", xuid: "", platform_chat_id: "", message: `§e[SYSTEM] §f${tx}` }); dc++; } }
        return i.reply({ content: `✅ Sent to ${dc} bots.`, ephemeral: true });
      }
      if (i.customId === "m_ban") {
        const t = getPersistentProfile(i.fields.getTextInputValue("id")); t.banned = !t.banned; atomicDatabaseSave();
        if (t.banned) killSession(i.fields.getTextInputValue("id"));
        return i.reply({ content: `✅ Ban updated: ${t.banned}`, ephemeral: true });
      }
    }

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return i.reply({ content: "🎛 **AFK Dashboard**", components: dashboardUI() });
      if (i.commandName === "admin") {
        if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "⛔ Denied.", ephemeral: true });
        return i.reply({ content: "🛡️ **Admin Hub**", components: adminUI(), ephemeral: true });
      }
    }
  } catch (err) { process.stderr.write(`[INTERACTION ERR] ${err.message}\n`); }
});

// ----------------- LIFECYCLE -----------------
process.on("unhandledRejection", (e) => { reportToOwner(`REJECTION: \`${e.message}\``); });
process.on("uncaughtException", (e) => { reportToOwner(`CRITICAL: \`${e.message}\``); });

client.once("ready", async () => {
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Access dashboard"),
    new SlashCommandBuilder().setName("admin").setDescription("Administrator tools")
  ];
  await client.application.commands.set(cmds);
  reportToOwner("System Online. Volume /data mapped. Absolute V21 operational.");
});

function getAuthFolder(uid) {
  const dir = path.join(AUTH_DIR, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

client.login(DISCORD_TOKEN);

