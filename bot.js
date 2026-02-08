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
// This 'data' folder is where your Fly.io volume should be mounted
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");
const REJOIN_STORE = path.join(DATA, "ReJoin.json"); // New file for persistence

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

// Load Users
let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};

// Load ReJoin Data (Active Sessions)
let activeSessionsStore = fs.existsSync(REJOIN_STORE) ? JSON.parse(fs.readFileSync(REJOIN_STORE, "utf8")) : {};

function save() {
  fs.writeFileSync(STORE, JSON.stringify(users, null, 2));
}

// Function to save which bots should be running
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
// 🛡️ CRASH PREVENTION SYSTEM (THE FIX)
// ==========================================================
// These listeners stop the bot from dying when Discord API fails
client.on("error", (error) => {
    console.error("⚠️ Discord Client Error (Ignored):", error.message);
});

client.on("shardError", (error) => {
    console.error("⚠️ WebSocket Error (Ignored):", error.message);
});

process.on("uncaughtException", (err) => {
    console.error("🔥 Uncaught Exception:", err);
    // We do NOT exit here, keeping the bot alive.
});
// ==========================================================

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

  // 1. Set Commands
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
    new SlashCommandBuilder().setName("java").setDescription("Open Java AFKBot Panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Open Admin Control Panel")
  ];
  await client.application.commands.set(cmds);

  // 2. Start Admin Refresh Loop
  setInterval(async () => {
    if (lastAdminMessage) {
        try {
            await lastAdminMessage.edit({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() });
        } catch (e) {
            lastAdminMessage = null; 
        }
    }
  }, 30000);

  // 3. PROCESS REJOINS (The Magic Part)
  // This logic runs every time the app deploys/restarts
  console.log("📂 Checking ReJoin.json for previous sessions...");
  const previousSessions = Object.keys(activeSessionsStore);
  
  if (previousSessions.length > 0) {
      console.log(`♻️ Found ${previousSessions.length} bots to restore. Starting them now...`);
      let delay = 0;
      for (const uid of previousSessions) {
          // Add a slight delay between starts to prevent flooding
          setTimeout(() => {
              // We pass true for isReconnect so it doesn't try to reply to a non-existent interaction
              startSession(uid, null, true);
          }, delay);
          delay += 5000; // 5 seconds stagger
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
  if (s.timeout) clearTimeout(s.timeout);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  try { s.client.close(); } catch {}
  sessions.delete(uid);
}

function stopSession(uid) {
  const s = sessions.get(uid);
  
  // REMOVE FROM PERSISTENCE (So it doesn't auto-start on next deploy)
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
    if (!s || s.manualStop || s.reconnectTimer) return;
    
    s.isReconnecting = true;
    logToDiscord(`⏳ Bot of <@${uid}> disconnected. Reconnecting in 2 minutes...`);

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
    }, 60000); // 2 Minutes
}

