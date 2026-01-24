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
const os = require("os");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

// ----------------- Asetukset (User IDs & Channel IDs) -----------------
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_ID = "1144987924123881564";
const LOG_CHANNEL_ID = "1464615030111731753";
const ADMIN_CHANNEL_ID = "1464615993320935447";
const CONN_TIMEOUT_MS = 25000; // 25 sekuntia

// ----------------- Storage -----------------
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};
function save() {
  fs.writeFileSync(STORE, JSON.stringify(users, null, 2));
}

function getUser(uid) {
  if (!users[uid]) users[uid] = {};
  if (!users[uid].delayMs) users[uid].delayMs = 5000;
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  if (users[uid].active === undefined) users[uid].active = false; // Uusi kenttä pysyvyydelle
  return users[uid];
}

function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ----------------- Runtime State -----------------
const sessions = new Map();
const pendingLink = new Map();
let adminPanelMessage = null; 

// ----------------- Discord Client -----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages
  ]
});

async function logToDiscord(message, color = "#5865F2") {
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (channel) {
      const embed = new EmbedBuilder()
        .setColor(color)
        .setDescription(message)
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    }
  } catch (e) {
    console.error("Logging error:", e);
  }
}

async function sendUserDM(uid, message) {
  try {
    const user = await client.users.fetch(uid);
    if (user) await user.send(message);
  } catch (e) {
    console.warn(`Could not send DM to ${uid}:`, e.message);
  }
}

function denyIfWrongGuild(i) {
  if (!i.inGuild() || i.guildId !== ALLOWED_GUILD_ID) {
    const msg = "This bot cannot be used in this server ⛔️";
    if (i.deferred) return i.editReply(msg).catch(() => {});
    if (i.replied) return i.followUp({ ephemeral: true, content: msg }).catch(() => {});
    return i.reply({ ephemeral: true, content: msg }).catch(() => {});
  }
  return null;
}

// ----------------- UI Helpers -----------------
function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("more").setLabel("➕ More").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function adminPanelComponents() {
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_refresh").setLabel("🔄 Refresh Now").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_stop_all").setLabel("🛑 Force Stop All").setStyle(ButtonStyle.Danger)
    )
  ];

  if (sessions.size > 0) {
    const options = [];
    let count = 0;
    for (const [uid, session] of sessions) {
      if (count >= 25) break;
      options.push({
        label: `User: ${uid}`,
        description: session.connected ? "🟢 Online" : "🔴 Connecting",
        value: uid
      });
      count++;
    }

    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("admin_force_stop_select")
          .setPlaceholder("Select a bot to Force Stop")
          .addOptions(options)
      )
    );
  }

  return rows;
}

// ----------------- Bedrock Session Logic -----------------
function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.afkInterval) clearInterval(s.afkInterval);
  
  try {
    s.client.removeAllListeners();
    s.client.close();
  } catch {}
  
  sessions.delete(uid);
  if (global.gc) global.gc();
}

function stopSession(uid, manual = true) {
  const s = sessions.get(uid);
  if (!s && manual) {
      // Vaikka sessiota ei ole RAMissa, varmistetaan että se on pois päältä levyllä
      const u = getUser(uid);
      u.active = false;
      save();
  }
  
  if (!s) return false;
  
  if (manual) {
    const u = getUser(uid);
    u.active = false; // Tallennetaan että käyttäjä halusi sammuttaa botin
    save();
    s.manualStop = true;
  }
  
  cleanupSession(uid);
  return true;
}

