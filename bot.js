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

// --- Emme tarvitse chunk-kirjastoja tässä kevyessä versiossa ---
// Mutta pidetään vec3 sijaintia varten
let Vec3;
try {
  Vec3 = require("vec3");
} catch (e) {
  console.log("⚠️ Vec3 missing. Run: npm install vec3");
}

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
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");
const REJOIN_STORE = path.join(DATA, "ReJoin.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};
let activeSessionsStore = fs.existsSync(REJOIN_STORE) ? JSON.parse(fs.readFileSync(REJOIN_STORE, "utf8")) : {};

function save() {
  fs.writeFileSync(STORE, JSON.stringify(users, null, 2));
}

function saveActiveSessions() {
  fs.writeFileSync(REJOIN_STORE, JSON.stringify(activeSessionsStore, null, 2));
}

function getUser(uid) {
  if (!users[uid]) users[uid] = {};
  users[uid].connectionType = "online"; 
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
let lastAdminMessage = null; 

// ----------------- Discord client -----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ==========================================================
// 🛡️ CRASH PREVENTION SYSTEM
// ==========================================================
client.on("error", (error) => console.error("⚠️ Discord Client Error (Ignored):", error.message));
process.on("uncaughtException", (err) => console.error("🔥 Uncaught Exception:", err));

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
      options.push({ label: `User: ${uid}`, description: `Online`, value: uid });
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
      { name: "🤖 Active Sessions", value: `**Total Bots:** ${sessions.size}`, inline: true }
    )
    .setFooter({ text: "Auto-refreshing every 30s" })
    .setTimestamp();

  return embed;
}

// ----------------- Events -----------------
client.once("ready", async () => {
  console.log("🟢 Online as", client.user.tag);

  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
    new SlashCommandBuilder().setName("java").setDescription("Open Java AFKBot Panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Open Admin Control Panel")
  ];
  await client.application.commands.set(cmds);

  setInterval(async () => {
    if (lastAdminMessage) {
        try {
            await lastAdminMessage.edit({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() });
        } catch (e) { lastAdminMessage = null; }
    }
  }, 30000);

  // Restore sessions
  const previousSessions = Object.keys(activeSessionsStore);
  if (previousSessions.length > 0) {
      console.log(`♻️ Restoring ${previousSessions.length} sessions...`);
      let delay = 0;
      for (const uid of previousSessions) {
          setTimeout(() => startSession(uid, null, true), delay);
          delay += 5000; 
      }
  }
});

// ----------------- Microsoft link -----------------
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) return safeReply(interaction, "⏳ Login in progress.");
  
  const authDir = getUserAuthDir(uid);
  const u = getUser(uid);
  let codeShown = false;

  const flow = new Authflow(uid, authDir, { flow: "live", authTitle: Titles?.MinecraftNintendoSwitch || "Bedrock Bot", deviceType: "Nintendo" }, async (data) => {
      const uri = data.verification_uri_complete || data.verification_uri;
      const code = data.user_code;
      codeShown = true;
      const msg = `🔐 **Auth Required**\n\n1. Visit: ${uri}\n2. Code: \`${code}\``;
      await interaction.editReply({ content: msg, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Link").setStyle(ButtonStyle.Link).setURL(uri))] }).catch(() => {});
  });

  const p = (async () => {
    try {
      if (!codeShown) await interaction.editReply("⏳ Requesting code...");
      await flow.getMsaToken();
      u.linked = true; save();
      await interaction.followUp({ ephemeral: true, content: "✅ Linked!" });
    } catch (e) {
      await interaction.editReply(`❌ Failed: ${e.message}`).catch(() => {});
    } finally { pendingLink.delete(uid); }
  })();
  pendingLink.set(uid, p);
}

// ----------------- Session Logic -----------------
function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.physicsLoop) clearInterval(s.physicsLoop);
  if (s.afkTimeout) clearTimeout(s.afkTimeout);

  try { s.client.close(); } catch {}
  sessions.delete(uid);
}

function stopSession(uid) {
  const s = sessions.get(uid);
  if (activeSessionsStore[uid]) {
      delete activeSessionsStore[uid];
      saveActiveSessions();
  }
  if (!s) return false;
  s.manualStop = true; 
  cleanupSession(uid);
  return true;
}

function handleAutoReconnect(uid) {
    const s = sessions.get(uid);
    if (!s || s.manualStop) return;
    
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    s.isReconnecting = true;
    logToDiscord(`⏳ <@${uid}> disconnected. Reconnecting in 60s...`);

    s.reconnectTimer = setTimeout(() => {
        if (sessions.has(uid)) {
            const checkS = sessions.get(uid);
            if (!checkS.manualStop) {
                checkS.reconnectTimer = null; 
                startSession(uid, null, true); 
            } else { cleanupSession(uid); }
        }
    }, 60000);
}

