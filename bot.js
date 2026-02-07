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
const ADMIN_ID = "1144987924123881564"; 

// ----------------- Storage Management -----------------
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

try {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);
  if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });
} catch (e) { console.error("FS Init Error:", e); }

let users = {};
try {
  users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};
} catch (e) {
  console.error("Failed to load users.json, starting fresh.", e);
  users = {};
}

async function save() {
  try {
    await fs.promises.writeFile(STORE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("Storage Save Error:", err);
  }
}

function getUser(uid) {
  if (!users[uid]) users[uid] = {};
  
  // Bedrock Defaults
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  
  // Java Defaults
  if (!users[uid].java) {
    users[uid].java = {
      server: null,
      offlineUsername: `Java_${uid.slice(-4)}`,
      selectedVersion: "auto"
    };
  }
  return users[uid];
}

function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
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
    if (!interaction) return;
    if (interaction.replied || interaction.deferred) return await interaction.editReply(options).catch(() => {});
    return await interaction.reply(options).catch(() => {});
  } catch (e) { console.error("SafeReply Failed:", e.message); }
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
    adminDashboardMessage = null;
  }
}

// ----------------- Global System Monitor -----------------
setInterval(() => {
  try {
    const mem = process.memoryUsage().heapUsed / 1024 / 1024;
    console.log(`[STATUS] B: ${sessions.size} | J: ${javaSessions.size} | Mem: ${mem.toFixed(2)} MB`);
    if (adminDashboardMessage) updateAdminDashboard();
  } catch(e) {}
}, 30000);


// ----------------- VERSION LISTS -----------------
const JAVA_VERSIONS = [
    { label: "Auto-Detect (Recommended)", value: "auto", description: "Let the bot figure it out" },
    { label: "1.21.4", value: "1.21.4" },
    { label: "1.21.1", value: "1.21.1" },
    { label: "1.21", value: "1.21" },
    { label: "1.20.6", value: "1.20.6" },
    { label: "1.20.4", value: "1.20.4" },
    { label: "1.20.1", value: "1.20.1" },
    { label: "1.19.4", value: "1.19.4" },
    { label: "1.18.2", value: "1.18.2" },
    { label: "1.16.5", value: "1.16.5" },
    { label: "1.12.2", value: "1.12.2" },
    { label: "1.8.9", value: "1.8.9" }
];

const BEDROCK_VERSIONS = [
    { label: "Auto-Detect (Recommended)", value: "auto", description: "Latest supported version" },
    { label: "1.21.50", value: "1.21.50" },
    { label: "1.21.40", value: "1.21.40" },
    { label: "1.21.20", value: "1.21.20" },
    { label: "1.21.0", value: "1.21.0" },
    { label: "1.20.80", value: "1.20.80" }
];

// ----------------- UI Component Generators -----------------

function bedrockPanelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("pre_start_bedrock").setLabel("▶ Start").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Xbox").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("unlink").setLabel("⛓ Unlink").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("tech_menu").setLabel("🛠 Technical").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function javaPanelRow() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("pre_start_java").setLabel("▶ Start Java").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("java_stop").setLabel("⏹ Stop Java").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("java_settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("java_tech").setLabel("🛠 Technical").setStyle(ButtonStyle.Secondary)
        )
    ];
}

function technicalMenuRow(type) {
    const menu = new StringSelectMenuBuilder()
        .setCustomId(type === 'bedrock' ? "tech_actions" : "java_tech_actions")
        .setPlaceholder("🛠 Select Technical Action")
        .addOptions(
            { label: "View Coordinates", value: "coords", description: "Get current bot position" },
            { label: "Send Command", value: "cmd", description: "Execute a command via the bot" },
            { label: "Force Reconnect", value: "reconnect", description: "Forcefully restart the session" }
        );
    return new ActionRowBuilder().addComponents(menu);
}

function getVersionSelector(type, currentSelection) {
    const opts = type === 'java' ? JAVA_VERSIONS : BEDROCK_VERSIONS;
    const exists = opts.find(o => o.value === currentSelection);
    const validSelection = exists ? currentSelection : "auto";

    const menu = new StringSelectMenuBuilder()
        .setCustomId(type === 'java' ? "select_ver_java" : "select_ver_bedrock")
        .setPlaceholder(`Selected Version: ${validSelection}`)
        .addOptions(opts.map(o => ({
            label: o.label,
            value: o.value,
            description: o.description,
            default: o.value === validSelection
        })));
    return new ActionRowBuilder().addComponents(menu);
}