// ----------------- MAIN SESSION FUNCTION -----------------
async function startSession(uid, interaction, isReconnect = false) {
  const u = getUser(uid);
  
  // MARK AS ACTIVE IN PERSISTENCE IMMEDIATELY
  if (!activeSessionsStore[uid]) {
      activeSessionsStore[uid] = true;
      saveActiveSessions();
  }

  const reply = async (msgObj) => {
    if (!isReconnect && interaction) {
      try {
        if (typeof msgObj === 'string') await interaction.editReply(msgObj);
        else await interaction.editReply(msgObj);
      } catch (e) { /* ignore expired interaction */ }
    }
  };

  if (!u.server) {
      await reply("⚠ Please configure your server settings first.");
      // If config is missing, we shouldn't persist the session
      delete activeSessionsStore[uid];
      saveActiveSessions();
      return;
  }

  const { ip, port } = u.server;

  if (sessions.has(uid) && !isReconnect) {
      return reply("⚠️ **Session Conflict**: An active bot session is already associated with your account.").catch(() => {});
  }

  // --- MOTD PING CHECK ---
  try {
      if (!isReconnect) await reply({ content: "🔍 Pinging server...", embeds: [], components: [] }).catch(() => {});
      
      const pingPort = parseInt(port) || 19132;
      await bedrock.ping({ host: ip, port: pingPort, timeout: 5000 });
      
      if (!isReconnect) await reply("✅ **Server found! Joining...**").catch(() => {});
  } catch (err) {
      logToDiscord(`❌ Connection failure for <@${uid}>: Server ${ip}:${port} is offline or unreachable.`);
      
      if (isReconnect) {
          // INFINITE LOOP LOGIC:
          // If server is down during reconnect/auto-boot, wait and try again.
          handleAutoReconnect(uid); 
      } else {
          await reply(`❌ **Connection Failed**: The server is currently offline.`).catch(() => {});
      }
      return; 
  }

  // --- CLIENT SETUP ---
  const authDir = getUserAuthDir(uid);
  const opts = { host: ip, port: parseInt(port), connectTimeout: 47000, keepAlive: true };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  } else {
    opts.username = uid;
    opts.offline = false;
    opts.profilesFolder = authDir;
  }

  const mc = bedrock.createClient(opts);
  
  const currentSession = { 
      client: mc, 
      timeout: null, 
      startedAt: Date.now(), 
      manualStop: false, 
      connected: false,
      isReconnecting: false 
  };
  sessions.set(uid, currentSession);

  // --- ANTI-CHEAT & ANTI-AFK BYPASS (JUMPING) ---
  const waitForEntity = setInterval(() => {
    if (!mc.entity || !mc.entityId) return;
    clearInterval(waitForEntity);

    const afkInterval = setInterval(() => {
      try {
        if (!mc.entity || !mc.entity.position) return;
        
        const JUMP_FLAG = 8n; 

        mc.write("player_auth_input", {
          pitch: 0,
          yaw: 0,
          position: { 
            x: mc.entity.position.x, 
            y: mc.entity.position.y, 
            z: mc.entity.position.z 
          },
          move_vector: { x: 0, z: 0 },
          head_yaw: 0,
          input_data: JUMP_FLAG, 
          input_mode: "mouse",
          play_mode: "screen",
          interaction_model: "touch",
          tick: 0n
        });
      } catch (e) {}
    }, 15000); // 15s

    mc.once("close", () => clearInterval(afkInterval));
  }, 1000);

  // --- EVENTS ---
  mc.on("spawn", () => {
    currentSession.connected = true;
    clearTimeout(currentSession.timeout);
    if (!isReconnect) reply(`🟢 **Successfully Connected** to **${ip}:${port}**`).catch(() => {});
    logToDiscord(`✅ Bot of <@${uid}> spawned on **${ip}:${port}**` + (isReconnect ? " (Auto-Rejoined)" : ""));
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
      if (i.commandName === "panel") return i.reply(panelRow(false));
      if (i.commandName === "java") return i.reply(panelRow(true));
      if (i.commandName === "admin") {
        if (uid !== ADMIN_ID || i.channelId !== ADMIN_CHANNEL_ID) return i.reply({ content: "⛔ Access restricted.", ephemeral: true });
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
        if (sessions.has(uid)) return i.reply({ ephemeral: true, content: "⚠️ **Session Conflict**: Please terminate your last session to start a new one." });
        
        const embed = new EmbedBuilder()
            .setTitle("Bedrock Server Connection")
            .setDescription("Confirm initiation of bot connection to the configured Bedrock server.")
            .setColor("#2ECC71");

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("confirm_start").setLabel("Confirm & Start").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
        );
        return i.reply({ embeds: [embed], components: [row], ephemeral: true }).catch(() => {});
      }

      if (i.customId === "start_java") {
        if (sessions.has(uid)) return i.reply({ ephemeral: true, content: "⚠️ **Session Conflict**: Please terminate your last session to start a new one." });

        const embed = new EmbedBuilder()
          .setTitle("⚙️ Java Compatibility Check")
          .setDescription("For a successful connection to a Java server, ensure the following plugins are installed.")
          .addFields(
              { name: "Required Plugins", value: "• GeyserMC\n• Floodgate\n• ViaVersion\n• ViaBackwards" }
          )
          .setColor("#E67E22");

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("confirm_start").setLabel("Confirm & Start").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
        );
        return i.reply({ embeds: [embed], components: [row], ephemeral: true }).catch(() => {});
      }

      if (i.customId === "confirm_start") {
          // Safeguard the defer update
          await i.deferUpdate().catch(() => {});
          return startSession(uid, i, false);
      }

      if (i.customId === "cancel") return i.update({ content: "❌ Cancelled.", embeds: [], components: [] }).catch(() => {});
      
      if (i.customId === "stop") {
        const ok = stopSession(uid);
        return i.reply({ ephemeral: true, content: ok ? "⏹ **Session Terminated.**" : "No active sessions found." }).catch(() => {});
      }

      if (i.customId === "link") {
          await i.deferReply({ ephemeral: true }).catch(() => {});
          return linkMicrosoft(uid, i);
      }

      if (i.customId === "unlink") {
        unlinkMicrosoft(uid);
        return i.reply({ ephemeral: true, content: "🗑 Microsoft account link removed." }).catch(() => {});
      }

      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Configuration");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setRequired(true).setValue(u.server?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(u.server?.port || 19132))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("offline").setLabel("Offline Username (Discontinued)").setStyle(TextInputStyle.Short).setRequired(false).setValue(u.offlineUsername || ""))
        );
        return i.showModal(modal);
      }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
        const ip = i.fields.getTextInputValue("ip").trim();
        const port = parseInt(i.fields.getTextInputValue("port").trim(), 10);
        const u = getUser(uid);
        u.server = { ip, port };
        u.offlineUsername = i.fields.getTextInputValue("offline").trim();
        save();
        return i.reply({ ephemeral: true, content: `✅ Saved: **${ip}:${port}**` }).catch(() => {});
    }

  } catch (e) {
    console.error(e);
  }
});

// Also catch globally
process.on("unhandledRejection", (e) => console.error("Unhandled Rejection:", e));
client.login(DISCORD_TOKEN);
