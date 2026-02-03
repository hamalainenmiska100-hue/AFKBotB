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
  StringSelectMenuBuilder
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// ----------------- Environment Variables -----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing from environment variables!");
  process.exit(1);
}

const ALLOWED_GUILD_ID = "1462335230345089254";

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

function getUser(uid) {
  if (!users[uid]) users[uid] = {};
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
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
const sessions = new Map();
const pendingLink = new Map();

// ----------------- Discord Client Setup -----------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function safeReply(interaction, options) {
  try {
    if (interaction.replied || interaction.deferred) return await interaction.editReply(options);
    return await interaction.reply(options);
  } catch (e) {}
}

// ----------------- Global System Monitor (30s) -----------------
setInterval(() => {
  const mem = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`\n--- [SYSTEM STATUS REPORT] ${new Date().toLocaleTimeString()} ---`);
  console.log(`Active Sessions: ${sessions.size}`);
  console.log(`Memory Usage: ${mem.toFixed(2)} MB`);
  
  sessions.forEach((s, uid) => {
    const status = s.connected ? "CONNECTED" : (s.isReconnecting ? "RECONNECTING" : "INITIALIZING");
    console.log(` > User [${uid}]: ${status} | Since: ${new Date(s.startedAt).toLocaleTimeString()}`);
  });
  console.log(`----------------------------------------------------\n`);
}, 30000);

// ----------------- UI Component Generators -----------------
function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start Bot").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop Bot").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("more").setLabel("➕ More Options").setStyle(ButtonStyle.Secondary)
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
      { label: "1.20.x", value: "1.20.x", default: current === "1.20.x" },
      { label: "1.19.x", value: "1.19.x", default: current === "1.19.x" }
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

// ----------------- Bedrock Protocol Engine -----------------
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
  if (pendingLink.has(uid)) {
    return safeReply(interaction, "⏳ Login in progress. Please use the previous code.");
  }

  const authDir = getUserAuthDir(uid);
  const u = getUser(uid);
  
  const flow = new Authflow(uid, authDir, {
    flow: "live",
    authTitle: Titles?.MinecraftNintendoSwitch || "Bedrock AFK Bot",
    deviceType: "Nintendo"
  }, async (data) => {
    const uri = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
    const code = data.user_code || "ERROR";
    
    const content = `🔐 **Microsoft Account Linking**\n\n1. Visit: [Microsoft Link](${uri})\n2. Enter code: \`${code}\`\n\n*Follow the steps and return here.*`;
    await safeReply(interaction, { 
        content: content, 
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("🌐 Open Login Page").setStyle(ButtonStyle.Link).setURL(uri))] 
    });
  });

  const p = (async () => {
    try {
      await flow.getMsaToken();
      u.linked = true;
      save();
      await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account linked successfully!" }).catch(() => {});
    } catch (e) {
      await safeReply(interaction, `❌ Login failed: ${e.message}`);
    } finally {
      pendingLink.delete(uid);
    }
  })();
  pendingLink.set(uid, p);
}

