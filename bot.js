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
  PermissionsBitField
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");

// --- Physics Dependency Check ---
let Vec3;
try {
  Vec3 = require("vec3");
} catch (e) {
  console.log("⚠️ Physics dependency missing! Bot will not fall. Run: npm install vec3");
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

// ==========================================================
// 🧠 AI CONFIGURATION (Gemini 2.5 Flash Lite)
// ==========================================================
const GEMINI_API_KEY = "AIzaSyD51YhFcYCTp5HNOUZOZe14ymIhamILoOg";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash-lite", 
    systemInstruction: "You are a helpful, witty AI assistant for a Minecraft Bot Discord server. You MUST speak English only. Keep responses concise and fun."
});

// ----------------- Config -----------------
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_ID = "1144987924123881564";
const LOG_CHANNEL_ID = "1464615030111731753";
const ADMIN_CHANNEL_ID = "1469013237625393163"; 

// ----------------- Storage -----------------
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");
const REJOIN_STORE = path.join(DATA, "ReJoin.json");
const CONFIG_STORE = path.join(DATA, "bot_config.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

// Load Data
let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};
let activeSessionsStore = fs.existsSync(REJOIN_STORE) ? JSON.parse(fs.readFileSync(REJOIN_STORE, "utf8")) : {};
let botConfig = fs.existsSync(CONFIG_STORE) ? JSON.parse(fs.readFileSync(CONFIG_STORE, "utf8")) : { scanChannelId: "1462398161074000143" };

function save() {
  fs.writeFileSync(STORE, JSON.stringify(users, null, 2));
}

function saveActiveSessions() {
  fs.writeFileSync(REJOIN_STORE, JSON.stringify(activeSessionsStore, null, 2));
}

function saveConfig() {
  fs.writeFileSync(CONFIG_STORE, JSON.stringify(botConfig, null, 2));
}

function getUser(uid) {
  if (!users[uid]) users[uid] = {};
  users[uid].connectionType = "online"; 
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  return users[uid];
}

function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function unlinkMicrosoft(uid) {
  const dir = getUserAuthDir(uid);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  const u = getUser(uid);
  u.linked = false;
  save();
}

// ----------------- Runtime -----------------
const sessions = new Map();
const pendingLink = new Map();
let lastAdminMessage = null; 

// ----------------- Discord Client -----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ==========================================================
// 🛡️ CRASH PREVENTION SYSTEM
// ==========================================================
client.on("error", (error) => {
    console.error("⚠️ Discord Client Error (Ignored):", error.message);
});

client.on("shardError", (error) => {
    console.error("⚠️ WebSocket Error (Ignored):", error.message);
});

process.on("uncaughtException", (err) => {
    console.error("🔥 Uncaught Exception:", err);
});

async function logToDiscord(message) {
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (channel) {
      const embed = new EmbedBuilder().setColor("#5865F2").setDescription(message).setTimestamp();
      await channel.send({ embeds: [embed] });
    }
  } catch (e) {}
}

function denyIfWrongGuild(i) {
  if (!i.inGuild() || i.guildId !== ALLOWED_GUILD_ID) {
    const msg = "This bot cannot be used in this server ⛔️";
    if (i.replied || i.deferred) return;
    return i.reply({ ephemeral: true, content: msg }).catch(() => {});
  }
  return null;
}