// ----------------- AUTHENTICATION LOGIC -----------------

async function linkMicrosoft(uid, interaction) {
  try {
      if (pendingLink.has(uid)) {
        return safeReply(interaction, "⏳ Login is already in progress. Check previous messages.");
      }

      const authDir = getUserAuthDir(uid);
      const u = getUser(uid);
      
      const flow = new Authflow(uid, authDir, {
        flow: "live",
        authTitle: Titles.MinecraftNintendoSwitch,
        deviceType: "Nintendo" 
      }, async (data) => {
        const uri = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
        const code = data.user_code;
        const content = `🔐 **Microsoft Account Linking**\n\n1. Visit: [Microsoft Link](${uri})\n2. Enter code: \`${code}\`\n\n*Follow the steps on the website and return here.*`;
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel("🌐 Open Login Page").setStyle(ButtonStyle.Link).setURL(uri)
        );

        await safeReply(interaction, { content: content, components: [row], ephemeral: true });
      });

      const p = (async () => {
        try {
          await flow.getMsaToken();
          u.linked = true;
          save();
          await interaction.followUp({ ephemeral: true, content: "✅ **Microsoft account linked successfully!**" }).catch(() => {});
        } catch (e) {
          console.error("Link Error:", e);
          await safeReply(interaction, `❌ **Login failed:** ${e.message}`);
        } finally {
          pendingLink.delete(uid);
        }
      })();
      pendingLink.set(uid, p);
  } catch (e) {
      console.error("Critical Auth Error:", e);
      safeReply(interaction, "❌ Internal Auth Error");
  }
}

// ----------------- PRE-FLIGHT CHECK LOGIC -----------------

async function sendPreFlightCheck(uid, interaction, type) {
    const u = getUser(uid);
    const data = type === 'java' ? u.java : u;
    
    if (!data.server) return safeReply(interaction, { content: "⚠ **Settings missing!** Please configure IP/Port first via Settings.", ephemeral: true });

    if (type === 'java' && javaSessions.has(uid)) return safeReply(interaction, { content: "❌ **Java Bot is already running!**", ephemeral: true });
    if (type === 'bedrock' && sessions.has(uid)) return safeReply(interaction, { content: "❌ **Bedrock Bot is already running!**", ephemeral: true });

    const serverTxt = `${data.server.ip}:${data.server.port}`;
    const userTxt = type === 'java' 
        ? (data.offlineUsername) 
        : (data.connectionType === 'online' ? "Xbox Account" : data.offlineUsername);
    
    const currentVer = type === 'java' 
        ? (u.java.selectedVersion || "auto") 
        : (u.bedrockVersion || "auto");

    const embed = new EmbedBuilder()
        .setTitle(type === 'java' ? "☕ Java Connection Setup" : "🧱 Bedrock Connection Setup")
        .setDescription(`**Does everything look right?**\n\n🌍 **Server:** \`${serverTxt}\`\n👤 **User:** \`${userTxt}\`\n\n*Select the server version below if Auto-Detect fails.*`)
        .setColor(type === 'java' ? 0xFFA500 : 0x00AA00);

    const versionRow = getVersionSelector(type, currentVer);
    
    const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(type === 'java' ? "confirm_start_java" : "confirm_start_bedrock")
            .setLabel("✅ Connect Now")
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setLabel("Cancel")
            .setCustomId("cancel_start")
            .setStyle(ButtonStyle.Secondary)
    );

    await safeReply(interaction, { 
        embeds: [embed], 
        components: [versionRow, confirmRow], 
        ephemeral: true 
    });
}

// ----------------- BEDROCK LOGIC -----------------

async function startSession(uid, interaction, versionOverride = "auto") {
  try {
      const u = getUser(uid);
      const { ip, port } = u.server;
      const authDir = getUserAuthDir(uid);

      if (interaction) await interaction.update({ content: `⏳ **Connecting to ${ip}:${port}...**\nVersion: ${versionOverride}`, embeds: [], components: [] }).catch(()=>{});

      const opts = {
        host: ip,
        port,
        connectTimeout: 47000,
        keepAlive: true,
        version: versionOverride === "auto" ? undefined : versionOverride
      };

      if (u.connectionType === "offline") {
        opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
        opts.offline = true;
      } else {
        if (!u.linked) {
             // If we updated the interaction we need to follow up
             return interaction.followUp({ content: "❌ **Account not linked!**", ephemeral: true });
        }
        opts.username = uid;
        opts.offline = false;
        opts.profilesFolder = authDir;
      }

      createBedrockClient(uid, opts, interaction);
  } catch (e) {
      console.error("Start Session Error:", e);
  }
}

