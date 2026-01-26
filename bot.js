/**
 * Bedrock AFK Bot - V23 (Ultimate Absolute Architecture) 🛡️
 * ----------------------------------------------------------------------
 * TÄMÄ ON TÄYDELLINEN KOODI. EI TIIVISTYKSIÄ. EI POISTOJA.
 * * CORE SYSTEMS:
 * - Original Microsoft Callback: Instant code/link display (Authflow).
 * - Advanced Physics Engine: Smooth incremental walking, jumping, crouching.
 * - Stability Sentinel: Atomic I/O, Listener Guard, Startup Queuing.
 * - AI Integration: Gemini Support (Channel: 1462398161074000143).
 * - Admin Hub: User Search, Metrics, In-game & Discord Broadcasts.
 * - Live Status: Real-time user logs for troubleshooting.
 * - Easter Eggs: Konami (upupdowndown), Potato, Slap, Tea Time.
 * ----------------------------------------------------------------------
 * UI: Modern Simple English | Comments: Finnish (Suomi)
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
const SOFT_REBOOT_INTERVAL = 4 * 60 * 60 * 1000; // 4h automaattinen restart
const HEARTBEAT_INTERVAL = 25000; // 25s keep-alive
const QUEUE_DELAY = 3500; // Viive jonossa olevien bottien välillä

// ----------------- TALLENNUSJÄRJESTELMÄ (PERSISTENCE) -----------------
// Käytetään fly.io:n /data -polkua hiljaisesti
const BASE_DATA = "/data";
const DATA_FOLDER = fs.existsSync(BASE_DATA) ? BASE_DATA : path.join(__dirname, "data");
const AUTH_FOLDER = path.join(DATA_FOLDER, "auth");
const USER_DATABASE = path.join(DATA_FOLDER, "users.json");

// Luodaan tarvittavat kansiot levyasemaan
if (!fs.existsSync(DATA_FOLDER)) fs.mkdirSync(DATA_FOLDER, { recursive: true });
if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

// Ladataan käyttäjädata muistiin
let users = fs.existsSync(USER_DATABASE) ? JSON.parse(fs.readFileSync(USER_DATABASE, "utf8")) : {};
let activeSessions = new Map(); // Aktiiviset botit ja niiden tilat
let startupQueue = []; // Jono botteja varten
let queueRunning = false;

/**
 * Tallentaa käyttäjätiedot levylle atomisesti (estää korruptoitumisen).
 */
function atomicStore() {
  try {
    const tempFile = USER_DATABASE + ".tmp";
    fs.writeFileSync(tempFile, JSON.stringify(users, null, 2));
    fs.renameSync(tempFile, USER_DATABASE);
  } catch (err) {
    process.stderr.write(`[System Error] Storage sync failed: ${err.message}\n`);
  }
}

/**
 * Hakee käyttäjäprofiilin tai luo uuden vakiomuodossa.
 */
function getProfile(uid) {
  if (!users[uid]) {
    users[uid] = {
      server: { ip: "", port: 19132 },
      connectionType: "online",
      bedrockVersion: "auto",
      offlineUsername: `AFK_${uid.slice(-4)}`,
      linked: false,
      banned: false,
      history: [],
      stats: { joins: 0, uptimeMinutes: 0 }
    };
  }
  if (!users[uid].history) users[uid].history = [];
  if (!users[uid].stats) users[uid].stats = { joins: 0, uptimeMinutes: 0 };
  return users[uid];
}

/**
 * Tallentaa tapahtuman botin sisäiseen lokiin käyttäjän nähtäväksi.
 */
function logEvent(uid, msg) {
  const u = getProfile(uid);
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  u.history.unshift(`[${timestamp}] ${msg}`);
  if (u.history.length > 6) u.history.pop();
}

/**
 * Poistaa kirjautumistiedot levyltä.
 */