async function safeReply(interaction, content) {
    if (!interaction) return;
    try {
        if (interaction.replied || interaction.deferred) await interaction.editReply(content);
        else await interaction.reply(content);
    } catch (e) {}
}

// ----------------- LIGHTWEIGHT SESSION (NO CHUNKS) -----------------
async function startSession(uid, interaction, isReconnect = false) {
  const u = getUser(uid);
  
  if (!activeSessionsStore[uid]) {
      activeSessionsStore[uid] = true;
      saveActiveSessions();
  }

  if (!u.server) {
      if (!isReconnect) await safeReply(interaction, "⚠ Configure server first.");
      delete activeSessionsStore[uid];
      saveActiveSessions();
      return;
  }

  const { ip, port } = u.server;
  if (sessions.has(uid) && !isReconnect) return safeReply(interaction, "⚠️ Session exists.").catch(() => {});
  
  const connectionEmbed = new EmbedBuilder().setColor("#5865F2").setTitle("Connecting...");

  try {
      if (!isReconnect) await safeReply(interaction, { embeds: [connectionEmbed], components: [] });
      await bedrock.ping({ host: ip, port: parseInt(port) || 19132, timeout: 5000 });
      if (!isReconnect) {
          connectionEmbed.setTitle("✅ Joining...");
          await safeReply(interaction, { embeds: [connectionEmbed] });
      }
  } catch (err) {
      logToDiscord(`❌ Connection failed for <@${uid}>`);
      if (isReconnect) handleAutoReconnect(uid); 
      else await safeReply(interaction, { content: `❌ Server offline.`, embeds: [] });
      return; 
  }

  const authDir = getUserAuthDir(uid);
  
  // ⚡ OPTIMIZATION: viewDistance 0 or minimum to stop server sending chunks
  const opts = { 
      host: ip, 
      port: parseInt(port), 
      connectTimeout: 60000, 
      keepAlive: true,
      viewDistance: 0, // Request minimum chunks
      profilesFolder: authDir,
      username: uid,
      offline: false
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  }

  let mc;
  try { mc = bedrock.createClient(opts); } catch(e) { return safeReply(interaction, `Error: ${e.message}`); }
  
  const currentSession = { 
      client: mc, 
      startedAt: Date.now(), 
      manualStop: false, 
      connected: false,
      isReconnecting: false,
      position: (Vec3) ? new Vec3(0, 0, 0) : null,
      yaw: 0,
      pitch: 0,
      entityId: 0n,
      reconnectTimer: null,
      physicsLoop: null,
      afkTimeout: null
  };
  sessions.set(uid, currentSession);

  // ⚠️ NO CHUNK LOADING HERE - PURE PERFORMANCE ⚠️
  // We do not listen to 'level_chunk'. The packets are ignored/dropped.

  // ==========================================
  // ⚡ LIGHTWEIGHT PHYSICS & AFK LOOP
  // ==========================================
  currentSession.physicsLoop = setInterval(() => {
      if (!currentSession.connected || !currentSession.position) return;
      
      // We don't simulate gravity properly because we don't know where the ground is (no chunks).
      // We rely on the server to correct our Y position if we drift.
      // We mainly just send input packets to keep the connection alive.

      try {
          mc.write("player_auth_input", {
             pitch: currentSession.pitch, 
             yaw: currentSession.yaw,
             position: { x: currentSession.position.x, y: currentSession.position.y, z: currentSession.position.z },
             move_vector: { x: 0, z: 0 }, 
             head_yaw: currentSession.yaw, 
             input_data: 0n,
             input_mode: "mouse", 
             play_mode: "screen", 
             interaction_model: "touch", 
             tick: 0n
          });
      } catch (e) {}
  }, 100); // Slower tick rate (100ms) saves CPU

  // ==========================================
  // 🤖 SIMPLE ANTI-AFK (Rotate & Swing)
  // ==========================================
  const performAntiAfk = () => {
      if (!sessions.has(uid)) return;
      const s = sessions.get(uid);
      
      if (!s.connected) {
          s.afkTimeout = setTimeout(performAntiAfk, 5000);
          return;
      }

      try {
          // 1. Rotate slightly
          s.yaw += (Math.random() - 0.5) * 10; 
          s.pitch += (Math.random() - 0.5) * 5;

          // 2. Swing Arm
          mc.write('animate', { action_id: 1, runtime_entity_id: s.entityId });
          
          // No walking logic to prevent falling into void since we are blind
      } catch (e) {}

      // Random interval 10s - 30s
      const nextDelay = Math.random() * 20000 + 10000;
      s.afkTimeout = setTimeout(performAntiAfk, nextDelay);
  };

  // --- EVENTS ---
  mc.on("spawn", () => {
    logToDiscord(`✅ Bot <@${uid}> spawned on **${ip}**`);
    if (!isReconnect) safeReply(interaction, { content: `🟢 **Online** on \`${ip}:${port}\``, embeds: [] });
  });

  mc.on("start_game", (packet) => {
      if (Vec3) {
          currentSession.position = new Vec3(packet.player_position.x, packet.player_position.y, packet.player_position.z);
      }
      currentSession.entityId = packet.runtime_entity_id;
      currentSession.connected = true;
      currentSession.isReconnecting = false;
      performAntiAfk();
  });
  
  // Update position from server packets (since we don't calculate it ourselves)
  mc.on("move_player", (packet) => {
      if (packet.runtime_id === currentSession.entityId && currentSession.position) {
          currentSession.position.set(packet.position.x, packet.position.y, packet.position.z);
          currentSession.yaw = packet.rotation.y; // Sync rotation
          currentSession.pitch = packet.rotation.x;
      }
  });

  mc.on("error", (e) => {
    if (!currentSession.manualStop) handleAutoReconnect(uid); 
    logToDiscord(`❌ Error <@${uid}>: \`${e.message}\``);
  });

  mc.on("close", () => {
    if (!currentSession.manualStop) handleAutoReconnect(uid);
    logToDiscord(`🔌 Closed <@${uid}>`);
  });
}

