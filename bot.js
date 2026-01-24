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

// ----------------------------------------------------------------
// PRODUCTION CONFIGURATION
// ----------------------------------------------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_ID = "1144987924123881564";
const LOG_CHANNEL_ID = "1464615030111731753";
const ADMIN_CHANNEL_ID = "1464615993320935447";
const CONNECTION_TIMEOUT = 25000; 

if (!DISCORD_TOKEN) {
  console.error("❌ CRITICAL: DISCORD_TOKEN is missing.");
  process.exit(1);
}

// ----------------------------------------------------------------
// DATABASE & DIRECTORIES
// ----------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const STORE_FILE = path.join(DATA_DIR, "users.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let users = {};
if (fs.existsSync(STORE_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch (e) {
    users = {};
  }
}

function save() {
  fs.writeFileSync(STORE_FILE, JSON.stringify(users, null, 2));
}

function getUser(uid) {
  if (!users[uid]) {
    users[uid] = {
      connectionType: "online",
      bedrockVersion: "auto",
      offlineUsername: `AFK_${uid.slice(-4)}`,
      active: false,
      server: null
    };
  }
  return users[uid];
}

function getAuthPath(uid) {
  const p = path.join(AUTH_DIR, uid);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

// ----------------------------------------------------------------
// RUNTIME STATE
// ----------------------------------------------------------------
const sessions = new Map();
const activeLinks = new Map();
let adminPanel = null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages
  ]
});

// ----------------------------------------------------------------
// PRODUCTION LOGGING
// ----------------------------------------------------------------

async function log(desc, color = "#5865F2") {
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID);
    if (ch && ch.isTextBased()) {
      const embed = new EmbedBuilder().setColor(color).setDescription(desc).setTimestamp();
      await ch.send({ embeds: [embed] });
    }
  } catch (e) {}
}

async function dm(uid, msg) {
  try {
    const u = await client.users.fetch(uid);
    if (u) await u.send(msg);
  } catch (e) {}
}

function checkGuild(i) {
  if (!i.inGuild() || i.guildId !== ALLOWED_GUILD_ID) {
    const txt = "Bot restricted to production guild ⛔";
    if (i.deferred || i.replied) i.editReply(txt).catch(() => {});
    else i.reply({ ephemeral: true, content: txt }).catch(() => {});
    return false;
  }
  return true;
}

// ----------------------------------------------------------------
// CORE SESSION LOGIC & RAM OPTIMIZATION
// ----------------------------------------------------------------

function stop(uid, manual = true) {
  const s = sessions.get(uid);
  if (manual) {
    const u = getUser(uid);
    u.active = false;
    save();
  }
  if (!s) return false;
  if (manual) s.manualStop = true;
  
  if (s.timeout) clearTimeout(s.timeout);
  if (s.reconnect) clearTimeout(s.reconnect);
  if (s.afk) clearInterval(s.afk);
  
  try {
    if (s.mc) {
      s.mc.removeAllListeners();
      s.mc.close();
      s.mc = null;
    }
  } catch (e) {}
  
  sessions.delete(uid);
  if (global.gc) global.gc();
  return true;
}

function start(uid, i = null) {
  const u = getUser(uid);
  if (!u.server || !u.server.ip) {
    if (i && !i.replied) i.editReply("⚠️ Configure Server Settings first.");
    return;
  }
  if (sessions.has(uid) && !sessions.get(uid).isRetry) {
    if (i && !i.replied) i.editReply("⚠️ Bot already running.");
    return;
  }

  u.active = true;
  save();

  const ip = u.server.ip;
  const port = parseInt(u.server.port) || 19132;

  const opts = {
    host: ip,
    port,
    connectTimeout: CONNECTION_TIMEOUT,
    keepAlive: true,
    version: u.bedrockVersion === "auto" ? undefined : u.bedrockVersion
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  } else {
    opts.username = uid;
    opts.offline = false;
    opts.profilesFolder = getAuthPath(uid);
  }

  const mc = bedrock.createClient(opts);
  let state = sessions.get(uid) || { started: Date.now(), manualStop: false, connected: false, pkts: 0, isRetry: false };
  state.mc = mc;
  state.isRetry = false;
  sessions.set(uid, state);

  // --- AGGRESSIVE RAM OPTIMIZATION ---
  mc.on('packet', (p) => {
    state.pkts++;
    const n = p.data.name;
    // Destroy world/chunk/entity data instantly
    if (n.includes('chunk') || n.includes('level') || n.includes('metadata') || n.includes('entity') || n.includes('player_list')) {
      if (p.data.payload) p.data.payload = null;
      p.data = null; 
    }
  });

  mc.on('play_status', (p) => {
    if ((p.status === 'player_spawn' || p.status === 'login_success') && !state.connected) {
      onSpawned(uid, mc, state, i, ip, port);
    }
  });

  mc.on("spawn", () => {
    if (!state.connected) onSpawned(uid, mc, state, i, ip, port);
  });

  state.timeout = setTimeout(() => {
    if (sessions.has(uid) && !state.connected) {
      if (i && i.deferred) i.editReply("❌ Connection Timeout (25s).");
      mc.close();
    }
  }, CONNECTION_TIMEOUT);

  mc.on("error", (e) => {
    clearTimeout(state.timeout);
    log(`❌ Error <@${uid}>: \`${e.message}\``, "#FF0000");
    if (!state.manualStop) retry(uid, i);
  });

  mc.on("close", () => {
    clearTimeout(state.timeout);
    log(`🔌 Closed <@${uid}>`, "#808080");
    if (!state.manualStop) retry(uid, i);
  });
}

