/**
 * ============================================================================
 * ADVANCED BEDROCK AFK BOT - FULL IMPLEMENTATION
 * ============================================================================
 * Uses EVERY feature bedrock-protocol offers for the most realistic AFK behavior
 * 
 * Features:
 * - Proper player initialization (fixes immortal state)
 * - Server-authoritative movement via player_auth_input
 * - Realistic human-like behavior patterns
 * - Advanced anti-AFK detection evasion
 * - Full packet utilization for maximum compatibility
 * - Smart reconnection system
 * - Chunk management and bed detection
 * - Physics simulation
 * - INSTANT RESPAWN on death
 * - ORE SCANNER (5-15 chunks radius)
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

// --- Firebase Admin SDK (Hardcoded Service Account) ---
const admin = require("firebase-admin");

// Service account credentials in one line
const serviceAccount = {"type":"service_account","project_id":"blimp-d9854","private_key_id":"9e6d82c8e7ac2eee89965fd5dcbf3149d9b715aa","private_key":"-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCzZCs1tXtsBTx4\nGjAkVX0xDxtqvqNvbNDsItv5VgziR0iu3hpWudl+czM4pr4CEvPV05f1Tgchaltd\nxT4XQmWyGbMoZ0JJhjiQtDBQ0oG+30PpCeuXNLQC4XzjpIh/pp3hcnbF3lS3fCrE\n728rUSWAlcJfQKKGyDQHsjYRQmAnhVdo3vBATr3uuLz5lIwiOmgYi6Ju/PRcy7Jj\nttPY37MjKZyaxYAuX+sf0xPR2Yt1jztX6OQ17MPKKzRODH+mPJPV6I7zoSU7S16d\nTVgFQ/1AKriPW2KJ366WidhXqU2L9Y+/c71ohM+AgLkJ6GVbB1Mf8C5UFFyDoJxR\nNP9O8d7hAgMBAAECggEAN47ZVwv6yoygmq25pTcYy73bBuc95L91wPxW1lTRLq9X\nEllVHPD4LBJvlacGh8vo2ptqn51n1fCDlXoF7dwxdMRC2UuJmw3HrQExSYa4ii3J\ncX4SCcVXzuCY9kO5xpcKpIz3vfZKlH0PHejtrCO4kqdPCIMTEt0kSBHobtX4w6Qi\nlOmCoNxj1WoWu3ghV9aO3vpHE5Y3VzdcDgHApEatL0pO5yvvMtSTZRYmBtPeQBXq\nKt0j3xn8kW66qmJVewyd69rnqsdE1ohDsV1ODwlcAE8Sx2tZSYq8BmSNtquZM9iC\nT7RQtigxCiTwGrtrG8SfLU1Lc497tQ980xQUOStyJQKBgQDbNyq7hswH0eN3iQ/R\nzxexUIrxt1EEZ6q9X/oXX9VYRFAkm7lkYIvVXvopAs4bHI83Ds6G5/D6kDsxaZvF\n1gGBPyPcLF0TpVACgijpdWX3mJ1Spb8B2jhURO3hW2a3KoPhI/z2I0p3VUYKXFjE\n0BVlzrXP0VEwtod11CwdeTLj9wKBgQDRfkZETyw0Z/SPvxwlSyC2VUNZBeeO+RfI\nw74qd8M2qOyJZVApfeRaPpoKnkkJzpYRHY9gNxFrxgXn3KVMGnFR+XPLPQgP8t+F\nTcUMnrt8799kZI7PY6L+iNh3cWPspVrADEbVEBEMRiUfxIJy6FusL69Ucps5Keze\nXKJGJzpt5wKBgD5ehcPw6B/ZcZRS5LNW7nC+b6mx9FUCgat7oRYBaBvC4+Jmg+qx\nJVfBu/7rE2TXTU/m4I+1cfR4EL9QQseYybjSFAvSe3DZedgc3DL/+dDmFOysx5lp\nUtl2+w9BCApZCEiICrKk+8zT8CeGeqMUaOIcW9ISxbzMUeIOSbbhAr+lAoGBALRV\njek5eiT2o8ily3Wy8UrjpKDae1VQyY+SKH3oMEw6J7uyUcoVy99/ahzf2qGtivLa\nzlQVs1Jh2S2Ze1VCoe/d2zbFp84K1SysIIbXkS9gUZ3bDjAqZeHULPrMyiaoxLDz\nIHpCZVp6e3SYNW7y5A8Z0UTRjxsrIvLbLPlUxXBbAoGBAIsuT4tPFf+x+o8ftV5/\nCkdSJmO/7tLvdx0ffEnBcuJOyl+0NelCRwe2a8FkLC6WtOR8+Qb8UZpA9dNOT/Ve\ntc5WR8N8NTNkmaNQYbch3BMIO2rG1joTdnDUyisZuQUNUVbmUCb2RoUF4+VjkKzl\nXTlpeMWvJECcGJNCU8+GGewJ\n-----END PRIVATE KEY-----\n","client_email":"firebase-adminsdk-fbsvc@blimp-d9854.iam.gserviceaccount.com","client_id":"117313970377423396902","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","auth_provider_x509_cert_url":"https://www.googleapis.com/oauth2/v1/certs","client_x509_cert_url":"https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40blimp-d9854.iam.gserviceaccount.com","universe_domain":"googleapis.com"};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://blimp-d9854-default-rtdb.firebaseio.com"
});

const db = admin.database();
const sessionsRef = db.ref("sessions");
const authRef = db.ref("auth");

console.log("✅ Firebase Realtime Database connected");

// --- Dependencies for Chunk Scanning & Bed Detection ---
let Vec3, PrismarineChunk, PrismarineRegistry, MinecraftData;
let advancedFeaturesEnabled = false;

try {
  Vec3 = require("vec3");
  PrismarineChunk = require("prismarine-chunk");
  PrismarineRegistry = require("prismarine-registry");
  MinecraftData = require("minecraft-data");
  advancedFeaturesEnabled = true;
  console.log("✅ Advanced features enabled (vec3, prismarine-chunk, etc.)");
} catch (e) {
  console.log("⚠️  Advanced features disabled! Run: npm install vec3 prismarine-chunk prismarine-registry minecraft-data");
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

// ----------------- Config -----------------
const ALLOWED_GUILD_ID = "1464973275397357772";
const ADMIN_ID = "1144987924123881564";
const LOG_CHANNEL_ID = "1464615030111731753";
const ADMIN_CHANNEL_ID = "1469013237625393163";

// ----------------- Storage -----------------
const DATA = path.join(__dirname, "data");
const STORE = path.join(DATA, "users.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);

let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};
let activeSessionsStore = {};

function save() {
  fs.writeFileSync(STORE, JSON.stringify(users, null, 2));
}

// Firebase: Save session to Realtime Database
async function saveSessionToFirebase(uid, sessionData) {
  try {
    await sessionsRef.child(uid).set({
      ...sessionData,
      timestamp: Date.now()
    });
    console.log(`[Firebase] Session saved for ${uid}`);
  } catch (e) {
    console.error(`[Firebase] Error saving session for ${uid}:`, e.message);
  }
}

// Firebase: Remove session from Realtime Database
async function removeSessionFromFirebase(uid) {
  try {
    await sessionsRef.child(uid).remove();
    console.log(`[Firebase] Session removed for ${uid}`);
  } catch (e) {
    console.error(`[Firebase] Error removing session for ${uid}:`, e.message);
  }
}

// Firebase: Load all active sessions
async function loadSessionsFromFirebase() {
  try {
    const snapshot = await sessionsRef.once("value");
    activeSessionsStore = snapshot.val() || {};
    console.log(`[Firebase] Loaded ${Object.keys(activeSessionsStore).length} active sessions`);
    return activeSessionsStore;
  } catch (e) {
    console.error("[Firebase] Error loading sessions:", e.message);
    return {};
  }
}

// Firebase-based auth token storage for persistent Xbox login
async function saveAuthToFirebase(uid, authData) {
  try {
    await authRef.child(uid).set({
      ...authData,
      savedAt: Date.now()
    });
    console.log(`[Firebase] Auth saved for ${uid}`);
  } catch (e) {
    console.error(`[Firebase] Error saving auth for ${uid}:`, e.message);
  }
}

async function loadAuthFromFirebase(uid) {
  try {
    const snapshot = await authRef.child(uid).once("value");
    return snapshot.val();
  } catch (e) {
    console.error(`[Firebase] Error loading auth for ${uid}:`, e.message);
    return null;
  }
}

async function removeAuthFromFirebase(uid) {
  try {
    await authRef.child(uid).remove();
    console.log(`[Firebase] Auth removed for ${uid}`);
  } catch (e) {
    console.error(`[Firebase] Error removing auth for ${uid}:`, e.message);
  }
}

function getUser(uid) {
  if (!users[uid]) users[uid] = {};
  users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  return users[uid];
}

async function getUserAuthDir(uid) {
  const authData = await loadAuthFromFirebase(uid);
  if (authData && authData.tokens) {
    const dir = path.join(DATA, "auth", uid);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(path.join(dir, "tokens.json"), JSON.stringify(authData.tokens, null, 2));
      if (authData.profile) {
        fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(authData.profile, null, 2));
      }
    } catch (e) {
      console.error(`Error writing auth cache for ${uid}:`, e.message);
    }
    return dir;
  }
  const dir = path.join(DATA, "auth", uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function saveAuthCache(uid, authDir) {
  try {
    const tokensPath = path.join(authDir, "tokens.json");
    const profilePath = path.join(authDir, "profile.json");
    let authData = { tokens: null, profile: null };
    if (fs.existsSync(tokensPath)) {
      authData.tokens = JSON.parse(fs.readFileSync(tokensPath, "utf8"));
    }
    if (fs.existsSync(profilePath)) {
      authData.profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    }
    if (authData.tokens) {
      await saveAuthToFirebase(uid, authData);
    }
  } catch (e) {
    console.error(`Error saving auth cache for ${uid}:`, e.message);
  }
}

async function unlinkMicrosoft(uid) {
  await removeAuthFromFirebase(uid);
  const dir = path.join(DATA, "auth", uid);
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
// 🔥 KORJAUS: Lisätty GuildMembers intent ja Partials jotta botti näkyy member listassa!
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,  // ⬅️ TÄMÄ LISÄTTY! Näkyy member listassa ja saa welcome-viestin
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message] // Lisätty varmuuden vuoksi DM-tukea varten
});

// ==========================================================
// CRASH PREVENTION SYSTEM
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
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("scan_ores").setLabel("⛏️ Scan Ores").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("scan_beds").setLabel("🛏️ Find Bed").setStyle(ButtonStyle.Secondary)
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
      options.push({ label: `User: ${uid}`, description: `Started: ${new Date(session.startedAt).toLocaleTimeString()}`, value: uid });
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
      { name: "🤖 Active Sessions", value: `**Total Bots:** ${sessions.size}`, inline: true },
      { name: "💾 Persisted Sessions (Firebase)", value: `**Saved for Restart:** ${Object.keys(activeSessionsStore).length}`, inline: true }
    )
    .setFooter({ text: "Auto-refreshing every 30s • Administrative Access Only" })
    .setTimestamp();
  if (sessions.size > 0) {
    let botList = "";
    for (const [uid, s] of sessions) {
      const status = s.connected ? "🟢 Online" : (s.isReconnecting ? "⏳ Reconnecting" : "🔴 Offline");
      botList += `<@${uid}>: ${status}\n`;
    }
    embed.addFields({ name: "📋 Active Bot Registry", value: botList.slice(0, 1024) });
  }
  return embed;
}

// ----------------- Events: Ready & Startup Rejoin -----------------
client.once("ready", async () => {
  console.log("🟢 Online as", client.user.tag);
  console.log("📂 Loading sessions from Firebase...");
  await loadSessionsFromFirebase();
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
  console.log("📂 Checking Firebase for previous sessions...");
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

// 🔥 KORJAUS: Welcome-viesti kun botti liittyy uudelle palvelimelle (jos tarvitset)
client.on(Events.GuildMemberAdd, async (member) => {
  if (member.user.id === client.user.id) {
    console.log(`✅ Bot joined server: ${member.guild.name}`);
    // Bot näkyy nyt member listassa tämän eventin myötä!
  }
});

// ----------------- Microsoft link -----------------
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) return interaction.editReply("⏳ Login already in progress. Use the last code.");
  const authDir = await getUserAuthDir(uid);
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
      await saveAuthCache(uid, authDir);
      u.linked = true;
      save();
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
  if (s.chunkGCLoop) clearInterval(s.chunkGCLoop);
  if (s.movementLoop) clearInterval(s.movementLoop);
  if (s.tickSyncLoop) clearInterval(s.tickSyncLoop);
  if (s.animationLoop) clearInterval(s.animationLoop);
  if (s.actionLoop) clearInterval(s.actionLoop);
  try { s.client.close(); } catch {}
  sessions.delete(uid);
}

async function stopSession(uid, isManual = true) {
  const s = sessions.get(uid);
  if (isManual) {
    await removeSessionFromFirebase(uid);
    if (activeSessionsStore[uid]) {
      delete activeSessionsStore[uid];
    }
    console.log(`[Stop] Manual stop for ${uid} - removed from Firebase`);
  } else {
    console.log(`[Stop] Automatic stop for ${uid} - keeping in Firebase for reconnect`);
  }
  if (!s) return false;
  s.manualStop = isManual;
  cleanupSession(uid);
  return true;
}

async function stopAllSessions() {
  const uids = Array.from(sessions.keys());
  for (const uid of uids) {
    await stopSession(uid, true);
  }
  return uids.length;
}

function handleAutoReconnect(uid) {
  const s = sessions.get(uid);
  if (!s || s.manualStop) return;
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  s.isReconnecting = true;
  logToDiscord(`⏳ Bot of <@${uid}> disconnected. Reconnecting in 60s...`);
  console.log(`[Reconnect] Scheduling reconnect for ${uid} in 60s`);
  s.reconnectTimer = setTimeout(() => {
    if (sessions.has(uid)) {
      const checkS = sessions.get(uid);
      if (!checkS.manualStop) {
        console.log(`[Reconnect] Executing reconnect for ${uid}`);
        checkS.reconnectTimer = null;
        startSession(uid, null, true);
      } else {
        console.log(`[Reconnect] Manual stop detected for ${uid}, cancelling reconnect`);
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
  } catch (e) {
    console.error(`[SafeReply] Failed to send message:`, e.message);
  }
}

async function safeFollowUp(interaction, content) {
  if (!interaction) return;
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(content);
    } else {
      await interaction.reply(content);
    }
  } catch (e) {
    console.error(`[SafeFollowUp] Failed:`, e.message);
  }
}

// ============================================================================
// ORE SCANNER SYSTEM
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
  'ancient_debris',
  'nether_quartz_ore', 'nether_gold_ore'
];

async function scanForOres(uid, radius = 8) {
  const s = sessions.get(uid);
  if (!s) return { error: "No active session" };
  if (!s.connected) return { error: "Bot not connected" };
  if (!advancedFeaturesEnabled || !s.chunks) return { error: "Advanced features not available" };
  
  const foundOres = [];
  const playerPos = s.position ? s.position.floored() : { x: 0, y: 64, z: 0 };
  const searchRadius = Math.min(Math.max(radius, 1), 15);
  
  console.log(`[${uid}] Scanning ${searchRadius} chunks radius for ores...`);
  
  const playerChunkX = Math.floor(playerPos.x / 16);
  const playerChunkZ = Math.floor(playerPos.z / 16);
  
  let chunksScanned = 0;
  let blocksChecked = 0;
  
  for (let cx = -searchRadius; cx <= searchRadius; cx++) {
    for (let cz = -searchRadius; cz <= searchRadius; cz++) {
      const chunkKey = `${playerChunkX + cx},${playerChunkZ + cz}`;
      const chunk = s.chunks.get(chunkKey);
      
      if (chunk) {
        chunksScanned++;
        for (let x = 0; x < 16; x++) {
          for (let z = 0; z < 16; z++) {
            for (let y = -64; y < 320; y++) {
              blocksChecked++;
              try {
                const block = chunk.getBlock({ x, y, z });
                if (block && block.name && ORE_BLOCKS.includes(block.name)) {
                  const worldX = (playerChunkX + cx) * 16 + x;
                  const worldZ = (playerChunkZ + cz) * 16 + z;
                  
                  foundOres.push({
                    type: block.name,
                    x: worldX,
                    y: y,
                    z: worldZ,
                    distance: Math.sqrt(
                      Math.pow(worldX - playerPos.x, 2) + 
                      Math.pow(y - playerPos.y, 2) + 
                      Math.pow(worldZ - playerPos.z, 2)
                    )
                  });
                }
              } catch (e) {}
            }
          }
        }
      }
    }
  }
  
  foundOres.sort((a, b) => a.distance - b.distance);
  
  const uniqueOres = [];
  const seen = new Set();
  for (const ore of foundOres) {
    const key = `${ore.x},${ore.y},${ore.z}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueOres.push(ore);
    }
  }
  
  console.log(`[${uid}] Scanned ${chunksScanned} chunks, checked ${blocksChecked} blocks, found ${uniqueOres.length} ores`);
  
  return {
    ores: uniqueOres.slice(0, 20),
    totalFound: uniqueOres.length,
    chunksScanned: chunksScanned,
    playerPos: playerPos
  };
}

// ============================================================================
// ADVANCED AFK SYSTEM - FULL BEDROCK-PROTOCOL IMPLEMENTATION
// ============================================================================

/**
 * Input flags for player_auth_input packet
 */
