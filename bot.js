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

// --- Dependencies for Physics Only ---
let Vec3;
try {
  Vec3 = require("vec3");
} catch (e) {
  console.log("⚠️ Physics dependency missing! Run: npm install vec3");
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
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
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
client.on("shardError", (error) => console.error("⚠️ WebSocket Error (Ignored):", error.message));
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
    // Row 1: Main Controls
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_reconnect_all").setLabel("♻️ Reconnect All").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_stop_all").setLabel("🛑 Stop All").setStyle(ButtonStyle.Danger)
    ),
    // Row 2: Fun/Control
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_chat_all").setLabel("📢 Chat (All)").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("admin_jump_all").setLabel("🦘 Jump (All)").setStyle(ButtonStyle.Success)
    )
  ];

  if (sessions.size > 0) {
    const options = [];
    let count = 0;
    for (const [uid, session] of sessions) {
      if (count >= 25) break; 
      options.push({ label: `User: ${uid}`, description: `Online since: ${new Date(session.startedAt).toLocaleTimeString()}`, value: uid });
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
    .setTitle("🛠 Admin Control Center")
    .setColor("#2f3136")
    .setThumbnail("https://files.catbox.moe/9mqpoz.gif")
    .addFields(
      { name: "📊 System", value: `**RAM:** ${ramMB} MB\n**Uptime:** ${hours}h ${minutes}m`, inline: true },
      { name: "🤖 Bots", value: `**Active:** ${sessions.size}\n**Saved:** ${Object.keys(activeSessionsStore).length}`, inline: true }
    )
    .setFooter({ text: "Real-time Control • Administrative Access Only" })
    .setTimestamp();

  if (sessions.size > 0) {
    let botList = "";
    for (const [uid, s] of sessions) {
      const status = s.connected ? "🟢 Online" : (s.isReconnecting ? "⏳ Reconnecting" : "🔴 Offline");
      const ver = getUser(uid).bedrockVersion || "Auto";
      botList += `<@${uid}>: ${status} [${ver}]\n`;
    }
    embed.addFields({ name: "📋 Active Bot Registry", value: botList.slice(0, 1024) });
  }
  return embed;
}

// ----------------- Events: Ready & Startup Rejoin -----------------
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

  console.log("📂 Checking ReJoin.json for previous sessions...");
  const previousSessions = Object.keys(activeSessionsStore);
  
  if (previousSessions.length > 0) {
      console.log(`♻️ Found ${previousSessions.length} bots to restore. Starting them now...`);
      let delay = 0;
      for (const uid of previousSessions) {
          setTimeout(() => startSession(uid, null, true), delay);
          delay += 5000; 
      }
  } else {
      console.log("⚪ No previous sessions found.");
  }
});

