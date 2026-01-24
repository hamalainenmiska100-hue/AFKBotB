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

// ----------------- Production Config -----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_ID = "1144987924123881564";
const LOG_CHANNEL_ID = "1464615030111731753";
const ADMIN_CHANNEL_ID = "1464615993320935447";
const RECONNECT_DELAY = 30000; // 30 seconds as requested

if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

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
  if (users[uid].active === undefined) users[uid].active = false;
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
  u.active = false;
  save();
}

// ----------------- Runtime -----------------
const sessions = new Map();
const pendingLink = new Map();
const lastMsa = new Map();
let adminPanelMessage = null;

// ----------------- Discord client -----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages
  ]
});

// ----------------- Production Logging -----------------
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
  } catch (e) {}
}

async function sendPrivateDM(uid, message) {
  try {
    const user = await client.users.fetch(uid);
    if (user) await user.send(message);
  } catch (e) {}
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

// ----------------- UI helpers -----------------
function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink Microsoft").setStyle(ButtonStyle.Secondary),
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
      new ButtonBuilder().setCustomId("admin_refresh").setLabel("Refresh Stats").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_stop_all").setLabel("Force Stop All").setStyle(ButtonStyle.Danger)
    )
  ];

  if (sessions.size > 0) {
    const options = Array.from(sessions.keys()).slice(0, 25).map(uid => ({
      label: `User: ${uid}`,
      description: sessions.get(uid).connected ? "Online" : "Connecting...",
      value: uid
    }));
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId("admin_force_stop").setPlaceholder("Force stop a specific bot").addOptions(options)
    ));
  }
  return rows;
}

function msaComponents(uri) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("🌐 Open link").setStyle(ButtonStyle.Link).setURL(uri)
    )
  ];
}

function versionRow(current = "auto") {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("set_version")
    .setPlaceholder("🌐 Bedrock Version")
    .addOptions(
      { label: "Auto", value: "auto", default: current === "auto" },
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
      { label: "Online (Microsoft)", value: "online", default: current === "online" },
      { label: "Offline (Cracked)", value: "offline", default: current === "offline" }
    );
  return new ActionRowBuilder().addComponents(menu);
}

// ----------------- Admin Analytics -----------------
function getAdminStats() {
  const mem = process.memoryUsage();
  const uptime = process.uptime();
  const embed = new EmbedBuilder()
    .setTitle("🛠 Admin Control Panel")
    .setColor("#2F3136")
    .addFields(
      { name: "📊 System Stats", value: `**RAM:** ${(mem.rss / 1024 / 1024).toFixed(2)} MB\n**Uptime:** ${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m\n**Active Bots:** ${sessions.size}`, inline: true },
      { name: "📂 Storage", value: `**Linked Users:** ${Object.keys(users).length}\n**Data Dir:** /app/data`, inline: true }
    )
    .setTimestamp();

  if (sessions.size > 0) {
    let list = "";
    for (const [uid, s] of sessions) {
      const statusIcon = s.connected ? "🟢" : "🟠";
      list += `${statusIcon} <@${uid}>: ${s.connected ? "Online" : "Connecting"} (${s.pkts || 0} pkts)\n`;
    }
    embed.addFields({ name: "🤖 Active Bots List", value: list.slice(0, 1024) });
  }
  return embed;
}

// ----------------- Slash commands -----------------
client.once("ready", async () => {
  console.log("🟢 Online as", client.user.tag);

  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Admin Control Panel (Owner only)")
  ];

  await client.application.commands.set(cmds);

  // --- FIXED AUTO-RESTORE (No more ReferenceError) ---
  const activeIds = Object.keys(users).filter(id => users[id].active === true);
  if (activeIds.length > 0) {
    logToDiscord(`♻️ **Auto-Restore**: Deployment finished. Reconnecting ${activeIds.length} bots...`);
    activeIds.forEach((id, idx) => {
      setTimeout(() => startSession(id), idx * 3000);
    });
  }

  // Admin Auto-Refresh
  setInterval(async () => {
    if (adminPanelMessage) {
      try { await adminPanelMessage.edit({ embeds: [getAdminStats()], components: adminPanelComponents() }); }
      catch (e) { adminPanelMessage = null; }
    }
  }, 30000);
});

