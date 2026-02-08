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
  EmbedBuilder
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// --- DEPENDENCIES FOR PHYSICS ---
let Vec3;
try {
  Vec3 = require("vec3");
} catch (e) {
  console.log("⚠️  Physics dependencies missing! Bot will not fall. Run: npm install vec3");
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

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

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

// Load Users
let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};

// Load ReJoin Data (Active Sessions)
let activeSessionsStore = fs.existsSync(REJOIN_STORE) ? JSON.parse(fs.readFileSync(REJOIN_STORE, "utf8")) : {};

function save() {
  fs.writeFileSync(STORE, JSON.stringify(users, null, 2));
}

function saveActiveSessions() {
  fs.writeFileSync(REJOIN_STORE, JSON.stringify(activeSessionsStore, null, 2));
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
const lastMsa = new Map();
let lastAdminMessage = null; 

// ----------------- Discord client -----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages
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

// ----------------- UI helpers -----------------
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
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_refresh").setLabel("🔄 Refresh Stats").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_stop_all").setLabel("🛑 Force Stop All").setStyle(ButtonStyle.Danger)
    )
  ];

  if (sessions.size > 0) {
    const options = [];
    let count = 0;
    for (const [uid, session] of sessions) {
      if (count >= 25) break; 
      options.push({ label: `User: ${uid}`, description: `Started: ${new Date(session.startedAt).toLocaleTimeString()}`, value: uid });
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
    .setTitle("🛠 Admin Panel")
    .setColor("#2f3136")
    .addFields(
      { name: "📊 Performance", value: `**RAM:** ${ramMB} MB\n**Uptime:** ${hours}h ${minutes}m`, inline: true },
      { name: "🤖 Active Sessions", value: `**Total Bots:** ${sessions.size}`, inline: true },
      { name: "💾 Persisted Sessions", value: `**Saved for Restart:** ${Object.keys(activeSessionsStore).length}`, inline: true }
    )
    .setFooter({ text: "Auto-refreshing every 30s • Administrative Access Only" })
    .setTimestamp();

  if (sessions.size > 0) {
    let botList = "";
    for (const [uid, s] of sessions) {
      const status = s.connected ? "🟢 Online" : (s.isReconnecting ? "⏳ Reconnecting" : "🔴 Offline");
      botList += `<@${uid}>: ${status}\n`;
    }
    embed.addFields({ name: "📋 Active Bot Registry", value: botList.slice(0, 1024) });
  }
  return embed;
}

// ----------------- Events: Ready & Startup Rejoin -----------------
client.once("ready", async () => {
  console.log("🟢 Online as", client.user.tag);

  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
    new SlashCommandBuilder().setName("java").setDescription("Open Java AFKBot Panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Open Admin Control Panel")
  ];
  await client.application.commands.set(cmds);

  // Admin Refresh Loop
  setInterval(async () => {
    if (lastAdminMessage) {
        try {
            await lastAdminMessage.edit({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() });
        } catch (e) { lastAdminMessage = null; }
    }
  }, 30000);

  // PROCESS REJOINS
  console.log("📂 Checking ReJoin.json for previous sessions...");
  const previousSessions = Object.keys(activeSessionsStore);
  
  if (previousSessions.length > 0) {
      console.log(`♻️ Found ${previousSessions.length} bots to restore. Starting them now...`);
      let delay = 0;
      for (const uid of previousSessions) {
          setTimeout(() => {
              startSession(uid, null, true);
          }, delay);
          delay += 5000; 
      }
  } else {
      console.log("⚪ No previous sessions found.");
  }
});

// ----------------- Microsoft link -----------------
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) return interaction.editReply("⏳ Login already in progress. Use the last code.");
  const authDir = getUserAuthDir(uid);
  const u = getUser(uid);
  let codeShown = false;

  const flow = new Authflow(uid, authDir, { flow: "live", authTitle: Titles?.MinecraftNintendoSwitch || "Bedrock AFK Bot", deviceType: "Nintendo" }, async (data) => {
      const uri = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
      const code = data.user_code || "(no code)";
      lastMsa.set(uid, { uri, code, at: Date.now() });
      codeShown = true;
      const msg = `🔐 **Microsoft Authentication Required**\n\n1. Visit: ${uri}\n2. Enter Code: \`${code}\`\n\n⚠️ **Important:** Please use an alternative account.`;
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
  
  // Clear Timers
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.physicsLoop) clearInterval(s.physicsLoop);
  if (s.afkTimeout) clearTimeout(s.afkTimeout);

  try { s.client.close(); } catch {}
  sessions.delete(uid);
}

function stopSession(uid) {
  const s = sessions.get(uid);
  
  if (activeSessionsStore[uid]) {
      delete activeSessionsStore[uid];
      saveActiveSessions();
  }

  if (!s) return false;
  s.manualStop = true; 
  cleanupSession(uid);
  return true;
}

