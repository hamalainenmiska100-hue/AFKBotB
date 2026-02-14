/**
 * ============================================================================
 * ADVANCED BEDROCK AFK BOT - FULL IMPLEMENTATION
 * ============================================================================
 * 
 * FIXED VERSION:
 * - Properly detects Minecraft spawn and updates Discord
 * - Fixed ore scanner connection detection
 * - Better error handling for Discord message updates
 * 
 * IMPORTANT: To fix "bot not showing in member list":
 * 1. Discord Developer Portal > Bot > Privileged Gateway Intents
 * 2. Enable "SERVER MEMBERS INTENT" 
 * 3. Kick bot from server and re-invite with new link!
 * ============================================================================
 */

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
  EmbedBuilder,
  Partials
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// ============================================================================
// JSON STORAGE (Fly.io Volume)
// ============================================================================

const DATA = process.env.VOLUME_PATH || "/data";
const USERS_FILE = path.join(DATA, "users.json");
const SESSIONS_FILE = path.join(DATA, "sessions.json");

if (!fs.existsSync(DATA)) {
  fs.mkdirSync(DATA, { recursive: true });
}

let users = {};
let activeSessionsStore = {};

function loadData() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    }
    if (fs.existsSync(SESSIONS_FILE)) {
      activeSessionsStore = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Error loading data:", e.message);
  }
}

function saveUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (e) {
    console.error("Error saving users:", e.message);
  }
}

function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(activeSessionsStore, null, 2));
  } catch (e) {
    console.error("Error saving sessions:", e.message);
  }
}

loadData();

// ============================================================================
// CONFIG
// ============================================================================

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

const ALLOWED_GUILD_ID = "1464973275397357772";
const ADMIN_ID = "1144987924123881564";
const LOG_CHANNEL_ID = "1464615030111731753";
const ADMIN_CHANNEL_ID = "1469013237625393163";

// ============================================================================
// DEPS
// ============================================================================

let Vec3, PrismarineChunk, PrismarineRegistry;
let advancedFeaturesEnabled = false;

try {
  Vec3 = require("vec3");
  PrismarineChunk = require("prismarine-chunk");
  PrismarineRegistry = require("prismarine-registry");
  advancedFeaturesEnabled = true;
  console.log("✅ Advanced features enabled");
} catch (e) {
  console.log("⚠️ Advanced features disabled");
}

// ============================================================================
// DATA FUNCTIONS
// ============================================================================

function getUser(uid) {
  if (!users[uid]) {
    users[uid] = {
      connectionType: "online",
      bedrockVersion: "auto",
      linked: false
    };
    saveUsers();
  }
  return users[uid];
}

async function getUserAuthDir(uid) {
  const dir = path.join(DATA, "auth", uid);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

async function unlinkMicrosoft(uid) {
  const dir = path.join(DATA, "auth", uid);
  try { 
    fs.rmSync(dir, { recursive: true, force: true }); 
  } catch(e) {}
  const u = getUser(uid);
  u.linked = false;
  saveUsers();
}

async function saveSessionToDisk(uid, sessionData) {
  activeSessionsStore[uid] = {
    ...sessionData,
    timestamp: Date.now()
  };
  saveSessions();
}

async function removeSessionFromDisk(uid) {
  if (activeSessionsStore[uid]) {
    delete activeSessionsStore[uid];
    saveSessions();
  }
}

// ============================================================================
// RUNTIME
// ============================================================================

const sessions = new Map();
const pendingLink = new Map();
const lastMsa = new Map();
let lastAdminMessage = null;

// ============================================================================
// DISCORD CLIENT
// ============================================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,  // TÄRKEÄ: Member list näkyvyys
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

client.on("error", (error) => console.error("Discord Error:", error.message));
process.on("uncaughtException", (err) => console.error("🔥 Uncaught:", err));
process.on("unhandledRejection", (e) => console.error("Unhandled:", e));

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
    return i.reply({ ephemeral: true, content: "This bot cannot be used in this server ⛔️" }).catch(() => {});
  }
  return null;
}

// ============================================================================
// UI HELPERS
// ============================================================================

