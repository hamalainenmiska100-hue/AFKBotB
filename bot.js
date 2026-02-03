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
const mineflayer = require("mineflayer");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// ----------------- Environment Variables -----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing from environment variables!");
  process.exit(1);
}

// ----------------- Configuration -----------------
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_ID = "1144987924123881564"; // Sinun ID

// ----------------- Storage Management -----------------
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};

async function save() {
  try {
    await fs.promises.writeFile(STORE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("Storage Save Error:", err);
  }
}

// Get User Data (Bedrock default)
function getUser(uid) {
  if (!users[uid]) users[uid] = {};
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  // Ensure Java config exists
  if (!users[uid].java) {
    users[uid].java = {
      server: null,
      connectionType: "offline",
      offlineUsername: `Java_${uid.slice(-4)}`
    };
  }
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

// ----------------- Runtime State -----------------
const sessions = new Map(); // Bedrock sessions
const javaSessions = new Map(); // Java sessions
const pendingLink = new Map();
let adminDashboardMessage = null;

// ----------------- Discord Client Setup -----------------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

async function safeReply(interaction, options) {
  try {
    if (interaction.replied || interaction.deferred) return await interaction.editReply(options);
    return await interaction.reply(options);
  } catch (e) {}
}

// ----------------- Admin Dashboard Logic -----------------
function getUptime() {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  return `${hours}h ${minutes}m ${seconds}s`;
}

async function generateAdminView() {
  const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
  const totalBedrock = sessions.size;
  const totalJava = javaSessions.size;
  
  const embed = new EmbedBuilder()
    .setTitle("🛡️ System Admin Dashboard")
    .setColor(0xFF0000)
    .addFields(
      { name: "System Health", value: `💾 **RAM:** ${mem} MB\n⏱ **Uptime:** ${getUptime()}`, inline: true },
      { name: "Active Bots", value: `🧱 **Bedrock:** ${totalBedrock}\n☕ **Java:** ${totalJava}`, inline: true },
      { name: "Last Updated", value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
    )
    .setTimestamp();

  let description = "";

  // List Bedrock Bots
  if (totalBedrock > 0) {
    description += "### 🧱 Bedrock Sessions\n";
    sessions.forEach((s, uid) => {
      const u = users[uid] || {};
      const serverInfo = u.server ? `${u.server.ip}:${u.server.port}` : "Unknown";
      const statusIcon = s.connected ? "🟢" : (s.isReconnecting ? "🟠" : "🔴");
      const duration = Math.floor((Date.now() - s.startedAt) / 60000);
      const identity = s.gamertag || u.offlineUsername || "Unknown ID";
      
      description += `**${statusIcon} User:** <@${uid}>\n`;
      description += `> 🌍 \`${serverInfo}\` | 👤 \`${identity}\` | ⏱ ${duration}m\n`;
    });
  }

  // List Java Bots
  if (totalJava > 0) {
    description += "\n### ☕ Java Sessions\n";
    javaSessions.forEach((s, uid) => {
      const u = users[uid]?.java || {};
      const serverInfo = u.server ? `${u.server.ip}:${u.server.port}` : "Unknown";
      const statusIcon = s.connected ? "🟢" : "🔴";
      const duration = Math.floor((Date.now() - s.startedAt) / 60000);
      const identity = s.username || u.offlineUsername || "Unknown ID";

      description += `**${statusIcon} User:** <@${uid}>\n`;
      description += `> 🌍 \`${serverInfo}\` | 👤 \`${identity}\` | ⏱ ${duration}m\n`;
    });
  }

  if (description.length === 0) description = "*No active bots.*";
  if (description.length > 4000) description = description.substring(0, 3900) + "... (truncated)";
  
  embed.setDescription(description);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin_refresh").setLabel("🔄 Refresh Data").setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

async function updateAdminDashboard() {
  if (!adminDashboardMessage) return;
  try {
    const data = await generateAdminView();
    await adminDashboardMessage.edit(data);
  } catch (e) {
    console.log("Admin dashboard lost.");
    adminDashboardMessage = null;
  }
}

// ----------------- Global System Monitor (30s) -----------------
setInterval(() => {
  const mem = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`[STATUS] B: ${sessions.size} | J: ${javaSessions.size} | Mem: ${mem.toFixed(2)} MB`);
  if (adminDashboardMessage) updateAdminDashboard();
}, 30000);

// ----------------- UI Component Generators -----------------

// BEDROCK Panel
function getBedrockPanelEmbed(uid) {
    const u = getUser(uid);
    const s = sessions.get(uid);
    
    let status = "🔴 Offline";
    if (s?.connected) status = "🟢 Online (AFK Active)";
    else if (s?.isReconnecting) status = "🟠 Reconnecting...";

    const serverText = u.server ? `${u.server.ip}:${u.server.port}` : "*Not Set*";

    return new EmbedBuilder()
        .setTitle("Bedrock Bot 🤖")
        .setDescription(`Hallitse Bedrock AFK-bottiasi tästä.\n\n**Tila:** ${status}\n**Server:** \`${serverText}\`\n**Auth:** ${u.connectionType}`)
        .setColor(s?.connected ? 0x00FF00 : 0x5865F2);
}

function bedrockPanelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("more").setLabel("➕ Options").setStyle(ButtonStyle.Secondary)
    )
  ];
}