function onSpawned(uid, mc, state, i, ip, port) {
  state.connected = true;
  clearTimeout(state.timeout);
  if (i && i.deferred) i.editReply(`🟢 Online at **${ip}:${port}**`);
  log(`✅ Bot <@${uid}> Online on ${ip}`, "#00FF00");

  state.afk = setInterval(() => {
    try {
      if (!mc.entityId) return;
      mc.write("move_player", {
        runtime_id: mc.entityId, position: mc.entity?.position || {x:0,y:0,z:0}, pitch: 0, yaw: 0, head_yaw: 0,
        mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false
      });
    } catch (e) {}
  }, 60000);
}

function retry(uid, i) {
  const s = sessions.get(uid);
  if (!s || s.manualStop || s.reconnect) return;
  s.isRetry = true;
  s.connected = false;
  s.reconnect = setTimeout(() => {
    if (sessions.has(uid) && !s.manualStop) {
      s.reconnect = null;
      start(uid, i);
    }
  }, 120000);
}

// ----------------------------------------------------------------
// MICROSOFT AUTHENTICATION
// ----------------------------------------------------------------

async function link(uid, i) {
  if (activeLinks.has(uid)) return i.editReply("⏳ Login already active.");

  // Pre-reply to prevent Discord timeout
  await i.editReply("⏳ Initializing Microsoft Authflow... Please wait.");

  const authPath = getAuthPath(uid);
  const u = getUser(uid);

  try {
    const flow = new Authflow(uid, authPath, {
      flow: "live",
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: "Nintendo"
    }, async (data) => {
      // Callback from prismarine-auth with code and link
      const embed = new EmbedBuilder()
        .setTitle("🔐 Microsoft Login")
        .setDescription(`Code: **\`${data.user_code}\`**\n\n1. Click button below\n2. Enter the code\n\n*Bot will update when done.*`)
        .setColor("#5865F2");
      
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Enter Code").setStyle(ButtonStyle.Link).setURL(data.verification_uri_complete)
      );

      await i.editReply({ content: null, embeds: [embed], components: [row] });
    });

    const p = (async () => {
      try {
        await flow.getMsaToken();
        u.linked = true;
        save();
        await i.followUp({ ephemeral: true, content: "✅ Microsoft account linked!" });
        log(`🔑 User <@${uid}> linked their account.`);
      } catch (e) {
        await i.followUp({ ephemeral: true, content: `❌ Auth Error: ${e.message}` });
      } finally {
        activeLinks.delete(uid);
      }
    })();

    activeLinks.set(uid, p);

  } catch (e) {
    await i.editReply(`❌ Init Error: ${e.message}`);
    activeLinks.delete(uid);
  }
}

// ----------------------------------------------------------------
// ADMIN INTERFACE
// ----------------------------------------------------------------

function getStats() {
  const m = process.memoryUsage();
  const rss = (m.rss / 1024 / 1024).toFixed(2);
  const up = process.uptime();
  return new EmbedBuilder()
    .setTitle("🚀 Production Admin Dashboard")
    .setColor("#2B2D31")
    .addFields(
      { name: "💻 System", value: `**RAM:** ${rss} MB\n**Uptime:** ${Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m`, inline: true },
      { name: "📊 Bots", value: `**Active:** ${sessions.size}\n**Users:** ${Object.keys(users).length}`, inline: true }
    )
    .setTimestamp();
}