// ----------------- UI Helpers -----------------
function panelRow(isJava = false) {
  const title = isJava ? "Java AFKBot Panel 🎛️" : "Bedrock AFKBot Panel 🎛️";
  const startCustomId = isJava ? "start_java" : "start_bedrock";
  
  return {
    content: `**${title}**`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink Microsoft").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(startCustomId).setLabel("▶ Start").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

function adminPanelComponents() {
  const rows = [
    // Row 1: Core Controls
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_reconnect_all").setLabel("♻️ Reconnect All").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_stop_all").setLabel("🛑 Stop All").setStyle(ButtonStyle.Danger)
    ),
    // Row 2: Chat
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_chat_all").setLabel("📢 Chat (All)").setStyle(ButtonStyle.Success)
    )
  ];

  if (sessions.size > 0) {
    const options = [];
    let count = 0;
    for (const [uid, session] of sessions) {
      if (count >= 25) break; 
      options.push({ label: `User: ${uid}`, description: `Online since: ${new Date(session.startedAt).toLocaleTimeString()}`, value: uid });
      count++;
    }
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId("admin_force_stop_select").setPlaceholder("Select bot to Force Stop").addOptions(options)
    ));
  }
  return rows;
}

function getAdminStatsEmbed() {
  const memory = process.memoryUsage();
  const ramMB = (memory.rss / 1024 / 1024).toFixed(2);
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  
  const embed = new EmbedBuilder()
    .setTitle("🛠 Admin Control Center")
    .setColor("#2f3136")
    .setThumbnail("https://files.catbox.moe/9mqpoz.gif")
    .addFields(
      { name: "📊 System", value: `**RAM:** ${ramMB} MB\n**Uptime:** ${hours}h ${minutes}m`, inline: true },
      { name: "🤖 Bots", value: `**Active:** ${sessions.size}\n**Saved:** ${Object.keys(activeSessionsStore).length}`, inline: true },
      { name: "📡 Scan Channel", value: `<#${botConfig.scanChannelId}>`, inline: true }
    )
    .setFooter({ text: "Real-time Control • Administrative Access Only" })
    .setTimestamp();

  if (sessions.size > 0) {
    let botList = "";
    for (const [uid, s] of sessions) {
      const status = s.connected ? "🟢 Online" : (s.isReconnecting ? "⏳ Reconnecting" : "🔴 Offline");
      const ver = getUser(uid).bedrockVersion || "Auto";
      botList += `<@${uid}>: ${status} [${ver}]\n`;
    }
    embed.addFields({ name: "📋 Active Bot Registry", value: botList.slice(0, 1024) });
  }
  return embed;
}

// ----------------- Global Physics Loop (Optimization) -----------------
// Runs physics for ALL bots in one loop to save CPU
setInterval(() => {
    for (const [uid, s] of sessions) {
        if (!s.connected || !s.position) continue;
        
        const gravity = 0.08;
        
        // Apply Gravity
        if (!s.onGround) {
           s.velocity.y -= gravity;
        }

        if (s.velocity.y < -3.92) s.velocity.y = -3.92;
        
        s.position.add(s.velocity);

        // Void Protection
        if (s.position.y < -64) {
           s.position.y = 320; 
           s.velocity.y = 0;
        }

        try {
            s.client.write("player_auth_input", {
                pitch: s.pitch,
                yaw: s.yaw,
                position: { x: s.position.x, y: s.position.y, z: s.position.z },
                move_vector: { x: 0, z: 0 },
                head_yaw: s.yaw,
                input_data: 0n,
                input_mode: "mouse",
                play_mode: "screen",
                interaction_model: "touch",
                tick: 0n
            });
        } catch (e) {}
    }
}, 50);

// ----------------- Events: Ready & Startup -----------------
client.once("ready", async () => {
  console.log("🟢 Online as", client.user.tag);

  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
    new SlashCommandBuilder().setName("java").setDescription("Open Java AFKBot Panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Open Admin Control Panel"),
    new SlashCommandBuilder().setName("help").setDescription("Show available commands"),
    new SlashCommandBuilder().setName("setup").setDescription("Configure AFK scan channel")
        .addChannelOption(option => option.setName("channel").setDescription("Channel to scan").setRequired(true))
  ];
  await client.application.commands.set(cmds);

  // Admin refresh loop
  setInterval(async () => {
    if (lastAdminMessage) {
        try {
            await lastAdminMessage.edit({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() });
        } catch (e) { lastAdminMessage = null; }
    }
  }, 30000);

  // Auto-Rejoin Logic (Persistence)
  console.log("📂 Checking ReJoin.json for previous sessions...");
  const previousSessions = Object.keys(activeSessionsStore);
  
  if (previousSessions.length > 0) {
      console.log(`♻️ Found ${previousSessions.length} bots to restore. Starting them now...`);
      let delay = 0;
      for (const uid of previousSessions) {
          setTimeout(() => {
              startSession(uid, null, true);
          }, delay);
          delay += 10000; // 10s stagger to prevent rate limits
      }
  } else {
      console.log("⚪ No previous sessions found.");
  }
});