function panelRow(isJava = false) {
  const title = isJava ? "Java AFKBot Panel 🎛️" : "Bedrock AFKBot Panel 🎛️";
  const startCustomId = isJava ? "start_java" : "start_bedrock";
  return {
    content: `**${title}**`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(startCustomId).setLabel("▶ Start").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("scan_ores").setLabel("⛏️ Scan Ores (8 chunks)").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("status").setLabel("📊 Status").setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

function getAdminStatsEmbed() {
  const memory = process.memoryUsage();
  const ramMB = (memory.rss / 1024 / 1024).toFixed(2);
  const embed = new EmbedBuilder()
    .setTitle("🛠 Admin Panel")
    .setColor("#2f3136")
    .addFields(
      { name: "RAM", value: `${ramMB} MB`, inline: true },
      { name: "Active Bots", value: `${sessions.size}`, inline: true },
      { name: "Saved Sessions", value: `${Object.keys(activeSessionsStore).length}`, inline: true }
    )
    .setTimestamp();
  return embed;
}

// ============================================================================
// READY
// ============================================================================

client.once("ready", async () => {
  console.log("🟢 Online as", client.user.tag);
  console.log(`📂 Data: ${DATA}`);
  
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
    new SlashCommandBuilder().setName("java").setDescription("Open Java AFKBot Panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Open Admin Control Panel")
  ];
  await client.application.commands.set(cmds);
  
  // Restore sessions
  const previousSessions = Object.keys(activeSessionsStore);
  if (previousSessions.length > 0) {
    console.log(`♻️ Restoring ${previousSessions.length} bots...`);
    let delay = 0;
    for (const uid of previousSessions) {
      setTimeout(() => startSession(uid, null, true), delay);
      delay += 5000;
    }
  }
});

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.physicsLoop) clearInterval(s.physicsLoop);
  if (s.afkTimeout) clearTimeout(s.afkTimeout);
  if (s.chunkGCLoop) clearInterval(s.chunkGCLoop);
  if (s.movementLoop) clearInterval(s.movementLoop);
  if (s.animationLoop) clearInterval(s.animationLoop);
  try { s.client.close(); } catch {}
  sessions.delete(uid);
}

async function stopSession(uid, isManual = true) {
  if (isManual) {
    await removeSessionFromDisk(uid);
    console.log(`[Stop] Manual stop for ${uid}`);
  }
  const s = sessions.get(uid);
  if (!s) return false;
  s.manualStop = isManual;
  cleanupSession(uid);
  return true;
}

function handleAutoReconnect(uid) {
  const s = sessions.get(uid);
  if (!s || s.manualStop) return;
  s.isReconnecting = true;
  console.log(`[Reconnect] Scheduling for ${uid} in 60s`);
  s.reconnectTimer = setTimeout(() => {
    if (sessions.has(uid) && !sessions.get(uid).manualStop) {
      startSession(uid, null, true);
    }
  }, 60000);
}

async function safeReply(interaction, content) {
  if (!interaction) return;
  try {
    if (interaction.replied || interaction.deferred) await interaction.editReply(content);
    else await interaction.reply(content);
  } catch (e) {
    console.error(`[SafeReply] Failed:`, e.message);
  }
}

// ============================================================================
// ORE SCANNER
// ============================================================================

const ORE_BLOCKS = [
  'diamond_ore', 'deepslate_diamond_ore',
  'iron_ore', 'deepslate_iron_ore',
  'gold_ore', 'deepslate_gold_ore',
  'emerald_ore', 'deepslate_emerald_ore',
  'redstone_ore', 'deepslate_redstone_ore',
  'lapis_ore', 'deepslate_lapis_ore',
  'coal_ore', 'deepslate_coal_ore',
  'copper_ore', 'deepslate_copper_ore',
  'ancient_debris', 'nether_quartz_ore', 'nether_gold_ore'
];