function createBedrockClient(uid, opts, interaction = null) {
  let mc;
  try {
      mc = bedrock.createClient(opts);
  } catch (creationErr) {
      console.error(creationErr);
      return;
  }
  
  let currentSession = sessions.get(uid);
  if (!currentSession) {
    currentSession = { 
      client: mc, 
      startedAt: Date.now(), 
      manualStop: false, 
      connected: false, 
      opts: opts, 
      pos: { x: 0, y: 0, z: 0 },
      afkInterval: null,
      uptimeInterval: null,
      congratsHours: 0
    };
    sessions.set(uid, currentSession);
  } else {
    currentSession.client = mc;
    currentSession.connected = false;
  }

  mc.on('move_player', (packet) => {
    if (packet.runtime_id === mc.entityId) currentSession.pos = packet.position; 
  });

  mc.on("spawn", () => {
    try {
        currentSession.connected = true;
        updateAdminDashboard();

        // Anti-AFK
        currentSession.afkInterval = setInterval(() => {
          try {
            const yaw = Math.random() * 360;
            mc.write("player_auth_input", {
              pitch: 0, yaw, head_yaw: yaw,
              position: currentSession.pos,
              move_vector: { x: 0, z: 0 },
              input_data: { _value: 0n },
              input_mode: 'mouse', play_mode: 'normal', tick: 0n, delta: { x: 0, y: 0, z: 0 }
            });
          } catch (e) {}
        }, 15000);

        // HOURLY CONGRATS DM
        if (currentSession.uptimeInterval) clearInterval(currentSession.uptimeInterval);
        currentSession.uptimeInterval = setInterval(async () => {
            try {
                currentSession.congratsHours++;
                const u = await client.users.fetch(uid).catch(() => null);
                if (u) {
                    const s = currentSession.congratsHours === 1 ? "" : "s";
                    u.send(`🎉 **Congrats!** Your Bedrock bot has been online for **${currentSession.congratsHours} hour${s}**! 🛡️`).catch(() => {});
                }
            } catch (e) {}
        }, 3600 * 1000); // 1 Hour

    } catch (e) { console.error("Spawn Logic Error:", e); }
  });

  mc.on("close", () => {
    handleDisconnect(uid, currentSession, 'bedrock');
  });

  mc.on("error", (e) => console.log(`[Bedrock Error] ${e.message}`));
}

// ----------------- JAVA LOGIC (OFFLINE ONLY) -----------------

async function startJavaSession(uid, interaction, versionOverride = "auto") {
    try {
        const u = getUser(uid);
        const j = u.java;
        const { ip, port } = j.server;

        if (interaction) await interaction.update({ content: `⏳ **Connecting Java Bot to ${ip}:${port}...**\nVersion: ${versionOverride}`, embeds: [], components: [] }).catch(()=>{});

        const opts = {
            host: ip,
            port: port,
            username: j.offlineUsername || `Java_${uid.slice(-4)}`,
            auth: 'offline', 
            version: versionOverride === "auto" ? false : versionOverride
        };

        createJavaBot(uid, opts, interaction);
    } catch(e) {
        console.error("Start Java Error:", e);
    }
}