function clearIdentity(uid) {
  const userPath = path.join(AUTH_FOLDER, uid);
  if (fs.existsSync(userPath)) {
    try {
      fs.rmSync(userPath, { recursive: true, force: true });
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
}

// ----------------- TEKOÄLY (DUAL-ENGINE GEMINI) -----------------
let keyIdx = 0;

function rotateKey() {
  const k = GEMINI_KEYS[keyIdx];
  keyIdx = (keyIdx + 1) % GEMINI_KEYS.length;
  return k;
}

/**
 * Keskustelee Geminin kanssa. AI tietää koko järjestelmän rakenteen.
 */
async function callAI(prompt, mode = "general") {
  const key = rotateKey();
  
  const systemInstruction = `You are the AFKBot Intelligence.
  You are an expert in helping players with their Minecraft Bedrock bot.
  
  System Info:
  - Tech: Node.js, bedrock-protocol (Smooth Physics), prismarine-auth.
  - UI: Link (Login), Unlink (Logout), Start, Stop, Settings, Status.
  - Logic: 4h reboot cycles, heartbeat packets, exponential rejoin logic.
  - Movement: High-fidelity physics simulation (walking, jumping, crouching).
  - Owner: ${OWNER_ID}.
  
  Behavior Rules:
  - Language: ENGLISH ONLY. No Finnish or other languages in responses.
  - Support Channel: If a user is NOT asking for help/troubleshooting, reply strictly with: [NoCont]
  - Simple & Professional: No dramatic "agent" talk. Be helpful and direct.
  - Easter Egg: If asked to "slap me", reply: "👋 *Slaps you with a massive wet cod!* 🐟"`;

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
    return mode === "support" ? "[NoCont]" : "The AI module is temporarily recalibrating. ☁️";
  }
}

/**
 * Lähettää kriittiset ilmoitukset omistajalle.
 */
async function alertOwner(msg) {
  try {
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (owner) {
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      const embed = new EmbedBuilder().setDescription(`\`[${ts}]\` 📡 **Core Status:** ${msg}`).setColor("#00f7ff");
      await owner.send({ embeds: [embed] }).catch(() => {});
    }
  } catch (e) {}
}

// ----------------- DISCORD CLIENT JA INTENTS -----------------
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

// ----------------- UI KOMPONENTIT (MODERN & CLEAN) -----------------

function buildMainUI() {
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

function buildAdminUI() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_metrics").setLabel("📊 Metrics").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("adm_bc_discord").setLabel("📢 Discord BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("adm_bc_mc").setLabel("⛏️ Game BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("adm_users").setLabel("👥 User Search").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_ban").setLabel("🚫 Blacklist").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("adm_kill_all").setLabel("☢️ Mass Kill").setStyle(ButtonStyle.Danger)
    )
  ];
}

function buildSupportUI() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("support_selector")
      .setPlaceholder("🆘 Assistance Required")
      .addOptions(
        { label: "Automatic Diagnostic", value: "opt_auto", emoji: "🔍", description: "AI scans your bot session and server." },
        { label: "Manual Chat", value: "opt_manual", emoji: "✍️", description: "Describe your issue directly to the AI." }
      )
  );
}

function buildVersionUI(current = "auto") {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId("menu_v").setPlaceholder("Minecraft Version").addOptions(
      { label: "Auto-detect (Stable)", value: "auto", default: current === "auto" },
      { label: "1.21.x", value: "1.21.x", default: current === "1.21.x" },
      { label: "1.20.x", value: "1.20.x", default: current === "1.20.x" }
    )
  );
}

// ----------------- BOT LOGIIKKA: THE PHYSICS ENGINE -----------------

/**
 * Puhdistaa ja vapauttaa botin resurssit täydellisesti.
 */
function terminateSession(uid) {
  const state = activeSessions.get(uid);
  if (!state) return;
  
  if (state.intervals) state.intervals.forEach(clearInterval);
  if (state.timers) state.timers.forEach(clearTimeout);

  if (state.client) {
    state.client.removeAllListeners();
    try { state.client.close(); } catch (e) {}
  }

  activeSessions.delete(uid);
}

/**
 * Hallitsee käynnistysjonoa vakauden varmistamiseksi.
 */
async function processQueue() {
  if (queueRunning || startupQueue.length === 0) return;
  queueRunning = true;
  
  while (startupQueue.length > 0) {
    const { uid, interaction } = startupQueue.shift();
    await executeBotStart(uid, interaction);
    await new Promise(r => setTimeout(r, QUEUE_DELAY));
  }
  
  queueRunning = false;
}

/**
 * Botin käynnistys fysiikoilla, kyykkäämisellä ja stabiliteetti-suojauksilla.
 */