function startSession(uid, interaction = null) {
  const u = getUser(uid);
  if (!u.server) {
    if (interaction && !interaction.replied) interaction.editReply("⚠ Set settings first.");
    return;
  }
  
  if (sessions.has(uid) && !sessions.get(uid).isReconnecting) {
    if (interaction && !interaction.replied) interaction.editReply("⚠ Bot is already running.");
    return;
  }

  // Merkitään botti aktiiviseksi levylle
  u.active = true;
  save();

  const { ip, port } = u.server;
  const authDir = getUserAuthDir(uid);

  const opts = {
    host: ip,
    port,
    connectTimeout: CONN_TIMEOUT_MS,
    keepAlive: true
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  } else {
    opts.username = uid;
    opts.offline = false;
    opts.profilesFolder = authDir;
  }

  const mc = bedrock.createClient(opts);
  
  let currentSession = sessions.get(uid) || { 
    startedAt: Date.now(), 
    manualStop: false, 
    connected: false,
    packetsReceived: 0
  };
  currentSession.client = mc;
  currentSession.isReconnecting = false;
  sessions.set(uid, currentSession);

  mc.on('packet', (packet) => {
    currentSession.packetsReceived++;
    const name = packet.data.name;
    if (name === 'level_chunk' || name === 'subchunk') {
      packet.data.payload = null; 
    }
  });

  mc.on('play_status', (packet) => {
    if (packet.status === 'player_spawn' || packet.status === 'login_success') {
      if (!currentSession.connected) {
        handleSpawn(uid, mc, currentSession, interaction, ip, port);
      }
    }
  });

  mc.on("spawn", () => {
    if (!currentSession.connected) {
      handleSpawn(uid, mc, currentSession, interaction, ip, port);
    }
  });

  currentSession.timeout = setTimeout(() => {
    if (sessions.has(uid) && !currentSession.connected) {
      if (interaction && interaction.deferred) {
        interaction.editReply("❌ Connection error: Server did not respond in 25s.").catch(() => {});
      }
      logToDiscord(`⚠️ Bot for <@${uid}>: Connection timeout (25s) on ${ip}`, "#FFFF00");
      mc.close();
    }
  }, CONN_TIMEOUT_MS);

  mc.on("error", (e) => {
    clearTimeout(currentSession.timeout);
    if (!currentSession.manualStop) handleAutoReconnect(uid, interaction);
  });

  mc.on("close", () => {
    clearTimeout(currentSession.timeout);
    if (!currentSession.manualStop) handleAutoReconnect(uid, interaction);
  });
}

function handleSpawn(uid, mc, currentSession, interaction, ip, port) {
  currentSession.connected = true;
  clearTimeout(currentSession.timeout);
  
  if (interaction && interaction.deferred) {
    interaction.editReply(`🟢 Connected to **${ip}:${port}** (Auto-restore active)` ).catch(() => {});
  }
  logToDiscord(`✅ Bot for <@${uid}> Online on ${ip}`, "#00FF00");

  let moveToggle = false;
  currentSession.afkInterval = setInterval(() => {
    try {
      if (!mc.entityId) return;
      const pos = mc.entity?.position || { x: 0, y: 0, z: 0 };
      const newPos = { ...pos };
      newPos.x += moveToggle ? 0.2 : -0.2;
      moveToggle = !moveToggle;

      mc.write("move_player", {
        runtime_id: mc.entityId,
        position: newPos,
        pitch: 0, yaw: 0, head_yaw: 0,
        mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false
      });
    } catch {}
  }, 60000);
}

function handleAutoReconnect(uid, interaction) {
    const s = sessions.get(uid);
    if (!s || s.manualStop || s.reconnectTimer) return;
    s.isReconnecting = true;
    s.connected = false;
    s.reconnectTimer = setTimeout(() => {
        if (sessions.has(uid) && !s.manualStop) {
            s.reconnectTimer = null;
            startSession(uid, interaction);
        }
    }, 120000); 
}

