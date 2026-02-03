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
// Tärkeää: Titles pitää tuoda prismarine-authista
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
  
  // Bedrock Defaults
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  
  // Java Defaults
  if (!users[uid].java) {
    users[uid].java = {
      server: null,
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
  const mem = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`[STATUS] B: ${sessions.size} | J: ${javaSessions.size} | Mem: ${mem.toFixed(2)} MB`);
  if (adminDashboardMessage) updateAdminDashboard();
}, 30000);

// ----------------- UI Component Generators -----------------

function bedrockPanelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start").setStyle(ButtonStyle.Success),
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
            new ButtonBuilder().setCustomId("java_start").setLabel("▶ Start Java").setStyle(ButtonStyle.Success),
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

// ----------------- AUTHENTICATION LOGIC (RESTORED) -----------------

async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) {
    return safeReply(interaction, "⏳ Login is already in progress. Check previous messages.");
  }

  const authDir = getUserAuthDir(uid);
  const u = getUser(uid);
  
  // ALKUPERÄINEN TOIMIVA AUTHFLOW
  // Titles.MinecraftNintendoSwitch on tärkeä "device code" -virheen välttämiseksi
  const flow = new Authflow(uid, authDir, {
    flow: "live",
    authTitle: Titles.MinecraftNintendoSwitch,
    deviceType: "Nintendo" 
  }, async (data) => {
    // Callback kun koodi saadaan
    const uri = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
    const code = data.user_code;
    
    const content = `🔐 **Microsoft Account Linking**\n\n1. Visit: [Microsoft Link](${uri})\n2. Enter code: \`${code}\`\n\n*Follow the steps on the website and return here.*`;
    
    // Nappi helpottamaan mobiilikäyttöä
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
}

// ----------------- BEDROCK LOGIC -----------------

async function startSession(uid, interaction) {
  const u = getUser(uid);
  if (!u.server) return safeReply(interaction, "⚠ **Settings missing!** Please configure IP/Port first.");
  
  if (sessions.has(uid)) return safeReply(interaction, { content: "❌ **You already have a Bedrock bot running!** Stop it first.", ephemeral: true });

  const { ip, port } = u.server;
  const authDir = getUserAuthDir(uid);

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
    // Tarkista onko käyttäjä linkittänyt tilin
    if (!u.linked) {
        return safeReply(interaction, "❌ **Account not linked!** Use 'Link Xbox' first or switch to offline mode in options.");
    }
    opts.username = uid;
    opts.offline = false;
    opts.profilesFolder = authDir;
  }

  createBedrockClient(uid, opts, interaction);
}

function createBedrockClient(uid, opts, interaction = null) {
  let mc;
  try {
      mc = bedrock.createClient(opts);
  } catch (creationErr) {
      if (interaction) safeReply(interaction, `❌ **Client Error:** ${creationErr.message}`);
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
      afkInterval: null
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
    currentSession.connected = true;
    if (interaction && !interaction.replied) safeReply(interaction, `🟢 **Connected to ${opts.host}!**`);
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
  });

  mc.on("close", () => {
    if (currentSession.afkInterval) clearInterval(currentSession.afkInterval);
    
    if (!currentSession.manualStop) {
        console.log(`[Bedrock] Disconnected ${uid}. Reconnecting in 30s...`);
        setTimeout(() => {
            if (sessions.has(uid) && !sessions.get(uid).manualStop) {
                createBedrockClient(uid, opts, null);
            }
        }, 30000);
    } else {
        sessions.delete(uid);
        if (interaction) safeReply(interaction, "⏹ **Bot Disconnected.**");
    }
    updateAdminDashboard();
  });

  mc.on("error", (e) => console.log(`[Bedrock Error] ${e.message}`));
}

// ----------------- JAVA LOGIC (OFFLINE ONLY) -----------------

async function startJavaSession(uid, interaction) {
    const u = getUser(uid);
    const j = u.java;
    if (!j.server) return safeReply(interaction, "⚠ **Settings missing!** Configure IP/Port first.");
    
    if (javaSessions.has(uid)) return safeReply(interaction, { content: "❌ **You already have a Java bot running!**", ephemeral: true });

    const { ip, port } = j.server;

    if (interaction) safeReply(interaction, `⏳ **Connecting Java Bot to ${ip}:${port}...**`);

    const opts = {
        host: ip,
        port: port,
        username: j.offlineUsername || `Java_${uid.slice(-4)}`,
        auth: 'offline', // FORCED OFFLINE
        version: false
    };

    createJavaBot(uid, opts, interaction);
}