const InputFlags = {
  ASCEND: 0x00000001,
  DESCEND: 0x00000002,
  NORTH_JUMP: 0x00000004,
  JUMP_DOWN: 0x00000008,
  SPRINT_DOWN: 0x00000010,
  CHANGE_HEIGHT: 0x00000020,
  JUMPING: 0x00000040,
  AUTO_JUMPING_IN_WATER: 0x00000080,
  SNEAKING: 0x00000100,
  SNEAK_DOWN: 0x00000200,
  UP: 0x00000400,
  DOWN: 0x00000800,
  LEFT: 0x00001000,
  RIGHT: 0x00002000,
  UP_LEFT: 0x00004000,
  UP_RIGHT: 0x00008000,
  WANT_UP: 0x00010000,
  WANT_DOWN: 0x00020000,
  WANT_DOWN_SLOW: 0x00040000,
  WANT_UP_SLOW: 0x00080000,
  SPRINTING: 0x00100000,
  ASCEND_SCAFFOLDING: 0x00200000,
  DESCEND_SCAFFOLDING: 0x00400000,
  SNEAK_TOGGLE_DOWN: 0x00800000,
  PERSIST_SNEAK: 0x01000000,
  START_SPRINTING: 0x02000000,
  STOP_SPRINTING: 0x04000000,
  START_SNEAKING: 0x08000000,
  STOP_SNEAKING: 0x10000000,
  START_SWIMMING: 0x20000000,
  STOP_SWIMMING: 0x40000000,
  START_JUMPING: 0x80000000,
  START_GLIDING: 0x0000000100000000n,
  STOP_GLIDING: 0x0000000200000000n,
  PERFORM_ITEM_INTERACTION: 0x0000000400000000n,
  PERFORM_BLOCK_ACTIONS: 0x0000000800000000n,
  PERFORM_ITEM_STACK_REQUEST: 0x0000001000000000n,
  HANDLED_TELEPORT: 0x0000002000000000n,
  MISSED_SWING: 0x0000004000000000n,
  START_CRAWLING: 0x0000008000000000n,
  STOP_CRAWLING: 0x0000010000000000n,
  START_FLYING: 0x0000020000000000n,
  STOP_FLYING: 0x0000040000000000n,
  RECEIVED_SERVER_DATA: 0x0000080000000000n,
  BLOCK_BREAKING_DELAY_ENABLED: 0x0000100000000000n,
  BLOCK_COMPONENT_IS_PLACING: 0x0000200000000000n,
  VERTICAL_COLLISION: 0x0000400000000000n,
};