// ----------------- Microsoft Link -----------------
async function linkMicrosoft(uid, interaction) {
  // Ephemeral check to prevent overwriting the main message
  if (pendingLink.has(uid)) return interaction.editReply("⏳ Login already in progress.");
  
  const authDir = getUserAuthDir(uid);
  const u = getUser(uid);
  let codeShown = false;

  const flow = new Authflow(uid, authDir, { flow: "live", authTitle: Titles?.MinecraftNintendoSwitch, deviceType: "Nintendo" }, async (data) => {
      const uri = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
      const code = data.user_code || "(no code)";
      codeShown = true;
      const msg = `🔐 **Microsoft Authentication Required**\n\n1. Visit: ${uri}\n2. Enter Code: \`${code}\``;
      // Use editReply here because we deferred in the Interaction Handler
      await interaction.editReply({ content: msg, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("🌐 Open link").setStyle(ButtonStyle.Link).setURL(uri))] }).catch(() => {});
  });

  const p = (async () => {
    try {
      if (!codeShown) await interaction.editReply("⏳ Requesting code…");
      await flow.getMsaToken();
      u.linked = true; save();
      await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account linked!" });
    } catch (e) {
      await interaction.editReply(`❌ Login failed: ${e.message}`).catch(() => {});
    } finally { pendingLink.delete(uid); }
  })();
  pendingLink.set(uid, p);
}

// ----------------- Session Logic -----------------
function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.afkTimeout) clearTimeout(s.afkTimeout);
  try { s.client.close(); } catch {}
  sessions.delete(uid);
}

function stopSession(uid) {
  const s = sessions.get(uid);
  
  // REMOVE FROM PERSISTENCE
  if (activeSessionsStore[uid]) {
      delete activeSessionsStore[uid];
      saveActiveSessions();
  }
  
  if (!s) return false;
  s.manualStop = true; 
  cleanupSession(uid);
  return true;
}

function handleAutoReconnect(uid) {
    const s = sessions.get(uid);
    if (!s || s.manualStop) return;
    
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    
    s.isReconnecting = true;
    logToDiscord(`⏳ Bot of <@${uid}> disconnected. Reconnecting in 60s...`);

    s.reconnectTimer = setTimeout(() => {
        if (sessions.has(uid)) {
            const checkS = sessions.get(uid);
            // Verify persistence is still true
            if (!checkS.manualStop) {
                checkS.reconnectTimer = null; 
                startSession(uid, null, true); 
            } else {
                cleanupSession(uid);
            }
        }
    }, 60000); // 1 Minute
}

// Helper to handle defer/reply logic safely
async function safeReply(interaction, content) {
    if (!interaction) return;
    try {
        if (interaction.replied || interaction.deferred) await interaction.editReply(content);
        else await interaction.reply(content);
    } catch (e) {}
}