function createJavaBot(uid, opts, interaction = null) {
    let bot;
    try {
        bot = mineflayer.createBot(opts);
    } catch (e) {
        console.error(e);
        return;
    }

    let session = javaSessions.get(uid);
    if (!session) {
        session = {
            bot: bot,
            startedAt: Date.now(),
            connected: false,
            manualStop: false,
            opts: opts,
            afkInterval: null,
            uptimeInterval: null,
            congratsHours: 0
        };
        javaSessions.set(uid, session);
    } else {
        session.bot = bot;
        session.connected = false;
    }

    bot.on('spawn', () => {
        try {
            session.connected = true;
            updateAdminDashboard();
            
            // Simple AFK
            session.afkInterval = setInterval(() => {
                try {
                    if (bot && bot.entity) {
                        bot.setControlState('jump', true);
                        bot.look(Math.random() * Math.PI, Math.random() * Math.PI);
                        setTimeout(() => { if(bot) bot.setControlState('jump', false); }, 500);
                    }
                } catch (e) {}
            }, 15000);

            // HOURLY CONGRATS DM
            if (session.uptimeInterval) clearInterval(session.uptimeInterval);
            session.uptimeInterval = setInterval(async () => {
                try {
                    session.congratsHours++;
                    const u = await client.users.fetch(uid).catch(() => null);
                    if (u) {
                        const s = session.congratsHours === 1 ? "" : "s";
                        u.send(`🎉 **Congrats!** Your Java bot has been online for **${session.congratsHours} hour${s}**! ☕`).catch(() => {});
                    }
                } catch (e) {}
            }, 3600 * 1000);

        } catch (e) { console.error("Java Spawn Error:", e); }
    });

    bot.on('kicked', (reason) => {
        console.log(`[Java] Kicked: ${reason}`);
    });

    bot.on('end', () => {
        handleDisconnect(uid, session, 'java');
    });

    bot.on('error', (err) => console.log(`[Java Error] ${err.message}`));
}

// Helper to handle auto-reconnect logic
function handleDisconnect(uid, s, type) {
    try {
        if (s.afkInterval) clearInterval(s.afkInterval);
        if (s.uptimeInterval) clearInterval(s.uptimeInterval);
        
        if (!s.manualStop) {
            console.log(`[${type}] Disconnected ${uid}. Reconnecting in 30s...`);
            setTimeout(() => {
                const sessionMap = type === 'java' ? javaSessions : sessions;
                if (sessionMap.has(uid) && !sessionMap.get(uid).manualStop) {
                    if (type === 'java') createJavaBot(uid, s.opts);
                    else createBedrockClient(uid, s.opts);
                }
            }, 30000);
        } else {
            if (type === 'java') javaSessions.delete(uid);
            else sessions.delete(uid);
        }
        updateAdminDashboard();
    } catch(e) { console.error("Disconnect Logic Error:", e); }
}

