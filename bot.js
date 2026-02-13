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

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

const ALLOWED_GUILD_ID = "1464973275397357772";

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
  if (!users[uid].reconnectAttempts) users[uid].reconnectAttempts = 0;
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
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("more").setLabel("➕ More").setStyle(ButtonStyle.Secondary)
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
    new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel")
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

// ----------------- MOTD / Ping Check -----------------
async function checkServerStatus(ip, port) {
  try {
    const result = await bedrock.ping({ host: ip, port: port || 19132 });
    return { 
      online: true, 
      motd: result.motd || "Unknown", 
      players: result.players || { online: 0, max: 0 },
      version: result.version,
      latency: result.latency
    };
  } catch (e) {
    return { online: false, error: e.message };
  }
}

// ----------------- Bedrock session -----------------
function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.afkInterval) clearInterval(s.afkInterval);
  if (s.handSwingInterval) clearInterval(s.handSwingInterval);
  if (s.pingCheckInterval) clearInterval(s.pingCheckInterval);
  try { s.client.close(); } catch {}
  sessions.delete(uid);
}

function stopSession(uid) {
  if (!sessions.get(uid)) return false;
  const s = sessions.get(uid);
  s.manualStop = true;
  cleanupSession(uid);
  // Reset reconnect attempts when manually stopped
  const u = getUser(uid);
  u.reconnectAttempts = 0;
  save();
  return true;
}