/**
 * Player action types for player_action packet
 */
const ActionTypes = {
  START_BREAK: 0,
  ABORT_BREAK: 1,
  STOP_BREAK: 2,
  GET_UPDATED_BLOCK: 3,
  DROP_ITEM: 4,
  START_SLEEPING: 5,
  STOP_SLEEPING: 6,
  RESPAWN: 7,
  JUMP: 8,
  START_SPRINT: 9,
  STOP_SPRINT: 10,
  START_SNEAK: 11,
  STOP_SNEAK: 12,
  CREATIVE_PLAYER_DESTROY_BLOCK: 13,
  DIMENSION_CHANGE_ACK: 14,
  START_GLIDE: 15,
  STOP_GLIDE: 16,
  BUILD_DENIED: 17,
  CRACK_BREAK: 18,
  CHANGE_SKIN: 19,
  SET_ENCHANTMENT_SEED: 20,
  START_SWIMMING: 21,
  STOP_SWIMMING: 22,
  START_SPIN_ATTACK: 23,
  STOP_SPIN_ATTACK: 24,
  INTERACT_BLOCK: 25,
  PREDICT_BREAK: 26,
  CONTINUE_BREAK: 27,
  START_ITEM_USE_ON: 28,
  STOP_ITEM_USE_ON: 29,
  HANDLED_TELEPORT: 30,
  MISSED_SWING: 31,
  START_CRAWLING: 32,
  STOP_CRAWLING: 33,
  START_FLYING: 34,
  STOP_FLYING: 35,
  RECEIVED_SERVER_DATA: 36,
};