// ----------------- Interactions -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (denyIfWrongGuild(i)) return;
    const uid = i.user.id;

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return safeReply(i, panelRow(false));
      if (i.commandName === "java") return safeReply(i, panelRow(true));
      if (i.commandName === "admin") {
        if (uid !== ADMIN_ID) return safeReply(i, { content: "⛔", ephemeral: true });
        const msg = await i.reply({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents(), fetchReply: true });
        lastAdminMessage = msg;
        return;
      }
    }

    if (i.isButton()) {
      if (i.customId === "admin_refresh") {
          await i.deferUpdate();
          return i.editReply({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() }).catch(() => {});
      }

      if (i.customId === "start_bedrock" || i.customId === "start_java") {
        if (sessions.has(uid)) return safeReply(i, { ephemeral: true, content: "⚠️ Active session exists." });
        const embed = new EmbedBuilder().setTitle("Start Bot?").setColor("#2ECC71");
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("confirm_start").setLabel("Start").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
        );
        return i.reply({ embeds: [embed], components: [row], ephemeral: true }).catch(() => {});
      }

      if (i.customId === "confirm_start") {
          await i.deferUpdate(); // Prevents timeout
          return startSession(uid, i, false);
      }

      if (i.customId === "cancel") return i.update({ content: "❌ Cancelled.", embeds: [], components: [] });
      
      if (i.customId === "stop") {
        await i.deferReply({ ephemeral: true });
        const ok = stopSession(uid);
        return i.editReply({ content: ok ? "⏹ Stopped." : "No session." });
      }

      if (i.customId === "link") {
          await i.deferReply({ ephemeral: true });
          return linkMicrosoft(uid, i);
      }

      if (i.customId === "unlink") {
        await i.deferReply({ ephemeral: true });
        unlinkMicrosoft(uid);
        return i.editReply({ content: "🗑 Unlinked." });
      }

      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Config");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setRequired(true).setValue(u.server?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(u.server?.port || 19132)))
        );
        return i.showModal(modal);
      }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
        const ip = i.fields.getTextInputValue("ip").trim();
        const port = parseInt(i.fields.getTextInputValue("port").trim(), 10);
        const u = getUser(uid);
        u.server = { ip, port };
        save();
        return safeReply(i, { ephemeral: true, content: `✅ Saved: **${ip}:${port}**` });
    }

  } catch (e) { console.error(e); }
});

// --- Chat Trigger ---
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.channel.id !== '1462398161074000143') return;
    
    if (['afk', 'afkbot'].some(w => message.content.toLowerCase().includes(w))) {
        try {
            const r = await message.react('<a:loading:1470137639339299053>');
            setTimeout(async () => {
                try { await r.users.remove(client.user.id); await message.reply("What bout me? 😁"); } catch (e) {}
            }, 3000);
        } catch (e) {}
    }
});

client.login(DISCORD_TOKEN);
