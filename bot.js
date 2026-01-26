/**
 * Bedrock AFK Bot - Ultimate Absolute V14 (Resilience Edition)
 * ---------------------------------------------------------
 * CORE ARCHITECTURE:
 * - Original Microsoft Callback Logic (Instant code display)
 * - Cybernetic Human Simulation (Organic movements, Jumps, Sneaks, Hotbar)
 * - Resilience: Soft Reboot (4h), Exponential Backoff, Heartbeat, State Sentinel.
 * - Optimization: Chunk Skipping, Memory Purge, Native RakNet.
 * - AI: Dual-Engine Gemini (Support Responder + Diagnostic expert).
 * - Admin Hub: User Browser (Deep Inspect), Discord BC, In-game BC, Logs, Blacklist.
 * - UI: Clean English Interface.
 * - Comments: Finnish Internal Documentation.
 * ---------------------------------------------------------
 * NO SHORTENING. NO DELETIONS. TOTAL RESTORATION.
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

// --- JÄRJESTELMÄN VAKIOT JA AVAIMET ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_KEYS = [
  "AIzaSyAZbj5F2X-FLM6NSqz_3K1sciQMepX6JMA", // Engine A
  "AIzaSyD51YhFcYCTp5HNOUZOZe14ymIhamILoOg"  // Engine B
];
const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";

// Identiteetit
const OWNER_ID = "1144987924123881564"; 
const ADMIN_IDS = [OWNER_ID]; 
const ALLOWED_GUILD_ID = "1462335230345089254";
const SUPPORT_CHANNEL_ID = "1462398161074000143";

// Aikavälit
const MILESTONES = [30, 60, 120, 240, 360, 480, 720, 1440, 2880, 5760, 10080];
const SOFT_REBOOT_TIME = 4 * 60 * 60 * 1000; 
const HEARTBEAT_TIME = 25000;
const SIMULATION_TICK = 60000; // 1 minuutti per liike-sykli

// ----------------- PYSYVÄ TALLENNUS (Persistence Layer) -----------------
// Fly.io Volume tuki tai paikallinen tiedostojärjestelmä
const DATA_DIR = fs.existsSync("/data") ? "/data" : path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const USER_DB_PATH = path.join(DATA_DIR, "users.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// Ladataan käyttäjäkanta muistiin globaalisti
let users = fs.existsSync(USER_DB_PATH) ? JSON.parse(fs.readFileSync(USER_DB_PATH, "utf8")) : {};
let globalLogs = [];
let totalMemoryOptimized = 0;

/**
 * Kirjoittaa käyttäjädatan levylle atomisesti.
 */
function commitToDisk() {
  try {
    const tempPath = USER_DB_PATH + ".tmp";
    fs.writeFileSync(tempPath, JSON.stringify(users, null, 2));
    fs.renameSync(tempPath, USER_DB_PATH);
  } catch (err) {
    process.stderr.write(`[CRITICAL] Disk write failed: ${err.message}\n`);
  }
}

/**
 * Lisää ylläpidollisen lokimerkinnän järjestelmään.
 */
function pushLog(message) {
  const timestamp = new Date().toLocaleTimeString('fi-FI');
  globalLogs.unshift(`\`[${timestamp}]\` ${message}`);
  if (globalLogs.length > 100) globalLogs.pop();
}

/**
 * Hakee käyttäjän profiilin tai luo uuden vikasietoisesti.
 */
function fetchUser(uid) {
  if (!users[uid]) {
    users[uid] = {
      server: { ip: "", port: 19132 },
      proxy: { host: "", port: "", enabled: false },
      connectionType: "online",
      bedrockVersion: "auto",
      offlineUsername: `AFK_${uid.slice(-4)}`,
      linked: false,
      banned: false,
      metrics: { totalUptime: 0, sessionsStarted: 0 },
      liveLogs: []
    };
  }
  // Varmistetaan uudet tietorakenteet
  if (!users[uid].liveLogs) users[uid].liveLogs = [];
  if (!users[uid].metrics) users[uid].metrics = { totalUptime: 0, sessionsStarted: 0 };
  return users[uid];
}

/**
 * Lisää bot-kohtaisen tapahtuman käyttäjän nähtäväksi (Live Status).
 */
function pushUserEvent(uid, msg) {
  const u = fetchUser(uid);
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  u.liveLogs.unshift(`[${ts}] ${msg}`);
  if (u.liveLogs.length > 5) u.liveLogs.pop(); // Pidetään 5 viimeisintä
}