async function executeBotStart(uid, interaction = null) {
  const profile = getProfile(uid);
  if (profile.banned) {
    if (interaction) await interaction.editReply("🚫 Access denied: Your account is on the blacklist.");
    return;
  }

  // Estetään päällekkäisyys
  if (activeSessions.has(uid) && !activeSessions.get(uid).isReconnecting) {
    if (interaction && !interaction.replied) await interaction.editReply("⚠️ Bot is already running! Stop it before restarting.");
    return;
  }

  const { ip, port } = profile.server || {};
  if (!ip) {
    if (interaction) await interaction.editReply("⚠️ IP and Port not configured in **Settings**.");
    return;
  }

  logEvent(uid, `Connecting to ${ip}...`);

  // MOTD Lobby Guard
  try {
    const ping = await bedrock.ping({ host: ip, port: port });
    const motdLower = (ping.motd || "").toLowerCase();
    if (motdLower.includes("offline") || motdLower.includes("starting") || motdLower.includes("queue")) {
      logEvent(uid, "Server offline/lobby.");
      if (interaction) await interaction.editReply(`❌ The server is currently offline or in a lobby queue. Join blocked.`);
      return;
    }
  } catch (e) {
    logEvent(uid, "Connection failed.");
    if (interaction) await interaction.editReply(`❌ Could not reach ${ip}. Make sure it is online.`);
    return;
  }

  const authDir = path.join(AUTH_FOLDER, uid);
  const protocolOptions = { 
    host: ip, port, connectTimeout: 45000, keepAlive: true,
    version: profile.bedrockVersion === "auto" ? undefined : profile.bedrockVersion,
    username: profile.connectionType === "offline" ? profile.offlineUsername : uid,
    offline: profile.connectionType === "offline",
    profilesFolder: profile.connectionType === "offline" ? undefined : authDir,
    // --- RESOURCE OPTIMIZATION ---
    skip_chunk_decoding: true,
    use_native_raknet: true 
  };

  const mc = bedrock.createClient(protocolOptions);
  const state = {
    client: mc, connected: false, manualStop: false, isReconnecting: false,
    startTime: Date.now(), milestones: [], retryCount: activeSessions.get(uid)?.retryCount || 0,
    intervals: new Map(), timers: new Map(), isSneaking: false
  };
  activeSessions.set(uid, state);

  // Connection Timeout Guard
  state.timers.set("timeout", setTimeout(async () => {
    if (!state.connected) {
      logEvent(uid, "Spawn packet timeout.");
      const advice = await callAI(`Join timeout for ${ip}:${port}. User: ${uid}`, "help");
      if (interaction) await interaction.editReply(`❌ **Spawn Timeout**\n\n${advice}`);
      terminateSession(uid);
    }
  }, 47000));

  mc.on("spawn", () => {
    state.connected = true; state.retryCount = 0;
    clearTimeout(state.timers.get("timeout"));
    
    logEvent(uid, "Successfully spawned!");
    profile.stats.joins++; atomicStore();

    if (interaction) {
      const spudLuck = Math.random() < 0.01;
      const response = spudLuck ? "🥔 **Potato mode!** Your AFK spud is online." : `🟢 **Connected** to **${ip}:${port}**\nPhysics-based simulation active! 🏃‍♂️`;
      interaction.editReply({ content: response, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Support Maintenance 💸").setStyle(ButtonStyle.Link).setURL("https://patreon.com/AFKBot396"))] }).catch(() => {});
    }

    // --- REBOOT CYCLE (4h) ---
    state.timers.set("reboot", setTimeout(() => {
      if (state.connected && !state.manualStop) {
        logEvent(uid, "Routine system reboot...");
        state.isReconnecting = true; terminateSession(uid);
        setTimeout(() => executeBotStart(uid), 5000);
      }
    }, SOFT_REBOOT_INTERVAL));

    // --- UPTIME MILESTONES ---
    state.intervals.set("uptime", setInterval(async () => {
      const elapsed = Math.floor((Date.now() - state.startTime) / 60000);
      const milestone = MILESTONES.find(v => elapsed >= v && !state.milestones.includes(v));
      if (milestone) {
        state.milestones.push(milestone);
        const discordUser = await client.users.fetch(uid).catch(() => null);
        if (discordUser) {
          const timeLabel = milestone >= 60 ? (milestone/60)+' hours' : milestone+' mins';
          const embed = new EmbedBuilder().setTitle("🏆 Online Success!").setDescription(`Your bot has been up for **${timeLabel}**! 🥳`).setColor("#f1c40f");
          await discordUser.send({ embeds: [embed] }).catch(() => {});
        }
      }
    }, 60000));

    // --- ADVANCED HUMAN PHYSICS ENGINE (V3.0) ---
    state.intervals.set("physics", setInterval(() => {
      try {
        if (!mc.entity?.position) return;
        
        // 1. Sneak Logic (Random Crouching)
        if (Math.random() < 0.12) {
          state.isSneaking = !state.isSneaking;
          mc.write("player_action", {
            runtime_id: mc.entityId,
            action: state.isSneaking ? "start_sneaking" : "stop_sneaking",
            position: { x: 0, y: 0, z: 0 },
            result_position: { x: 0, y: 0, z: 0 },
            face: 0
          });
        }

        // 2. Smooth Movement Simulation (No Teleporting)
        const pos = { ...mc.entity.position };
        const roll = Math.random();
        let yaw = Math.random() * 360;
        let pitch = (Math.random() * 26) - 13;

        // Botti kulkee askeleita (walk simulation)
        if (roll < 0.25) {
          // Siirtymä askeleina (delta 0.45)
          pos.x += (Math.random() > 0.5 ? 0.45 : -0.45);
        } else if (roll < 0.35) {
          // Hyppy-paketti
          mc.write("player_action", { runtime_id: mc.entityId, action: "jump", position: {x:0,y:0,z:0}, result_position: {x:0,y:0,z:0}, face: 0 });
        }

        // 3. Move Packet (Synchronized Head/Body)
        mc.write("move_player", {
          runtime_id: mc.entityId, position: pos, 
          pitch, yaw, head_yaw: yaw, 
          mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false 
        });

        // 4. Hotbar shuffling (Active interaction)
        if (Math.random() < 0.1) {
          mc.write("player_hotbar", { selected_slot: Math.floor(Math.random() * 9), window_id: "inventory", select_slot: true });
        }
      } catch (e) {}
    }, 48000 + Math.random() * 28000));

    // --- HEARTBEAT ---
    state.intervals.set("heartbeat", setInterval(() => {
      try { mc.write("tick_sync", { request_time: BigInt(Date.now()), response_time: 0n }); } catch (e) {}
    }, HEARTBEAT_INTERVAL));

    // --- RAM & HEALTH MONITOR ---
    state.intervals.set("health", setInterval(async () => {
      const ram = process.memoryUsage().heapUsed / 1024 / 1024;
      if (ram > 490) {
        const advice = await callAI(`RAM high (${ram.toFixed(1)}MB). User ${uid}. Suggest purge?`);
        const discordUser = await client.users.fetch(uid).catch(() => null);
        if (discordUser && advice.includes("[RAM_PURGE]")) {
           const clean = advice.replace("[RAM_PURGE]", "").trim();
           const embed = new EmbedBuilder().setTitle("🛡️ Stability Guard").setDescription(`**Support:** Resource cleanup suggested.\n\n${clean}`).setColor("#e74c3c");
           await discordUser.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ai_purge_fix_${uid}`).setLabel("Optimize Now").setStyle(ButtonStyle.Danger))] }).catch(() => {});
        }
      }
    }, 300000));
  });

  mc.on("error", (err) => { 
    if (!state.manualStop && !state.isReconnecting) {
      logEvent(uid, `Err: ${err.message}`);
      triggerRecovery(uid, interaction); 
    }
  });

  mc.on("close", () => { 
    if (!state.manualStop && !state.isReconnecting) {
      logEvent(uid, "Disconnected.");
      triggerRecovery(uid, interaction); 
    }
  });
}

function triggerRecovery(uid, interaction) {
  const s = activeSessions.get(uid); if (!s || s.manualStop || s.reconnectTimer) return;
  s.isReconnecting = true; s.connected = false; s.retryCount++;
  const wait = Math.min(30000 * Math.pow(1.5, s.retryCount - 1), 300000);
  
  s.reconnectTimer = setTimeout(async () => {
    if (activeSessions.has(uid) && !s.manualStop) {
      try {
        await bedrock.ping({ host: getProfile(uid).server.ip, port: getProfile(uid).server.port });
        executeBotStart(uid, interaction);
      } catch (e) {
        s.reconnectTimer = null; triggerRecovery(uid, interaction);
      }
    }
  }, wait);
}

// ----------------- TAPAHTUMAKÄSITTELIJÄT (DISCORD) -----------------

// Gemini Support Responder #support kanavalla
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot || msg.channelId !== SUPPORT_CHANNEL_ID) return;
  
  // Easter Egg: Slap
  if (msg.content.toLowerCase().includes("slap me")) return msg.reply("👋 *Slaps you with a massive wet cod!* 🐟");

  const res = await callAI(`Help input: <@${msg.author.id}> says: ${msg.content}`, "support");
  if (res.includes("[NoCont]")) return;
  await msg.reply({ content: res });
});

// Interaktiot (Dashboard, Admin, Modals)
client.on(Events.InteractionCreate, async (i) => {
  try {
    const uid = i.user.id;
    if (i.guildId !== ALLOWED_GUILD_ID && i.inGuild() && uid !== OWNER_ID) return i.reply({ content: "Restricted Access ⛔️", ephemeral: true });

    // --- PAINIKKEET (BUTTONS) ---
    if (i.isButton()) {
      if (i.customId === "ui_help") return i.reply({ content: "🆘 **Support Center**", components: [buildSupportUI()], ephemeral: true });
      if (i.customId === "ui_start") { await i.deferReply({ ephemeral: true }); startupQueue.push({ uid, interaction: i }); processQueue(); return; }
      if (i.customId === "ui_stop") { 
        const active = activeSessions.has(uid);
        if (active) { activeSessions.get(uid).manualStop = true; terminateSession(uid); }
        let msg = active ? "⏹ **Stopped.** Have a great day! 👋" : "❌ No active session.";
        if (new Date().getHours() === 16) msg += "\n☕ *Tea time! Good timing.*";
        return i.reply({ ephemeral: true, content: msg }); 
      }

      if (i.customId === "ui_unlink") {
        const u = getProfile(uid);
        if (!u.linked) return i.reply({ ephemeral: true, content: "❌ **Error:** No account is currently linked." });
        clearIdentity(uid); u.linked = false; atomicStore();
        return i.reply({ ephemeral: true, content: "🗑 **Success:** Login link removed." }); 
      }
      
      if (i.customId === "ui_status") {
        const u = getProfile(uid); const s = activeSessions.get(uid);
        const stateStr = s ? (s.connected ? "🟢 Online" : "🟡 Rejoining") : "🔴 Offline";
        const e = new EmbedBuilder().setTitle("📡 Bot Status").setColor(s ? "#3498db" : "#95a5a6").addFields({ name: "State", value: `\`${stateStr}\``, inline: true }, { name: "Joins", value: `\`${u.stats.joins}\``, inline: true }, { name: "Recent Logs", value: `\`\`\`\n${u.history.join("\n") || "No activity logs."}\n\`\`\`` });
        return i.reply({ embeds: [e], ephemeral: true });
      }

      // --- ALKUPERÄINEN MICROSOFT AUTH CALLBACK (PAIKALLAAN) ---
      if (i.customId === "ui_link") {
        await i.deferReply({ ephemeral: true });
        const flow = new Authflow(uid, getMicrosoftPath(uid), { flow: "live", authTitle: Titles?.MinecraftNintendoSwitch || "AFK Bot", deviceType: "Nintendo" }, async (data) => {
          // TÄMÄ CALLBACK PÄIVITTÄÄ VIESTIN HETI KOODIN TULLESSA
          const m = `🔐 **Microsoft Login Required**\n\n1️⃣ **Link:** [Click to login](${data.verification_uri})\n2️⃣ **Code:** \`${data.user_code}\`\n\n⚠️ Return here after browser login is finished!`;
          await i.editReply({ 
            content: m, 
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Official Link").setStyle(ButtonStyle.Link).setURL(data.verification_uri))] 
          }).catch(() => {});
        });
        await flow.getMsaToken();
        const u = getProfile(uid); u.linked = true; atomicStore();
        return i.followUp({ ephemeral: true, content: "✅ **Success:** Microsoft account linked!" });
      }

      if (i.customId === "ui_settings") {
        const u = getProfile(uid);
        const m = new ModalBuilder().setCustomId("settings_modal").setTitle("Bot Configuration");
        m.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("f_ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "").setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("f_pt").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("f_nm").setLabel("Cracked Name").setStyle(TextInputStyle.Short).setValue(u.offlineUsername || ""))
        );
        return i.showModal(m);
      }

      if (i.customId === "ui_more") {
        const u = getProfile(uid);
        return i.reply({ ephemeral: true, content: "➕ **Advanced Settings**", components: [buildVersionUI(u.bedrockVersion)] });
      }

      // ADMIN HUB
      if (i.customId === "adm_metrics") {
        if (!ADMIN_IDS.includes(uid)) return;
        const mem = process.memoryUsage();
        const e = new EmbedBuilder().setTitle("📊 System Monitor").addFields({ name: "Heap", value: `\`${(mem.heapUsed/1024/1024).toFixed(2)} MB\``, inline: true }, { name: "Active", value: `\`${activeSessions.size}\``, inline: true }, { name: "Users", value: `\`${Object.keys(users).length}\``, inline: true });
        return i.reply({ embeds: [e], ephemeral: true });
      }

      if (i.customId === "adm_bc_discord") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("bc_discord_modal").setTitle("Discord Broadcast");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("f_ch").setLabel("Channel ID").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("f_tx").setLabel("Message").setStyle(TextInputStyle.Paragraph).setRequired(true)));
        return i.showModal(m);
      }

      if (i.customId === "adm_bc_mc") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("bc_mc_modal").setTitle("In-Game Broadcast");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("f_tx").setLabel("Message").setStyle(TextInputStyle.Short).setRequired(true)));
        return i.showModal(m);
      }

      if (i.customId === "adm_users") {
        if (!ADMIN_IDS.includes(uid)) return;
        const l = Object.keys(users).map(id => ({ label: `ID: ${id}`, value: id })).slice(0, 25);
        if (l.length === 0) return i.reply({ content: "DB is empty.", ephemeral: true });
        const menu = new StringSelectMenuBuilder().setCustomId("adm_inspect_user").setPlaceholder("Select User").addOptions(l);
        return i.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      }

      if (i.customId === "adm_kill_all") {
        if (!ADMIN_IDS.includes(uid)) return;
        const c = activeSessions.size; for (const [id, s] of activeSessions) { s.manualStop = true; terminateSession(id); }
        return i.reply({ content: `☢️ KILLED ${c} BOTS.`, ephemeral: true });
      }

      if (i.customId === "adm_ban") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("ban_modal").setTitle("Blacklist Control");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("f_id").setLabel("Target ID").setStyle(TextInputStyle.Short).setRequired(true)));
        return i.showModal(m);
      }

      if (i.customId?.startsWith("ai_purge_fix_")) {
        const target = i.customId.split("_")[3];
        terminateSession(target); setTimeout(() => executeBotStart(target), 1500);
        return i.update({ content: "⚡ **Action Confirmed:** Optimization in progress...", components: [] });
      }
    }

    // --- MENUS ---
    if (i.isStringSelectMenu()) {
      if (i.customId === "adm_inspect_user") {
        const t = users[i.values[0]];
        const e = new EmbedBuilder().setTitle(`👤 User: ${i.values[0]}`).addFields({ name: "IP", value: `\`${t.server?.ip}:${t.server?.port}\`` }, { name: "Banned", value: `\`${t.banned}\`` }, { name: "Joins", value: `\`${t.stats?.joins}\`` });
        return i.reply({ embeds: [e], ephemeral: true });
      }

      if (i.customId === "support_selector") {
        const choice = i.values[0];
        if (choice === "opt_auto") {
          await i.update({ content: "⏳ **AI Thinking…** Scanning agent health.", components: [] });
          const u = getProfile(uid); const s = activeSessions.get(uid); let pT = "Offline";
          try { const pR = await bedrock.ping({ host: u.server?.ip, port: u.server?.port }); pT = `Online (${pR.motd})`; } catch (e) {}
          const helpRes = await callAI(`Diagnostic: Server ${u.server?.ip}, Session ${s?.connected ? 'OK' : 'FAIL'}, Ping ${pT}`, "help");
          
          let comps = []; let txt = helpRes;
          ['RECONNECT', 'RAM_PURGE', 'RESTART'].forEach(a => { if (helpRes.includes(`[${a}]`)) { txt = txt.replace(`[${a}]`, "").trim(); comps.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ai_purge_fix_${uid}`).setLabel(`Fix with ${a}`).setStyle(ButtonStyle.Danger))); } });
          return i.editReply({ content: `🆘 **Result**\n\n${txt}`, components: comps });
        }
        if (choice === "opt_manual") {
          const m = new ModalBuilder().setCustomId("manual_help_modal").setTitle("Support Chat");
          m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("f_tx").setLabel("What is wrong?").setStyle(TextInputStyle.Paragraph).setRequired(true)));
          return i.showModal(m);
        }
      }

      if (i.customId === "menu_v") {
        const u = getProfile(uid); u.bedrockVersion = i.values[0]; atomicStore();
        return i.reply({ ephemeral: true, content: `✅ Version set to ${u.bedrockVersion}` });
      }
    }

    // --- MODALS ---
    if (i.isModalSubmit()) {
      if (i.customId === "settings_modal") {
        const u = getProfile(uid);
        const newIp = i.fields.getTextInputValue("f_ip").trim();
        if (newIp === "upupdowndown") return i.reply({ ephemeral: true, content: "🎮 **Cheat Activated!** System recalibrated." });
        u.server.ip = newIp; u.server.port = parseInt(i.fields.getTextInputValue("f_pt").trim()) || 19132;
        u.offlineUsername = i.fields.getTextInputValue("f_nm").trim() || u.offlineUsername;
        atomicStore(); return i.reply({ ephemeral: true, content: "✅ **Saved.** Your data is secure on /data volume." });
      }
      if (i.customId === "manual_help_modal") {
        await i.reply({ content: "⏳ **AI Thinking…**", ephemeral: true });
        const res = await callAI(`Manual: "${i.fields.getTextInputValue("f_tx")}" for ${getProfile(uid).server?.ip}`, "help");
        return i.editReply({ content: `🆘 **AI Response**\n\n${res}` });
      }
      if (i.customId === "bc_discord_modal") {
        const c = await client.channels.fetch(i.fields.getTextInputValue("f_ch")).catch(() => null);
        if (c) { await c.send({ embeds: [new EmbedBuilder().setTitle("📢 Update").setDescription(i.fields.getTextInputValue("f_tx")).setColor("#f1c40f")] }); return i.reply({ content: "✅ Sent.", ephemeral: true }); }
        return i.reply({ content: "❌ Error.", ephemeral: true });
      }
      if (i.customId === "bc_mc_modal") {
        let dc = 0; const txt = i.fields.getTextInputValue("f_tx");
        for (const [id, s] of activeSessions) { if (s.connected) { s.client.write("text", { type: "chat", needs_translation: false, source_name: "", xuid: "", platform_chat_id: "", message: `§e[SYSTEM] §f${txt}` }); dc++; } }
        return i.reply({ content: `✅ Sent to ${dc} bots.`, ephemeral: true });
      }
      if (i.customId === "ban_modal") {
        const t = getProfile(i.fields.getTextInputValue("f_id")); t.banned = !t.banned; atomicStore();
        if (t.banned) terminateSession(i.fields.getTextInputValue("f_id"));
        return i.reply({ content: `✅ Status updated.`, ephemeral: true });
      }
    }

    // --- SLASH KOMENNOT ---
    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return i.reply({ content: "🎛 **AFK Dashboard**", components: buildMainUI() });
      if (i.commandName === "admin") {
        if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "⛔ Denied.", ephemeral: true });
        return i.reply({ content: "🛡️ **Admin Hub**", components: buildAdminUI(), ephemeral: true });
      }
    }
  } catch (err) { process.stderr.write(`[ERR] ${err.message}\n`); }
});

// --- ELINKAARI ---
process.on("unhandledRejection", (e) => alertOwner(`REJECTION: \`${e.message}\``));
process.on("uncaughtException", (e) => alertOwner(`CRITICAL: \`${e.message}\``));

client.once("ready", async () => {
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Access control dashboard"),
    new SlashCommandBuilder().setName("admin").setDescription("Administrator tools")
  ];
  await client.application.commands.set(cmds);
  alertOwner("System Reboot Complete. V23 ONLINE.");
});

function getMicrosoftPath(uid) {
  const dir = path.join(AUTH_FOLDER, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getAuthFolder(uid) { return getMicrosoftPath(uid); }

client.login(DISCORD_TOKEN);