function createJavaBot(uid, opts, interaction = null) {
    let bot;
    try {
        bot = mineflayer.createBot(opts);
    } catch (e) {
        if (interaction) safeReply(interaction, `❌ Java Error: ${e.message}`);
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
            afkInterval: null
        };
        javaSessions.set(uid, session);
    } else {
        session.bot = bot;
        session.connected = false;
    }

    bot.on('spawn', () => {
        session.connected = true;
        if (interaction && !interaction.replied) safeReply(interaction, `🟢 **Java Connected as ${bot.username}!**`);
        updateAdminDashboard();
        
        // Simple AFK
        session.afkInterval = setInterval(() => {
            try {
                bot.setControlState('jump', true);
                bot.look(Math.random() * Math.PI, Math.random() * Math.PI);
                setTimeout(() => bot.setControlState('jump', false), 500);
            } catch (e) {}
        }, 15000);
    });

    bot.on('kicked', (reason) => {
        console.log(`[Java] Kicked: ${reason}`);
    });

    bot.on('end', () => {
        if (session.afkInterval) clearInterval(session.afkInterval);
        
        if (!session.manualStop) {
            console.log(`[Java] Ended ${uid}. Reconnecting in 30s...`);
            setTimeout(() => {
                if (javaSessions.has(uid) && !javaSessions.get(uid).manualStop) {
                    createJavaBot(uid, opts, null);
                }
            }, 30000);
        } else {
            javaSessions.delete(uid);
        }
        updateAdminDashboard();
    });

    bot.on('error', (err) => console.log(`[Java Error] ${err.message}`));
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
            return i.reply({ content: "**Bedrock Bot Panel 🤖**", components: bedrockPanelRow() });
        }
        else if (i.commandName === "java") {
            return i.reply({ content: "**Java Bot Panel 🤖**", components: javaPanelRow() });
        }
    }

    // --- BUTTONS ---
    if (i.isButton()) {
      // BEDROCK
      if (i.customId === "link") { await i.deferReply({ ephemeral: true }); return linkMicrosoft(uid, i); }
      if (i.customId === "unlink") { unlinkMicrosoft(uid); return i.reply({ ephemeral: true, content: "🗑 Microsoft account unlinked." }); }
      
      if (i.customId === "start") { 
          await i.deferReply({ ephemeral: true }); 
          return startSession(uid, i); 
      }
      
      if (i.customId === "stop") { 
          const s = sessions.get(uid); 
          if (!s) return i.reply({ content: "❌ **No bots running on your account.**", ephemeral: true });
          s.manualStop = true; 
          s.client.close(); 
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

      // JAVA
      if (i.customId === "java_start") { 
          await i.deferReply({ ephemeral: true }); 
          return startJavaSession(uid, i); 
      }
      
      if (i.customId === "java_stop") { 
          const s = javaSessions.get(uid); 
          if (!s) return i.reply({ content: "❌ **No bots running on your account.**", ephemeral: true });
          s.manualStop = true;
          s.bot.quit();
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

    // --- MENUS (Technical Actions) ---
    if (i.isStringSelectMenu()) {
        const val = i.values[0];
        
        // Bedrock Tech
        if (i.customId === "tech_actions") {
            const s = sessions.get(uid);
            if (!s || !s.connected) return i.reply({ ephemeral: true, content: "❌ Bot is not connected!" });

            if (val === "coords") {
                const p = s.pos;
                return i.reply({ ephemeral: true, content: `📍 **Position:** X: ${p.x.toFixed(1)}, Y: ${p.y.toFixed(1)}, Z: ${p.z.toFixed(1)}` });
            }
            if (val === "reconnect") {
                s.client.close(); // Triggers auto-reconnect
                return i.reply({ ephemeral: true, content: "🔄 **Forcing reconnect...**" });
            }
            if (val === "cmd") {
                const modal = new ModalBuilder().setCustomId("cmd_modal_bedrock").setTitle("Send Command");
                const input = new TextInputBuilder().setCustomId("cmd_input").setLabel("Command (without /)").setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return i.showModal(modal);
            }
        }

        // Java Tech
        if (i.customId === "java_tech_actions") {
            const s = javaSessions.get(uid);
            if (!s || !s.connected) return i.reply({ ephemeral: true, content: "❌ Bot is not connected!" });

            if (val === "coords") {
                const p = s.bot.entity.position;
                return i.reply({ ephemeral: true, content: `📍 **Position:** X: ${p.x.toFixed(1)}, Y: ${p.y.toFixed(1)}, Z: ${p.z.toFixed(1)}` });
            }
            if (val === "reconnect") {
                s.bot.quit(); // Triggers auto-reconnect
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
            if (s && s.client) s.client.write("command_request", { command: `/${cmd}`, origin: { type: 0, uuid: "", request_id: "", player_entity_id: undefined }, internal: false, version: 52 });
            return i.reply({ ephemeral: true, content: `📤 Sent: /${cmd}` });
        }
        if (i.customId === "cmd_modal_java") {
            const cmd = i.fields.getTextInputValue("cmd_input");
            const s = javaSessions.get(uid);
            if (s && s.bot) s.bot.chat(`/${cmd}`);
            return i.reply({ ephemeral: true, content: `📤 Sent: /${cmd}` });
        }
    }

  } catch (e) { console.error("Interaction Error:", e); }
});

client.once("ready", async () => {
  console.log(`🟢 System Online: ${client.user.tag}`);
  await client.application.commands.set([
      new SlashCommandBuilder().setName("panel").setDescription("Bedrock Bot Panel"),
      new SlashCommandBuilder().setName("java").setDescription("Java Bot Panel"),
      new SlashCommandBuilder().setName("admin").setDescription("System Admin")
  ]);
});

process.on("unhandledRejection", (e) => console.error("Error:", e));
client.login(DISCORD_TOKEN);


