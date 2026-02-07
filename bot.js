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
const mcJava = require("minecraft-protocol"); // Java logic requirement
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

const ALLOWED_GUILD_ID = "1462335230345089254";

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
  // Java defaults
  if (!users[uid].javaConnectionType) users[uid].javaConnectionType = "online";
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
const javaSessions = new Map(); // Separate map for Java
const pendingLink = new Map();
const lastMsa = new Map();

// ----------------- Discord client -----------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

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
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start Bedrock").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop Bedrock").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("more").setLabel("➕ More").setStyle(ButtonStyle.Secondary)
    )
  ];
}

// Java UI Panel
function javaPanelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("j_start").setLabel("▶ Start Java").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("j_stop").setLabel("⏹ Stop Java").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("j_settings").setLabel("⚙ Java Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("set_java_conn")
        .setPlaceholder("🔌 Java Connection Type")
        .addOptions(
          { label: "Online (Microsoft)", value: "online" },
          { label: "Offline (Cracked)", value: "offline" }
        )
    )
  ];
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

// ----------------- Slash commands -----------------
client.once("ready", async () => {
  console.log("🟢 Online as", client.user.tag);

  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
    new SlashCommandBuilder().setName("java").setDescription("Open Java AFK panel")
  ];

  await client.application.commands.set(cmds);
});

// ----------------- Microsoft link -----------------
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) {
    await interaction.editReply("⏳ Login already in progress. Use the last code.");
    return;
  }

  const authDir = getUserAuthDir(uid);
  const u = getUser(uid);
  let codeShown = false;

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

      const msg =
        `🔐 **Microsoft login required**\n\n` +
        `👉 ${uri}\n\n` +
        `Your code: \`${code}\`\n\n` +
        `⚠ **IMPORTANT:** Use a *second* Microsoft account.\n` +
        `Do **NOT** use the account you normally play with.\n\n` +
        `Come back here after login.`;

      await interaction.editReply({ content: msg, components: msaComponents(uri) }).catch(() => {});
    }
  );

  const p = (async () => {
    try {
      if (!codeShown) await interaction.editReply("⏳ Requesting Microsoft login code…");
      await flow.getMsaToken();
      u.linked = true;
      save();
      await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account linked!" }).catch(() => {});
    } catch (e) {
      await interaction.editReply(`❌ Microsoft login failed:\n${String(e?.message || e)}`).catch(() => {});
    } finally {
      pendingLink.delete(uid);
    }
  })();

  pendingLink.set(uid, p);
}

// ----------------- Bedrock session -----------------
function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  try { s.client.close(); } catch {}
  sessions.delete(uid);
}

function stopSession(uid) {
  if (!sessions.get(uid)) return false;
  const s = sessions.get(uid);
  s.manualStop = true; 
  cleanupSession(uid);
  return true;
}