// JAVA Panel
function getJavaPanelEmbed(uid) {
    const u = getUser(uid);
    const s = javaSessions.get(uid);
    const j = u.java || {};

    let status = "🔴 Offline";
    if (s?.connected) status = "🟢 Online (AFK Active)";
    else if (s) status = "🟠 Connecting...";

    const serverText = j.server ? `${j.server.ip}:${j.server.port}` : "*Not Set*";

    return new EmbedBuilder()
        .setTitle("Java Bot 🤖")
        .setDescription(`Hallitse Java Edition AFK-bottiasi tästä.\n\n**Tila:** ${status}\n**Server:** \`${serverText}\`\n**Auth:** ${j.connectionType}`)
        .setColor(s?.connected ? 0xFFA500 : 0x5865F2); // Orange for Java
}

function javaPanelRow() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("java_start").setLabel("▶ Start Java").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("java_stop").setLabel("⏹ Stop Java").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("java_settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Primary)
        )
    ];
}

function versionRow(current = "auto") {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("set_version")
    .setPlaceholder("🌐 Select Bedrock Version")
    .addOptions(
      { label: "Auto-Detect", value: "auto", default: current === "auto" },
      { label: "1.21.x", value: "1.21.x", default: current === "1.21.x" },
      { label: "1.20.x", value: "1.20.x", default: current === "1.20.x" }
    );
  return new ActionRowBuilder().addComponents(menu);
}

function connRow(current = "online") {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("set_conn")
    .setPlaceholder("🔌 Connection Type")
    .addOptions(
      { label: "Online (Microsoft Auth)", value: "online", default: current === "online" },
      { label: "Offline (Cracked/No Auth)", value: "offline", default: current === "offline" }
    );
  return new ActionRowBuilder().addComponents(menu);
}

// ----------------- Bedrock Logic -----------------
function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.afkInterval) clearInterval(s.afkInterval);
  if (s.waitForEntity) clearInterval(s.waitForEntity);
  try { s.client.close(); } catch {}
  sessions.delete(uid);
}