function getRows() {
  const r = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("adm_ref").setLabel("Refresh").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("adm_stop").setLabel("Stop All").setStyle(ButtonStyle.Danger)
  )];
  if (sessions.size > 0) {
    const opts = Array.from(sessions.keys()).slice(0, 25).map(id => ({ label: id, value: id }));
    r.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId("adm_force").setPlaceholder("Force Stop User").addOptions(opts)));
  }
  return r;
}

// ----------------------------------------------------------------
// HANDLERS
// ----------------------------------------------------------------

client.once("ready", async () => {
  console.log(`🟢 Production Instance: ${client.user.tag}`);
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("User Control Panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Admin Analytics")
  ];
  await client.application.commands.set(cmds);

  // Post-Deployment Auto-Restore
  const restoreUids = Object.keys(users).filter(id => users[id].active === true);
  restoreUids.forEach((id, idx) => setTimeout(() => start(id), idx * 3000));

  setInterval(async () => {
    if (adminPanel) {
      try { await adminPanel.edit({ embeds: [getStats()], components: getRows() }); } catch (e) { adminPanel = null; }
    }
  }, 30000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!checkGuild(interaction)) return;
    const uid = interaction.user.id;

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "panel") {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("btn_l").setLabel("Link Microsoft").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("btn_u").setLabel("Unlink").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("btn_on").setLabel("Start").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("btn_off").setLabel("Stop").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("btn_s").setLabel("Settings").setStyle(ButtonStyle.Secondary)
        );
        return interaction.reply({ content: "🎛 **AFK Bot Panel**", components: [row] });
      }
      if (interaction.commandName === "admin") {
        if (uid !== ADMIN_ID) return interaction.reply({ content: "⛔ Access Denied.", ephemeral: true });
        adminPanel = await interaction.reply({ embeds: [getStats()], components: getRows(), fetchReply: true });
        return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === "adm_ref") return interaction.update({ embeds: [getStats()], components: getRows() });
      if (interaction.customId === "adm_stop") {
        if (uid !== ADMIN_ID) return;
        for (const [id, s] of sessions) { stop(id, true); dm(id, "⚠️ Your bot was stopped by admin."); }
        return interaction.reply({ content: "All bots terminated.", ephemeral: true });
      }
      if (interaction.customId === "btn_l") { await interaction.deferReply({ ephemeral: true }); return link(uid, interaction); }
      if (interaction.customId === "btn_u") {
        const p = getAuthPath(uid); if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        const profile = getUser(uid); profile.linked = false; profile.active = false; save();
        return interaction.reply({ content: "🗑 Account Unlinked.", ephemeral: true });
      }
      if (interaction.customId === "btn_on") { await interaction.deferReply({ ephemeral: true }); return start(uid, interaction); }
      if (interaction.customId === "btn_off") {
        if (stop(uid, true)) return interaction.reply({ content: "⏹ Bot Stopped.", ephemeral: true });
        return interaction.reply({ content: "Bot not active.", ephemeral: true });
      }
      if (interaction.customId === "btn_s") {
        const p = getUser(uid);
        const modal = new ModalBuilder().setCustomId("m_s").setTitle("Settings");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("i_ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(p.server?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("i_p").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(p.server?.port || 19132))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("i_o").setLabel("Offline Name").setStyle(TextInputStyle.Short).setValue(p.offlineUsername || ""))
        );
        return interaction.showModal(modal);
      }
    }

    if (interaction.isModalSubmit() && interaction.customId === "m_s") {
      const p = getUser(uid);
      p.server = { ip: interaction.fields.getTextInputValue("i_ip"), port: interaction.fields.getTextInputValue("i_p") };
      p.offlineUsername = interaction.fields.getTextInputValue("i_o");
      save();
      return interaction.reply({ content: "✅ Saved.", ephemeral: true });
    }
    
    if (interaction.isStringSelectMenu() && interaction.customId === "adm_force") {
      const target = interaction.values[0];
      if (stop(target, true)) { dm(target, "⚠️ Bot stopped by admin."); return interaction.reply({ content: `✅ Stopped <@${target}>`, ephemeral: true }); }
    }
  } catch (err) { console.error(err); }
});

process.on("unhandledRejection", (e) => console.error(e));
client.login(DISCORD_TOKEN);