// ----------------- Microsoft link -----------------
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) {
    await interaction.editReply("⏳ Login already in progress. Use the last code.");
    return;
  }

  await interaction.editReply("⏳ Requesting login code from Microsoft... Please wait.");

  const authDir = getUserAuthDir(uid);
  const u = getUser(uid);
  let codeShown = false;

  try {
    const flow = new Authflow(
      uid,
      authDir,
      {
        flow: "live",
        authTitle: Titles?.MinecraftNintendoSwitch || "Bedrock AFK Bot",
        deviceType: "Nintendo"
      },
      async (data) => {
        const uri = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
        const code = data.user_code || "(no code)";
        lastMsa.set(uid, { uri, code, at: Date.now() });
        codeShown = true;

        const embed = new EmbedBuilder()
          .setTitle("🔐 Microsoft Login")
          .setDescription(`Code: **\`${code}\`**\n\n1. Click button below\n2. Enter the code\n\n*The bot will update when done.*`)
          .setColor("#5865F2");

        await interaction.editReply({ content: null, embeds: [embed], components: msaComponents(uri) }).catch(() => {});
      }
    );

    const p = (async () => {
      try {
        await flow.getMsaToken();
        u.linked = true;
        save();
        await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account linked!" }).catch(() => {});
        logToDiscord(`🔑 User <@${uid}> successfully linked.`);
      } catch (e) {
        await interaction.followUp({ ephemeral: true, content: `❌ Microsoft login failed: ${e.message}` }).catch(() => {});
      } finally {
        pendingLink.delete(uid);
      }
    })();
    pendingLink.set(uid, p);
  } catch (e) {
    await interaction.editReply(`❌ Failed to init Microsoft flow: ${e.message}`);
  }
}

// ----------------- Bedrock session -----------------
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
  if (manual) {
    const u = getUser(uid);
    u.active = false;
    save();
  }
  if (!s) return false;
  if (manual) s.manualStop = true;
  cleanupSession(uid);
  return true;
}