// ----------------- Admin Analytics -----------------
function getAdminStatsEmbed() {
  const memory = process.memoryUsage();
  const ramRSS = (memory.rss / 1024 / 1024).toFixed(2);
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  
  const embed = new EmbedBuilder()
    .setTitle("🚀 Admin Analytics Dashboard")
    .setColor("#2F3136")
    .addFields(
      { name: "💻 System", value: `**RAM:** ${ramRSS} MB\n**Uptime:** ${hours}h ${minutes}m\n**Active Bots:** ${sessions.size}`, inline: true },
      { name: "📊 Storage", value: `**Linked:** ${Object.keys(users).length}\n**Auto-Restore:** Active`, inline: true }
    )
    .setTimestamp();

  if (sessions.size > 0) {
    let list = "";
    for (const [uid, s] of sessions) {
      const status = s.connected ? "🟢 Online" : (s.isReconnecting ? "⏳ Retry" : "🔴 Conn");
      list += `<@${uid}>: ${status}\n`;
    }
    embed.addFields({ name: "🤖 Active Sessions", value: list.slice(0, 1024) });
  }

  return embed;
}

// ----------------- Discord Client Events -----------------
client.once("ready", async () => {
  console.log("🟢 Bot Online. Restoring sessions...");

  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("User AFK Panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Admin Analytics Panel")
  ];
  await client.application.commands.set(cmds);

  // --- AUTOMAATTINEN PALAUTUS (KORJAA BLACKDOWNIN) ---
  const activeUids = Object.keys(users).filter(uid => users[uid].active === true);
  if (activeUids.length > 0) {
    console.log(`♻️ Restoring ${activeUids.length} sessions...`);
    logToDiscord(`♻️ **Deployment Finished**: Restoring ${activeUids.length} active sessions automatically...`);
    
    // Yhdistetään botit pienellä viiveellä, ettei Fly.io piikkaa heti
    for (let i = 0; i < activeUids.length; i++) {
      setTimeout(() => {
        startSession(activeUids[i]);
      }, i * 3000); 
    }
  }

  setInterval(async () => {
    if (adminPanelMessage) {
      try {
        await adminPanelMessage.edit({ 
          embeds: [getAdminStatsEmbed()], 
          components: adminPanelComponents() 
        });
      } catch (e) { adminPanelMessage = null; }
    }
  }, 30000);
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    const blocked = denyIfWrongGuild(i);
    if (blocked) return;
    const uid = i.user.id;

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") {
        return i.reply({ content: "🎛 **Bedrock AFK Panel**", components: panelRow() });
      }
      if (i.commandName === "admin") {
        if (uid !== ADMIN_ID) return i.reply({ content: "⛔", ephemeral: true });
        const reply = await i.reply({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents(), fetchReply: true });
        adminPanelMessage = reply;
        return;
      }
    }

    if (i.isButton()) {
      if (i.customId === "admin_refresh") {
        return i.update({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() });
      }
      if (i.customId === "admin_stop_all") {
        if (uid !== ADMIN_ID) return;
        for (const [tUid, s] of sessions) {
          stopSession(tUid, true);
          await sendUserDM(tUid, "⚠️ Your bot has been stopped by the owner.");
        }
        return i.reply({ content: `✅ Stopped all.`, ephemeral: true });
      }
      if (i.customId === "start") {
        await i.deferReply({ ephemeral: true });
        await i.editReply("⏳ Connecting...");
        return startSession(uid, i);
      }
      if (i.customId === "stop") {
        if (stopSession(uid, true)) return i.reply({ content: "⏹ Stopped.", ephemeral: true });
        return i.reply({ content: "No bot running.", ephemeral: true });
      }
    }

    if (i.isStringSelectMenu() && i.customId === "admin_force_stop_select") {
      const target = i.values[0];
      if (stopSession(target, true)) {
        await sendUserDM(target, "⚠️ Your bot has been stopped by the owner.");
        return i.reply({ content: `✅ Force stopped <@${target}>`, ephemeral: true });
      }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
        const ip = i.fields.getTextInputValue("ip").trim();
        const port = parseInt(i.fields.getTextInputValue("port").trim(), 10);
        const u = getUser(uid);
        u.server = { ip, port };
        save();
        return i.reply({ content: `✅ Saved.`, ephemeral: true });
    }
  } catch (e) { console.error(e); }
});

client.login(DISCORD_TOKEN);