// ----------------- Interaction Listeners -----------------
client.on(Events.InteractionCreate, async (i) => {
  const uid = i.user.id;

  try {
    // --- COMMANDS ---
    if (i.isChatInputCommand()) {
        if (!i.inGuild() || i.guildId !== ALLOWED_GUILD_ID) {
             if (i.commandName === 'admin' && uid === ADMIN_ID) { /* allow */ } else return;
        }

        if (i.commandName === "admin" && uid === ADMIN_ID) {
            const data = await generateAdminView();
            adminDashboardMessage = await i.reply({ ...data, fetchReply: true });
        }
        else if (i.commandName === "panel") {
            // Minimal UI
            return i.reply({ content: "**Bedrock Bot Panel 🤖**", components: bedrockPanelRow() });
        }
        else if (i.commandName === "java") {
            // Minimal UI
            return i.reply({ content: "**Java Bot Panel 🤖**", components: javaPanelRow() });
        }
    }

    // --- BUTTONS ---
    if (i.isButton()) {
      // PRE-FLIGHT
      if (i.customId === "pre_start_bedrock") return sendPreFlightCheck(uid, i, 'bedrock');
      if (i.customId === "pre_start_java") return sendPreFlightCheck(uid, i, 'java');
      if (i.customId === "cancel_start") return i.update({ content: "❌ Connection cancelled.", embeds: [], components: [] });

      // CONFIRM START
      if (i.customId === "confirm_start_bedrock") {
          const u = getUser(uid);
          return startSession(uid, i, u.bedrockVersion || "auto");
      }
      if (i.customId === "confirm_start_java") {
          const u = getUser(uid);
          return startJavaSession(uid, i, u.java.selectedVersion || "auto");
      }

      // BEDROCK ACTIONS
      if (i.customId === "link") { await i.deferReply({ ephemeral: true }); return linkMicrosoft(uid, i); }
      if (i.customId === "unlink") { unlinkMicrosoft(uid); return i.reply({ ephemeral: true, content: "🗑 Microsoft account unlinked." }); }
      
      if (i.customId === "stop") { 
          const s = sessions.get(uid); 
          if (!s) return i.reply({ content: "❌ **No bots running on your account.**", ephemeral: true });
          
          try {
              s.manualStop = true; 
              s.client.close(); 
          } catch(e) {
              sessions.delete(uid); 
          }
          return i.reply({ ephemeral: true, content: "⏹ **Stopping Bedrock Bot...**" }); 
      }

      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Bedrock Settings");
        const ip = new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setRequired(true).setValue(u.server?.ip || "");
        const port = new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(u.server?.port || 19132));
        const off = new TextInputBuilder().setCustomId("off").setLabel("Offline Username").setStyle(TextInputStyle.Short).setRequired(false).setValue(u.offlineUsername || "");
        modal.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port), new ActionRowBuilder().addComponents(off));
        return i.showModal(modal);
      }

      if (i.customId === "tech_menu") {
          return i.reply({ ephemeral: true, content: "🧱 **Bedrock Technical Actions**", components: [technicalMenuRow('bedrock')] });
      }
      
      // JAVA ACTIONS
      if (i.customId === "java_stop") { 
          const s = javaSessions.get(uid); 
          if (!s) return i.reply({ content: "❌ **No bots running on your account.**", ephemeral: true });
          
          try {
              s.manualStop = true;
              if (s.bot) {
                  try { s.bot.quit(); } catch (quitErr) { s.bot.end(); }
              }
          } catch(e) {
               javaSessions.delete(uid);
          }
          return i.reply({ ephemeral: true, content: "⏹ **Stopping Java Bot...**" }); 
      }

      if (i.customId === "java_settings") {
        const u = getUser(uid);
        const j = u.java || {};
        const modal = new ModalBuilder().setCustomId("java_settings_modal").setTitle("Java Settings");
        const ip = new TextInputBuilder().setCustomId("j_ip").setLabel("IP").setStyle(TextInputStyle.Short).setRequired(true).setValue(j.server?.ip || "");
        const port = new TextInputBuilder().setCustomId("j_port").setLabel("Port").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(j.server?.port || 25565));
        const user = new TextInputBuilder().setCustomId("j_user").setLabel("Offline Username").setStyle(TextInputStyle.Short).setRequired(false).setValue(j.offlineUsername || "");
        modal.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port), new ActionRowBuilder().addComponents(user));
        return i.showModal(modal);
      }

      if (i.customId === "java_tech") {
          return i.reply({ ephemeral: true, content: "☕ **Java Technical Actions**", components: [technicalMenuRow('java')] });
      }
      
      if (i.customId === "admin_refresh" && uid === ADMIN_ID) {
          await i.deferUpdate(); updateAdminDashboard();
      }
    }

    // --- MENUS (Dropdowns) ---
    if (i.isStringSelectMenu()) {
        const val = i.values[0];

        // VERSION SELECTORS
        if (i.customId === "select_ver_java") {
            const u = getUser(uid);
            u.java.selectedVersion = val;
            save();
            const newRow = getVersionSelector('java', val);
            const confirmRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("confirm_start_java").setLabel("✅ Connect Now").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setLabel("Cancel").setCustomId("cancel_start").setStyle(ButtonStyle.Secondary)
            );
            return i.update({ components: [newRow, confirmRow] });
        }
        if (i.customId === "select_ver_bedrock") {
            const u = getUser(uid);
            u.bedrockVersion = val;
            save();
            const newRow = getVersionSelector('bedrock', val);
            const confirmRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("confirm_start_bedrock").setLabel("✅ Connect Now").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setLabel("Cancel").setCustomId("cancel_start").setStyle(ButtonStyle.Secondary)
            );
            return i.update({ components: [newRow, confirmRow] });
        }
        
        // TECH ACTIONS
        if (i.customId === "tech_actions") { // Bedrock
            const s = sessions.get(uid);
            if (!s || !s.connected) return i.reply({ ephemeral: true, content: "❌ Bot is not connected!" });

            if (val === "coords") {
                const p = s.pos;
                return i.reply({ ephemeral: true, content: `📍 **Position:** X: ${p.x.toFixed(1)}, Y: ${p.y.toFixed(1)}, Z: ${p.z.toFixed(1)}` });
            }
            if (val === "reconnect") {
                try { s.client.close(); } catch(e){}
                return i.reply({ ephemeral: true, content: "🔄 **Forcing reconnect...**" });
            }
            if (val === "cmd") {
                const modal = new ModalBuilder().setCustomId("cmd_modal_bedrock").setTitle("Send Command");
                const input = new TextInputBuilder().setCustomId("cmd_input").setLabel("Command (without /)").setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return i.showModal(modal);
            }
        }

        if (i.customId === "java_tech_actions") { // Java
            const s = javaSessions.get(uid);
            if (!s || !s.connected) return i.reply({ ephemeral: true, content: "❌ Bot is not connected!" });

            if (val === "coords") {
                try {
                    const p = s.bot.entity.position;
                    return i.reply({ ephemeral: true, content: `📍 **Position:** X: ${p.x.toFixed(1)}, Y: ${p.y.toFixed(1)}, Z: ${p.z.toFixed(1)}` });
                } catch(e) { return i.reply({ ephemeral: true, content: "❌ Couldn't get coordinates."}); }
            }
            if (val === "reconnect") {
                try { s.bot.quit(); } catch(e) { s.bot.end(); }
                return i.reply({ ephemeral: true, content: "🔄 **Forcing reconnect...**" });
            }
            if (val === "cmd") {
                const modal = new ModalBuilder().setCustomId("cmd_modal_java").setTitle("Send Command");
                const input = new TextInputBuilder().setCustomId("cmd_input").setLabel("Command (without /)").setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return i.showModal(modal);
            }
        }
    }

    // --- MODALS ---
    if (i.isModalSubmit()) {
        if (i.customId === "settings_modal") { // Bedrock Save
            const ip = i.fields.getTextInputValue("ip").trim();
            const port = parseInt(i.fields.getTextInputValue("port").trim(), 10);
            const off = i.fields.getTextInputValue("off").trim();
            if (!ip || isNaN(port)) return i.reply({ ephemeral: true, content: "❌ Invalid Data." });
            const u = getUser(uid);
            u.server = { ip, port };
            if (off) u.offlineUsername = off;
            save();
            return i.reply({ ephemeral: true, content: `✅ Saved: ${ip}:${port}` });
        }
        if (i.customId === "java_settings_modal") { // Java Save
            const ip = i.fields.getTextInputValue("j_ip").trim();
            const port = parseInt(i.fields.getTextInputValue("j_port").trim(), 10);
            const user = i.fields.getTextInputValue("j_user").trim();
            
            if (!ip || isNaN(port)) return i.reply({ ephemeral: true, content: "❌ Invalid Data." });
            const u = getUser(uid);
            if (!u.java) u.java = {};
            u.java.server = { ip, port };
            if (user) u.java.offlineUsername = user;
            save();
            return i.reply({ ephemeral: true, content: `✅ Saved: ${ip}:${port}` });
        }
        // Command Execution
        if (i.customId === "cmd_modal_bedrock") {
            const cmd = i.fields.getTextInputValue("cmd_input");
            const s = sessions.get(uid);
            try {
                if (s && s.client) s.client.write("command_request", { command: `/${cmd}`, origin: { type: 0, uuid: "", request_id: "", player_entity_id: undefined }, internal: false, version: 52 });
                return i.reply({ ephemeral: true, content: `📤 Sent: /${cmd}` });
            } catch(e) { return i.reply({ ephemeral: true, content: "❌ Failed to send command." }); }
        }
        if (i.customId === "cmd_modal_java") {
            const cmd = i.fields.getTextInputValue("cmd_input");
            const s = javaSessions.get(uid);
            try {
                if (s && s.bot) s.bot.chat(`/${cmd}`);
                return i.reply({ ephemeral: true, content: `📤 Sent: /${cmd}` });
            } catch(e) { return i.reply({ ephemeral: true, content: "❌ Failed to send command." }); }
        }
    }

  } catch (e) { console.error("Interaction Error:", e); }
});

client.once("ready", async () => {
  console.log(`🟢 System Online: ${client.user.tag}`);
  try {
    await client.application.commands.set([
        new SlashCommandBuilder().setName("panel").setDescription("Bedrock Bot Panel"),
        new SlashCommandBuilder().setName("java").setDescription("Java Bot Panel"),
        new SlashCommandBuilder().setName("admin").setDescription("System Admin")
    ]);
  } catch(e) { console.error("Command Register Error:", e); }
});

// GLOBAL ERROR HANDLERS
process.on("unhandledRejection", (e) => console.error("Unhandled Rejection (Suppressed):", e));
process.on("uncaughtException", (e) => console.error("Uncaught Exception (Suppressed):", e));

client.login(DISCORD_TOKEN);