async function scanForOres(uid, radius = 8) {
  const s = sessions.get(uid);
  
  // DEBUG: Log what we found
  console.log(`[ScanOres] uid=${uid}, session exists=${!!s}`);
  if (s) {
    console.log(`[ScanOres] connected=${s.connected}, initialized=${s.initialized}, chunks=${s.chunks?.size}`);
  }
  
  if (!s) return { error: "No active session. Start the bot first!" };
  
  // Check if Minecraft client exists and is connected
  if (!s.client) return { error: "Bot client not initialized" };
  
  // More lenient check - if we have position and chunks, we're "connected enough"
  if (!s.connected && !s.initialized) {
    return { error: "Bot not connected. Wait for 'Bot Online' message." };
  }
  
  if (!advancedFeaturesEnabled) return { error: "Advanced features not available. Install: npm install vec3 prismarine-chunk" };
  if (!s.chunks || s.chunks.size === 0) return { error: "No chunks loaded yet. Wait a moment after spawning." };
  
  const foundOres = [];
  const playerPos = s.position || { x: 0, y: 64, z: 0 };
  const playerChunkX = Math.floor(playerPos.x / 16);
  const playerChunkZ = Math.floor(playerPos.z / 16);
  
  let chunksScanned = 0;
  
  for (let cx = -radius; cx <= radius; cx++) {
    for (let cz = -radius; cz <= radius; cz++) {
      const chunkKey = `${playerChunkX + cx},${playerChunkZ + cz}`;
      const chunk = s.chunks.get(chunkKey);
      
      if (chunk) {
        chunksScanned++;
        for (let x = 0; x < 16; x++) {
          for (let z = 0; z < 16; z++) {
            // Scan only important Y levels for ores (-64 to 16 for diamonds, 0 to 320 for others)
            for (let y = -64; y < 320; y += 4) { // Step 4 for speed
              try {
                const block = chunk.getBlock({ x, y, z });
                if (block && block.name && ORE_BLOCKS.includes(block.name)) {
                  const worldX = (playerChunkX + cx) * 16 + x;
                  const worldZ = (playerChunkZ + cz) * 16 + z;
                  const dist = Math.sqrt(
                    Math.pow(worldX - playerPos.x, 2) + 
                    Math.pow(y - playerPos.y, 2) + 
                    Math.pow(worldZ - playerPos.z, 2)
                  );
                  foundOres.push({
                    type: block.name,
                    x: worldX, y, z: worldZ,
                    distance: dist
                  });
                }
              } catch (e) {}
            }
          }
        }
      }
    }
  }
  
  // Remove duplicates and sort
  const seen = new Set();
  const uniqueOres = [];
  for (const ore of foundOres) {
    const key = `${ore.x},${ore.y},${ore.z}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueOres.push(ore);
    }
  }
  uniqueOres.sort((a, b) => a.distance - b.distance);
  
  return {
    ores: uniqueOres.slice(0, 15),
    totalFound: uniqueOres.length,
    chunksScanned,
    playerPos
  };
}

// ============================================================================
// MINECRAFT PROTOCOL
// ============================================================================

const InputFlags = {
  JUMPING: 0x00000040, SNEAKING: 0x00000100, SPRINTING: 0x00100000,
  UP: 0x00000400, DOWN: 0x00000800, LEFT: 0x00001000, RIGHT: 0x00002000
};

async function startSession(uid, interaction, isReconnect = false) {
  console.log(`[StartSession] uid=${uid}, reconnect=${isReconnect}`);
  const u = getUser(uid);

  if (!u.server) {
    if (!isReconnect && interaction) await safeReply(interaction, "⚠️ Set server IP/port first in Settings!");
    return;
  }

  if (sessions.has(uid) && !isReconnect) {
    if (interaction) await safeReply(interaction, "⚠️ Session already active! Use Stop first.");
    return;
  }

  const { ip, port } = u.server;

  // Send initial Discord message
  let statusMessage = null;
  if (!isReconnect && interaction) {
    try {
      await interaction.deferReply({ ephemeral: true });
      statusMessage = interaction;
    } catch(e) {
      console.error("Failed to defer reply:", e);
    }
  }

  try {
    if (statusMessage) {
      await statusMessage.editReply({ content: `🔍 Pinging ${ip}:${port}...` });
    }
    
    await bedrock.ping({ host: ip, port: parseInt(port) || 19132, timeout: 5000 });
    
    if (statusMessage) {
      await statusMessage.editReply({ content: `✅ Server found! Connecting...` });
    }
  } catch (err) {
    console.error(`Server unreachable: ${err.message}`);
    if (statusMessage) {
      await statusMessage.editReply({ content: `❌ Server offline at ${ip}:${port}` });
    }
    if (isReconnect) handleAutoReconnect(uid);
    return;
  }

  // Save session to disk for persistence
  await saveSessionToDisk(uid, { server: u.server, startedAt: Date.now() });

  const authDir = await getUserAuthDir(uid);
  
  const opts = {
    host: ip,
    port: parseInt(port),
    connectTimeout: 60000,
    keepAlive: true,
    viewDistance: 10,
    profilesFolder: authDir,
    username: uid,
    offline: u.connectionType === "offline",
    autoInitPlayer: false,
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
  }

  const mc = bedrock.createClient(opts);

  // Create session object
  const session = {
    client: mc,
    userId: uid,
    startedAt: Date.now(),
    manualStop: false,
    connected: false,
    initialized: false,
    isReconnecting: false,
    position: advancedFeaturesEnabled && Vec3 ? new Vec3(0, 64, 0) : { x: 0, y: 64, z: 0 },
    chunks: new Map(),
    Chunk: null,
    runtimeEntityId: null,
    statusMessage: statusMessage,
    serverIp: ip,
    serverPort: port
  };
  
  sessions.set(uid, session);

  // ==========================================================================
  // MINECRAFT EVENT HANDLERS
  // ==========================================================================

  // Connection established
  mc.on("connect", () => {
    console.log(`[${uid}] Connected to Minecraft server`);
  });

  // CRITICAL: Start game - sets entity ID
  mc.on("start_game", (packet) => {
    console.log(`[${uid}] Start game received, entity ID: ${packet.runtime_entity_id}`);
    session.runtimeEntityId = packet.runtime_entity_id;
    
    if (advancedFeaturesEnabled && Vec3) {
      session.position = new Vec3(packet.player_position.x, packet.player_position.y, packet.player_position.z);
    } else {
      session.position = { 
        x: packet.player_position.x, 
        y: packet.player_position.y, 
        z: packet.player_position.z 
      };
    }
    
    // Request chunks
    mc.queue("request_chunk_radius", { chunk_radius: 10 });
    mc.queue("client_cache_status", { enabled: false });
  });

  // CRITICAL: Play status - triggers initialization
  mc.on("play_status", (packet) => {
    console.log(`[${uid}] Play status: ${packet.status}`);
    if (packet.status === "player_spawn" || packet.status === 3) {
      mc.queue("serverbound_loading_screen", { type: 1 });
      mc.queue("serverbound_loading_screen", { type: 2 });
      
      if (session.runtimeEntityId) {
        mc.queue("set_local_player_as_initialized", {
          runtime_entity_id: session.runtimeEntityId
        });
        session.initialized = true;
        console.log(`[${uid}] Player initialized`);
      }
    }
  });

  // CRITICAL: Spawn event - bot is now in-game!
  mc.on("spawn", async () => {
    console.log(`[${uid}] ✅ SPAWNED IN WORLD!`);
    session.connected = true;
    session.isReconnecting = false;
    
    // Update Discord status - TRY MULTIPLE METHODS
    try {
      const onlineEmbed = new EmbedBuilder()
        .setColor("#00FF00")
        .setTitle("🟢 Bot Online")
        .setDescription(`Connected to \`${ip}:${port}\``)
        .addFields(
          { name: "Position", value: `X: ${Math.floor(session.position.x)}, Y: ${Math.floor(session.position.y)}, Z: ${Math.floor(session.position.z)}`, inline: false }
        )
        .setTimestamp();
      
      if (session.statusMessage) {
        try {
          await session.statusMessage.editReply({ 
            content: null, 
            embeds: [onlineEmbed], 
            components: [] 
          });
          console.log(`[${uid}] Discord status updated via editReply`);
        } catch (editErr) {
          console.error(`editReply failed: ${editErr.message}`);
          // Try followUp
          try {
            await session.statusMessage.followUp({ embeds: [onlineEmbed], ephemeral: true });
            console.log(`[${uid}] Discord status updated via followUp`);
          } catch (followUpErr) {
            console.error(`followUp also failed: ${followUpErr.message}`);
          }
        }
      }
      
      // Also log to admin channel
      logToDiscord(`✅ Bot <@${uid}> online at ${ip}:${port}`);
      
    } catch (discordErr) {
      console.error(`Failed to update Discord: ${discordErr.message}`);
    }
    
    // Start AFK systems
    startAfkSystems(uid);
  });

  // Chunk loading
  mc.on("level_chunk", (packet) => {
    if (!session.Chunk && advancedFeaturesEnabled && PrismarineChunk) {
      try {
        const reg = PrismarineRegistry('bedrock_1.21.0');
        session.Chunk = PrismarineChunk(reg);
      } catch(e) {}
    }
    
    if (session.Chunk) {
      try {
        const chunk = new session.Chunk();
        chunk.load(packet.payload);
        session.chunks.set(`${packet.x},${packet.z}`, chunk);
      } catch(e) {}
    }
  });

  // Position updates
  mc.on("move_player", (packet) => {
    if (packet.runtime_id === session.runtimeEntityId) {
      session.position.x = packet.position.x;
      session.position.y = packet.position.y;
      session.position.z = packet.position.z;
    }
  });

  // INSTANT RESPAWN on death
  mc.on("set_health", (packet) => {
    if (packet.health <= 0 && session.runtimeEntityId) {
      console.log(`[${uid}] Died, respawning...`);
      mc.queue("player_action", {
        runtime_entity_id: session.runtimeEntityId,
        action: 7, // RESPAWN
        position: { x: 0, y: 0, z: 0 },
        result_position: { x: 0, y: 0, z: 0 },
        face: 0
      });
    }
  });

  // Errors
  mc.on("error", (e) => {
    console.error(`[${uid}] MC Error: ${e.message}`);
    if (!session.manualStop) handleAutoReconnect(uid);
  });

  mc.on("close", () => {
    console.log(`[${uid}] Connection closed`);
    if (!session.manualStop) handleAutoReconnect(uid);
  });

  mc.on("kick", (reason) => {
    console.log(`[${uid}] Kicked: ${reason}`);
    session.manualStop = true;
    cleanupSession(uid);
    removeSessionFromDisk(uid);
  });
}