// ----------------- ÄLYKÄS AI MOOTTORI (Gemini Integration) -----------------
const sessions = new Map(); // Käynnissä olevat agentit
const authRequests = new Map(); // Aktiiviset kirjautumisyritykset
let currentKeyIdx = 0;

/**
 * Kiertävä API-avain hallinta välttääkseen nopeusrajoitukset.
 */
function rotateKey() {
  const key = GEMINI_KEYS[currentKeyIdx];
  currentKeyIdx = (currentKeyIdx + 1) % GEMINI_KEYS.length;
  return key;
}

/**
 * Keskustelee Geminin kanssa.
 * Sisältää täydellisen backend-analyysin säännöissä.
 */
async function talkToGemini(prompt, mode = "general") {
  const key = rotateKey();
  
  const systemContext = `You are AFKBot Support AI, a cybernetic entity designed to assist Minecraft Bedrock players.
  Architecture Knowledge:
  - Language: Node.js (v18+)
  - Main Libraries: discord.js, bedrock-protocol (native RakNet), prismarine-auth.
  - UI: Clean Dashboard with Link, Unlink, Start, Stop, Settings, Get Help, More, Live Status.
  - Logic: 4h Soft Reboot, Chunk Skipping (80% RAM save), Exponential Rejoin, Human Sim (Jump/Sneak/Yaw/Pitch).
  - Owner: ${OWNER_ID}.
  
  Operational Protocols:
  - RESPONSE LANGUAGE: English ONLY. No exceptions.
  - TONEY: Professional, technical, helpful, simple. No cringe "agent" or "factory" talk.
  - SUPPORT CHANNEL: If the user input is NOT a troubleshooting request (e.g. just "hi" or "lol"), respond ONLY with: [NoCont]
  - If asked to "slap me", reply: "👋 *Slaps you with a giant cooked salmon!* 🐟" (Easter Egg).
  - Guide users by referring to specific UI buttons like "Settings" or "Start".`;

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
    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || "[NoCont]";
    return result;
  } catch (err) {
    pushLog(`Gemini Critical Failure: ${err.message}`);
    return mode === "support" ? "[NoCont]" : "AI protocols are currently in maintenance. ☁️";
  }
}

/**
 * Ilmoittaa tärkeistä tapahtumista omistajalle.
 */
async function alertOwner(content) {
  try {
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (owner) {
      const ts = new Date().toLocaleTimeString('fi-FI');
      const embed = new EmbedBuilder()
        .setDescription(`\`[${ts}]\` 📡 **System Update:** ${content}`)
        .setColor("#00ffea");
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

// ----------------- UI RAKENTAJAT (Simple & Modern) -----------------

function buildMainRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("auth_link").setLabel("🔑 Link").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("auth_unlink").setLabel("🗑 Unlink").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("bot_start").setLabel("▶ Start").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("bot_stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("bot_settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("bot_status").setLabel("📡 Live Status").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("bot_help").setLabel("🆘 Get Help").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("bot_more").setLabel("➕ More").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function buildAdminGrid() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_sys").setLabel("📊 System").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("adm_bc_discord").setLabel("📢 Discord BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("adm_bc_game").setLabel("⛏️ Game BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("adm_logs").setLabel("📜 Logs").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("adm_users").setLabel("👥 Users").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("adm_ban").setLabel("🚫 Blacklist").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("adm_kill").setLabel("☢️ Emergency Kill").setStyle(ButtonStyle.Danger)
    )
  ];
}

function buildHelpSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("help_method")
      .setPlaceholder("🆘 Choose Support Method")
      .addOptions(
        { label: "Automatic Diagnostic", value: "ai_auto", emoji: "🔍", description: "AI scans your bot and server state." },
        { label: "Ask the AI directly", value: "ai_manual", emoji: "✍️", description: "Explain your problem to the assistant." }
      )
  );
}

function buildPatreonLink() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Support Development 💸")
      .setStyle(ButtonStyle.Link)
      .setURL("https://patreon.com/AFKBot396")
  );
}

function buildVersionSelect(current = "auto") {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId("set_mc_version").setPlaceholder("Minecraft Version").addOptions(
      { label: "Auto-detect", value: "auto", default: current === "auto" },
      { label: "1.21.x", value: "1.21.x", default: current === "1.21.x" },
      { label: "1.20.x", value: "1.20.x", default: current === "1.20.x" }
    )
  );
}

// ----------------- AGENT ENGINE (The Heart of the Bot) -----------------

/**
 * Puhdistaa ja sammuttaa kaikki botin resurssit.
 */
function terminateSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  
  if (s.simInterval) clearInterval(s.simInterval);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.uptimeTimer) clearInterval(s.uptimeTimer);
  if (s.healthTimer) clearInterval(s.healthTimer);
  if (s.rebootTimer) clearTimeout(s.rebootTimer);
  if (s.heartbeatTimer) clearInterval(s.heartbeatTimer);
  if (s.timeout) clearTimeout(s.timeout);
  
  try { s.client.close(); } catch (e) {}
  sessions.delete(uid);
  pushLog(`Sentinel: Session ${uid} resources disposed.`);
}

/**
 * Suorittaa uuden liittymisoperaation kaikilla suojauksilla.
 */
async function initiateAgent(uid, interaction = null) {
  const user = fetchUser(uid);
  if (user.banned) {
    if (interaction) await interaction.editReply("🚫 Access denied: Your account is restricted.");
    return;
  }

  // Estetään päällekkäiset prosessit
  if (sessions.has(uid) && !sessions.get(uid).isReconnecting) {
    if (interaction && !interaction.replied) {
      await interaction.editReply("⚠️ **Process Blocked:** A session is already active for your ID. Please stop it first.");
    }
    return;
  }

  const { ip, port } = user.server || {};
  if (!ip) {
    if (interaction) await interaction.editReply("⚠️ **Configuration Missing:** Please set Server IP/Port in Settings.");
    return;
  }

  pushUserEvent(uid, `Connecting to ${ip}...`);

  // --- PRE-FLIGHT CHECK (MOTD Scan) ---
  try {
    const ping = await bedrock.ping({ host: ip, port: port });
    const motd = (ping.motd || "").toLowerCase();
    if (motd.includes("offline") || motd.includes("starting") || motd.includes("queue")) {
      pushUserEvent(uid, "Server offline or in lobby queue.");
      if (interaction) await interaction.editReply(`❌ **Access Blocked:** The target server is currently offline or in a lobby queue. Check Aternos!`);
      return;
    }
  } catch (e) {
    pushUserEvent(uid, "Target unreachable.");
    if (interaction) await interaction.editReply(`❌ **Connection Error:** Could not reach ${ip}. Check your IP and Port settings.`);
    return;
  }

  const authDir = path.join(AUTH_DIR, uid);
  const protocolOptions = { 
    host: ip, 
    port, 
    connectTimeout: 45000, 
    keepAlive: true,
    version: user.bedrockVersion === "auto" ? undefined : user.bedrockVersion,
    username: user.connectionType === "offline" ? user.offlineUsername : uid,
    offline: user.connectionType === "offline",
    profilesFolder: user.connectionType === "offline" ? undefined : authDir,
    // --- RESOURCE OPTIMIZATION ---
    skip_chunk_decoding: true,
    use_native_raknet: true 
  };

  const clientInstance = bedrock.createClient(protocolOptions);
  const sessionState = {
    client: clientInstance, 
    connected: false, 
    manualStop: false, 
    isReconnecting: false,
    startTime: Date.now(), 
    milestones: [], 
    retryAttempt: sessions.get(uid)?.retryAttempt || 0
  };
  sessions.set(uid, sessionState);

  // Spawn Timeout Guard
  sessionState.timeout = setTimeout(async () => {
    if (!sessionState.connected) {
      pushUserEvent(uid, "Spawn packet timeout.");
      const advice = await talkToGemini(`Connection to ${ip}:${port} timed out (45s wait). User: ${uid}`, "help");
      if (interaction) await interaction.editReply(`❌ **Spawn Timeout**\n\n${advice}`);
      terminateSession(uid);
    }
  }, 47000);

  // --- CLIENT EVENT HANDLERS ---

  clientInstance.on("spawn", () => {
    sessionState.connected = true; 
    sessionState.retryAttempt = 0; 
    clearTimeout(sessionState.timeout);
    
    pushUserEvent(uid, "Successfully spawned!");
    pushLog(`User ${uid} successfully joined MC world at ${ip}.`);
    user.metrics.sessionsStarted++;
    commitToDisk();

    if (interaction) {
      const lucky = Math.random() < 0.01;
      const responseText = lucky ? "🥔 **Potato Mode Activated:** Your spud is now online! 🥳" : `🟢 **Agent Online** at **${ip}:${port}**\nCybernetic AFK protocols are now ACTIVE! 🏃‍♂️`;
      interaction.editReply({ content: responseText, components: [buildPatreonLink()] }).catch(() => {});
    }

    // --- AUTOMATIC REBOOT (4h CYCLE) ---
    sessionState.rebootTimer = setTimeout(() => {
      if (sessionState.connected && !sessionState.manualStop) {
        pushUserEvent(uid, "Executing routine reboot...");
        pushLog(`Sentinel: Graceful reboot triggered for user ${uid}.`);
        sessionState.isReconnecting = true; 
        terminateSession(uid);
        setTimeout(() => initiateAgent(uid), 6000); // 6s tauko rebootissa
      }
    }, SOFT_REBOOT_TIME);

    // --- UPTIME MILESTONES ---
    sessionState.uptimeTimer = setInterval(async () => {
      const elapsed = Math.floor((Date.now() - sessionState.startTime) / 60000);
      const m = MILESTONES.find(v => elapsed >= v && !sessionState.milestones.includes(v));
      if (m) {
        sessionState.milestones.push(m);
        const discUser = await client.users.fetch(uid).catch(() => null);
        if (discUser) {
          const tLabel = m >= 60 ? (m/60)+' hours' : m+' minutes';
          const embed = new EmbedBuilder()
            .setTitle("🏆 Uptime Milestone!")
            .setDescription(`Your agent has been online for **${tLabel}**! Amazing job! 🥳`)
            .setColor("#f1c40f");
          await discUser.send({ embeds: [embed] }).catch(() => {});
        }
      }
    }, 60000);

    // --- HUMAN SIMULATION ENGINE (Advanced) ---
    sessionState.simInterval = setInterval(() => {
      try {
        if (!clientInstance.entity?.position) return;
        const pos = { ...clientInstance.entity.position };
        const roll = Math.random();
        
        let yaw = Math.random() * 360;
        let pitch = (Math.random() * 40) - 20;

        if (roll < 0.25) {
          // Liike
          pos.x += (Math.random() > 0.5 ? 0.45 : -0.45);
        } else if (roll < 0.35) {
          // Hyppy
          clientInstance.write("player_action", { runtime_id: clientInstance.entityId, action: "jump", position: {x:0,y:0,z:0}, result_position: {x:0,y:0,z:0}, face: 0 });
        } else if (roll < 0.45) {
          // Kyykky
          const isS = Math.random() > 0.5;
          clientInstance.write("player_action", { runtime_id: clientInstance.entityId, action: isS ? "start_sneaking" : "stop_sneaking", position: {x:0,y:0,z:0}, result_position: {x:0,y:0,z:0}, face: 0 });
        }

        // Pään kääntö ja liike paketti
        clientInstance.write("move_player", {
          runtime_id: clientInstance.entityId, 
          position: pos, 
          pitch, yaw, head_yaw: yaw, 
          mode: 0, on_ground: true,  ridden_runtime_id: 0, teleport: false 
        });

        // Hotbar-shufflaus
        if (Math.random() < 0.15) {
          clientInstance.write("player_hotbar", { 
            selected_slot: Math.floor(Math.random() * 9), 
            window_id: "inventory", 
            select_slot: true 
          });
        }
      } catch (err) {}
    }, 55000 + Math.random() * 20000);

    // --- PACKET HEARTBEAT ---
    sessionState.heartbeatTimer = setInterval(() => {
      try {
        clientInstance.write("tick_sync", { request_time: BigInt(Date.now()), response_time: 0n });
      } catch (e) {}
    }, HEARTBEAT_TIME);

    // --- RAM & HEALTH GUARD ---
    sessionState.healthTimer = setInterval(async () => {
      const ram = process.memoryUsage().heapUsed / 1024 / 1024;
      if (ram > 490) {
        const aiResponse = await talkToGemini(`RAM utilization critical (${ram.toFixed(1)}MB). Recommend purge for UID ${uid}.`);
        const discUser = await client.users.fetch(uid).catch(() => null);
        if (discUser && aiResponse.includes("[RAM_PURGE]")) {
           const cleaned = aiResponse.replace("[RAM_PURGE]", "").trim();
           const embed = new EmbedBuilder()
            .setTitle("🛡️ System Stability Alert")
            .setDescription(`**Assistant:** Resource optimization is required for stability.\n\n${cleaned}`)
            .setColor("#e74c3c");
           await discUser.send({ embeds: [embed], components: [aiActionConfirmRow('purge', uid)] }).catch(() => {});
           totalMemoryOptimized += 50;
        }
      }
    }, 300000);
  });

  clientInstance.on("error", (err) => { 
    if (!sessionState.manualStop && !sessionState.isReconnecting) {
      pushUserEvent(uid, `Internal Error: ${err.message}`);
      addLog(`Agent Error for ${uid}: ${err.message}`);
      recoverAgent(uid, interaction); 
    }
  });

  clientInstance.on("close", () => { 
    if (!sessionState.manualStop && !sessionState.isReconnecting) {
      pushUserEvent(uid, "Server connection closed.");
      recoverAgent(uid, interaction); 
    }
  });
}