// ----------------- MAIN SESSION FUNCTION -----------------
async function startSession(uid, interaction, isReconnect = false) {
  console.log(`[StartSession] Starting for ${uid}, isReconnect: ${isReconnect}`);
  const u = getUser(uid);

  if (!activeSessionsStore[uid]) {
    console.log(`[StartSession] Saving new session to Firebase for ${uid}`);
    await saveSessionToFirebase(uid, {
      server: u.server,
      startedAt: Date.now(),
      isReconnect: isReconnect
    });
    activeSessionsStore[uid] = true;
  } else {
    console.log(`[StartSession] Session already exists in Firebase for ${uid}`);
  }

  if (!u.server) {
    console.log(`[StartSession] No server configured for ${uid}`);
    if (!isReconnect && interaction) await safeReply(interaction, "⚠ Please configure your server settings first.");
    await removeSessionFromFirebase(uid);
    delete activeSessionsStore[uid];
    return;
  }

  const { ip, port } = u.server;

  if (sessions.has(uid) && !isReconnect) {
    console.log(`[StartSession] Active session already exists for ${uid}`);
    if (interaction) return safeReply(interaction, "⚠️ **Session Conflict**: Active session already exists.").catch(() => {});
    return;
  }

  let statusInteraction = interaction;
  let initialMessageSent = false;
  
  const connectionEmbed = new EmbedBuilder()
    .setColor("#5865F2")
    .setTitle("Bot Initialization")
    .setThumbnail("https://files.catbox.moe/9mqpoz.gif");

  try {
    if (!isReconnect && interaction) {
      connectionEmbed.setDescription(`🔍 **Pinging server...**\n🌐 **Target:** \`${ip}:${port}\``);
      await safeReply(interaction, { embeds: [connectionEmbed], content: null, components: [] });
      initialMessageSent = true;
    }

    await bedrock.ping({ host: ip, port: parseInt(port) || 19132, timeout: 5000 });

    if (!isReconnect && interaction) {
      connectionEmbed.setDescription(`✅ **Server found! Connecting...**\n🌐 **Target:** \`${ip}:${port}\``);
      await safeReply(interaction, { embeds: [connectionEmbed] });
    }
  } catch (err) {
    console.error(`[StartSession] Server ${ip}:${port} unreachable for ${uid}`);
    logToDiscord(`❌ Connection failure for <@${uid}>: Server ${ip}:${port} unreachable.`);
    if (isReconnect) {
      console.log(`[StartSession] Scheduling reconnect for ${uid} after ping failure`);
      const dummySession = { manualStop: false, isReconnecting: true };
      sessions.set(uid, dummySession);
      handleAutoReconnect(uid);
    } else if (interaction) {
      await safeReply(interaction, { content: `❌ **Connection Failed**: The server at \`${ip}:${port}\` is currently offline.`, embeds: [] });
      await removeSessionFromFirebase(uid);
      delete activeSessionsStore[uid];
    }
    return;
  }

  const authDir = await getUserAuthDir(uid);

  const opts = {
    host: ip,
    port: parseInt(port),
    connectTimeout: 60000,
    keepAlive: true,
    viewDistance: 10,
    profilesFolder: authDir,
    username: uid,
    offline: false,
    autoInitPlayer: false,
    compressionLevel: 7,
    batchingInterval: 20,
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
    velocity: (advancedFeaturesEnabled && Vec3) ? new Vec3(0, 0, 0) : null,
    yaw: 0,
    pitch: 0,
    headYaw: 0,
    onGround: false,
    isWalking: false,
    isSneaking: false,
    isSprinting: false,
    isJumping: false,
    isSwimming: false,
    isGliding: false,
    isFlying: false,
    isSleeping: false,
    targetPosition: null,
    isTryingToSleep: false,
    chunks: new Map(),
    registry: null,
    Chunk: null,
    runtimeEntityId: null,
    tick: 0,
    inputData: 0n,
    moveVector: { x: 0, z: 0 },
    analogMoveVector: { x: 0, z: 0 },
    reconnectTimer: null,
    physicsLoop: null,
    afkTimeout: null,
    chunkGCLoop: null,
    movementLoop: null,
    tickSyncLoop: null,
    animationLoop: null,
    actionLoop: null,
    lastActionTime: 0,
    lastSwingTime: 0,
    lastJumpTime: 0,
    lastSneakTime: 0,
    lastSprintTime: 0,
    lastEmoteTime: 0,
    lastChatTime: 0,
    actionCounter: 0,
    bedPosition: null,
    spawnPosition: null,
    dimension: 0,
    gameMode: 0,
    difficulty: 0,
    levelChunkCount: 0,
    initialized: false,
    statusInteraction: statusInteraction,
    isReconnect: isReconnect,
    serverIp: ip,
    serverPort: port
  };
  sessions.set(uid, currentSession);

  // ============================================================================
  // PACKET EVENT HANDLERS
  // ============================================================================

  mc.on("connect", () => {
    console.log(`[${uid}] Connected to server`);
  });

  mc.on("login", () => {
    console.log(`[${uid}] Logged in successfully`);
  });

  mc.on("join", () => {
    console.log(`[${uid}] Joined server, ready for game packets`);
  });

  // --- Play Status Handler ---
  mc.on("play_status", (packet) => {
    console.log(`[${uid}] Play status: ${packet.status}`);
    
    if (packet.status === "player_spawn" || packet.status === 3) {
      console.log(`[${uid}] Received player_spawn status, initializing...`);
      
      mc.queue("serverbound_loading_screen", { type: 1 });
      mc.queue("serverbound_loading_screen", { type: 2 });
      
      mc.queue("interact", {
        action_id: 4,
        target_entity_id: 0n,
        position: { x: 0, y: 0, z: 0 }
      });
      
      if (currentSession.runtimeEntityId) {
        mc.queue("set_local_player_as_initialized", {
          runtime_entity_id: currentSession.runtimeEntityId
        });
      }
      
      currentSession.initialized = true;
    }
  });

  // --- Start Game Handler ---
  mc.on("start_game", (packet) => {
    console.log(`[${uid}] Start game received`);
    
    currentSession.runtimeEntityId = packet.runtime_entity_id;
    currentSession.dimension = packet.dimension;
    currentSession.gameMode = packet.player_gamemode;
    currentSession.difficulty = packet.difficulty;
    currentSession.spawnPosition = packet.spawn_position;
    
    if (advancedFeaturesEnabled && Vec3) {
      currentSession.position = new Vec3(
        packet.player_position.x,
        packet.player_position.y,
        packet.player_position.z
      );
      currentSession.targetPosition = currentSession.position.clone();
    }
    
    mc.queue("request_chunk_radius", { chunk_radius: 10 });
    mc.queue("client_cache_status", { enabled: false });
    mc.queue("tick_sync", { request_time: BigInt(Date.now()), response_time: 0n });
  });

  // --- Spawn Handler ---
  mc.on("spawn", () => {
    console.log(`[${uid}] Spawned in world`);
    currentSession.connected = true;
    currentSession.isReconnecting = false;
    
    const onlineEmbed = new EmbedBuilder()
      .setColor("#00FF00")
      .setTitle("🟢 Bot Online")
      .setDescription(`Successfully connected and spawned in the server!`)
      .addFields(
        { name: "Server", value: `\`${currentSession.serverIp}:${currentSession.serverPort}\``, inline: true },
        { name: "Mode", value: currentSession.isReconnect ? "🔄 Auto-Reconnect" : "🚀 Fresh Start", inline: true },
        { name: "Position", value: currentSession.position ? 
          `X: ${Math.floor(currentSession.position.x)}, Y: ${Math.floor(currentSession.position.y)}, Z: ${Math.floor(currentSession.position.z)}` : 
          "Loading...", inline: false }
      )
      .setTimestamp();
    
    if (currentSession.statusInteraction) {
      safeReply(currentSession.statusInteraction, { 
        content: null, 
        embeds: [onlineEmbed], 
        components: [] 
      }).then(() => {
        console.log(`[${uid}] Discord status updated to ONLINE`);
      }).catch(err => {
        console.error(`[${uid}] Failed to edit original message:`, err.message);
        safeFollowUp(currentSession.statusInteraction, {
          embeds: [onlineEmbed],
          ephemeral: true
        });
      });
    }
    
    if (currentSession.isReconnect) {
      client.users.fetch(uid).then(user => {
        user.send({ 
          embeds: [onlineEmbed.setDescription("Your AFK bot has automatically reconnected to the server!")] 
        }).catch(() => {});
      }).catch(() => {});
    }
    
    logToDiscord(`✅ Bot of <@${uid}> spawned on **${ip}:${port}**` + (isReconnect ? " (Auto-Rejoined)" : ""));
    
    startAfkSystems(uid);
  });

  // --- Chunk Handling ---
  mc.on("level_chunk", (packet) => {
    if (!currentSession.Chunk) return;
    try {
      const chunk = new currentSession.Chunk();
      chunk.load(packet.payload);
      currentSession.chunks.set(`${packet.x},${packet.z}`, chunk);
      currentSession.levelChunkCount++;
    } catch(e) {}
  });

  // --- Move Player Handler ---
  mc.on("move_player", (packet) => {
    if (packet.runtime_id === currentSession.runtimeEntityId && currentSession.position) {
      currentSession.onGround = packet.on_ground || false;
      currentSession.position.set(packet.position.x, packet.position.y, packet.position.z);
      currentSession.pitch = packet.pitch;
      currentSession.yaw = packet.yaw;
      currentSession.headYaw = packet.head_yaw;
    }
  });

  // --- Tick Sync Handler ---
  mc.on("tick_sync", (packet) => {
    currentSession.tick = Number(packet.response_time);
  });

  // --- INSTANT RESPAWN: Set Health Handler ---
  mc.on("set_health", (packet) => {
    console.log(`[${uid}] Health set to ${packet.health}`);
    
    if (packet.health <= 0) {
      console.log(`[${uid}] Bot died! Respawning immediately...`);
      logToDiscord(`💀 Bot of <@${uid}> died - respawning instantly`);
      
      if (currentSession.runtimeEntityId) {
        try {
          mc.queue("player_action", {
            runtime_entity_id: currentSession.runtimeEntityId,
            action: ActionTypes.RESPAWN,
            position: { x: 0, y: 0, z: 0 },
            result_position: { x: 0, y: 0, z: 0 },
            face: 0
          });
          console.log(`[${uid}] Respawn packet sent`);
        } catch (e) {
          console.error(`[${uid}] Failed to send respawn:`, e.message);
        }
      }
    }
  });

  // --- Respawn Handler ---
  mc.on("respawn", (packet) => {
    console.log(`[${uid}] Server confirmed respawn`);
    
    if (currentSession.position) {
      currentSession.position.set(packet.position.x, packet.position.y, packet.position.z);
      currentSession.targetPosition = currentSession.position.clone();
      if (currentSession.velocity) currentSession.velocity.set(0, 0, 0);
      currentSession.isSleeping = false;
      currentSession.isTryingToSleep = false;
    }
    
    currentSession.isJumping = false;
    currentSession.isSneaking = false;
    currentSession.isSprinting = false;
    
    logToDiscord(`✅ Bot of <@${uid}> respawned successfully`);
  });

  // --- Text/Chat Handler ---
  mc.on("text", (packet) => {
    if (packet.source_name && packet.source_name !== mc.username) {
      const msg = packet.message.toLowerCase();
      if (msg.includes(mc.username.toLowerCase()) || msg.includes("afk")) {
        if (Math.random() < 0.1) {
          setTimeout(() => {
            sendChatMessage(uid, "I'm AFK right now, be back soon!");
          }, 2000 + Math.random() * 3000);
        }
      }
    }
  });

  // --- Error Handler ---
  mc.on("error", (e) => {
    console.error(`[Session ${uid}] Connection error:`, e.message);
    if (!currentSession.manualStop) handleAutoReconnect(uid);
    logToDiscord(`❌ Bot of <@${uid}> error: \`${e.message}\``);
  });

  // --- Close Handler ---
  mc.on("close", () => {
    console.log(`[Session ${uid}] Connection closed`);
    if (!currentSession.manualStop) handleAutoReconnect(uid);
    logToDiscord(`🔌 Bot of <@${uid}> connection closed.`);
  });

  // --- Kick Handler ---
  mc.on("kick", (reason) => {
    console.log(`[Session ${uid}] Kicked:`, reason);
    logToDiscord(`👢 Bot of <@${uid}> was kicked: \`${reason}\``);
    currentSession.manualStop = true;
    cleanupSession(uid);
  });

  // --- Change Dimension Handler ---
  mc.on("change_dimension", (packet) => {
    console.log(`[${uid}] Dimension change to ${packet.dimension}`);
    currentSession.dimension = packet.dimension;
    
    if (currentSession.runtimeEntityId) {
      try {
        mc.queue("player_action", {
          runtime_entity_id: currentSession.runtimeEntityId,
          action: ActionTypes.DIMENSION_CHANGE_ACK,
          position: { x: 0, y: 0, z: 0 },
          result_position: { x: 0, y: 0, z: 0 },
          face: 0
        });
      } catch (e) {}
    }
  });

  // --- Other Handlers ---
  mc.on("chunk_radius_update", (packet) => {
    console.log(`[${uid}] Chunk radius updated to ${packet.chunk_radius}`);
  });

  mc.on("network_settings", (packet) => {
    console.log(`[${uid}] Network settings received`);
  });

  mc.on("adventure_settings", (packet) => {
    console.log(`[${uid}] Adventure settings received`);
  });

  mc.on("set_player_game_type", (packet) => {
    currentSession.gameMode = packet.gamemode;
    console.log(`[${uid}] Game mode changed to ${packet.gamemode}`);
  });

  mc.on("set_difficulty", (packet) => {
    currentSession.difficulty = packet.difficulty;
  });

  mc.on("set_spawn_position", (packet) => {
    currentSession.spawnPosition = packet.spawn_position;
  });

  mc.on("container_open", (packet) => {
    mc.queue("container_close", { window_id: packet.window_id });
  });

  mc.on("correct_player_move_prediction", (packet) => {
    if (currentSession.position) {
      currentSession.position.set(packet.position.x, packet.position.y, packet.position.z);
      currentSession.yaw = packet.yaw;
      currentSession.pitch = packet.pitch;
      currentSession.headYaw = packet.head_yaw;
    }
  });

  mc.on("npc_dialogue", (packet) => {
    mc.queue("npc_dialogue", { 
      npc_runtime_entity_id: packet.npc_runtime_entity_id,
      action_type: 0
    });
  });

  mc.on("modal_form_request", (packet) => {
    mc.queue("modal_form_response", {
      form_id: packet.form_id,
      data: null
    });
  });

  mc.on("server_settings_request", (packet) => {
    mc.queue("server_settings_response", { settings: "" });
  });

  mc.on("network_stack_latency", (packet) => {
    mc.queue("network_stack_latency", {
      timestamp: packet.timestamp,
      needs_response: false
    });
  });

  mc.on("packet_violation_warning", (packet) => {
    console.warn(`[${uid}] Packet violation: ${packet.violation_type}`);
  });
}