// ----------------- MAIN SESSION FUNCTION -----------------
async function startSession(uid, interaction, isReconnect = false) {
  const u = getUser(uid);
  
  // 1. ADD TO PERSISTENCE IMMEDIATELY
  if (!activeSessionsStore[uid]) {
      activeSessionsStore[uid] = true;
      saveActiveSessions();
  }

  if (!u.server) {
      if (!isReconnect) await interaction.editReply("⚠ Configure server settings first."); 
      delete activeSessionsStore[uid]; 
      saveActiveSessions(); 
      return; 
  }

  const { ip, port } = u.server;
  if (sessions.has(uid) && !isReconnect) return;

  const connectionEmbed = new EmbedBuilder()
    .setColor("#5865F2").setTitle("Bot Initialization")
    .setThumbnail("https://files.catbox.moe/9mqpoz.gif");

  // Skip Ping Logic
  const SKIP_PING_DOMAINS = ['.progamer.me', '.playserver.pro', '.freeservers.cloud'];
  const shouldSkipPing = SKIP_PING_DOMAINS.some(domain => ip.toLowerCase().endsWith(domain));

  // --- STEP 1: PREPARATION & PING ---
  try {
      if (!isReconnect) {
          if (shouldSkipPing) {
              connectionEmbed.setDescription(`⏩ **Skipping Ping (Known Host)**\n🌐 **Target:** \`${ip}:${port}\``);
          } else {
              connectionEmbed.setDescription(`🔍 **Pinging server...**\n🌐 **Target:** \`${ip}:${port}\``);
          }
          await safeReply(interaction, { embeds: [connectionEmbed], content: null, components: [] });
      }
      
      // Token Pre-load
      const preAuth = new Authflow(uid, getUserAuthDir(uid), { flow: "live", authTitle: Titles?.MinecraftNintendoSwitch, deviceType: "Nintendo" });
      try { await preAuth.getXboxToken(); } catch (e) {}

      // Ping check
      if (!shouldSkipPing) {
          await bedrock.ping({ host: ip, port: parseInt(port) || 19132, timeout: 5000 });
      }
      
      if (!isReconnect) {
          const statusText = shouldSkipPing ? "Attempting connection..." : "Server Online! Connecting...";
          connectionEmbed.setDescription(`✅ **${statusText}**\n🌐 **Target:** \`${ip}:${port}\``);
          await safeReply(interaction, { embeds: [connectionEmbed] });
      }
  } catch (err) {
      logToDiscord(`❌ Connection failure for <@${uid}>: Server ${ip}:${port} unreachable.`);
      if (isReconnect) {
          handleAutoReconnect(uid); 
      } else {
          connectionEmbed.setDescription(`❌ **Connection Failed**\nThe server at \`${ip}:${port}\` is offline or unreachable.`);
          connectionEmbed.setThumbnail(null); // Remove GIF on fail
          await safeReply(interaction, { embeds: [connectionEmbed] });
          delete activeSessionsStore[uid];
          saveActiveSessions();
      }
      return; 
  }

  // --- STEP 2: CONNECT ---
  const authDir = getUserAuthDir(uid);
  
  const opts = { 
      host: ip, 
      port: parseInt(port), 
      connectTimeout: 60000, 
      keepAlive: true,
      viewDistance: 4, 
      profilesFolder: authDir,
      username: uid,
      offline: false
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  }

  const mc = bedrock.createClient(opts);
  
  const currentSession = { 
      client: mc, 
      startedAt: Date.now(), 
      manualStop: false, 
      connected: false,
      isReconnecting: false,
      position: null,
      velocity: (Vec3) ? new Vec3(0, 0, 0) : null,
      yaw: 0,
      pitch: 0,
      onGround: false,
      reconnectTimer: null,
      afkTimeout: null,
  };
  sessions.set(uid, currentSession);

  // ==========================================
  // 🤖 ANTI-AFK (Look, Jump, Swing)
  // ==========================================
  const performAntiAfk = () => {
      if (!sessions.has(uid)) return;
      const s = sessions.get(uid);
      
      if (!s.connected || !s.position) {
          s.afkTimeout = setTimeout(performAntiAfk, 5000);
          return;
      }

      try {
          // Randomize Look
          s.yaw += (Math.random() - 0.5) * 20; 
          s.pitch += (Math.random() - 0.5) * 10;

          // Random Jump (if on ground)
          if (s.onGround && Math.random() > 0.9) {
              s.velocity.y = 0.42;
              s.onGround = false;
          }
          
          // Hand Swing (Animation)
          mc.write('animate', { action_id: 1, runtime_entity_id: s.entityId || 0n });
      } catch (e) {}

      const nextDelay = Math.random() * 20000 + 10000;
      s.afkTimeout = setTimeout(performAntiAfk, nextDelay);
  };

  // --- EVENTS ---
  mc.on("spawn", () => {
    logToDiscord(`✅ Bot of <@${uid}> spawned on **${ip}:${port}**` + (isReconnect ? " (Auto-Rejoined)" : ""));
    // Final Success Embed
    if (!isReconnect) {
        connectionEmbed.setDescription(`🟢 **Online** on \`${ip}:${port}\`\nPhysics & Hand Swing Active.`);
        connectionEmbed.setThumbnail(null); // Remove GIF on success
        safeReply(interaction, { embeds: [connectionEmbed] });
    }
  });

  mc.on("start_game", (packet) => {
      if (Vec3) {
          currentSession.position = new Vec3(packet.player_position.x, packet.player_position.y, packet.player_position.z);
      }
      currentSession.entityId = packet.runtime_entity_id;
      currentSession.connected = true;
      currentSession.isReconnecting = false;
      
      performAntiAfk();
  });
  
  mc.on("move_player", (packet) => {
      if (packet.runtime_id === currentSession.entityId && currentSession.position) {
          if (packet.position.y > currentSession.position.y) {
              currentSession.onGround = true;
              currentSession.velocity.y = 0;
          } else {
              currentSession.onGround = false;
          }
          currentSession.position.set(packet.position.x, packet.position.y, packet.position.z);
      }
  });
  
  mc.on("respawn", (packet) => {
      logToDiscord(`💀 Bot of <@${uid}> died and respawned.`);
      if (currentSession.position) {
          currentSession.position.set(packet.position.x, packet.position.y, packet.position.z);
          currentSession.velocity.set(0,0,0);
      }
  });

  mc.on("error", (e) => {
    if (!currentSession.manualStop) handleAutoReconnect(uid); 
    logToDiscord(`❌ Bot of <@${uid}> error: \`${e.message}\``);
  });

  mc.on("close", () => {
    if (!currentSession.manualStop) handleAutoReconnect(uid);
    logToDiscord(`🔌 Bot of <@${uid}> connection closed.`);
  });
}