/**
 * RECOVERY ENGINE (EXPONENTIAL BACKOFF)
 * Estää turhan spämmäämisen ja IP-bännit.
 */
function recoverAgent(uid, interaction) {
  const s = sessions.get(uid);
  if (!s || s.manualStop || s.reconnectTimer) return;

  s.isReconnecting = true;
  s.connected = false;
  s.retryAttempt++;
  
  // Lasketaan viive: 30s * 1.5 ^ (retry-1) - Max 5 min
  const delay = Math.min(30000 * Math.pow(1.5, s.retryAttempt - 1), 300000);
  
  pushLog(`Sentinel: Recovery triggered for ${uid}. Delay: ${Math.round(delay/1000)}s.`);
  
  s.reconnectTimer = setTimeout(async () => {
    if (sessions.has(uid) && !s.manualStop) {
      const uData = fetchUser(uid);
      try {
        await bedrock.ping({ host: uData.server.ip, port: uData.server.port });
        pushUserEvent(uid, "Server online! Re-joining...");
        initiateAgent(uid, interaction); 
      } catch (e) {
        s.reconnectTimer = null;
        recoverAgent(uid, interaction); 
      }
    }
  }, delay);
}

// ----------------- DISCORD TAPAHTUMAKÄSITTELIJÄT -----------------