// ============================================================================
// AFK SYSTEMS
// ============================================================================

function startAfkSystems(uid) {
  const s = sessions.get(uid);
  if (!s) return;

  if (advancedFeaturesEnabled && PrismarineChunk && PrismarineRegistry) {
    try {
      s.registry = PrismarineRegistry('bedrock_1.21.0');
      s.Chunk = PrismarineChunk(s.registry);
    } catch (e) {
      console.error(`[${uid}] Could not initialize chunk manager:`, e.message);
    }
  }

  startMovementLoop(uid);
  startAnimationLoop(uid);
  startActionLoop(uid);
  startTickSyncLoop(uid);
  startChunkGCLoop(uid);
  startAntiAfkLoop(uid);

  console.log(`[${uid}] All AFK systems started`);
}

function startMovementLoop(uid) {
  const s = sessions.get(uid);
  if (!s) return;

  s.movementLoop = setInterval(() => {
    if (!s.connected || !s.position || !s.initialized) return;

    s.tick++;

    let inputData = 0n;
    
    if (s.isJumping) inputData |= InputFlags.JUMPING;
    if (s.isSneaking) inputData |= InputFlags.SNEAKING;
    if (s.isSprinting) inputData |= InputFlags.SPRINTING;
    if (s.onGround) inputData |= InputFlags.VERTICAL_COLLISION;
    
    if (s.moveVector.x !== 0 || s.moveVector.z !== 0) {
      if (s.moveVector.z < 0) inputData |= InputFlags.UP;
      if (s.moveVector.z > 0) inputData |= InputFlags.DOWN;
      if (s.moveVector.x < 0) inputData |= InputFlags.LEFT;
      if (s.moveVector.x > 0) inputData |= InputFlags.RIGHT;
    }

    const delta = s.velocity ? {
      x: s.velocity.x,
      y: s.velocity.y,
      z: s.velocity.z
    } : { x: 0, y: 0, z: 0 };

    try {
      s.client.queue("player_auth_input", {
        pitch: s.pitch,
        yaw: s.yaw,
        position: {
          x: s.position.x,
          y: s.position.y,
          z: s.position.z
        },
        move_vector: s.moveVector,
        head_yaw: s.headYaw,
        input_data: inputData,
        input_mode: 1,
        play_mode: 0,
        interaction_model: 1,
        tick: BigInt(s.tick),
        delta: delta,
        analog_move_vector: s.analogMoveVector
      });
    } catch (e) {}

    applyPhysics(uid);

  }, 50);
}