// ----------------- Interactions (Lag Protected) -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    // 1. Instant Defer for EVERYTHING except Modals
    if (i.isButton()) {
        if (i.customId === "settings" || i.customId === "admin_chat_all") { } 
        else if (i.customId === "link") { await i.deferReply({ ephemeral: true }); }
        else { await i.deferUpdate().catch(() => {}); }
    } else if (i.isChatInputCommand()) {
        if (i.commandName !== "setup" && i.commandName !== "help") await i.deferReply();
    }

    const blocked = denyIfWrongGuild(i); if (blocked) return;
    const uid = i.user.id;

    if (i.isChatInputCommand()) {
      if (i.commandName === "help") {
          const embed = new EmbedBuilder().setTitle("📚 Commands Help").setColor("#00AAFF")
            .setDescription("Available commands:\n\n🎮 `/panel` - Main Panel\n☕ `/java` - Java Panel\n⚙ `/setup` - Set scan channel\n🤖 `:talk [msg]` - AI Chat");
          return i.reply({ embeds: [embed], ephemeral: true });
      }
      if (i.commandName === "setup") {
          if (uid !== ADMIN_ID) return i.reply({ content: "⛔ Admin only.", ephemeral: true });
          botConfig.scanChannelId = i.options.getChannel("channel").id; saveConfig();
          return i.reply({ content: "✅ Scan channel updated.", ephemeral: true });
      }
      if (i.commandName === "admin") {
          if (uid !== ADMIN_ID) return i.reply({ content: "Denied.", ephemeral: true });
          const msg = await i.reply({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents(), fetchReply: true });
          lastAdminMessage = msg;
      } else {
          await i.editReply(panelRow(i.commandName === "java"));
      }
      return;
    }

    if (i.isButton()) {
      if (i.customId === "admin_refresh") return i.editReply({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() });
      if (i.customId === "admin_stop_all") { sessions.forEach((s, id) => stopSession(id)); return i.followUp({ content: "🛑 Stopped.", ephemeral: true }); }
      if (i.customId === "admin_reconnect_all") {
        i.followUp({ content: "♻️ Reconnecting...", ephemeral: true });
        sessions.forEach((s, id) => { stopSession(id); setTimeout(() => startSession(id, null, true), 3000); });
        return;
      }
      if (i.customId === "confirm_start") return startSession(uid, i, false);
      if (i.customId === "start_bedrock" || i.customId === "start_java") {
         const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("confirm_start").setLabel("Confirm").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary));
         return i.followUp({ content: "Start session?", components: [row], ephemeral: true });
      }
      if (i.customId === "stop") { stopSession(uid); return i.followUp({ content: "⏹ Terminated.", ephemeral: true }); }
      if (i.customId === "link") return linkMicrosoft(uid, i);
      if (i.customId === "unlink") { unlinkMicrosoft(uid); return i.followUp({ content: "🗑 Unlinked.", ephemeral: true }); }
      if (i.customId === "cancel") return i.editReply({ content: "❌ Cancelled.", embeds: [], components: [] });
      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Config");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132)))
        );
        return i.showModal(modal);
      }
      if (i.customId === "admin_chat_all") {
          const modal = new ModalBuilder().setCustomId("admin_chat_modal").setTitle("Broadcast");
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("msg").setLabel("Message").setStyle(TextInputStyle.Short)));
          return i.showModal(modal);
      }
    }

    if (i.isModalSubmit()) {
        if (i.customId === "settings_modal") {
            const u = getUser(uid); u.server = { ip: i.fields.getTextInputValue("ip"), port: parseInt(i.fields.getTextInputValue("port")) }; save();
            return i.reply({ content: `✅ Saved.`, ephemeral: true });
        }
        if (i.customId === "admin_chat_modal") {
            const msg = i.fields.getTextInputValue("msg");
            sessions.forEach(s => { if (s.client) try { s.client.queue('text', { type: 'chat', needs_translation: false, source_name: s.client.username, xuid: '', message: msg }); } catch(e){} });
            return i.reply({ content: "📢 Sent.", ephemeral: true });
        }
    }
  } catch (e) { console.error("Interaction Error:", e); }
});

// --- MESSAGE HANDLER (AI & SCANNING) ---
client.on(Events.MessageCreate, async (m) => {
    if (m.author.bot) return;

    // AI Chat
    if (m.content.startsWith(":talk")) {
        const query = m.content.slice(5).trim(); if (!query) return;
        try {
            const r = await m.react('<a:loading:1470137639339299053>');
            const result = await aiModel.generateContent(query);
            await r.remove(); await m.reply((await result.response).text());
        } catch (e) { m.reply("⚠️ AI error."); }
        return;
    }

    // AFK Scanning
    if (botConfig.scanChannelId && m.channel.id === botConfig.scanChannelId) {
        if (['afk', 'afkbot'].some(w => m.content.toLowerCase().includes(w))) {
            try {
                const r = await m.react('<a:loading:1470137639339299053>');
                setTimeout(async () => { try { await r.remove(); await m.reply("What bout me? 😁"); } catch (e) {} }, 3000);
            } catch (e) {}
        }
    }
});

client.login(DISCORD_TOKEN);