function startSession(uid, interaction = null) {
  const u = getUser(uid);
  if (!u.server || !u.server.ip) {
    if (interaction) interaction.editReply("⚠ Set settings first.");
    return;
  }
  if (sessions.has(uid) && !sessions.get(uid).isRejoining) {
    if (interaction) interaction.editReply("⚠ You already have a running bot.");
    return;
  }

  u.active = true;
  save();

  const { ip, port } = u.server;
  const authDir = getUserAuthDir(uid);

  const opts = {
    host: ip,
    port: parseInt(port),
    connectTimeout: 25000,
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
  let session = sessions.get(uid) || { startedAt: Date.now(), manualStop: false, connected: false, pkts: 0 };
  session.client = mc;
  session.isRejoining = false;
  sessions.set(uid, session);

  // --- RAM OPTIMIZATION (Packet Stripping) ---
  mc.on('packet', (packet) => {
    session.pkts++;
    const name = packet.data.name;
    if (name.includes('chunk') || name.includes('level') || name.includes('metadata') || name.includes('entity') || name.includes('player_list')) {
      if (packet.data.payload) packet.data.payload = null;
      packet.data = null; 
    }
  });

  // Geyser Fix
  mc.on('play_status', (p) => {
    if ((p.status === 'player_spawn' || p.status === 'login_success') && !session.connected) {
      handleJoin(uid, mc, session, interaction, ip, port);
    }
  });

  mc.on("spawn", () => {
    if (!session.connected) handleJoin(uid, mc, session, interaction, ip, port);
  });

  session.timeout = setTimeout(() => {
    if (sessions.has(uid) && !session.connected) {
      if (interaction && interaction.deferred) interaction.editReply("❌ Timeout (25s). Check Server IP.");
      mc.close();
    }
  }, 25000);

  mc.on("error", (e) => {
    clearTimeout(session.timeout);
    logToDiscord(`❌ Error <@${uid}>: \`${e.message}\``, "#FF0000");
    if (!session.manualStop) handleRejoin(uid, interaction);
  });

  mc.on("close", () => {
    clearTimeout(session.timeout);
    logToDiscord(`🔌 Closed <@${uid}>`, "#808080");
    if (!session.manualStop) handleRejoin(uid, interaction);
  });
}

function handleJoin(uid, mc, session, interaction, ip, port) {
  session.connected = true;
  clearTimeout(session.timeout);
  if (interaction && interaction.deferred) interaction.editReply(`🟢 Connected to **${ip}:${port}**`);
  logToDiscord(`✅ Bot <@${uid}> is Online on ${ip}`, "#00FF00");

  session.afkInterval = setInterval(() => {
    try {
      if (!mc.entityId) return;
      mc.write("move_player", {
        runtime_id: mc.entityId,
        position: mc.entity.position || {x:0,y:0,z:0},
        pitch: 0, yaw: 0, head_yaw: 0,
        mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false
      });
    } catch {}
  }, 60000);
}

// ----------------- REJOIN LOGIC (30s Loop) -----------------
function handleRejoin(uid, interaction) {
  const s = sessions.get(uid);
  if (!s || s.manualStop || s.reconnectTimer) return;

  s.isRejoining = true;
  s.connected = false;
  s.reconnectTimer = setTimeout(() => {
    if (sessions.has(uid) && !s.manualStop) {
      s.reconnectTimer = null;
      startSession(uid, interaction);
    }
  }, 30000); // 30 seconds
}

// ----------------- Interactions -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (denyIfWrongGuild(i)) return;
    const uid = i.user.id;

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") {
        return i.reply({ content: "🎛 **Bedrock AFK Panel**", components: panelRow() });
      }
      if (i.commandName === "admin") {
        if (uid !== ADMIN_ID) return i.reply({ content: "⛔ Unauthorized", ephemeral: true });
        adminPanelMessage = await i.reply({ embeds: [getAdminStats()], components: adminPanelComponents(), fetchReply: true });
        return;
      }
    }

    if (i.isButton()) {
      if (i.customId === "admin_refresh") {
        if (uid !== ADMIN_ID) return;
        return i.update({ embeds: [getAdminStats()], components: adminPanelComponents() });
      }
      if (i.customId === "admin_stop_all") {
        if (uid !== ADMIN_ID) return;
        let count = 0;
        for (const [id, s] of sessions) { stopSession(id, true); sendPrivateDM(id, "⚠️ Your bot was stopped by the owner."); count++; }
        return i.reply({ content: `Stopped ${count} bots.`, ephemeral: true });
      }

      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true });
        return linkMicrosoft(uid, i);
      }

      if (i.customId === "unlink") {
        unlinkMicrosoft(uid);
        return i.reply({ ephemeral: true, content: "🗑 Microsoft account unlinked." });
      }

      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("⚙ Settings");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setRequired(true).setValue(u.server?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(u.server?.port || 19132))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("offline").setLabel("Offline username").setStyle(TextInputStyle.Short).setRequired(false).setValue(u.offlineUsername || ""))
        );
        return i.showModal(modal);
      }

      if (i.customId === "start") {
        await i.deferReply({ ephemeral: true });
        return startSession(uid, i);
      }

      if (i.customId === "stop") {
        if (stopSession(uid, true)) return i.reply({ ephemeral: true, content: "⏹ Stopped." });
        return i.reply({ ephemeral: true, content: "No bot active." });
      }

      if (i.customId === "more") {
        const u = getUser(uid);
        return i.reply({
          ephemeral: true,
          content: "➕ **More options**",
          components: [
            new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("invisible").setLabel("👻 Invisible Mode").setStyle(ButtonStyle.Secondary)),
            versionRow(u.bedrockVersion),
            connRow(u.connectionType)
          ]
        });
      }

      if (i.customId === "invisible") {
        const s = sessions.get(uid);
        if (!s) return i.reply({ ephemeral: true, content: "Bot is not running." });
        try {
          s.client.write("command_request", { command: "/gamemode survival @s", internal: false, version: 2 });
          return i.reply({ ephemeral: true, content: "Attempted to hide bot." });
        } catch {
          return i.reply({ ephemeral: true, content: "Commands not allowed." });
        }
      }
    }

    if (i.isStringSelectMenu()) {
      const u = getUser(uid);
      if (i.customId === "set_version") { u.bedrockVersion = i.values[0]; save(); return i.reply({ ephemeral: true, content: `Version: ${u.bedrockVersion}` }); }
      if (i.customId === "set_conn") { u.connectionType = i.values[0]; save(); return i.reply({ ephemeral: true, content: `Auth: ${u.connectionType}` }); }
      if (i.customId === "admin_force_stop") {
        if (uid !== ADMIN_ID) return;
        if (stopSession(i.values[0], true)) {
          sendPrivateDM(i.values[0], "⚠️ Your bot was stopped by the owner.");
          return i.reply({ ephemeral: true, content: "Bot terminated." });
        }
      }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
      const u = getUser(uid);
      u.server = { ip: i.fields.getTextInputValue("ip").trim(), port: i.fields.getTextInputValue("port").trim() };
      u.offlineUsername = i.fields.getTextInputValue("offline").trim();
      save();
      return i.reply({ ephemeral: true, content: "✅ Saved." });
    }
  } catch (e) { console.error(e); }
});

process.on("unhandledRejection", (e) => console.error(e));
client.login(DISCORD_TOKEN);