// ----------------- Auto Reconnect Handling -----------------
function handleAutoReconnect(uid) {
    const s = sessions.get(uid);
    if (!s || s.manualStop) return;
    
    // PREVENT DUPLICATE TIMERS
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    
    s.isReconnecting = true;
    logToDiscord(`⏳ Bot of <@${uid}> disconnected. Reconnecting in 60s...`);

    s.reconnectTimer = setTimeout(() => {
        if (sessions.has(uid)) {
            const checkS = sessions.get(uid);
            if (!checkS.manualStop) {
                checkS.reconnectTimer = null; 
                startSession(uid, null, true); 
            } else {
                cleanupSession(uid);
            }
        }
    }, 60000); // 1 Minute Wait
}

// ----------------- HELPER: Safe Reply -----------------
async function safeReply(interaction, content) {
    if (!interaction) return;
    try {
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply(content);
        } else {
            await interaction.reply(content);
        }
    } catch (e) {}
}

// ----------------- MAIN SESSION FUNCTION -----------------
async function startSession(uid, interaction, isReconnect = false) {
  const u = getUser(uid);
  
  if (!activeSessionsStore[uid]) {
      activeSessionsStore[uid] = true;
      saveActiveSessions();
  }

  if (!u.server) {
      if (!isReconnect) await safeReply(interaction, "⚠ Please configure your server settings first.");
      delete activeSessionsStore[uid];
      saveActiveSessions();
      return;
  }

  const { ip, port } = u.server;

  if (sessions.has(uid) && !isReconnect) {
      // Check if it's just a zombie session
      const zombie = sessions.get(uid);
      if (!zombie.connected && !zombie.isReconnecting) {
          cleanupSession(uid);
      } else {
          return safeReply(interaction, "⚠️ **Session Conflict**: Active session already exists.").catch(() => {});
      }
  }

  // --- MOTD PING ---
  try {
      if (!isReconnect) await safeReply(interaction, { content: "🔍 Pinging server...", embeds: [], components: [] });
      
      const pingPort = parseInt(port) || 19132;
      await bedrock.ping({ host: ip, port: pingPort, timeout: 5000 });
      
      if (!isReconnect) await safeReply(interaction, "✅ **Server found! Joining...**");
  } catch (err) {
      logToDiscord(`❌ Connection failure for <@${uid}>: Server ${ip}:${port} unreachable.`);
      if (isReconnect) handleAutoReconnect(uid); 
      else await safeReply(interaction, `❌ **Connection Failed**: Server offline.`);
      return; 
  }

  // --- CLIENT SETUP ---
  const authDir = getUserAuthDir(uid);
  
  const opts = { 
      host: ip, 
      port: parseInt(port), 
      connectTimeout: 60000, 
      keepAlive: true,
      viewDistance: 4, // OPTIMIZED for RAM
      profilesFolder: authDir,
      username: uid,
      offline: false
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  }

  const mc = bedrock.createClient(opts);
  
  // SESSION STATE
  const currentSession = { 
      client: mc, 
      startedAt: Date.now(), 
      manualStop: false, 
      connected: false,
      isReconnecting: false,
      // Physics Data
      // Initialized to null to wait for start_game
      position: null,
      velocity: (Vec3) ? new Vec3(0, 0, 0) : null,
      yaw: 0,
      pitch: 0,
      onGround: false,
      // Timers
      reconnectTimer: null,
      physicsLoop: null,
      afkTimeout: null
  };
  sessions.set(uid, currentSession);

  // ==========================================
  // 🍎 GRAVITY & PHYSICS ENGINE (Server Corrected)
  // ==========================================
  if (Vec3) {
      // 3. Gravity / Physics Loop (20 TPS)
      currentSession.physicsLoop = setInterval(() => {
          // CRITICAL FIX: Do not run physics if we haven't received spawn coordinates yet.
          if (!currentSession.connected || !currentSession.position) return;
          
          const gravity = 0.08; 
          
          // Always try to apply gravity if not grounded
          if (!currentSession.onGround) {
             currentSession.velocity.y -= gravity;
          } else {
             // Keep a tiny downward velocity to stick to the floor
             currentSession.velocity.y = -0.01;
          }

          // Terminal velocity
          if (currentSession.velocity.y < -3.0) currentSession.velocity.y = -3.0;
          
          // Apply velocity
          currentSession.position.add(currentSession.velocity);

          // Void Protection
          if (currentSession.position.y < -64) {
             currentSession.position.y = 100; // Rubberband up
             currentSession.velocity.y = 0;
          }

          // SEND POSITION PACKET (Heartbeat)
          try {
              mc.write("player_auth_input", {
                 pitch: currentSession.pitch,
                 yaw: currentSession.yaw,
                 position: { x: currentSession.position.x, y: currentSession.position.y, z: currentSession.position.z },
                 move_vector: { x: 0, z: 0 },
                 head_yaw: currentSession.yaw,
                 input_data: 0n,
                 input_mode: "mouse",
                 play_mode: "screen",
                 interaction_model: "touch",
                 tick: 0n
              });
          } catch (e) {}

      }, 50); // 20 times a second
  }

  // ==========================================
  // 🤖 HUMAN-LIKE ANTI-AFK
  // ==========================================
  const performAntiAfk = () => {
      if (!sessions.has(uid)) return;
      const s = sessions.get(uid);
      
      // Guard clause
      if (!s.connected || !s.position) {
          s.afkTimeout = setTimeout(performAntiAfk, 5000);
          return;
      }

      try {
          // Randomize look direction
          s.yaw += (Math.random() - 0.5) * 10; 
          s.pitch += (Math.random() - 0.5) * 5;

          // Occasional Jump (only if grounded)
          if (s.onGround && Math.random() > 0.8) {
              s.velocity.y = 0.42;
              s.onGround = false;
          }
          
          // Send update (Physics loop handles the position packet, we just updated yaw/pitch/velocity)
          
          // Swing Arm
          mc.write('animate', {
             action_id: 1, 
             runtime_entity_id: s.entityId || 0n
          });

      } catch (e) {}

      // Schedule next action (Random: 2s to 10s)
      const nextDelay = Math.random() * 8000 + 2000;
      s.afkTimeout = setTimeout(performAntiAfk, nextDelay);
  };


  // --- EVENTS ---
  mc.on("spawn", () => {
    // We log here, but physics waits for start_game
    logToDiscord(`✅ Bot of <@${uid}> spawned on **${ip}:${port}**` + (isReconnect ? " (Auto-Rejoined)" : ""));
    if (!isReconnect) safeReply(interaction, `🟢 **Connected**`);
  });

  // Use start_game to get the initial coordinates safely
  mc.on("start_game", (packet) => {
      if (Vec3) {
          currentSession.position = new Vec3(packet.player_position.x, packet.player_position.y, packet.player_position.z);
      }
      currentSession.entityId = packet.runtime_entity_id;
      currentSession.connected = true;
      currentSession.isReconnecting = false;
      
      performAntiAfk();
  });
  
  // SERVER CORRECTION: This fixes the floating issue
  mc.on("move_player", (packet) => {
      if (packet.runtime_id === currentSession.entityId && currentSession.position) {
          const serverY = packet.position.y;
          const clientY = currentSession.position.y;

          // If server stopped our fall, we are on ground
          if (serverY >= clientY) {
              currentSession.onGround = true;
              currentSession.velocity.y = 0;
          } else {
              currentSession.onGround = false;
          }

          currentSession.position.set(packet.position.x, packet.position.y, packet.position.z);
      }
  });
  
  // Respawn Handling
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

// ----------------- Interactions -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    const blocked = denyIfWrongGuild(i);
    if (blocked) return;
    const uid = i.user.id;

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return safeReply(i, panelRow(false));
      if (i.commandName === "java") return safeReply(i, panelRow(true));
      if (i.commandName === "admin") {
        if (uid !== ADMIN_ID || i.channelId !== ADMIN_CHANNEL_ID) return safeReply(i, { content: "⛔ Access restricted.", ephemeral: true });
        const msg = await i.reply({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents(), fetchReply: true });
        lastAdminMessage = msg;
        return;
      }
    }

    if (i.isButton()) {
      if (i.customId === "admin_refresh") {
        return i.update({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() }).catch(() => {});
      }

      if (i.customId === "start_bedrock") {
        if (sessions.has(uid)) return safeReply(i, { ephemeral: true, content: "⚠️ **Session Conflict**: Active session exists." });
        
        const embed = new EmbedBuilder().setTitle("Bedrock Connection").setDescription("Start bot?").setColor("#2ECC71");
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("confirm_start").setLabel("Start").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
        );
        return i.reply({ embeds: [embed], components: [row], ephemeral: true }).catch(() => {});
      }

      if (i.customId === "confirm_start") {
          await i.deferUpdate().catch(() => {});
          return startSession(uid, i, false);
      }

      if (i.customId === "cancel") return i.update({ content: "❌ Cancelled.", embeds: [], components: [] }).catch(() => {});
      
      if (i.customId === "stop") {
        const ok = stopSession(uid);
        return safeReply(i, { ephemeral: true, content: ok ? "⏹ **Session Terminated.**" : "No active sessions." });
      }

      if (i.customId === "link") {
          await i.deferReply({ ephemeral: true }).catch(() => {});
          return linkMicrosoft(uid, i);
      }

      if (i.customId === "unlink") {
        unlinkMicrosoft(uid);
        return safeReply(i, { ephemeral: true, content: "🗑 Unlinked." });
      }

      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Configuration");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setRequired(true).setValue(u.server?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(u.server?.port || 19132)))
        );
        return i.showModal(modal);
      }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
        const ip = i.fields.getTextInputValue("ip").trim();
        const port = parseInt(i.fields.getTextInputValue("port").trim(), 10);
        const u = getUser(uid);
        u.server = { ip, port };
        save();
        return safeReply(i, { ephemeral: true, content: `✅ Saved: **${ip}:${port}**` });
    }

  } catch (e) { console.error(e); }
});

process.on("unhandledRejection", (e) => console.error("Unhandled Rejection:", e));
client.login(DISCORD_TOKEN);