function applyPhysics(uid) {
  const s = sessions.get(uid);
  if (!s || !s.velocity || !s.position) return;

  const gravity = 0.08;
  const friction = 0.91;

  if (!s.onGround) {
    s.velocity.y -= gravity;
    if (s.velocity.y < -3.92) s.velocity.y = -3.92;
  } else {
    s.velocity.y = 0;
  }

  if (s.isWalking && (s.moveVector.x !== 0 || s.moveVector.z !== 0)) {
    const speed = s.isSprinting ? 0.28 : 0.22;
    s.velocity.x = s.moveVector.x * speed;
    s.velocity.z = s.moveVector.z * speed;
  } else {
    s.velocity.x *= friction;
    s.velocity.z *= friction;
  }

  s.position.add(s.velocity);

  if (s.position.y < -64) {
    s.position.y = 320;
    s.velocity.y = 0;
  }
}

function startAnimationLoop(uid) {
  const s = sessions.get(uid);
  if (!s) return;

  s.animationLoop = setInterval(() => {
    if (!s.connected || !s.initialized) return;

    const now = Date.now();
    
    if (now - s.lastSwingTime > 3000 + Math.random() * 5000) {
      swingArm(uid);
      s.lastSwingTime = now;
    }

  }, 1000);
}

function startActionLoop(uid) {
  const s = sessions.get(uid);
  if (!s) return;

  s.actionLoop = setInterval(() => {
    if (!s.connected || !s.initialized) return;

    const now = Date.now();
    const actions = [];

    if (now - s.lastJumpTime > 5000 + Math.random() * 10000) {
      actions.push(ActionTypes.JUMP);
      s.lastJumpTime = now;
      s.isJumping = true;
      if (s.velocity) s.velocity.y = 0.42;
      setTimeout(() => { s.isJumping = false; }, 500);
    }

    if (now - s.lastSneakTime > 10000 + Math.random() * 20000) {
      if (s.isSneaking) {
        actions.push(ActionTypes.STOP_SNEAK);
        s.isSneaking = false;
      } else {
        actions.push(ActionTypes.START_SNEAK);
        s.isSneaking = true;
      }
      s.lastSneakTime = now;
    }

    if (now - s.lastSprintTime > 15000 + Math.random() * 30000) {
      if (s.isSprinting) {
        actions.push(ActionTypes.STOP_SPRINT);
        s.isSprinting = false;
      } else {
        actions.push(ActionTypes.START_SPRINT);
        s.isSprinting = true;
      }
      s.lastSprintTime = now;
    }

    actions.forEach(action => {
      sendPlayerAction(uid, action);
    });

  }, 1000);
}