async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) return safeReply(interaction, "⏳ Login in progress.");

  const authDir = getUserAuthDir(uid);
  const u = getUser(uid);
  
  const flow = new Authflow(uid, authDir, { flow: "live", authTitle: "Bedrock Bot", deviceType: "Nintendo" }, async (data) => {
    const uri = data.verification_uri_complete || data.verification_uri;
    const code = data.user_code;
    const content = `🔐 **Microsoft Account Linking**\n\n1. Visit: [Microsoft Link](${uri})\n2. Enter code: \`${code}\``;
    await safeReply(interaction, { content: content, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Login Page").setStyle(ButtonStyle.Link).setURL(uri))] });
  });

  const p = (async () => {
    try {
      await flow.getMsaToken();
      u.linked = true;
      save();
      await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account linked!" }).catch(() => {});
    } catch (e) {
      await safeReply(interaction, `❌ Login failed: ${e.message}`);
    } finally { pendingLink.delete(uid); }
  })();
  pendingLink.set(uid, p);
}

async function startSession(uid, interaction) {
  const u = getUser(uid);
  if (!u.server) return safeReply(interaction, "⚠ Set Bedrock settings first.");
  const existing = sessions.get(uid);
  if (existing && !existing.isReconnecting) return safeReply(interaction, "❌ Bedrock Bot already running!");

  const { ip, port } = u.server;
  const authDir = getUserAuthDir(uid);

  if (interaction) safeReply(interaction, `🔍 **Pinging Bedrock ${ip}:${port}...**`);

  try {
    const pong = await bedrock.ping({ host: ip, port: port, timeout: 5000 });
  } catch (pingErr) {
    if (interaction) return safeReply(interaction, `🛑 **Server Unreachable.**`);
    return;
  }

  const opts = {
    host: ip, port, connectTimeout: 30000, keepAlive: true,
    version: u.bedrockVersion === "auto" ? undefined : u.bedrockVersion
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  } else {
    opts.username = uid;
    opts.offline = false;
    opts.profilesFolder = authDir;
  }

  let mc;
  try { mc = bedrock.createClient(opts); } catch (e) { if (interaction) safeReply(interaction, `❌ Error: ${e.message}`); return; }
  
  let currentSession = sessions.get(uid) || { 
      client: mc, timeout: null, startedAt: Date.now(), manualStop: false, 
      connected: false, hasSpawned: false, isReconnecting: false, gamertag: null, 
      pos: { x: 0, y: 0, z: 0 }, afkInterval: null, waitForEntity: null 
  };
  sessions.set(uid, currentSession);
  currentSession.client = mc;

  mc.on('move_player', (packet) => { if (packet.runtime_id === mc.entityId) currentSession.pos = packet.position; });

  currentSession.waitForEntity = setInterval(() => {
    if (!mc.entity || !mc.entityId) return;
    if (mc.profile) currentSession.gamertag = mc.profile.name;
    clearInterval(currentSession.waitForEntity);

    let moveToggle = false;
    currentSession.afkInterval = setInterval(() => {
      try {
        const yaw = Math.random() * 360;
        const offset = moveToggle ? 0.05 : -0.05; moveToggle = !moveToggle;
        currentSession.pos.x += offset;
        mc.write("move_player", { runtime_id: mc.entityId, position: currentSession.pos, pitch: 0, yaw, head_yaw: yaw, mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false });
        mc.write("player_auth_input", { pitch: 0, yaw, head_yaw: yaw, position: currentSession.pos, move_vector: { x: offset, z: 0 }, input_data: { _value: 0n }, input_mode: 'mouse', play_mode: 'normal', tick: 0n, delta: { x: offset, y: 0, z: 0 } });
      } catch (e) {}
    }, 30000);
  }, 1000);

  mc.on("spawn", () => {
    currentSession.connected = true;
    currentSession.hasSpawned = true;
    if (interaction) safeReply(interaction, `🟢 **Bedrock Connected!**`);
    updateAdminDashboard();
  });

  mc.on("close", () => {
    if (!currentSession.manualStop && currentSession.hasSpawned) {
        currentSession.isReconnecting = true;
        setTimeout(() => startSession(uid, null), 30000);
    } else {
        cleanupSession(uid);
    }
    updateAdminDashboard();
  });
}

// ----------------- Java Logic -----------------

function cleanupJavaSession(uid) {
    const s = javaSessions.get(uid);
    if (!s) return;
    if (s.afkInterval) clearInterval(s.afkInterval);
    try { s.bot.quit(); } catch {}
    javaSessions.delete(uid);
}

async function startJavaSession(uid, interaction) {
    const u = getUser(uid);
    const j = u.java;
    if (!j.server) return safeReply(interaction, "⚠ Set Java settings first.");
    if (javaSessions.has(uid)) return safeReply(interaction, "❌ Java Bot already running!");

    const { ip, port } = j.server;
    const authDir = getUserAuthDir(uid); // Share auth folder with Bedrock if possible

    if (interaction) safeReply(interaction, `☕ **Connecting Java Bot to ${ip}:${port}...**`);

    const opts = {
        host: ip,
        port: port,
        username: j.connectionType === "offline" ? j.offlineUsername : undefined, // Undefined lets mineflayer handle auth cache
        auth: j.connectionType === "offline" ? "offline" : "microsoft",
        profilesFolder: authDir, // Use same folder structure to keep sessions persistent
        version: false
    };

    let bot;
    try {
        bot = mineflayer.createBot(opts);
    } catch (e) {
        return safeReply(interaction, `❌ Java Create Error: ${e.message}`);
    }

    const session = {
        bot: bot,
        startedAt: Date.now(),
        connected: false,
        username: j.offlineUsername,
        afkInterval: null
    };
    javaSessions.set(uid, session);

    bot.on('spawn', () => {
        session.connected = true;
        session.username = bot.username;
        if (interaction) safeReply(interaction, `🟢 **Java Connected!**\nUser: ${bot.username}`);
        
        // Simple AFK: Jump and look around
        session.afkInterval = setInterval(() => {
            try {
                bot.setControlState('jump', true);
                bot.look(Math.random() * Math.PI, Math.random() * Math.PI); // Random look
                setTimeout(() => bot.setControlState('jump', false), 500);
            } catch (e) {}
        }, 30000);
        
        updateAdminDashboard();
    });

    bot.on('kicked', (reason) => {
        if (interaction) interaction.followUp(`⚠️ Java Kicked: ${reason}`);
        cleanupJavaSession(uid);
        updateAdminDashboard();
    });

    bot.on('error', (err) => {
        if (interaction) interaction.followUp(`❌ Java Error: ${err.message}`);
        cleanupJavaSession(uid);
        updateAdminDashboard();
    });

    bot.on('end', () => {
        cleanupJavaSession(uid);
        updateAdminDashboard();
    });
}


// ----------------- Interaction Listeners -----------------
client.on(Events.InteractionCreate, async (i) => {
  const uid = i.user.id;

  try {
    // COMMANDS
    if (i.isChatInputCommand()) {
        if (!i.inGuild() || i.guildId !== ALLOWED_GUILD_ID) {
             if (i.commandName === 'admin' && uid === ADMIN_ID) { /* allow */ } else return;
        }

        if (i.commandName === "admin" && uid === ADMIN_ID) {
            const data = await generateAdminView();
            adminDashboardMessage = await i.reply({ ...data, fetchReply: true });
        }
        else if (i.commandName === "panel") {
            // Bedrock Panel
            return i.reply({ embeds: [getBedrockPanelEmbed(uid)], components: bedrockPanelRow() });
        }
        else if (i.commandName === "java") {
            // Java Panel
            return i.reply({ embeds: [getJavaPanelEmbed(uid)], components: javaPanelRow() });
        }
    }

    // BUTTONS
    if (i.isButton()) {
      // BEDROCK ACTIONS
      if (i.customId === "link") { await i.deferReply({ ephemeral: true }); return linkMicrosoft(uid, i); }
      if (i.customId === "start") { await i.deferReply({ ephemeral: true }); return startSession(uid, i); }
      if (i.customId === "stop") { 
          const s = sessions.get(uid); s ? (s.manualStop = true, cleanupSession(uid)) : null; 
          return i.reply({ ephemeral: true, content: "⏹ Bedrock Bot stopped." }); 
      }
      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("🧱 Bedrock Settings");
        const ip = new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setRequired(true).setValue(u.server?.ip || "");
        const port = new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(u.server?.port || 19132));
        const off = new TextInputBuilder().setCustomId("off").setLabel("Offline Username").setStyle(TextInputStyle.Short).setRequired(false).setValue(u.offlineUsername || "");
        modal.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port), new ActionRowBuilder().addComponents(off));
        return i.showModal(modal);
      }
      if (i.customId === "more") {
        const u = getUser(uid);
        return i.reply({ ephemeral: true, content: "➕ **Bedrock Options**", components: [versionRow(u.bedrockVersion), connRow(u.connectionType)] });
      }

      // JAVA ACTIONS
      if (i.customId === "java_start") { await i.deferReply({ ephemeral: true }); return startJavaSession(uid, i); }
      if (i.customId === "java_stop") { 
          cleanupJavaSession(uid); 
          return i.reply({ ephemeral: true, content: "⏹ Java Bot stopped." }); 
      }
      if (i.customId === "java_settings") {
        const u = getUser(uid);
        const j = u.java || {};
        const modal = new ModalBuilder().setCustomId("java_settings_modal").setTitle("☕ Java Settings");
        const ip = new TextInputBuilder().setCustomId("j_ip").setLabel("IP").setStyle(TextInputStyle.Short).setRequired(true).setValue(j.server?.ip || "");
        const port = new TextInputBuilder().setCustomId("j_port").setLabel("Port").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(j.server?.port || 25565));
        const user = new TextInputBuilder().setCustomId("j_user").setLabel("Username (Offline) / Email").setStyle(TextInputStyle.Short).setRequired(false).setValue(j.offlineUsername || "");
        const authType = new TextInputBuilder().setCustomId("j_auth").setLabel("Auth (microsoft/offline)").setStyle(TextInputStyle.Short).setPlaceholder("microsoft").setRequired(true).setValue(j.connectionType || "offline");

        modal.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port), new ActionRowBuilder().addComponents(user), new ActionRowBuilder().addComponents(authType));
        return i.showModal(modal);
      }
      
      // ADMIN REFRESH
      if (i.customId === "admin_refresh" && uid === ADMIN_ID) {
          await i.deferUpdate(); updateAdminDashboard();
      }
    }

    // MODALS
    if (i.isModalSubmit()) {
        if (i.customId === "settings_modal") { // Bedrock
            const ip = i.fields.getTextInputValue("ip").trim();
            const port = parseInt(i.fields.getTextInputValue("port").trim(), 10);
            const off = i.fields.getTextInputValue("off").trim();
            if (!ip || isNaN(port)) return i.reply({ ephemeral: true, content: "❌ Invalid Bedrock IP/Port." });
            const u = getUser(uid);
            u.server = { ip, port };
            if (off) u.offlineUsername = off;
            save();
            return i.reply({ ephemeral: true, content: `✅ Bedrock saved: ${ip}:${port}` });
        }
        if (i.customId === "java_settings_modal") { // Java
            const ip = i.fields.getTextInputValue("j_ip").trim();
            const port = parseInt(i.fields.getTextInputValue("j_port").trim(), 10);
            const user = i.fields.getTextInputValue("j_user").trim();
            const authRaw = i.fields.getTextInputValue("j_auth").trim().toLowerCase();
            
            if (!ip || isNaN(port)) return i.reply({ ephemeral: true, content: "❌ Invalid Java IP/Port." });
            
            const u = getUser(uid);
            if (!u.java) u.java = {};
            u.java.server = { ip, port };
            if (user) u.java.offlineUsername = user;
            u.java.connectionType = authRaw.includes("micro") ? "microsoft" : "offline";
            
            save();
            return i.reply({ ephemeral: true, content: `✅ Java saved: ${ip}:${port} (${u.java.connectionType})` });
        }
    }

    // MENUS
    if (i.isStringSelectMenu()) {
      const u = getUser(uid);
      if (i.customId === "set_version") { u.bedrockVersion = i.values[0]; save(); return i.reply({ ephemeral: true, content: `✅ Version: ${u.bedrockVersion}` }); }
      if (i.customId === "set_conn") { u.connectionType = i.values[0]; save(); return i.reply({ ephemeral: true, content: `✅ Bedrock Conn: ${u.connectionType}` }); }
    }

  } catch (e) { console.error("Interact Error:", e); }
});

client.once("ready", async () => {
  console.log(`🟢 System Online. Logged in as: ${client.user.tag}`);
  
  const commands = [
      new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock Bot Panel"),
      new SlashCommandBuilder().setName("java").setDescription("Open Java Bot Panel"),
      new SlashCommandBuilder().setName("admin").setDescription("System Admin Dashboard")
  ];
  
  await client.application.commands.set(commands);
});

process.on("unhandledRejection", (e) => console.error("Unhandled Rejection:", e));
process.on("uncaughtException", (e) => console.error("Uncaught Exception:", e));

client.login(DISCORD_TOKEN);