async function startSession(uid, interaction) {
  const u = getUser(uid);
  if (!u.server) {
    if (interaction && !interaction.replied) interaction.editReply("⚠ Set settings first.");
    return;
  }
  
  const existing = sessions.get(uid);
  if (existing && !existing.isReconnecting) {
    if (interaction && !interaction.replied) interaction.editReply("⚠ You already have a running bot.");
    return;
  }

  const { ip, port } = u.server;

  // --- MOTD PING CHECK ---
  try {
    console.log(`[Bedrock] Pinging ${ip}:${port}...`);
    const status = await bedrock.ping({ host: ip, port: port });
    console.log(`[Bedrock] Server online: ${status.motd}`);
  } catch (err) {
    if (interaction && !interaction.replied) interaction.editReply(`❌ Server Offline (MOTD Check Failed). Retrying in 30s...`);
    handleAutoReconnect(uid, interaction);
    return;
  }
  // -----------------------

  const authDir = getUserAuthDir(uid);
  const opts = {
    host: ip,
    port,
    connectTimeout: 47000,
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
  
  let currentSession = sessions.get(uid);
  if (!currentSession) {
    currentSession = { client: mc, timeout: null, startedAt: Date.now(), manualStop: false };
    sessions.set(uid, currentSession);
  } else {
    currentSession.client = mc;
    currentSession.isReconnecting = false;
  }

  const waitForEntity = setInterval(() => {
    if (!mc.entity || !mc.entityId) return;

    clearInterval(waitForEntity);

    let moveToggle = false;
    const afkInterval = setInterval(() => {
      try {
        const pos = { ...mc.entity.position };
        if (moveToggle) {
           pos.x += 0.5;
        } else {
           pos.x -= 0.5;
        }
        moveToggle = !moveToggle;

        mc.write("move_player", {
          runtime_id: mc.entityId,
          position: pos,
          pitch: 0,
          yaw: Math.random() * 360,
          head_yaw: Math.random() * 360,
          mode: 0,
          on_ground: true,
          ridden_runtime_id: 0,
          teleport: false
        });
      } catch {}
    }, 60 * 1000);

    mc.once("close", () => clearInterval(afkInterval));
    mc.once("error", () => clearInterval(afkInterval));
  }, 1000);

  currentSession.timeout = setTimeout(() => {
    if (sessions.has(uid) && !currentSession.connected) {
      if (interaction && !interaction.replied) interaction.editReply("❌ Connection timeout. Retrying in 30s...");
      mc.close();
    }
  }, 47000);

  mc.on("spawn", () => {
    currentSession.connected = true;
    clearTimeout(currentSession.timeout);
    if (interaction && interaction.deferred) {
        interaction.editReply(`🟢 Bedrock connected to **${ip}:${port}**`).catch(() => {});
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
    s.reconnectTimer = setTimeout(() => {
        if (sessions.has(uid) && !s.manualStop) {
            s.reconnectTimer = null;
            startSession(uid, interaction);
        }
    }, 30000);
}

// ----------------- Java Logic (No Mineflayer) -----------------

function cleanupJavaSession(uid) {
  const s = javaSessions.get(uid);
  if (!s) return;
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  try { s.client.end(); } catch {}
  javaSessions.delete(uid);
}

function stopJavaSession(uid) {
  if (!javaSessions.get(uid)) return false;
  const s = javaSessions.get(uid);
  s.manualStop = true;
  cleanupJavaSession(uid);
  return true;
}

function handleJavaAutoReconnect(uid, interaction) {
  const s = javaSessions.get(uid);
  if (!s || s.manualStop || s.reconnectTimer) return;
  s.isReconnecting = true;
  s.reconnectTimer = setTimeout(() => {
    if (javaSessions.has(uid) && !s.manualStop) {
      s.reconnectTimer = null;
      startJavaSession(uid, interaction);
    }
  }, 30000);
}

async function startJavaSession(uid, interaction) {
  const u = getUser(uid);
  if (!u.javaServer) {
    if (interaction && !interaction.replied) interaction.editReply("⚠ Set Java settings first.");
    return;
  }

  const existing = javaSessions.get(uid);
  if (existing && !existing.isReconnecting) {
    if (interaction && !interaction.replied) interaction.editReply("⚠ You already have a running Java bot.");
    return;
  }

  const { ip, port } = u.javaServer;
  const authDir = getUserAuthDir(uid);

  const opts = {
    host: ip,
    port: port,
    version: false // Auto-detect version
  };

  if (u.javaConnectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_Java_${uid.slice(-4)}`;
  } else {
    // Online mode via Xbox account
    opts.auth = 'microsoft';
    opts.profilesFolder = authDir;
    opts.username = uid;
  }

  const mc = mcJava.createClient(opts);
  let session = javaSessions.get(uid);

  if (!session) {
    session = { client: mc, manualStop: false, pos: { x: 0, y: 0, z: 0 } };
    javaSessions.set(uid, session);
  } else {
    session.client = mc;
    session.isReconnecting = false;
  }

  // Handle movements to prevent AFK kick
  mc.on('position', (packet) => {
    session.pos = { x: packet.x, y: packet.y, z: packet.z };
  });

  const afkTimer = setInterval(() => {
    if (mc.state === mcJava.states.PLAY) {
      // Small jitter movement
      mc.write('position', {
        x: session.pos.x + (Math.random() * 0.1),
        y: session.pos.y,
        z: session.pos.z + (Math.random() * 0.1),
        onGround: true
      });
    }
  }, 60000);

  mc.on('login', () => {
    if (interaction && interaction.deferred) {
      interaction.editReply(`🟢 Java Bot connected to **${ip}:${port}**`).catch(() => {});
    }
  });

  mc.on('error', (err) => {
    clearInterval(afkTimer);
    if (!session.manualStop) handleJavaAutoReconnect(uid, interaction);
  });

  mc.on('end', () => {
    clearInterval(afkTimer);
    if (!session.manualStop) handleJavaAutoReconnect(uid, interaction);
  });
}

// ----------------- Interactions -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    const blocked = denyIfWrongGuild(i);
    if (blocked) return;

    const uid = i.user.id;

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") {
        return i.reply({ content: "🎛 **Bedrock AFK Panel**", components: panelRow() });
      }
      if (i.commandName === "java") {
        return i.reply({ content: "☕ **Java AFK Panel**", components: javaPanelRow() });
      }
    }

    if (i.isButton()) {
      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true });
        return linkMicrosoft(uid, i);
      }
      if (i.customId === "unlink") {
        unlinkMicrosoft(uid);
        return i.reply({ ephemeral: true, content: "🗑 Microsoft account unlinked." });
      }

      // Bedrock Buttons
      if (i.customId === "start") {
        await i.deferReply({ ephemeral: true });
        return startSession(uid, i);
      }
      if (i.customId === "stop") {
        stopSession(uid);
        return i.reply({ ephemeral: true, content: "⏹ Bedrock Stopped." });
      }
      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("⚙ Bedrock Settings");
        const ip = new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "");
        const port = new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132));
        modal.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port));
        return i.showModal(modal);
      }

      // Java Buttons
      if (i.customId === "j_start") {
        await i.deferReply({ ephemeral: true });
        await i.editReply("⏳ Connecting Java...");
        return startJavaSession(uid, i);
      }
      if (i.customId === "j_stop") {
        stopJavaSession(uid);
        return i.reply({ ephemeral: true, content: "⏹ Java Stopped." });
      }
      if (i.customId === "j_settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("j_settings_modal").setTitle("⚙ Java Settings");
        const ip = new TextInputBuilder().setCustomId("j_ip").setLabel("Java Server IP").setStyle(TextInputStyle.Short).setValue(u.javaServer?.ip || "");
        const port = new TextInputBuilder().setCustomId("j_port").setLabel("Port (25565)").setStyle(TextInputStyle.Short).setValue(String(u.javaServer?.port || 25565));
        modal.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port));
        return i.showModal(modal);
      }

      if (i.customId === "more") {
        const u = getUser(uid);
        return i.reply({
          ephemeral: true,
          content: "➕ **More options**",
          components: [versionRow(u.bedrockVersion), connRow(u.connectionType)]
        });
      }
    }

    if (i.isStringSelectMenu()) {
      const u = getUser(uid);
      if (i.customId === "set_version") { u.bedrockVersion = i.values[0]; save(); return i.reply({ ephemeral: true, content: `Version: ${u.bedrockVersion}` }); }
      if (i.customId === "set_conn") { u.connectionType = i.values[0]; save(); return i.reply({ ephemeral: true, content: `Conn: ${u.connectionType}` }); }
      if (i.customId === "set_java_conn") { u.javaConnectionType = i.values[0]; save(); return i.reply({ ephemeral: true, content: `Java Conn: ${u.javaConnectionType}` }); }
    }

    if (i.isModalSubmit()) {
      const u = getUser(uid);
      if (i.customId === "settings_modal") {
        u.server = { ip: i.fields.getTextInputValue("ip"), port: parseInt(i.fields.getTextInputValue("port")) };
        save();
        return i.reply({ ephemeral: true, content: "Bedrock settings saved." });
      }
      if (i.customId === "j_settings_modal") {
        u.javaServer = { ip: i.fields.getTextInputValue("j_ip"), port: parseInt(i.fields.getTextInputValue("j_port")) };
        save();
        return i.reply({ ephemeral: true, content: "Java settings saved." });
      }
    }

  } catch (e) {
    console.error("Interaction error:", e);
  }
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

client.login(DISCORD_TOKEN);