function startTickSyncLoop(uid) {
  const s = sessions.get(uid);
  if (!s) return;

  s.tickSyncLoop = setInterval(() => {
    if (!s.connected) return;

    try {
      s.client.queue("tick_sync", {
        request_time: BigInt(Date.now()),
        response_time: 0n
      });
    } catch (e) {}

  }, 1000);
}

function startChunkGCLoop(uid) {
  const s = sessions.get(uid);
  if (!s) return;

  s.chunkGCLoop = setInterval(() => {
    if (s.chunks.size > 100) {
      if (s.position) {
        const pcx = Math.floor(s.position.x / 16);
        const pcz = Math.floor(s.position.z / 16);
        for (const [key, chunk] of s.chunks) {
          const [cx, cz] = key.split(',').map(Number);
          if (Math.abs(cx - pcx) > 12 || Math.abs(cz - pcz) > 12) {
            s.chunks.delete(key);
          }
        }
      } else {
        s.chunks.clear();
      }
    }
  }, 30000);
}

function startAntiAfkLoop(uid) {
  const s = sessions.get(uid);
  if (!s) return;

  const performAntiAfk = () => {
    if (!sessions.has(uid)) return;
    const session = sessions.get(uid);
    if (!session.connected || !session.initialized) {
      session.afkTimeout = setTimeout(performAntiAfk, 5000);
      return;
    }

    scanForBedAndSleep(uid);

    if (Math.random() > 0.3) {
      session.yaw += (Math.random() - 0.5) * 30;
      session.pitch += (Math.random() - 0.5) * 15;
      session.pitch = Math.max(-90, Math.min(90, session.pitch));
    }

    if (Math.random() > 0.5) {
      session.isWalking = true;
      const angle = Math.random() * Math.PI * 2;
      session.moveVector.x = Math.sin(angle);
      session.moveVector.z = Math.cos(angle);
      
      setTimeout(() => {
        if (sessions.has(uid)) {
          const s2 = sessions.get(uid);
          s2.isWalking = false;
          s2.moveVector.x = 0;
          s2.moveVector.z = 0;
        }
      }, 500 + Math.random() * 1500);
    }

    if (Math.random() > 0.95) {
      sendEmote(uid);
    }

    if (Math.random() > 0.98) {
      const messages = ["brb", "afk", "back soon", "...", "lol"];
      sendChatMessage(uid, messages[Math.floor(Math.random() * messages.length)]);
    }

    const nextDelay = 2000 + Math.random() * 6000;
    session.afkTimeout = setTimeout(performAntiAfk, nextDelay);
  };

  performAntiAfk();
}

// ============================================================================
// PACKET SENDER FUNCTIONS
// ============================================================================

function sendPlayerAction(uid, action, position = { x: 0, y: 0, z: 0 }, face = 0) {
  const s = sessions.get(uid);
  if (!s || !s.connected || !s.runtimeEntityId) return;

  try {
    s.client.queue("player_action", {
      runtime_entity_id: s.runtimeEntityId,
      action: action,
      position: position,
      result_position: position,
      face: face
    });
  } catch (e) {}
}

function swingArm(uid) {
  const s = sessions.get(uid);
  if (!s || !s.connected || !s.runtimeEntityId) return;

  try {
    s.client.queue("animate", {
      action_id: 1,
      runtime_entity_id: s.runtimeEntityId
    });
  } catch (e) {}
}

function sendChatMessage(uid, message) {
  const s = sessions.get(uid);
  if (!s || !s.connected) return;

  const now = Date.now();
  if (now - s.lastChatTime < 5000) return;
  s.lastChatTime = now;

  try {
    s.client.queue("text", {
      type: "chat",
      needs_translation: false,
      source_name: s.client.username || "Player",
      xuid: "",
      platform_chat_id: "",
      filtered_message: "",
      message: message
    });
  } catch (e) {}
}

function sendEmote(uid) {
  const s = sessions.get(uid);
  if (!s || !s.connected) return;

  const now = Date.now();
  if (now - s.lastEmoteTime < 10000) return;
  s.lastEmoteTime = now;

  const emotes = [
    "animation.player.attack.pos",
    "animation.player.attack.neg",
    "animation.player.hurt",
  ];

  try {
    s.client.queue("emote", {
      runtime_entity_id: s.runtimeEntityId,
      emote_id: emotes[Math.floor(Math.random() * emotes.length)],
      flags: 0
    });
  } catch (e) {}
}

// ============================================================================
// BED DETECTION AND SLEEPING
// ============================================================================