async function startSession(uid, interaction, isReconnect = false) {
  const u = getUser(uid);
  if (!u.server) {
    if (interaction && !interaction.replied) {
      const reply = isReconnect ? interaction.followUp : interaction.editReply;
      await reply.call(interaction, { ephemeral: true, content: "⚠ Set settings first." }).catch(() => {});
    }
    return;
  }
  
  // Check if already running (unless it's a reconnect)
  const existing = sessions.get(uid);
  if (existing && !existing.isReconnecting && !isReconnect) {
    if (interaction && !interaction.replied) {
      await interaction.editReply("⚠ You already have a running bot.").catch(() => {});
    }
    return;
  }

  const { ip, port } = u.server;

  // MOTD Check before connecting
  if (interaction && !isReconnect) {
    await interaction.editReply("🔍 Checking server status...").catch(() => {});
  }
  
  const status = await checkServerStatus(ip, port);
  
  if (!status.online) {
    const msg = `❌ Server **${ip}:${port}** is offline or unreachable.\nError: ${status.error || "Unknown"}`;
    if (interaction) {
      if (isReconnect) {
        await interaction.followUp({ ephemeral: true, content: msg }).catch(() => {});
      } else {
        await interaction.editReply(msg).catch(() => {});
      }
    }
    
    // Schedule retry if this was an auto-reconnect attempt
    if (isReconnect) {
      handleAutoReconnect(uid, interaction);
    }
    return;
  }

  // Server is online, proceed with connection
  if (interaction && !isReconnect) {
    await interaction.editReply(`✅ Server online! MOTD: ${status.motd}\n👥 Players: ${status.players?.online || 0}/${status.players?.max || 0}\n🌐 Version: ${status.version || "Unknown"}\n\n⏳ Connecting...`).catch(() => {});
  }

  const authDir = getUserAuthDir(uid);

  const opts = {
    host: ip,
    port: port || 19132,
    connectTimeout: 30000, // Reduced from 47s to 30s
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

  let mc;
  try {
    mc = bedrock.createClient(opts);
  } catch (e) {
    console.error(`[${uid}] Failed to create client:`, e);
    if (interaction) {
      const msg = `❌ Failed to create connection: ${e.message}`;
      if (isReconnect) {
        await interaction.followUp({ ephemeral: true, content: msg }).catch(() => {});
      } else {
        await interaction.editReply(msg).catch(() => {});
      }
    }
    handleAutoReconnect(uid, interaction);
    return;
  }
  
  let currentSession = sessions.get(uid);
  if (!currentSession) {
    currentSession = { 
      client: mc, 
      timeout: null, 
      startedAt: Date.now(), 
      manualStop: false,
      isReconnecting: false,
      connected: false,
      afkInterval: null,
      handSwingInterval: null,
      pingCheckInterval: null,
      lastPing: Date.now()
    };
    sessions.set(uid, currentSession);
  } else {
    currentSession.client = mc;
    currentSession.isReconnecting = false;
    currentSession.connected = false;
  }

  // Connection timeout - if not connected within 30s, retry
  currentSession.timeout = setTimeout(() => {
    if (sessions.has(uid) && !currentSession.connected && !currentSession.manualStop) {
      console.log(`[${uid}] Connection timeout, triggering reconnect...`);
      try { mc.close(); } catch {}
      handleAutoReconnect(uid, interaction);
    }
  }, 30000);

  // Handle successful spawn
  mc.on("spawn", () => {
    currentSession.connected = true;
    currentSession.isReconnecting = false;
    u.reconnectAttempts = 0; // Reset attempts on successful connection
    save();
    
    clearTimeout(currentSession.timeout);
    
    if (interaction) {
      const msg = `🟢 Connected to **${ip}:${port}** (Auto-move & hand swing active)`;
      if (isReconnect) {
        interaction.followUp({ ephemeral: true, content: msg }).catch(() => {});
      } else if (!interaction.replied) {
        interaction.editReply(msg).catch(() => {});
      }
    }

    // Start AFK movement (every 60 seconds)
    let moveToggle = false;
    const afkInterval = setInterval(() => {
      try {
        if (!mc.entity || !mc.entity.position) return;
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
      } catch (e) {
        console.log(`[${uid}] Move error:`, e.message);
      }
    }, 60 * 1000);

    // Hand swing every 3 seconds
    const handSwingInterval = setInterval(() => {
      try {
        if (!mc.entity) return;
        mc.write("animate", {
          action_id: 1, // 1 = swing arm
          runtime_entity_id: mc.entityId
        });
      } catch (e) {
        console.log(`[${uid}] Hand swing error:`, e.message);
      }
    }, 3000);

    // Periodic ping check to detect disconnects faster
    const pingCheckInterval = setInterval(async () => {
      try {
        const pingStatus = await checkServerStatus(ip, port);
        currentSession.lastPing = Date.now();
        
        if (!pingStatus.online && !currentSession.manualStop) {
          console.log(`[${uid}] Server appears offline in ping check, reconnecting...`);
          mc.close();
          handleAutoReconnect(uid, interaction);
        }
      } catch (e) {
        console.log(`[${uid}] Ping check error:`, e.message);
      }
    }, 60000); // Check every minute

    currentSession.afkInterval = afkInterval;
    currentSession.handSwingInterval = handSwingInterval;
    currentSession.pingCheckInterval = pingCheckInterval;
  });

  // Handle errors
  mc.on("error", (e) => {
    console.log(`[${uid}] Client error: ${e.message}`);
    if (!currentSession.manualStop && !currentSession.isReconnecting) {
      handleAutoReconnect(uid, interaction);
    }
  });

  // Handle disconnect
  mc.on("close", () => {
    clearTimeout(currentSession.timeout);
    if (!currentSession.manualStop && !currentSession.isReconnecting) {
      console.log(`[${uid}] Connection closed, attempting reconnect...`);
      handleAutoReconnect(uid, interaction);
    }
  });

  // Handle kicks
  mc.on("kick", (reason) => {
    console.log(`[${uid}] Kicked:`, reason);
    if (!currentSession.manualStop) {
      if (interaction) {
        interaction.followUp({ ephemeral: true, content: `👢 Kicked from server: ${reason}` }).catch(() => {});
      }
      handleAutoReconnect(uid, interaction);
    }
  });
}

function handleAutoReconnect(uid, interaction) {
  const s = sessions.get(uid);
  if (!s || s.manualStop || s.isReconnecting) return;

  const u = getUser(uid);
  
  // Exponential backoff: 30s, 60s, 120s, 240s, max 5 minutes
  const baseDelay = 30000;
  const maxDelay = 300000;
  const attempt = u.reconnectAttempts || 0;
  const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  
  u.reconnectAttempts = attempt + 1;
  save();
  
  console.log(`[${uid}] Reconnect attempt ${attempt + 1} in ${delay/1000}s...`);
  
  if (interaction) {
    interaction.followUp({ 
      ephemeral: true, 
      content: `🔄 Connection lost. Reconnecting in ${delay/1000}s... (Attempt ${attempt + 1})` 
    }).catch(() => {});
  }

  s.isReconnecting = true;
  s.connected = false;
  
  // Clear old intervals
  if (s.afkInterval) clearInterval(s.afkInterval);
  if (s.handSwingInterval) clearInterval(s.handSwingInterval);
  if (s.pingCheckInterval) clearInterval(s.pingCheckInterval);
  
  s.reconnectTimer = setTimeout(() => {
    if (sessions.has(uid) && !s.manualStop) {
      s.reconnectTimer = null;
      startSession(uid, interaction, true);
    }
  }, delay);
}

// ----------------- Interactions -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    const blocked = denyIfWrongGuild(i);
    if (blocked) return;

    const uid = i.user.id;

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") {
        return i.reply({
          content: "🎛 **Bedrock AFK Panel**",
          components: panelRow()
        });
      }
    }

    if (i.isButton()) {
      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true });
        await i.editReply("⏳ Requesting Microsoft login…");
        return linkMicrosoft(uid, i);
      }

      if (i.customId === "unlink") {
        unlinkMicrosoft(uid);
        return i.reply({ ephemeral: true, content: "🗑 Microsoft account unlinked for your user." });
      }

      if (i.customId === "settings") {
        const u = getUser(uid);
        const pre = {
          ip: u.server?.ip || "",
          port: u.server?.port || 19132,
          offlineUsername: u.offlineUsername || ""
        };

        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("⚙ Bedrock Settings");

        const ip = new TextInputBuilder()
          .setCustomId("ip")
          .setLabel("Server IP")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(pre.ip);

        const port = new TextInputBuilder()
          .setCustomId("port")
          .setLabel("Port (19132)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(pre.port));

        const offlineUser = new TextInputBuilder()
          .setCustomId("offline")
          .setLabel("Offline username (cracked)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(pre.offlineUsername);

        modal.addComponents(
          new ActionRowBuilder().addComponents(ip),
          new ActionRowBuilder().addComponents(port),
          new ActionRowBuilder().addComponents(offlineUser)
        );

        return i.showModal(modal);
      }

      if (i.customId === "start") {
        await i.deferReply({ ephemeral: true });
        await i.editReply("⏳ Starting...");
        return startSession(uid, i);
      }

      if (i.customId === "stop") {
        const ok = stopSession(uid);
        if (!ok) return i.reply({ ephemeral: true, content: "No bots running." });
        return i.reply({ ephemeral: true, content: "⏹ Stopped." });
      }

      if (i.customId === "more") {
        const u = getUser(uid);
        return i.reply({
          ephemeral: true,
          content: "➕ **More options**",
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("invisible").setLabel("👻 Make bot invisible").setStyle(ButtonStyle.Secondary)
            ),
            versionRow(u.bedrockVersion),
            connRow(u.connectionType)
          ]
        });
      }

      if (i.customId === "invisible") {
        const s = sessions.get(uid);
        if (!s) return i.reply({ ephemeral: true, content: "Bot is not running." });
        try {
          s.client.write("command_request", {
            command: "/gamemode survival @s",
            internal: false,
            version: 2
          });
          return i.reply({ ephemeral: true, content: "Attempted to hide bot." });
        } catch {
          return i.reply({ ephemeral: true, content: "Commands not allowed." });
        }
      }
    }

    if (i.isStringSelectMenu()) {
      const u = getUser(uid);
      if (i.customId === "set_version") {
        u.bedrockVersion = i.values[0];
        save();
        return i.reply({ ephemeral: true, content: `Version set to ${u.bedrockVersion}` });
      }
      if (i.customId === "set_conn") {
        u.connectionType = i.values[0];
        save();
        return i.reply({ ephemeral: true, content: `Connection set to ${u.connectionType}` });
      }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
      const ip = i.fields.getTextInputValue("ip").trim();
      const port = parseInt(i.fields.getTextInputValue("port").trim(), 10);
      const offline = i.fields.getTextInputValue("offline").trim();

      if (!ip || !Number.isFinite(port)) {
        return i.reply({ ephemeral: true, content: "Bad IP or port." });
      }

      const u = getUser(uid);
      u.server = { ip, port };
      if (offline) u.offlineUsername = offline;
      save();

      return i.reply({ ephemeral: true, content: `Saved ${ip}:${port}` });
    }

  } catch (e) {
    console.error("Interaction error:", e);
    if (!i.replied && !i.deferred) {
      await i.reply({ ephemeral: true, content: "Internal error." }).catch(() => {});
    } else if (i.deferred) {
      await i.editReply("Internal error.").catch(() => {});
    }
  }
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

client.login(DISCORD_TOKEN);