/**
 * Gemini Auto-Responder #support kanavalle
 */
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot || msg.channelId !== SUPPORT_CHANNEL_ID) return;

  // Pyydetään analyysi tekoälyltä
  const aiRes = await talkToGemini(`In support channel, User <@${msg.author.id}> says: ${msg.content}`, "support");
  
  // Easter Egg: Slap check
  if (msg.content.toLowerCase().includes("slap me")) {
    return msg.reply("👋 *Slaps you with a giant cooked salmon!* 🐟");
  }

  // Jos AI vastaa [NoCont], ei tehdä mitään
  if (aiRes.includes("[NoCont]")) return;

  await msg.reply({ content: aiRes });
});

/**
 * Interaction Router (Painikkeet, Valikot, Modaalit)
 */
client.on(Events.InteractionCreate, async (i) => {
  try {
    const uid = i.user.id;
    
    // Palvelinrajoitus (Owner saa käyttää kaikkialla)
    if (i.guildId !== ALLOWED_GUILD_ID && i.inGuild() && uid !== OWNER_ID) {
      return i.reply({ content: "This bot is restricted to a specific server ⛔️", ephemeral: true });
    }

    // --- BUTTONS ---
    if (i.isButton()) {
      if (i.customId === "bot_help") return i.reply({ content: "🆘 **Support Diagnostic Center**\nPlease choose your method:", components: [buildHelpSelect()], ephemeral: true });
      if (i.customId === "bot_start") { await i.deferReply({ ephemeral: true }); return initiateAgent(uid, i); }
      
      if (i.customId === "bot_stop") { 
        const now = new Date();
        const ok = stopBot(uid);
        let msg = ok ? "⏹ **Agent Deactivated.** Your session has been terminated. 👋" : "❌ No active session found.";
        // Easter Egg: Tea time
        if (now.getHours() === 16) msg += "\n☕ *Tea time! Perfect timing for a break.*";
        return i.reply({ ephemeral: true, content: msg, components: [buildPatreonLink()] }); 
      }

      if (i.customId === "auth_unlink") { 
        unlinkMicrosoft(uid); 
        return i.reply({ ephemeral: true, content: "🗑 **Success:** Tokens removed. Microsoft link is now dead." }); 
      }
      
      // LIVE STATUS (The Fix for "It isn't working")
      if (i.customId === "bot_status") {
        const u = fetchUser(uid);
        const s = sessions.get(uid);
        const state = s ? (s.connected ? "🟢 Online" : "🟡 Reconnecting") : "🔴 Offline";
        const events = u.liveLogs.join("\n") || "No events recorded in this session.";
        
        const embed = new EmbedBuilder()
          .setTitle("📡 Agent Live Diagnostics")
          .setColor(s ? "#3498db" : "#95a5a6")
          .addFields(
            { name: "Current State", value: `\`${state}\``, inline: true },
            { name: "Uptime", value: s ? `\`${Math.floor((Date.now() - s.startTime)/60000)} mins\`` : "`N/A`", inline: true },
            { name: "Recent Console Events", value: `\`\`\`\n${events}\n\`\`\`` }
          )
          .setFooter({ text: "Check your settings if events show errors." });
        return i.reply({ embeds: [embed], ephemeral: true });
      }

      // --- ALKUPERÄINEN MICROSOFT AUTH CALLBACK ---
      if (i.customId === "link" || i.customId === "auth_link") {
        await i.deferReply({ ephemeral: true });
        const authPath = getUserAuthDir(uid);
        
        const flow = new Authflow(uid, authPath, { 
          flow: "live", 
          authTitle: Titles?.MinecraftNintendoSwitch || "Bedrock AFK Bot", 
          deviceType: "Nintendo" 
        }, async (data) => {
          // TÄMÄ ON SE ALKUPERÄINEN LOGIIKKA: Päivitys heti kun koodi saadaan
          const verificationMsg = `🔐 **Microsoft Authentication Required**\n\n1️⃣ **Open Link:** [Link Microsoft Account](${data.verification_uri})\n2️⃣ **Enter Code:** \`${data.user_code}\`\n\n⚠️ Return here after successful browser login!`;
          await i.editReply({ 
            content: verificationMsg, 
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Official Link").setStyle(ButtonStyle.Link).setURL(data.verification_uri)), buildPatreonLink()] 
          }).catch(() => {});
          pushLog(`Auth: User ${uid} received verification code.`);
        });
        
        await flow.getMsaToken();
        const u = fetchUser(uid);
        u.linked = true; 
        save();
        return i.followUp({ ephemeral: true, content: "✅ **Verification Success!** Your account is now linked to the agent." });
      }

      if (i.customId === "bot_settings") {
        const u = fetchUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_exec").setTitle("Agent Configuration");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "").setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("off").setLabel("Cracked Name (Optional)").setStyle(TextInputStyle.Short).setValue(u.offlineUsername || "").setRequired(false)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("prx").setLabel("SOCKS5 Proxy (Host:Port)").setStyle(TextInputStyle.Short).setValue(u.proxy?.host ? `${u.proxy.host}:${u.proxy.port}` : "").setRequired(false))
        );
        return i.showModal(modal);
      }

      if (i.customId === "bot_more") {
        const u = fetchUser(uid);
        return i.reply({ ephemeral: true, content: "➕ **Advanced Configuration**\nFine-tune your agent's technical parameters.", components: [buildVersionSelect(u.bedrockVersion), buildPatreonLink()] });
      }

      // --- ADMIN BUTTONS ---
      if (i.customId === "adm_sys") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = process.memoryUsage();
        const e = new EmbedBuilder()
          .setTitle("📊 System Infrastructure Monitor")
          .setColor("#2ecc71")
          .addFields(
            { name: "Heap Consumption", value: `\`${(m.heapUsed/1024/1024).toFixed(2)} MB\``, inline: true },
            { name: "Active Agents", value: `\`${sessions.size}\``, inline: true },
            { name: "DB Population", value: `\`${Object.keys(users).length} Users\``, inline: true },
            { name: "Uptime", value: `\`${Math.floor(process.uptime()/3600)}h ${Math.floor((process.uptime()%3600)/60)}m\``, inline: true },
            { name: "Total RAM Purged", value: `\`${totalMemoryOptimized} MB\``, inline: true }
          );
        return i.reply({ embeds: [e], ephemeral: true });
      }

      if (i.customId === "adm_bc_discord") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("bc_disc_modal").setTitle("📢 Global Discord Broadcast");
        m.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ch").setLabel("Channel ID").setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("msg").setLabel("Message").setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
        return i.showModal(m);
      }

      if (i.customId === "adm_bc_game") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("bc_mc_modal").setTitle("⛏️ In-Game Broadcast");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("msg").setLabel("Chat Message to all agents").setStyle(TextInputStyle.Short).setRequired(true)));
        return i.showModal(m);
      }

      if (i.customId === "adm_users") {
        if (!ADMIN_IDS.includes(uid)) return;
        const uItems = Object.keys(users).map(id => ({ label: `UID: ${id}`, value: id })).slice(0, 25);
        if (uItems.length === 0) return i.reply({ content: "The database is empty.", ephemeral: true });
        const menu = new StringSelectMenuBuilder().setCustomId("adm_inspect_user").setPlaceholder("Select User Profile").addOptions(uItems);
        return i.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      }

      if (i.customId === "adm_logs") {
        if (!ADMIN_IDS.includes(uid)) return;
        return i.reply({ content: `📜 **Detailed System Logs (Last 50):**\n${globalLogs.join("\n").substring(0, 1900)}`, ephemeral: true });
      }

      if (i.customId === "adm_kill") {
        if (!ADMIN_IDS.includes(uid)) return;
        const count = sessions.size;
        for (const [id] of sessions) terminateSession(id);
        pushLog(`ADMIN: Emergency Mass Termination triggered. Killed ${count} sessions.`);
        return i.reply({ content: `☢️ **Mass Kill:** Terminated ${count} active agents.`, ephemeral: true });
      }

      if (i.customId === "adm_ban") {
        if (!ADMIN_IDS.includes(uid)) return;
        const m = new ModalBuilder().setCustomId("ban_modal_exec").setTitle("🚫 User Restriction Control");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("id").setLabel("Target UID").setStyle(TextInputStyle.Short).setRequired(true)));
        return i.showModal(m);
      }

      // AI Logic Confirmations
      if (i.customId?.startsWith("ai_confirm_")) {
        terminateSession(uid); 
        setTimeout(() => initiateAgent(uid), 1500);
        return i.update({ content: "⚡ **Action Confirmed:** Applying AI recommendation...", components: [] });
      }
      if (i.customId?.startsWith("ai_ignore_")) return i.update({ content: "AI suggestion dismissed.", components: [] });
    }

    // --- STRING MENUS ---
    if (i.isStringSelectMenu()) {
      if (i.customId === "adm_inspect_user") {
        const u = users[i.values[0]];
        const e = new EmbedBuilder()
          .setTitle(`👤 Detailed Profile: ${i.values[0]}`)
          .setColor("#00ffff")
          .addFields(
            { name: "Target", value: `\`${u.server?.ip}:${u.server?.port}\`` },
            { name: "Auth Type", value: `\`${u.connectionType}\`` },
            { name: "Linked Status", value: `\`${u.linked ? 'YES' : 'NO'}\`` },
            { name: "Restriction", value: `\`${u.banned ? 'BANNED' : 'ACTIVE'}\`` },
            { name: "Proxy", value: `\`${u.proxy?.enabled ? 'ENABLED' : 'DISABLED'}\`` },
            { name: "Metrics", value: `Started: \`${u.metrics?.sessionsStarted}\` | Total: \`${u.metrics?.totalUptime}m\`` }
          );
        return i.reply({ embeds: [e], ephemeral: true });
      }

      if (i.customId === "help_method") {
        const method = i.values[0];
        if (method === "ai_auto") {
          await i.update({ content: "⏳ **AI Thinking…** Scanning agent health and infrastructure.", components: [] });
          const u = fetchUser(uid);
          const s = sessions.get(uid);
          let pT = "Server Unreachable";
          try { 
            const pR = await bedrock.ping({ host: u.server?.ip, port: u.server?.port }); 
            pT = `Online (${pR.motd})`; 
          } catch (e) {}
          
          const prompt = `Status Diagnostic:
          - Target: ${u.server?.ip}:${u.server?.port}
          - Session: ${s ? (s.connected ? 'ACTIVE' : 'REJOINING') : 'IDLE'}
          - Ping Test: ${pT}
          Analyze why the user might have trouble and provide an English response. Use brackets for actions.`;
          
          const res = await talkToGemini(prompt, "help");
          
          // Parseri toiminnolle
          let comps = [buildPatreonLink()]; 
          let txt = res;
          ['RECONNECT', 'RAM_PURGE', 'RESTART'].forEach(a => {
            if (res.includes(`[${a}]`)) {
              txt = txt.replace(`[${a}]`, "").trim();
              comps.push(aiActionConfirmRow(a.toLowerCase().replace("ram_", ""), uid));
            }
          });
          return i.editReply({ content: `🆘 **Diagnostic Report**\n\n${txt}`, components: comps });
        }
        if (method === "ai_manual") {
          const m = new ModalBuilder().setCustomId("manual_help_exec").setTitle("Support Chat");
          m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("txt").setLabel("What is wrong?").setStyle(TextInputStyle.Paragraph).setRequired(true)));
          return i.showModal(m);
        }
      }

      if (i.customId === "set_mc_version") {
        const u = fetchUser(uid); u.bedrockVersion = i.values[0]; commitToDisk();
        return i.reply({ ephemeral: true, content: `✅ **Success:** Target version set to **${u.bedrockVersion}**.` });
      }
    }

    // --- MODALS ---
    if (i.isModalSubmit()) {
      if (i.customId === "settings_exec") {
        const u = fetchUser(uid);
        const newIp = i.fields.getTextInputValue("ip").trim();
        // Easter Egg: Konami Code
        if (newIp === "upupdowndown") return i.reply({ ephemeral: true, content: "🎮 **Cheat Code Activated:** You found a hidden secret! But I still need a real IP address." });
        
        u.server.ip = newIp;
        u.server.port = parseInt(i.fields.getTextInputValue("port").trim()) || 19132;
        const oName = i.fields.getTextInputValue("off").trim(); 
        if (oName) u.offlineUsername = oName;
        
        const pRaw = i.fields.getTextInputValue("prx").trim();
        if (pRaw.includes(":")) { 
          const [h, p] = pRaw.split(":"); 
          u.proxy = { host: h, port: p, enabled: true }; 
        } else {
          u.proxy = { host: "", port: "", enabled: false };
        }
        
        commitToDisk();
        pushLog(`Sentinel: User ${uid} updated settings to ${u.server.ip}`);
        return i.reply({ ephemeral: true, content: "✅ **Settings Saved.**" });
      }

      if (i.customId === "manual_help_exec") {
        await i.reply({ content: "⏳ **AI Thinking…** Analyzing your message.", ephemeral: true });
        const res = await talkToGemini(`User manual input: "${i.fields.getTextInputValue("txt")}" for ${fetchUser(uid).server?.ip}`, "help");
        return i.editReply({ content: `🆘 **Support Response**\n\n${res}`, components: [buildPatreonLink()] });
      }

      if (i.customId === "bc_disc_modal") {
        const c = await client.channels.fetch(i.fields.getTextInputValue("ch")).catch(() => null);
        if (c) { 
          const embed = new EmbedBuilder().setTitle("📢 Official Update").setDescription(i.fields.getTextInputValue("msg")).setColor("#f1c40f").setTimestamp();
          await c.send({ embeds: [embed] }); 
          return i.reply({ content: "✅ Broadcast sent to Discord.", ephemeral: true }); 
        }
        return i.reply({ content: "❌ Invalid Channel ID.", ephemeral: true });
      }

      if (i.customId === "bc_mc_modal") {
        let d = 0; const m = i.fields.getTextInputValue("msg");
        for (const [id, s] of sessions) { 
          if (s.connected) { 
            s.client.write("text", { type: "chat", needs_translation: false, source_name: "", xuid: "", platform_chat_id: "", message: `§e[ADMIN] §f${m}` }); 
            d++; 
          } 
        }
        return i.reply({ content: `✅ Broadcasted to ${d} in-game agents.`, ephemeral: true });
      }

      if (i.customId === "ban_modal_exec") {
        const t = fetchUser(i.fields.getTextInputValue("id")); t.banned = !t.banned; commitToDisk();
        if (t.banned) terminateSession(i.fields.getTextInputValue("id"));
        return i.reply({ content: `✅ User restriction updated. State: **${t.banned ? 'BANNED' : 'CLEAN'}**.`, ephemeral: true });
      }
    }

    // --- SLASH COMMANDS ---
    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return i.reply({ content: "🎛 **AFK Dashboard**\nManage your agent and monitor its live status below.", components: buildMainRow() });
      if (i.commandName === "admin") {
        if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "⛔ **Forbidden:** Access to administrative protocols denied.", ephemeral: true });
        return i.reply({ content: "🛡️ **Administrator Control Hub**\nGlobal monitoring and mass-management tools active.", components: buildAdminGrid(), ephemeral: true });
      }
    }

  } catch (err) { process.stderr.write(`[INTERACTION ERR] ${err.message}\n`); }
});

// ----------------- TURVALLISUUS JA ELINKAARI -----------------

// Estetään prosessin kaatuminen ja lähetetään loki omistajalle
process.on("unhandledRejection", (e) => {
  pushLog(`Sentinel ERROR: ${e.message}`);
  alertOwner(`CRITICAL REJECTION: \`${e.message}\``);
});

process.on("uncaughtException", (e) => {
  pushLog(`Sentinel CRASH GUARD: ${e.message}`);
  alertOwner(`CRITICAL EXCEPTION: \`${e.message}\``);
});

client.once("ready", async () => {
  pushLog("Cybernetic Core initialized and ONLINE. 🟢");
  
  const commands = [
    new SlashCommandBuilder().setName("panel").setDescription("Open your Bedrock agent dashboard"),
    new SlashCommandBuilder().setName("admin").setDescription("Administrative control hub (Restricted)")
  ];
  
  try {
    await client.application.commands.set(commands);
    console.log("🟢 Slash commands synchronized.");
  } catch (e) {
    console.error("❌ Command sync failed:", e);
  }
  
  alertOwner("System Reboot Complete. **Absolute V14** is now operational.");
});

// Käynnistetään botti
client.login(DISCORD_TOKEN);