function startAfkSystems(uid) {
  const s = sessions.get(uid);
  if (!s) return;

  console.log(`[${uid}] Starting AFK systems`);

  // Movement loop
  s.movementLoop = setInterval(() => {
    if (!s.connected || !s.runtimeEntityId) return;
    
    try {
      s.client.queue("player_auth_input", {
        pitch: 0,
        yaw: Math.random() * 360,
        position: s.position,
        move_vector: { x: 0, z: 0 },
        head_yaw: 0,
        input_data: 0n,
        input_mode: 1,
        play_mode: 0,
        interaction_model: 1,
        tick: BigInt(Date.now()),
        delta: { x: 0, y: 0, z: 0 },
        analog_move_vector: { x: 0, z: 0 }
      });
    } catch(e) {}
  }, 50);

  // Animation loop (arm swing)
  s.animationLoop = setInterval(() => {
    if (!s.connected || !s.runtimeEntityId) return;
    try {
      s.client.queue("animate", {
        action_id: 1,
        runtime_entity_id: s.runtimeEntityId
      });
    } catch(e) {}
  }, 5000);
}

// ============================================================================
// INTERACTION HANDLER
// ============================================================================

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (denyIfWrongGuild(i)) return;
    const uid = i.user.id;

    // Slash commands
    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return safeReply(i, panelRow(false));
      if (i.commandName === "java") return safeReply(i, panelRow(true));
      if (i.commandName === "admin") {
        if (uid !== ADMIN_ID) return safeReply(i, { content: "⛔ No access", ephemeral: true });
        const msg = await i.reply({ embeds: [getAdminStatsEmbed()], fetchReply: true });
        lastAdminMessage = msg;
        return;
      }
    }

    // Buttons
    if (i.isButton()) {
      
      if (i.customId === "start_bedrock") {
        if (sessions.has(uid)) return safeReply(i, { content: "⚠️ Already running! Click Stop first.", ephemeral: true });
        await i.deferReply({ ephemeral: true });
        return startSession(uid, i, false);
      }

      if (i.customId === "stop") {
        const stopped = await stopSession(uid, true);
        return safeReply(i, { content: stopped ? "⏹ Stopped" : "No session", ephemeral: true });
      }

      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true });
        // Quick auth flow
        const authDir = await getUserAuthDir(uid);
        const flow = new Authflow(uid, authDir, { flow: "live", authTitle: Titles?.MinecraftNintendoSwitch || "Bedrock Bot", deviceType: "Nintendo" }, async (data) => {
          const uri = data.verification_uri_complete || "https://www.microsoft.com/link";
          const code = data.user_code;
          await i.editReply({ content: `🔐 Code: \`${code}\`\nLink: ${uri}` });
        });
        try {
          await flow.getMsaToken();
          getUser(uid).linked = true;
          saveUsers();
          await i.followUp({ content: "✅ Linked!", ephemeral: true });
        } catch(e) {
          await i.editReply({ content: "❌ Link failed" });
        }
        return;
      }

      if (i.customId === "unlink") {
        await unlinkMicrosoft(uid);
        return safeReply(i, { content: "🗑 Unlinked", ephemeral: true });
      }

      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder()
          .setCustomId("settings_modal")
          .setTitle("Server Settings")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short)
                .setRequired(true).setValue(u.server?.ip || "")
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short)
                .setRequired(true).setValue(String(u.server?.port || "19132"))
            )
          );
        return i.showModal(modal);
      }

      if (i.customId === "scan_ores") {
        await i.deferReply({ ephemeral: true });
        
        const result = await scanForOres(uid, 8);
        
        if (result.error) {
          return i.editReply({ content: `❌ ${result.error}` });
        }
        
        if (result.ores.length === 0) {
          return i.editReply({ content: `⛏️ Scanned ${result.chunksScanned} chunks. No ores found.\nTip: Wait 30s after spawning for chunks to load.` });
        }
        
        // Group by type
        const byType = {};
        result.ores.forEach(o => {
          if (!byType[o.type]) byType[o.type] = [];
          byType[o.type].push(o);
        });
        
        let desc = `**${result.totalFound}** ores found (showing closest):\n\n`;
        
        for (const [type, ores] of Object.entries(byType)) {
          const emoji = type.includes('diamond') ? '💎' : type.includes('gold') ? '🥇' : type.includes('iron') ? '⛓️' : '⛏️';
          desc += `${emoji} **${type}** (${ores.length}):\n`;
          ores.slice(0, 3).forEach(o => {
            desc += `\`${o.x}, ${o.y}, ${o.z}\` (${Math.round(o.distance)}m)\n`;
          });
        }
        
        const embed = new EmbedBuilder()
          .setTitle("⛏️ Ore Scan Results")
          .setDescription(desc)
          .setColor("#FFD700")
          .setFooter({ text: `Player at: ${Math.round(result.playerPos.x)}, ${Math.round(result.playerPos.y)}, ${Math.round(result.playerPos.z)}` });
        
        return i.editReply({ embeds: [embed] });
      }

      if (i.customId === "status") {
        const s = sessions.get(uid);
        if (!s) return safeReply(i, { content: "❌ No session", ephemeral: true });
        
        const status = s.connected ? "🟢 Connected" : s.initialized ? "🟡 Initializing" : "🟠 Connecting";
        const chunks = s.chunks?.size || 0;
        const pos = s.position ? `${Math.round(s.position.x)}, ${Math.round(s.position.y)}, ${Math.round(s.position.z)}` : "Unknown";
        
        return safeReply(i, { 
          content: `**Status:** ${status}\n**Chunks:** ${chunks} loaded\n**Position:** ${pos}\n**Entity ID:** ${s.runtimeEntityId || "None"}`, 
          ephemeral: true 
        });
      }
    }

    // Modal submit
    if (i.isModalSubmit() && i.customId === "settings_modal") {
      const ip = i.fields.getTextInputValue("ip").trim();
      const port = parseInt(i.fields.getTextInputValue("port").trim()) || 19132;
      const u = getUser(uid);
      u.server = { ip, port };
      saveUsers();
      return safeReply(i, { content: `✅ Server set: ${ip}:${port}`, ephemeral: true });
    }

  } catch (e) { 
    console.error("Interaction error:", e); 
  }
});

client.login(DISCORD_TOKEN);