// ----------------- Microsoft link -----------------
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) return interaction.editReply("⏳ Login already in progress. Use the last code.");
  const authDir = getUserAuthDir(uid);
  const u = getUser(uid);
  let codeShown = false;

  const flow = new Authflow(uid, authDir, { flow: "live", authTitle: Titles?.MinecraftNintendoSwitch || "Bedrock AFK Bot", deviceType: "Nintendo" }, async (data) => {
      const uri = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
      const code = data.user_code || "(no code)";
      lastMsa.set(uid, { uri, code, at: Date.now() });
      codeShown = true;
      const msg = `🔐 **Microsoft Authentication Required**\n\n1. Visit: ${uri}\n2. Enter Code: \`${code}\``;
      await interaction.editReply({ content: msg, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("🌐 Open link").setStyle(ButtonStyle.Link).setURL(uri))] }).catch(() => {});
  });

  const p = (async () => {
    try {
      if (!codeShown) await interaction.editReply("⏳ Requesting code…");
      await flow.getMsaToken();
      u.linked = true; save();
      await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account linked!" });
    } catch (e) {
      await interaction.editReply(`❌ Login failed: ${e.message}`).catch(() => {});
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
    logToDiscord(`⏳ Bot of <@${uid}> disconnected. Reconnecting in 60s...`);

    s.reconnectTimer = setTimeout(() => {
        if (sessions.has(uid)) {
            const checkS = sessions.get(uid);
            if (!checkS.manualStop) {
                checkS.reconnectTimer = null; 
                startSession(uid, null, true); 
            } else {
                cleanupSession(uid);
            }
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

// ----------------- MAIN SESSION FUNCTION -----------------
async function startSession(uid, interaction, isReconnect = false) {
  const u = getUser(uid);
  
  if (!activeSessionsStore[uid]) {
      activeSessionsStore[uid] = true;
      saveActiveSessions();
  }

  if (!u.server) {
      if (!isReconnect) await safeReply(interaction, "⚠ Please configure your server settings first.");
      delete activeSessionsStore[uid];
      saveActiveSessions();
      return;
  }

  const { ip, port } = u.server;

  if (sessions.has(uid) && !isReconnect) {
      return safeReply(interaction, "⚠️ **Session Conflict**: Active session already exists.").catch(() => {});
  }
  
  // --- UI: Compact Embed ---
  const connectionEmbed = new EmbedBuilder()
    .setColor("#5865F2")
    .setTitle("Bot Initialization")
    .setThumbnail("https://files.catbox.moe/9mqpoz.gif"); // Compact GIF next to text

  // 1. Show "Connecting" UI immediately
  if (!isReconnect) {
      connectionEmbed.setDescription(`🚀 **Connecting to server...**\n🌐 **Target:** \`${ip}:${port}\``);
      await safeReply(interaction, { embeds: [connectionEmbed], content: null, components: [] });
  }

  const authDir = getUserAuthDir(uid);
  
  // 2. Start Client Creation IMMEDIATELY (Do not wait for ping)
  const opts = { 
      host: ip, 
      port: parseInt(port), 
      connectTimeout: 60000, 
      keepAlive: true,
      viewDistance: 4, // Low RAM usage
      profilesFolder: authDir,
      username: uid,
      offline: false
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  }

  const mc = bedrock.createClient(opts);
  
  const currentSession = { 
      client: mc, 
      startedAt: Date.now(), 
      manualStop: false, 
      connected: false,
      isReconnecting: false,
      position: null,
      velocity: (Vec3) ? new Vec3(0, 0, 0) : null,
      yaw: 0,
      pitch: 0,
      onGround: false,
      reconnectTimer: null,
      physicsLoop: null,
      afkTimeout: null,
  };
  sessions.set(uid, currentSession);

  // 3. Run Ping in Background (Just for UI feedback)
  if (!isReconnect) {
      bedrock.ping({ host: ip, port: parseInt(port) || 19132, timeout: 5000 })
      .then(() => {
          // Only update UI if we are still connecting
          if (sessions.has(uid) && !currentSession.connected) {
             connectionEmbed.setDescription(`✅ **Server found! Authenticating...**\n🌐 **Target:** \`${ip}:${port}\``);
             safeReply(interaction, { embeds: [connectionEmbed] });
          }
      })
      .catch(() => {
          // If ping fails, we still let the client try to connect, but warn user
          connectionEmbed.setDescription(`⚠️ **Ping failed, but trying to connect...**\n🌐 **Target:** \`${ip}:${port}\``);
          safeReply(interaction, { embeds: [connectionEmbed] });
      });
  }

  // ==========================================
  // 🍎 PHYSICS ENGINE (Gravity & Hand Swing Only)
  // ==========================================
  if (Vec3) {
      currentSession.physicsLoop = setInterval(() => {
          if (!currentSession.connected || !currentSession.position) return;
          
          const gravity = 0.08; 
          
          // Apply Gravity
          if (!currentSession.onGround) {
             currentSession.velocity.y -= gravity;
          }

          if (currentSession.velocity.y < -3.92) currentSession.velocity.y = -3.92;
          
          currentSession.position.add(currentSession.velocity);

          // Void Protection
          if (currentSession.position.y < -64) {
             currentSession.position.y = 320; 
             currentSession.velocity.y = 0;
          }

          // Send Packet (No walking vector, just existence)
          try {
              mc.write("player_auth_input", {
                 pitch: currentSession.pitch, yaw: currentSession.yaw,
                 position: { x: currentSession.position.x, y: currentSession.position.y, z: currentSession.position.z },
                 move_vector: { x: 0, z: 0 }, 
                 head_yaw: currentSession.yaw, input_data: 0n,
                 input_mode: "mouse", play_mode: "screen", interaction_model: "touch", tick: 0n
              });
          } catch (e) {}
      }, 50); 
  }

  // ==========================================
  // 🤖 ANTI-AFK (Look, Jump, Swing)
  // ==========================================
  const performAntiAfk = () => {
      if (!sessions.has(uid)) return;
      const s = sessions.get(uid);
      
      if (!s.connected || !s.position) {
          s.afkTimeout = setTimeout(performAntiAfk, 5000);
          return;
      }

      try {
          // Randomize Look
          s.yaw += (Math.random() - 0.5) * 20; 
          s.pitch += (Math.random() - 0.5) * 10;

          // Random Jump (if on ground)
          if (s.onGround && Math.random() > 0.9) {
              s.velocity.y = 0.42;
              s.onGround = false;
          }
          
          // Hand Swing (Animation)
          mc.write('animate', { action_id: 1, runtime_entity_id: s.entityId || 0n });
      } catch (e) {}

      const nextDelay = Math.random() * 20000 + 10000;
      s.afkTimeout = setTimeout(performAntiAfk, nextDelay);
  };

  // --- EVENTS ---
  mc.on("spawn", () => {
    logToDiscord(`✅ Bot of <@${uid}> spawned on **${ip}:${port}**` + (isReconnect ? " (Auto-Rejoined)" : ""));
    // Final Success Embed
    if (!isReconnect) {
        connectionEmbed.setDescription(`🟢 **Online** on \`${ip}:${port}\`\nPhysics & Hand Swing Active.`);
        safeReply(interaction, { embeds: [connectionEmbed] });
    }
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
  
  mc.on("move_player", (packet) => {
      if (packet.runtime_id === currentSession.entityId && currentSession.position) {
          if (packet.position.y > currentSession.position.y) {
              currentSession.onGround = true;
              currentSession.velocity.y = 0;
          } else {
              currentSession.onGround = false;
          }
          currentSession.position.set(packet.position.x, packet.position.y, packet.position.z);
      }
  });
  
  mc.on("respawn", (packet) => {
      logToDiscord(`💀 Bot of <@${uid}> died and respawned.`);
      if (currentSession.position) {
          currentSession.position.set(packet.position.x, packet.position.y, packet.position.z);
          currentSession.velocity.set(0,0,0);
      }
  });

  mc.on("error", (e) => {
    if (!currentSession.manualStop) handleAutoReconnect(uid); 
    logToDiscord(`❌ Bot of <@${uid}> error: \`${e.message}\``);
  });

  mc.on("close", () => {
    if (!currentSession.manualStop) handleAutoReconnect(uid);
    logToDiscord(`🔌 Bot of <@${uid}> connection closed.`);
  });
}

// ----------------- Interactions -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    const blocked = denyIfWrongGuild(i);
    if (blocked) return;
    const uid = i.user.id;

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return safeReply(i, panelRow(false));
      if (i.commandName === "java") return safeReply(i, panelRow(true));
      if (i.commandName === "admin") {
        if (uid !== ADMIN_ID || i.channelId !== ADMIN_CHANNEL_ID) return safeReply(i, { content: "⛔ Access restricted.", ephemeral: true });
        const msg = await i.reply({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents(), fetchReply: true });
        lastAdminMessage = msg;
        return;
      }
    }

    if (i.isButton()) {
      // --- ADMIN CONTROLS ---
      if (i.customId === "admin_refresh") {
        return i.update({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() }).catch(() => {});
      }
      
      if (i.customId === "admin_stop_all") {
        sessions.forEach((s, id) => stopSession(id));
        return i.reply({ content: "🛑 All sessions stopped.", ephemeral: true });
      }

      if (i.customId === "admin_reconnect_all") {
        i.reply({ content: "♻️ Reconnecting all bots...", ephemeral: true });
        const ids = Array.from(sessions.keys());
        ids.forEach(id => {
            stopSession(id);
            setTimeout(() => startSession(id, null, true), 3000); // 3s delay before reconnect
        });
        return;
      }

      if (i.customId === "admin_chat_all") {
          const modal = new ModalBuilder().setCustomId("admin_chat_modal").setTitle("Broadcast Message");
          modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("msg").setLabel("Message").setStyle(TextInputStyle.Short)
          ));
          return i.showModal(modal);
      }

      if (i.customId === "admin_jump_all") {
          let count = 0;
          sessions.forEach(s => {
              if (s.connected && s.onGround) {
                  s.velocity.y = 0.42; s.onGround = false; count++;
              }
          });
          return i.reply({ content: `🦘 Made ${count} bots jump.`, ephemeral: true });
      }

      // --- USER CONTROLS ---
      if (i.customId === "start_bedrock") {
        if (sessions.has(uid)) return safeReply(i, { ephemeral: true, content: "⚠️ **Session Conflict**: Active session exists." });
        const embed = new EmbedBuilder().setTitle("Bedrock Connection").setDescription("Start bot?").setColor("#2ECC71");
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("confirm_start").setLabel("Start").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
        );
        return i.reply({ embeds: [embed], components: [row], ephemeral: true }).catch(() => {});
      }

      if (i.customId === "start_java") {
        if (sessions.has(uid)) return safeReply(i, { ephemeral: true, content: "⚠️ **Session Conflict**: Active session exists." });
        const embed = new EmbedBuilder()
          .setTitle("⚙️ Java Compatibility Check")
          .setDescription("For a successful connection to a Java server, ensure the following plugins are installed.")
          .addFields( { name: "Required Plugins", value: "• GeyserMC\n• Floodgate" } )
          .setColor("#E67E22");
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("confirm_start").setLabel("Confirm & Start").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
        );
        return i.reply({ embeds: [embed], components: [row], ephemeral: true }).catch(() => {});
      }

      if (i.customId === "confirm_start") {
          await i.deferUpdate().catch(() => {});
          return startSession(uid, i, false);
      }

      if (i.customId === "cancel") return i.update({ content: "❌ Cancelled.", embeds: [], components: [] }).catch(() => {});
      
      if (i.customId === "stop") {
        const ok = stopSession(uid);
        return safeReply(i, { ephemeral: true, content: ok ? "⏹ **Session Terminated.**" : "No active sessions." });
      }

      if (i.customId === "link") {
          await i.deferReply({ ephemeral: true }).catch(() => {});
          return linkMicrosoft(uid, i);
      }

      if (i.customId === "unlink") {
        unlinkMicrosoft(uid);
        return safeReply(i, { ephemeral: true, content: "🗑 Unlinked." });
      }

      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Configuration");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setRequired(true).setValue(u.server?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(u.server?.port || 19132)))
        );
        return i.showModal(modal);
      }
    }

    // --- MODAL SUBMITS ---
    if (i.isModalSubmit()) {
        if (i.customId === "settings_modal") {
            const ip = i.fields.getTextInputValue("ip").trim();
            const port = parseInt(i.fields.getTextInputValue("port").trim(), 10);
            const u = getUser(uid);
            u.server = { ip, port };
            save();
            return safeReply(i, { ephemeral: true, content: `✅ Saved: **${ip}:${port}**` });
        }
        
        if (i.customId === "admin_chat_modal") {
            const msg = i.fields.getTextInputValue("msg");
            let count = 0;
            sessions.forEach(s => {
                if (s.connected) {
                    try { s.client.queue('text', { type: 'chat', needs_translation: false, source_name: s.client.username, xuid: '', message: msg }); count++; } catch (e) {}
                }
            });
            return i.reply({ content: `📢 Broadcast sent to ${count} bots.`, ephemeral: true });
        }
    }

  } catch (e) { console.error(e); }
});

// --- MESSAGE REACTION HANDLER ---
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.channel.id !== '1462398161074000143') return;
    
    const content = message.content.toLowerCase();
    const triggerWords = ['afk', 'afkbot'];

    if (triggerWords.some(word => content.includes(word))) {
        try {
            const reaction = await message.react('<a:loading:1470137639339299053>');
            setTimeout(async () => {
                try {
                    await reaction.remove();
                    await message.reply("What bout me? 😁");
                } catch (e) {}
            }, 3000);
        } catch (e) {}
    }
});

process.on("unhandledRejection", (e) => console.error("Unhandled Rejection:", e));
client.login(DISCORD_TOKEN);