function scanForBedAndSleep(uid) {
  const s = sessions.get(uid);
  if (!s || !s.Chunk || !s.position || s.isTryingToSleep || s.isSleeping || !advancedFeaturesEnabled) return;

  const searchRadius = 5;
  const playerPos = s.position.floored();

  for (let x = -searchRadius; x <= searchRadius; x++) {
    for (let y = -2; y <= 2; y++) {
      for (let z = -searchRadius; z <= searchRadius; z++) {
        const checkPos = playerPos.offset(x, y, z);
        const chunkX = Math.floor(checkPos.x / 16);
        const chunkZ = Math.floor(checkPos.z / 16);
        const chunk = s.chunks.get(`${chunkX},${chunkZ}`);

        if (chunk) {
          try {
            const block = chunk.getBlock(checkPos);
            if (block && block.name && (block.name.includes('bed') || block.name.includes('sleeping'))) {
              console.log(`[${uid}] Bed found at ${checkPos.x}, ${checkPos.y}, ${checkPos.z}`);
              s.bedPosition = checkPos;
              s.isTryingToSleep = true;

              s.targetPosition = new Vec3(checkPos.x + 0.5, checkPos.y, checkPos.z + 0.5);
              s.isWalking = true;

              setTimeout(() => {
                if (sessions.has(uid)) {
                  const s2 = sessions.get(uid);
                  s2.isWalking = false;
                  s2.moveVector.x = 0;
                  s2.moveVector.z = 0;

                  sendPlayerAction(uid, ActionTypes.START_SLEEPING, checkPos);
                  s2.isSleeping = true;

                  setTimeout(() => {
                    if (sessions.has(uid)) {
                      const s3 = sessions.get(uid);
                      sendPlayerAction(uid, ActionTypes.STOP_SLEEPING);
                      s3.isSleeping = false;
                      s3.isTryingToSleep = false;
                    }
                  }, 30000 + Math.random() * 30000);
                }
              }, 2000);

              return;
            }
          } catch (e) {}
        }
      }
    }
  }
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
      if (i.customId === "admin_refresh") {
        return i.update({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() }).catch(() => {});
      }

      if (i.customId === "admin_stop_all") {
        const count = await stopAllSessions();
        await i.reply({ ephemeral: true, content: `🛑 Stopped ${count} bot(s).` });
        if (lastAdminMessage) {
          try {
            await lastAdminMessage.edit({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() });
          } catch (e) {}
        }
        return;
      }

      if (i.customId === "start_bedrock") {
        if (sessions.has(uid)) return safeReply(i, { ephemeral: true, content: "⚠️ **Session Conflict**: Active session exists." });
        const embed = new EmbedBuilder().setTitle("Bedrock Connection").setDescription("Start bot?").setColor("#2ECC71");
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("confirm_start_bedrock").setLabel("Start").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
        );
        return i.reply({ embeds: [embed], components: [row], ephemeral: true }).catch(() => {});
      }

      if (i.customId === "start_java") {
        if (sessions.has(uid)) return safeReply(i, { ephemeral: true, content: "⚠️ **Session Conflict**: Active session exists." });
        const embed = new EmbedBuilder()
          .setTitle("⚙️ Java Compatibility Check")
          .setDescription("For a successful connection to a Java server, ensure the following plugins are installed.")
          .addFields({ name: "Required Plugins", value: "• GeyserMC\n• Floodgate" })
          .setColor("#E67E22");
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("confirm_start_java").setLabel("Confirm & Start").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
        );
        return i.reply({ embeds: [embed], components: [row], ephemeral: true }).catch(() => {});
      }

      if (i.customId === "confirm_start_bedrock" || i.customId === "confirm_start_java") {
        await i.deferUpdate().catch(() => {});
        return startSession(uid, i, false);
      }

      if (i.customId === "cancel") return i.update({ content: "❌ Cancelled.", embeds: [], components: [] }).catch(() => {});

      if (i.customId === "stop") {
        console.log(`[Button] Stop pressed by ${uid}`);
        const ok = await stopSession(uid, true);
        return safeReply(i, { ephemeral: true, content: ok ? "⏹ **Session Terminated.**" : "No active sessions." });
      }

      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true }).catch(() => {});
        return linkMicrosoft(uid, i);
      }

      if (i.customId === "unlink") {
        await unlinkMicrosoft(uid);
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

      // ORE SCANNER BUTTON
      if (i.customId === "scan_ores") {
        await i.deferReply({ ephemeral: true });
        
        const result = await scanForOres(uid, 8);
        
        if (result.error) {
          return i.editReply({ content: `❌ ${result.error}` });
        }
        
        if (result.ores.length === 0) {
          return i.editReply({ 
            content: `⛏️ Scanned ${result.chunksScanned} chunks. No ores found nearby.\nTip: Wait a bit for chunks to load, or move to a different area.` 
          });
        }
        
        const byType = {};
        result.ores.forEach(ore => {
          if (!byType[ore.type]) byType[ore.type] = [];
          byType[ore.type].push(ore);
        });
        
        let description = `Found **${result.totalFound}** ores in ${result.chunksScanned} chunks!\nShowing closest 20:\n\n`;
        
        Object.keys(byType).forEach(type => {
          const ores = byType[type];
          const emoji = type.includes('diamond') ? '💎' : 
                       type.includes('emerald') ? '✳️' :
                       type.includes('gold') ? '🥇' :
                       type.includes('iron') ? '⛓️' :
                       type.includes('redstone') ? '🔴' :
                       type.includes('lapis') ? '🔵' :
                       type.includes('coal') ? '⚫' :
                       type.includes('copper') ? '🟫' :
                       type.includes('ancient') ? '🏺' : '⛏️';
          
          description += `${emoji} **${type.replace(/_/g, ' ')}** (${ores.length} found):\n`;
          ores.slice(0, 5).forEach(ore => {
            description += `   \`${ore.x}, ${ore.y}, ${ore.z}\` (${Math.round(ore.distance)}m)\n`;
          });
          if (ores.length > 5) description += `   ... and ${ores.length - 5} more\n`;
          description += '\n';
        });
        
        const embed = new EmbedBuilder()
          .setTitle("⛏️ Ore Scanner Results")
          .setDescription(description)
          .setColor("#FFD700")
          .setFooter({ text: `Player pos: ${Math.round(result.playerPos.x)}, ${Math.round(result.playerPos.y)}, ${Math.round(result.playerPos.z)}` })
          .setTimestamp();
        
        return i.editReply({ embeds: [embed] });
      }

      // BED FINDER BUTTON
      if (i.customId === "scan_beds") {
        await i.deferReply({ ephemeral: true });
        const s = sessions.get(uid);
        
        if (!s || !s.connected) {
          return i.editReply({ content: "❌ Bot not connected" });
        }
        
        if (!advancedFeaturesEnabled || !s.chunks) {
          return i.editReply({ content: "❌ Advanced features not available" });
        }
        
        const beds = [];
        const playerPos = s.position ? s.position.floored() : { x: 0, y: 64, z: 0 };
        
        for (const [key, chunk] of s.chunks) {
          for (let x = 0; x < 16; x++) {
            for (let z = 0; z < 16; z++) {
              for (let y = -64; y < 320; y++) {
                try {
                  const block = chunk.getBlock({ x, y, z });
                  if (block && block.name && block.name.includes('bed')) {
                    const [cx, cz] = key.split(',').map(Number);
                    const wx = cx * 16 + x;
                    const wz = cz * 16 + z;
                    const dist = Math.sqrt(Math.pow(wx - playerPos.x, 2) + Math.pow(wz - playerPos.z, 2));
                    beds.push({ x: wx, y, z: wz, distance: dist });
                  }
                } catch (e) {}
              }
            }
          }
        }
        
        beds.sort((a, b) => a.distance - b.distance);
        
        if (beds.length === 0) {
          return i.editReply({ content: "🛏️ No beds found in loaded chunks." });
        }
        
        let desc = `Found **${beds.length}** beds:\n\n`;
        beds.slice(0, 10).forEach(bed => {
          desc += `🛏️ \`${bed.x}, ${bed.y}, ${bed.z}\` (${Math.round(bed.distance)}m away)\n`;
        });
        
        const embed = new EmbedBuilder()
          .setTitle("🛏️ Nearby Beds")
          .setDescription(desc)
          .setColor("#FF69B4");
        
        return i.editReply({ embeds: [embed] });
      }
    }

    if (i.isStringSelectMenu()) {
      if (i.customId === "admin_force_stop_select") {
        const targetUid = i.values[0];
        const ok = await stopSession(targetUid, true);
        await i.reply({ ephemeral: true, content: ok ? `🛑 Stopped bot for user ${targetUid}.` : "No active session found for that user." });
        if (lastAdminMessage) {
          try {
            await lastAdminMessage.edit({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() });
          } catch (e) {}
        }
        return;
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

// Message listener
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
    } catch (e) {
      console.error("Could not react to message. Is the emoji on the server?", e.message);
    }
  }
});

process.on("unhandledRejection", (e) => console.error("Unhandled Rejection:", e));
client.login(DISCORD_TOKEN);