function startSession(uid, interaction) {
  const u = getUser(uid);
  if (!u.server) {
    if (interaction && !interaction.replied) safeReply(interaction, "⚠ Set settings first.");
    return;
  }
  
  // Check if session is already running and not in reconnection phase
  const existing = sessions.get(uid);
  if (existing && !existing.isReconnecting) {
    if (interaction && !interaction.replied) safeReply(interaction, "❌ **Bot already running for your account!** Stop the current bot before starting a new one.");
    return;
  }

  const { ip, port } = u.server;
  const authDir = getUserAuthDir(uid);

  // Immediate UI feedback
  if (interaction) safeReply(interaction, `⏳ **Connecting to ${ip}:${port}...**`);

  const opts = {
    host: ip,
    port,
    connectTimeout: 47000,
    keepAlive: true,
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

  const mc = bedrock.createClient(opts);
  
  let currentSession = sessions.get(uid);
  if (!currentSession) {
    currentSession = { 
      client: mc, 
      timeout: null, 
      startedAt: Date.now(), 
      manualStop: false, 
      connected: false, 
      isReconnecting: false,
      pos: { x: 0, y: 0, z: 0 },
      afkInterval: null,
      waitForEntity: null
    };
    sessions.set(uid, currentSession);
  } else {
    currentSession.client = mc;
    currentSession.isReconnecting = false;
  }

  // Authority & Position Sync
  mc.on('move_player', (packet) => {
    if (packet.runtime_id === mc.entityId) {
      currentSession.pos = packet.position; 
    }
  });

  currentSession.waitForEntity = setInterval(() => {
    if (!mc.entity || !mc.entityId) return;
    clearInterval(currentSession.waitForEntity);
    currentSession.waitForEntity = null;

    let moveToggle = false;
    currentSession.afkInterval = setInterval(() => {
      try {
        const yaw = Math.random() * 360;
        const pitch = (Math.random() * 10) - 5;
        const offset = moveToggle ? 0.05 : -0.05;
        moveToggle = !moveToggle;

        currentSession.pos.x += offset;
        currentSession.pos.z += offset;

        // Sync with both Move and Auth Input packets
        mc.write("move_player", {
          runtime_id: mc.entityId,
          position: currentSession.pos,
          pitch, yaw, head_yaw: yaw,
          mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false
        });

        mc.write("player_auth_input", {
          pitch, yaw, head_yaw: yaw,
          position: currentSession.pos,
          move_vector: { x: offset, z: offset },
          input_data: { _value: 0n, is_sneaking: false, is_sprinting: false },
          input_mode: 'mouse', play_mode: 'normal', tick: 0n, delta: { x: offset, y: 0, z: offset }
        });
      } catch (e) {}
    }, 30000);
  }, 1000);

  currentSession.timeout = setTimeout(() => {
    if (sessions.has(uid) && !currentSession.connected) {
      if (interaction) safeReply(interaction, `❌ **Connection Timeout** at ${ip}:${port}. Retrying in 30s...`);
      mc.close();
    }
  }, 47000);

  mc.on("spawn", () => {
    currentSession.connected = true;
    clearTimeout(currentSession.timeout);
    if (interaction) {
        safeReply(interaction, `🟢 **Connected to ${ip}:${port}**\nAnti-AFK and Physics Sync are active.`);
    }
  });

  mc.on("error", (e) => {
    clearTimeout(currentSession.timeout);
    if (!currentSession.manualStop) {
        handleAutoReconnect(uid, interaction);
    }
  });

  mc.on("close", () => {
    clearTimeout(currentSession.timeout);
    if (!currentSession.manualStop) {
        handleAutoReconnect(uid, interaction);
    }
  });
}

function handleAutoReconnect(uid, interaction) {
    const s = sessions.get(uid);
    if (!s || s.manualStop || s.reconnectTimer) return;

    s.isReconnecting = true;
    s.connected = false;
    
    if (s.afkInterval) clearInterval(s.afkInterval);
    if (s.waitForEntity) clearInterval(s.waitForEntity);

    s.reconnectTimer = setTimeout(() => {
        if (sessions.has(uid) && !s.manualStop) {
            s.reconnectTimer = null;
            startSession(uid, interaction);
        }
    }, 30000);
}

// ----------------- Interaction Listeners -----------------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.inGuild() || i.guildId !== ALLOWED_GUILD_ID) return;
  const uid = i.user.id;

  try {
    if (i.isChatInputCommand() && i.commandName === "panel") {
      return i.reply({ content: "🎛 **Bedrock AFK Management Console**", components: panelRow() });
    }

    if (i.isButton()) {
      if (i.customId === "link") { await i.deferReply({ ephemeral: true }); return linkMicrosoft(uid, i); }
      if (i.customId === "unlink") { unlinkMicrosoft(uid); return i.reply({ ephemeral: true, content: "🗑 Microsoft account unlinked." }); }
      if (i.customId === "start") { 
          await i.deferReply({ ephemeral: true }); 
          return startSession(uid, i); 
      }
      if (i.customId === "stop") { 
          const s = sessions.get(uid);
          if (s) { 
              s.manualStop = true; 
              cleanupSession(uid); 
              return i.reply({ ephemeral: true, content: "⏹ Bot stopped manually." }); 
          }
          return i.reply({ ephemeral: true, content: "No active bot found for your account." });
      }
      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("⚙ Server Configuration");
        const ip = new TextInputBuilder().setCustomId("ip").setLabel("Server Address").setStyle(TextInputStyle.Short).setRequired(true).setValue(u.server?.ip || "");
        const port = new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(u.server?.port || 19132));
        const off = new TextInputBuilder().setCustomId("off").setLabel("Offline Username").setStyle(TextInputStyle.Short).setRequired(false).setValue(u.offlineUsername || "");
        
        modal.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port), new ActionRowBuilder().addComponents(off));
        return i.showModal(modal);
      }
      if (i.customId === "more") {
        const u = getUser(uid);
        return i.reply({ ephemeral: true, content: "➕ **Advanced Settings**", components: [versionRow(u.bedrockVersion), connRow(u.connectionType)] });
      }
    }

    if (i.isStringSelectMenu()) {
      const u = getUser(uid);
      if (i.customId === "set_version") { u.bedrockVersion = i.values[0]; save(); return i.reply({ ephemeral: true, content: `✅ Version set to: **${u.bedrockVersion}**` }); }
      if (i.customId === "set_conn") { u.connectionType = i.values[0]; save(); return i.reply({ ephemeral: true, content: `✅ Connection mode set to: **${u.connectionType}**` }); }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
      const ip = i.fields.getTextInputValue("ip").trim();
      const port = parseInt(i.fields.getTextInputValue("port").trim(), 10);
      const off = i.fields.getTextInputValue("off").trim();
      
      if (!ip || isNaN(port)) return i.reply({ ephemeral: true, content: "❌ Invalid Server Address or Port." });
      
      const u = getUser(uid);
      u.server = { ip, port };
      if (off) u.offlineUsername = off;
      save();
      return i.reply({ ephemeral: true, content: `✅ Configuration saved: **${ip}:${port}**` });
    }
  } catch (e) { console.error("Interaction Error:", e); }
});

client.once("ready", async () => {
  console.log(`🟢 System Online. Logged in as: ${client.user.tag}`);
  await client.application.commands.set([new SlashCommandBuilder().setName("panel").setDescription("Open the AFK Bot Management Panel")]);
});

process.on("unhandledRejection", (e) => console.error("Unhandled Rejection:", e));
process.on("uncaughtException", (e) => console.error("Uncaught Exception:", e));

client.login(DISCORD_TOKEN);
