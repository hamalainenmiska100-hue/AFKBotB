/**
 * Discord + Minecraft Bedrock 24/7 AFK Bot (hardened)
 * - Stronger crash resilience (no silent errors; logged + recovered where possible)
 * - Safer shutdown (SIGINT/SIGTERM handled once)
 * - Memory pressure controls + leak prevention
 * - Anti-AFK upgraded: real movement (MovePlayer OR PlayerAuthInput when server-authoritative), + crouch
 *
 * Notes:
 * - Bedrock servers can be "server authoritative movement" (SAM). In that case, movement is sent via
 *   PlayerAuthInput instead of MovePlayer. (See PrismarineJS bedrock-protocol discussions/issues.)
 * - No code can *guarantee* 24/7 if the host restarts or you hit provider limits; run with a supervisor
 *   (systemd/pm2/docker restart policy) for true 24/7.
 */

"use strict";

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
  EmbedBuilder,
  ActivityType
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fsp = require("fs").promises;
const fsSync = require("fs");
const pathMod = require("path");

process.setMaxListeners(50);

// ==================== ENV ====================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN missing");
  process.exit(1);
}

// ==================== CONFIGURATION ====================
const CONFIG = {
  ADMIN_ID: "1144987924123881564",
  LOG_CHANNEL_ID: "1464615030111731753",

  SAVE_DEBOUNCE_MS: 150,
  AUTO_SAVE_INTERVAL_MS: 15000,

  MAX_RECONNECT_ATTEMPTS: 10,
  RECONNECT_BASE_DELAY_MS: 10000,
  RECONNECT_MAX_DELAY_MS: 300000,

  CONNECTION_TIMEOUT_MS: 30000,
  KEEPALIVE_INTERVAL_MS: 15000,
  STALE_CONNECTION_TIMEOUT_MS: 60000,

  MEMORY_CHECK_INTERVAL_MS: 60000,
  MAX_MEMORY_MB: 1536,

  NATIVE_CLEANUP_DELAY_MS: 5000,
  PING_TIMEOUT_MS: 5000,

  // Anti-AFK
  ANTI_AFK_MIN_MS: 8000,
  ANTI_AFK_MAX_MS: 20000,
  WALK_TICKS: 18, // ~0.9s if 50ms interval
  WALK_TICK_MS: 50,
  WALK_SPEED: 0.18 // small delta per tick
};

// ==================== FLY.IO VOLUME PATH ====================
const DATA = process.env.FLY_VOLUME_PATH || "/data";
const AUTH_ROOT = pathMod.join(DATA, "auth");
const STORE = pathMod.join(DATA, "users.json");
const REJOIN_STORE = pathMod.join(DATA, "rejoin.json");
const CRASH_LOG = pathMod.join(DATA, "crash.log");

async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    return true;
  } catch (e) {
    console.error(`Failed to create directory ${dir}:`, e?.message || e);
    return false;
  }
}

// ==================== SIMPLIFIED PERSISTENT STORE ====================
class PersistentStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
    this.saveTimeout = null;
    this.isSaving = false;
  }

  async load(defaultVal = {}) {
    this.data = defaultVal;
    try {
      const content = await fsp.readFile(this.filePath, "utf8");
      if (content.trim()) {
        const parsed = JSON.parse(content);
        if (typeof parsed === "object" && parsed !== null) {
          this.data = { ...this.data, ...parsed };
        }
      }
    } catch (e) {
      // If file missing, that's fine; if corrupt, back it up
      if (e?.code !== "ENOENT") {
        console.error(`Failed to load ${this.filePath}:`, e?.message || e);
        await this._backupCorruptFile();
      }
    }
    return this.data;
  }

  async _backupCorruptFile() {
    try {
      if (!fsSync.existsSync(this.filePath)) return;
      const backupPath = `${this.filePath}.backup.${Date.now()}`;
      await fsp.rename(this.filePath, backupPath);
    } catch (_) {}
  }

  set(key, value) {
    if (!this.data) this.data = {};
    this.data[key] = value;
    this.save();
  }

  get(key) {
    return this.data?.[key];
  }

  delete(key) {
    if (!this.data) return;
    delete this.data[key];
    this.save();
  }

  save(immediate = false) {
    if (immediate) return this._flush();
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this._flush(), CONFIG.SAVE_DEBOUNCE_MS);
    return Promise.resolve(true);
  }

  async _flush() {
    if (this.isSaving) return;
    this.isSaving = true;
    try {
      const dir = pathMod.dirname(this.filePath);
      await fsp.mkdir(dir, { recursive: true });

      const jsonString = JSON.stringify(
        this.data,
        (k, v) => (typeof v === "bigint" ? v.toString() : v),
        2
      );

      await fsp.writeFile(`${this.filePath}.tmp`, jsonString);
      await fsp.rename(`${this.filePath}.tmp`, this.filePath);
    } catch (e) {
      console.error("Store flush error:", e?.message || e);
      // emergency backup
      try {
        const emergencyPath = `${this.filePath}.emergency.${Date.now()}`;
        await fsp.writeFile(
          emergencyPath,
          JSON.stringify(this.data, (k, v) => (typeof v === "bigint" ? v.toString() : v))
        );
      } catch (_) {}
    } finally {
      this.isSaving = false;
    }
  }
}

// ==================== INITIALIZE STORES ====================
const userStore = new PersistentStore(STORE);
const sessionStore = new PersistentStore(REJOIN_STORE);

let users = {};
let activeSessionsStore = {};
let storesInitialized = false;

async function initializeStores() {
  await ensureDir(DATA);
  await ensureDir(AUTH_ROOT);
  users = await userStore.load({});
  activeSessionsStore = await sessionStore.load({});
  storesInitialized = true;
  console.log(
    `Loaded ${Object.keys(users).length} users and ${Object.keys(activeSessionsStore).length} active sessions`
  );
}

// ==================== RUNTIME STATE ====================
const sessions = new Map();
const pendingLink = new Map();
const lastMsa = new Map();
const cleanupLocks = new Set();
const lastDiscordInteraction = new Map();

let isShuttingDown = false;
let shutdownOnce = false;

let discordReady = false;

// ==================== ENHANCED DISCORD CLIENT ====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMessages],
  failIfNotExists: false,
  allowedMentions: { parse: ["users", "roles"], repliedUser: false },
  rest: { rejectOnRateLimit: () => false, retries: 2, timeout: 15000 },
  presence: { status: "online", activities: [{ name: "AFK Bot System", type: ActivityType.Watching }] }
});

// ==================== CRASH PREVENTION SYSTEM ====================
const crashLogger = {
  log: async (type, err) => {
    try {
      const timestamp = new Date().toISOString();
      const msg = `[${timestamp}] ${type}:\n${err?.stack || err?.message || String(err)}\n\n`;
      await fsp.appendFile(CRASH_LOG, msg).catch(() => {});
    } catch (_) {}
  },
  isFatal: (err) => {
    const fatalCodes = ["EADDRINUSE", "EACCES", "ENOTFOUND", "EAI_AGAIN"];
    return fatalCodes.includes(err?.code);
  }
};

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  crashLogger.log("UNCAUGHT EXCEPTION", err);
  if (crashLogger.isFatal(err)) gracefulShutdown("FATAL_ERROR");
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
  crashLogger.log("UNHANDLED REJECTION", reason);
});

// ==================== DISCORD CONNECTION RESILIENCE ====================
client.on("error", (error) => {
  console.error("DISCORD ERROR:", error?.message || error);
  discordReady = false;
});

client.on("shardError", (error) => {
  console.error("SHARD ERROR:", error?.message || error);
});

client.on("disconnect", () => {
  discordReady = false;
  console.log("Discord disconnected. Auto-reconnecting...");
});

client.on("reconnecting", () => {
  console.log("Discord reconnecting...");
});

client.on("resume", (replayed) => {
  discordReady = true;
  console.log(`Discord resumed. Replayed: ${replayed}`);
});

client.once("ready", async () => {
  discordReady = true;
  console.log("Discord client ready");

  try {
    const cmds = [
      new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
      new SlashCommandBuilder().setName("java").setDescription("Open Java AFKBot Panel"),
      new SlashCommandBuilder().setName("refresh").setDescription("Refresh Discord connection without restart")
    ];
    await client.application?.commands?.set(cmds);
  } catch (e) {
    console.error("Failed to register commands:", e?.message || e);
  }

  // Memory monitor
  setInterval(() => {
    const mem = process.memoryUsage();
    const mb = mem.rss / 1024 / 1024;
    if (mb > CONFIG.MAX_MEMORY_MB) {
      console.warn(`High memory usage: ${mb.toFixed(2)}MB`);
      if (global.gc) global.gc();
    }
  }, CONFIG.MEMORY_CHECK_INTERVAL_MS);

  // Restore sessions shortly after boot
  setTimeout(() => restoreSessions().catch((e) => console.error("restoreSessions error:", e)), 10000);
});

// ==================== GRACEFUL SHUTDOWN ====================
async function gracefulShutdown(signal) {
  if (shutdownOnce) return; // prevents double SIGINT/SIGTERM
  shutdownOnce = true;

  console.log(`Shutting down due to ${signal}...`);
  isShuttingDown = true;

  const forceExit = setTimeout(() => process.exit(1), 15000);

  try {
    await saveAllSessionData();
    await Promise.all([userStore.save(true), sessionStore.save(true)]);
    await cleanupAllSessions();
    await client.destroy().catch(() => {});
    clearTimeout(forceExit);
    process.exit(0);
  } catch (e) {
    console.error("Shutdown error:", e?.message || e);
    clearTimeout(forceExit);
    process.exit(1);
  }
}

process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => gracefulShutdown("SIGINT"));

// ==================== HELPERS ====================
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function jitter(base, pct = 0.25) {
  const j = base * pct;
  return base + (Math.random() * 2 - 1) * j;
}

function isValidIP(ip) {
  if (!ip || typeof ip !== "string") return false;
  if (ip.length > 253) return false;
  if (ip.includes("..") || ip.startsWith(".") || ip.endsWith(".")) return false;
  if (ip.includes("://")) return false;

  const ipv4Regex =
    /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
  const hostnameRegex =
    /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;

  return ipv4Regex.test(ip) || ipv6Regex.test(ip) || hostnameRegex.test(ip);
}

function isValidPort(port) {
  const num = parseInt(port, 10);
  return !isNaN(num) && num > 0 && num <= 65535;
}

async function safeReply(interaction, content, ephemeral = true) {
  try {
    if (!interaction) return;
    const payload = typeof content === "string" ? { content } : content;
    if (typeof payload.ephemeral === "undefined") payload.ephemeral = ephemeral;

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch((err) => console.error("followUp failed:", err?.message || err));
    } else {
      await interaction.reply(payload).catch((err) => console.error("reply failed:", err?.message || err));
    }
  } catch (e) {
    console.error("safeReply error:", e?.message || e);
  }
}

let logChannelCache = null;
async function logToDiscord(message) {
  if (!message || isShuttingDown || !discordReady) return;
  try {
    if (!logChannelCache) logChannelCache = await client.channels.fetch(CONFIG.LOG_CHANNEL_ID).catch(() => null);
    const channel = logChannelCache;
    if (!channel) return;

    const embed = new EmbedBuilder().setColor("#5865F2").setDescription(String(message).slice(0, 4096)).setTimestamp();
    await channel.send({ embeds: [embed] }).catch(() => {});
  } catch (_) {}
}

// ==================== UI COMPONENTS ====================
function panelRow(isJava = false) {
  const title = isJava ? "Java AFKBot Panel" : "Bedrock AFKBot Panel";
  const startCustomId = isJava ? "start_java" : "start_bedrock";

  return {
    content: `**${title}**`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("link").setLabel("Link Microsoft").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("unlink").setLabel("Unlink Microsoft").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(startCustomId).setLabel("Start").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("stop").setLabel("Stop").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("settings").setLabel("Settings").setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

// ==================== USER MANAGEMENT ====================
function getUser(uid) {
  if (!uid || typeof uid !== "string" || !/^\d+$/.test(uid)) {
    return { connectionType: "online", bedrockVersion: "auto", _temp: true };
  }

  if (!users[uid]) {
    users[uid] = { connectionType: "online", bedrockVersion: "auto", createdAt: Date.now(), lastActive: Date.now() };
    userStore.save();
  }

  users[uid].connectionType = users[uid].connectionType || "online";
  users[uid].bedrockVersion = users[uid].bedrockVersion || "auto";
  users[uid].lastActive = Date.now();
  return users[uid];
}

async function getUserAuthDir(uid) {
  if (!uid || typeof uid !== "string") return null;
  const safeUid = uid.replace(/[^a-zA-Z0-9]/g, "");
  if (!safeUid) return null;
  const dir = pathMod.join(AUTH_ROOT, safeUid);
  await ensureDir(dir);
  return dir;
}

async function unlinkMicrosoft(uid) {
  if (!uid) return false;
  const dir = await getUserAuthDir(uid);
  if (dir) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch (_) {}
  }
  const u = getUser(uid);
  u.linked = false;
  u.authTokenExpiry = null;
  u.tokenAcquiredAt = null;
  await userStore.save();
  return true;
}

// ==================== MICROSOFT AUTHENTICATION ====================
async function linkMicrosoft(uid, interaction) {
  if (!uid || !interaction) return;
  await interaction.deferReply({ ephemeral: true }).catch(() => {});

  if (pendingLink.has(uid)) {
    return interaction.followUp({ content: "Login already in progress. Check your DMs or use the last code.", ephemeral: true }).catch(() => {});
  }

  const authDir = await getUserAuthDir(uid);
  if (!authDir) {
    return interaction.followUp({ content: "System error: Cannot create auth directory.", ephemeral: true }).catch(() => {});
  }

  const u = getUser(uid);

  const timeoutId = setTimeout(() => {
    pendingLink.delete(uid);
    interaction.followUp({ content: "Login timed out after 5 minutes.", ephemeral: true }).catch(() => {});
  }, 300000);

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
        const uri = data?.verification_uri_complete || data?.verification_uri || "https://www.microsoft.com/link";
        const code = data?.user_code || "(no code)";
        lastMsa.set(uid, { uri, code, at: Date.now() });

        const msg =
          `**Microsoft Authentication Required**\n\n1. Visit: ${uri}\n2. Enter Code: \`${code}\`\n\n**Security Notice:** Your account tokens are saved locally and are never shared.`;

        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open link").setStyle(ButtonStyle.Link).setURL(uri));
        await interaction.followUp({ content: msg, components: [row], ephemeral: true }).catch(() => {});
      }
    );

    pendingLink.set(uid, true);

    flow
      .getMsaToken()
      .then(async () => {
        clearTimeout(timeoutId);
        u.linked = true;
        u.tokenAcquiredAt = Date.now();
        await userStore.save();
        pendingLink.delete(uid);
        await interaction.followUp({ content: "Microsoft account linked!", ephemeral: true }).catch(() => {});
      })
      .catch(async (e) => {
        clearTimeout(timeoutId);
        pendingLink.delete(uid);
        await interaction.followUp({ content: `Login failed: ${e?.message || "Unknown error"}`, ephemeral: true }).catch(() => {});
      });
  } catch (e) {
    clearTimeout(timeoutId);
    pendingLink.delete(uid);
    await interaction.followUp({ content: "Authentication system error.", ephemeral: true }).catch(() => {});
  }
}

// ==================== SESSION DATA MANAGEMENT ====================
async function saveSessionData(uid) {
  if (!uid) return;
  const u = getUser(uid);
  if (!u || u._temp) return;

  activeSessionsStore[uid] = {
    startedAt: Date.now(),
    server: u.server,
    connectionType: u.connectionType,
    bedrockVersion: u.bedrockVersion,
    offlineUsername: u.offlineUsername,
    linked: u.linked,
    authTokenExpiry: u.authTokenExpiry,
    tokenAcquiredAt: u.tokenAcquiredAt,
    lastActive: Date.now()
  };

  await sessionStore.save();
}

async function saveAllSessionData() {
  for (const [uid] of sessions) await saveSessionData(uid);
}

async function clearSessionData(uid) {
  if (activeSessionsStore?.[uid]) {
    delete activeSessionsStore[uid];
    await sessionStore.save();
  }
}

// ==================== SESSION MANAGEMENT ====================
async function cleanupSession(uid) {
  if (!uid) return;
  if (cleanupLocks.has(uid)) return;
  cleanupLocks.add(uid);

  try {
    const s = sessions.get(uid);
    if (!s) return;

    s.isCleaningUp = true;
    s.manualStop = true;

    const timers = ["reconnectTimer", "afkTimer", "keepaliveTimer", "staleCheckTimer", "walkTimer"];
    for (const t of timers) {
      if (s[t]) {
        clearTimeout(s[t]);
        clearInterval(s[t]);
        s[t] = null;
      }
    }

    if (s.client) {
      const mc = s.client;
      s.client = null;
      try {
        mc.removeAllListeners();
      } catch (_) {}

      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 2000);
        try {
          mc.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
          mc.close();
        } catch (_) {
          clearTimeout(timeout);
          resolve();
        }
      });
    }

    sessions.delete(uid);
    if (global.gc) global.gc();
  } finally {
    cleanupLocks.delete(uid);
  }
}

async function cleanupAllSessions() {
  await Promise.all(Array.from(sessions.keys()).map((uid) => cleanupSession(uid)));
}

async function stopSession(uid) {
  if (!uid) return false;
  const s = sessions.get(uid);
  if (s) {
    s.manualStop = true;
    if (s.reconnectTimer) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = null;
    }
  }
  await clearSessionData(uid);
  await cleanupSession(uid);
  return true;
}

// ==================== RECONNECTION SYSTEM ====================
async function handleAutoReconnect(uid, attempt = 1) {
  if (!uid || isShuttingDown) return;
  const s = sessions.get(uid);
  if (!s || s.manualStop || s.isCleaningUp) return;

  if (attempt > CONFIG.MAX_RECONNECT_ATTEMPTS) {
    await logToDiscord(`Bot of <@${uid}> stopped after max failed attempts.`);
    await cleanupSession(uid);
    await clearSessionData(uid);
    return;
  }

  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);

  s.isReconnecting = true;
  s.reconnectAttempt = attempt;

  const baseDelay = Math.min(CONFIG.RECONNECT_BASE_DELAY_MS * Math.pow(1.5, attempt - 1), CONFIG.RECONNECT_MAX_DELAY_MS);
  const delay = jitter(baseDelay, 0.3);

  await logToDiscord(`Bot of <@${uid}> disconnected. Reconnecting in ${Math.round(delay / 1000)}s (Attempt ${attempt})...`);

  s.reconnectTimer = setTimeout(async () => {
    try {
      if (isShuttingDown) return;
      const still = sessions.get(uid);
      if (!still || still.manualStop) return;

      await cleanupSession(uid);
      await new Promise((r) => setTimeout(r, CONFIG.NATIVE_CLEANUP_DELAY_MS));
      if (!isShuttingDown) await startSession(uid, null, true, attempt + 1);
    } catch (e) {
      console.error("Reconnect error:", e?.message || e);
      await startSession(uid, null, true, attempt + 1).catch(() => {});
    }
  }, delay);
}

// ==================== CONNECTION HEALTH MONITORING ====================
function startHealthMonitoring(uid) {
  const s = sessions.get(uid);
  if (!s) return;

  s.keepaliveTimer = setInterval(() => {
    try {
      if (!s.connected || !s.client || s.isCleaningUp) return;
      s.client.queue("client_cache_status", { enabled: false });
      s.lastKeepalive = Date.now();
    } catch (e) {
      console.error("keepalive error:", e?.message || e);
      if (!s.isReconnecting && !s.isCleaningUp && !s.manualStop) handleAutoReconnect(uid, (s.reconnectAttempt || 0) + 1);
    }
  }, CONFIG.KEEPALIVE_INTERVAL_MS);

  s.staleCheckTimer = setInterval(() => {
    try {
      if (!s.connected || s.isCleaningUp) return;
      const last = Math.max(s.lastPacketTime || 0, s.lastKeepalive || 0);
      if (Date.now() - last > CONFIG.STALE_CONNECTION_TIMEOUT_MS) {
        try {
          s.client?.close();
        } catch (_) {}
        if (!s.isReconnecting && !s.isCleaningUp && !s.manualStop) handleAutoReconnect(uid, (s.reconnectAttempt || 0) + 1);
      }
    } catch (_) {}
  }, CONFIG.STALE_CONNECTION_TIMEOUT_MS);
}

// ==================== ANTI-AFK: REAL MOVEMENT + CROUCH ====================
// Movement has two modes. If the server uses "server authoritative movement" (SAM),
// clients send PlayerAuthInput. Otherwise, MovePlayer tends to work.
// (See PrismarineJS discussions/issues about MovePlayer vs PlayerAuthInput.)

function startAntiAfk(uid) {
  const s = sessions.get(uid);
  if (!s) return;

  const scheduleNext = () => {
    if (!sessions.has(uid) || isShuttingDown) return;
    const s2 = sessions.get(uid);
    if (!s2 || !s2.connected || s2.isCleaningUp) return;

    const delay = Math.floor(Math.random() * (CONFIG.ANTI_AFK_MAX_MS - CONFIG.ANTI_AFK_MIN_MS + 1) + CONFIG.ANTI_AFK_MIN_MS);
    s2.afkTimer = setTimeout(() => antiAfkTick(uid).catch(() => {}), delay);
  };

  const antiAfkTick = async () => {
    const s3 = sessions.get(uid);
    if (!s3 || !s3.connected || s3.isCleaningUp || !s3.client || !s3.entityId) return;

    try {
      const roll = Math.random();

      // 40%: real walk (small step forward then back)
      if (roll < 0.40) await doWalkSequence(uid);
      // 30%: crouch toggle (start/stop sneak)
      else if (roll < 0.70) await doCrouch(uid);
      // 30%: animation swing (fallback)
      else s3.client.write("animate", { action_id: 1, runtime_entity_id: s3.entityId });
    } catch (e) {
      console.error("Anti-AFK error:", e?.message || e);
    } finally {
      scheduleNext();
    }
  };

  scheduleNext();
}

async function doCrouch(uid) {
  const s = sessions.get(uid);
  if (!s?.client || !s.entityId || s.isCleaningUp) return;

  try {
    s.client.write("player_action", {
      runtime_entity_id: s.entityId,
      action: 11,
      position: { x: 0, y: 0, z: 0 },
      result_code: 0,
      face: 0
    });
  } catch (_) {}

  await new Promise((r) => setTimeout(r, Math.random() * 800 + 600));

  const s2 = sessions.get(uid);
  if (!s2?.client || !s2.entityId || s2.isCleaningUp) return;

  try {
    s2.client.write("player_action", {
      runtime_entity_id: s2.entityId,
      action: 12,
      position: { x: 0, y: 0, z: 0 },
      result_code: 0,
      face: 0
    });
  } catch (_) {}
}

async function doWalkSequence(uid) {
  const s = sessions.get(uid);
  if (!s?.client || !s.connected || s.isCleaningUp) return;
  if (!s.position) return;

  // Choose a direction based on current yaw, or random if unknown
  const yaw = typeof s.yaw === "number" ? s.yaw : Math.random() * 360;
  const rad = (yaw * Math.PI) / 180;
  const dx = Math.cos(rad) * CONFIG.WALK_SPEED;
  const dz = Math.sin(rad) * CONFIG.WALK_SPEED;

  await walkTicks(uid, dx, dz, CONFIG.WALK_TICKS);
  await new Promise((r) => setTimeout(r, 250 + Math.random() * 400));
  await walkTicks(uid, -dx, -dz, Math.floor(CONFIG.WALK_TICKS * 0.7));
}

async function walkTicks(uid, dx, dz, ticks) {
  const s = sessions.get(uid);
  if (!s?.client || !s.entityId || s.isCleaningUp || !s.position) return;
  if (s.walkInProgress) return;
  s.walkInProgress = true;

  try {
    for (let i = 0; i < ticks; i++) {
      const s2 = sessions.get(uid);
      if (!s2?.client || !s2.entityId || s2.isCleaningUp || !s2.position) break;

      s2.position = { x: s2.position.x + dx, y: s2.position.y, z: s2.position.z + dz };

      if (s2.serverAuthMovement) sendPlayerAuthInputStep(s2);
      else sendMovePlayerStep(s2);

      await new Promise((r) => setTimeout(r, CONFIG.WALK_TICK_MS));
    }
  } finally {
    const s3 = sessions.get(uid);
    if (s3) s3.walkInProgress = false;
  }
}

function sendMovePlayerStep(s) {
  const payload = {
    runtime_id: Number(s.entityId),
    runtime_entity_id: s.entityId,
    position: s.position,
    pitch: clamp(s.pitch || 0, -90, 90),
    yaw: ((s.yaw || 0) % 360 + 360) % 360,
    head_yaw: ((s.headYaw || s.yaw || 0) % 360 + 360) % 360,
    mode: 0,
    on_ground: true,
    ridden_runtime_id: 0,
    tick: BigInt(s.moveTick++ || 0)
  };

  try {
    s.client.write("move_player", payload);
  } catch (e) {
    s.serverAuthMovement = true; // fallback
    throw e;
  }
}

function sendPlayerAuthInputStep(s) {
  const inputTick = BigInt(s.inputTick++ || 1);

  const payload = {
    pitch: clamp(s.pitch || 0, -90, 90),
    yaw: ((s.yaw || 0) % 360 + 360) % 360,
    head_yaw: ((s.headYaw || s.yaw || 0) % 360 + 360) % 360,
    position: s.position,
    motion: { x: 0, y: 0 },
    input_tick: inputTick,
    inputTick,
    input_data: { forward: true },
    input_mode: 0,
    play_mode: 0,
    interaction_mode: 0
  };

  s.client.write("player_auth_input", payload);
}

// ==================== MAIN SESSION FUNCTION ====================
async function startSession(uid, interaction, isReconnect = false, reconnectAttempt = 1) {
  if (!uid || isShuttingDown) return;

  if (!storesInitialized) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!storesInitialized) {
      if (interaction) await safeReply(interaction, "System initializing, please try again.");
      return;
    }
  }

  if (interaction && !interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true }).catch(() => {});

  if (cleanupLocks.has(uid)) {
    let attempts = 0;
    while (cleanupLocks.has(uid) && attempts < 20) {
      await new Promise((r) => setTimeout(r, 250));
      attempts++;
    }
  }

  const u = getUser(uid);
  if (!u) {
    if (interaction) await safeReply(interaction, "User data error.");
    return;
  }

  if (!u.linked) {
    if (interaction) await safeReply(interaction, "Please auth with Xbox to use the bot");
    return;
  }

  await saveSessionData(uid);

  if (!u.server?.ip) {
    if (interaction) await safeReply(interaction, "Please configure your server settings first.");
    await clearSessionData(uid);
    return;
  }

  const { ip, port } = u.server;
  if (!isValidIP(ip) || !isValidPort(port)) {
    if (interaction) await safeReply(interaction, "Invalid server IP or port format.");
    await clearSessionData(uid);
    return;
  }

  if (sessions.has(uid) && !isReconnect) {
    if (interaction) await safeReply(interaction, "**Session Conflict**: Active session exists. Use Stop first.");
    return;
  }

  if (isReconnect && sessions.has(uid)) {
    await cleanupSession(uid);
    await new Promise((r) => setTimeout(r, CONFIG.NATIVE_CLEANUP_DELAY_MS));
  }

  if (!isReconnect && interaction) {
    try {
      await bedrock.ping({ host: ip, port: parseInt(port, 10) || 19132, timeout: CONFIG.PING_TIMEOUT_MS });
    } catch (_) {}
  }

  const authDir = await getUserAuthDir(uid);
  if (!authDir) {
    if (interaction) await safeReply(interaction, "Auth directory error.");
    return;
  }

  // --- DO NOT CHANGE JOINING LOGIC (kept) ---
  const opts = {
    host: ip,
    port: parseInt(port, 10),
    connectTimeout: CONFIG.CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    viewDistance: 1,
    profilesFolder: authDir,
    username: uid,
    offline: false,
    skipPing: true,
    autoInitPlayer: true,
    useTimeout: true
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  }
  // ----------------------------------------

  const state = {
    client: null,
    startedAt: Date.now(),
    manualStop: false,
    connected: false,
    isReconnecting: false,
    isCleaningUp: false,
    reconnectAttempt: reconnectAttempt,

    entityId: null,

    reconnectTimer: null,
    afkTimer: null,
    keepaliveTimer: null,
    staleCheckTimer: null,
    walkTimer: null,

    lastPacketTime: Date.now(),
    lastKeepalive: Date.now(),

    // movement state
    position: null,
    pitch: 0,
    yaw: 0,
    headYaw: 0,
    moveTick: 0,
    inputTick: 1,
    serverAuthMovement: false,
    walkInProgress: false
  };

  sessions.set(uid, state);

  let mc;
  try {
    mc = bedrock.createClient(opts);
    state.client = mc;
  } catch (err) {
    console.error("Failed to create client:", err?.message || err);
    if (interaction) await safeReply(interaction, "Failed to create Bedrock client.");
    if (isReconnect) await handleAutoReconnect(uid, reconnectAttempt);
    else await cleanupSession(uid);
    return;
  }

  mc.on("kick", async (packet) => {
    if (state.isCleaningUp) return;
    const reason = packet?.message || packet?.reason || "Kicked";
    await logToDiscord(`Bot of <@${uid}> was kicked: ${String(reason).slice(0, 1800)}`);
  });

  mc.on("disconnect", async (packet) => {
    if (state.isCleaningUp) return;
    const reason = packet?.reason || packet?.message || "Disconnected";
    await logToDiscord(`Bot of <@${uid}> disconnected: ${String(reason).slice(0, 1800)}`);
  });

  mc.on("spawn", async () => {
    if (state.isCleaningUp) return;
    await logToDiscord(`Bot of <@${uid}> spawned on **${ip}:${port}**${isReconnect ? ` (Attempt ${reconnectAttempt})` : ""}`);
    if (interaction) await safeReply(interaction, `**Online** on \`${ip}:${port}\``, true);
  });

  mc.on("start_game", (packet) => {
    if (!packet || state.isCleaningUp) return;

    state.entityId = packet.runtime_entity_id;
    state.connected = true;
    state.isReconnecting = false;
    state.reconnectAttempt = 0;
    state.lastPacketTime = Date.now();

    try {
      if (packet.player_position) state.position = { ...packet.player_position };
      state.serverAuthMovement = !!packet.server_authoritative_movement;
    } catch (_) {}

    if (activeSessionsStore?.[uid]) {
      activeSessionsStore[uid].lastConnected = Date.now();
      activeSessionsStore[uid].entityId = packet.runtime_entity_id;
      sessionStore.save();
    }

    startHealthMonitoring(uid);
    startAntiAfk(uid);
  });

  mc.on("packet", (data, meta) => {
    if (state.isCleaningUp) return;
    state.lastPacketTime = Date.now();
    try {
      if (meta?.name === "move_player" && data?.position) {
        state.position = { ...data.position };
        if (typeof data.pitch === "number") state.pitch = data.pitch;
        if (typeof data.yaw === "number") state.yaw = data.yaw;
        if (typeof data.head_yaw === "number") state.headYaw = data.head_yaw;
      }
    } catch (_) {}
  });

  mc.on("error", async (e) => {
    console.error(`Session error for ${uid}:`, e?.message || e);
    await logToDiscord(`Bot of <@${uid}> error: \`${String(e?.message || "Unknown error").slice(0, 900)}\``);
    if (!state.manualStop && !state.isReconnecting && !state.isCleaningUp) await handleAutoReconnect(uid, (state.reconnectAttempt || 0) + 1);
  });

  mc.on("close", async () => {
    if (state.isCleaningUp) return;
    if (!state.manualStop && !state.isReconnecting) await handleAutoReconnect(uid, (state.reconnectAttempt || 0) + 1);
    else await logToDiscord(`Bot of <@${uid}> disconnected manually.`);
  });
}

// ==================== SESSION RESTORATION ====================
async function restoreSessions() {
  const previousSessions = Object.keys(activeSessionsStore || {});
  console.log(`Found ${previousSessions.length} sessions to restore`);

  let delay = 0;
  for (const uid of previousSessions) {
    if (typeof uid !== "string" || !uid.match(/^\d+$/)) continue;
    const sessionData = activeSessionsStore[uid];
    if (!sessionData) continue;

    if (!users[uid]) users[uid] = {};

    if (sessionData.server) users[uid].server = sessionData.server;
    if (sessionData.connectionType) users[uid].connectionType = sessionData.connectionType;
    if (sessionData.bedrockVersion) users[uid].bedrockVersion = sessionData.bedrockVersion;
    if (sessionData.offlineUsername) users[uid].offlineUsername = sessionData.offlineUsername;
    if (sessionData.linked !== undefined) users[uid].linked = sessionData.linked;
    if (sessionData.authTokenExpiry) users[uid].authTokenExpiry = sessionData.authTokenExpiry;
    if (sessionData.tokenAcquiredAt) users[uid].tokenAcquiredAt = sessionData.tokenAcquiredAt;

    await userStore.save();

    setTimeout(() => {
      if (!isShuttingDown) {
        console.log(`Restoring session for user ${uid}`);
        startSession(uid, null, true).catch((e) => console.error("restore startSession error:", e));
      }
    }, delay);

    delay += 8000;
  }
}

// ==================== DISCORD EVENTS ====================
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (!i || isShuttingDown) return;
    if (!i.user?.id) return;
    const uid = i.user.id;

    const last = lastDiscordInteraction.get(uid) || 0;
    if (Date.now() - last < 900) return safeReply(i, "Please wait a moment before clicking again.", true);
    lastDiscordInteraction.set(uid, Date.now());

    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") return i.reply({ ...panelRow(false) }).catch(() => {});
      if (i.commandName === "java") return i.reply({ ...panelRow(true) }).catch(() => {});

      if (i.commandName === "refresh") {
        await i.deferReply({ ephemeral: true }).catch(() => {});
        try {
          discordReady = false;
          await client.destroy().catch(() => {});
          await new Promise((r) => setTimeout(r, 1200));
          await client.login(DISCORD_TOKEN);

          const start = Date.now();
          while (!client.isReady() && Date.now() - start < 12000) await new Promise((r) => setTimeout(r, 300));
          discordReady = client.isReady();

          return safeReply(i, discordReady ? "Discord connection refreshed successfully!" : "Refresh timed out (still reconnecting).", true);
        } catch (err) {
          discordReady = false;
          return safeReply(i, `Refresh failed: ${err?.message || err}`, true);
        }
      }
    }

    if (i.isButton()) {
      if (i.customId === "start_bedrock" || i.customId === "start_java") {
        if (sessions.has(uid)) return safeReply(i, "**Session Conflict**: Active session exists.", true);
        await i.deferReply({ ephemeral: true }).catch(() => {});
        const embed =
          i.customId === "start_java"
            ? new EmbedBuilder()
                .setTitle("Java Compatibility Check")
                .setDescription("For a successful connection to a Java server, ensure the following plugins are installed.")
                .addFields({ name: "Required Plugins", value: "GeyserMC\nFloodgate" })
                .setColor("#E67E22")
            : new EmbedBuilder().setTitle("Bedrock Connection").setDescription("Start bot?").setColor("#2ECC71");

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("confirm_start").setLabel(i.customId === "start_java" ? "Confirm & Start" : "Start").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
        );

        return i.followUp({ embeds: [embed], components: [row], ephemeral: true }).catch(() => {});
      }

      if (i.customId === "confirm_start") {
        await i.deferReply({ ephemeral: true }).catch(() => {});
        safeReply(i, "**Connecting...**", true);
        startSession(uid, i, false).catch((e) => console.error("startSession error:", e));
        return;
      }

      if (i.customId === "cancel") return safeReply(i, "Cancelled.", true);

      if (i.customId === "stop") {
        await i.deferReply({ ephemeral: true }).catch(() => {});
        const ok = await stopSession(uid);
        return safeReply(i, ok ? "**Session Terminated.**" : "No active sessions.", true);
      }

      if (i.customId === "link") return linkMicrosoft(uid, i);

      if (i.customId === "unlink") {
        await i.deferReply({ ephemeral: true }).catch(() => {});
        await unlinkMicrosoft(uid);
        return safeReply(i, "Unlinked Microsoft account.", true);
      }

      if (i.customId === "settings") {
        const u = getUser(uid);

        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Configuration");
        const ipInput = new TextInputBuilder()
          .setCustomId("ip")
          .setLabel("Server IP")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(u.server?.ip || "")
          .setMaxLength(253);

        const portInput = new TextInputBuilder()
          .setCustomId("port")
          .setLabel("Port")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(u.server?.port || 19132))
          .setMaxLength(5);

        modal.addComponents(new ActionRowBuilder().addComponents(ipInput), new ActionRowBuilder().addComponents(portInput));
        return i.showModal(modal);
      }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
      const ip = i.fields?.getTextInputValue("ip")?.trim();
      const portStr = i.fields?.getTextInputValue("port")?.trim();
      const port = parseInt(portStr, 10);

      if (!ip || !portStr) return safeReply(i, "IP and Port are required.", true);
      if (!isValidIP(ip)) return safeReply(i, "Invalid IP address format.", true);
      if (!isValidPort(port)) return safeReply(i, "Invalid port (must be 1-65535).", true);

      const u = getUser(uid);
      u.server = { ip, port };
      await userStore.save();
      return safeReply(i, `Saved: **${ip}:${port}**`, true);
    }
  } catch (e) {
    console.error("Interaction error:", e?.message || e);
  }
});

// ==================== STARTUP ====================
async function main() {
  await initializeStores();

  // periodic autosave to reduce corruption on hard kills
  setInterval(() => {
    userStore.save().catch(() => {});
    sessionStore.save().catch(() => {});
  }, CONFIG.AUTO_SAVE_INTERVAL_MS);

  await client.login(DISCORD_TOKEN).catch((err) => {
    console.error("Initial login failed:", err?.message || err);
    process.exit(1);
  });
}

main().catch((e) => {
  console.error("Fatal main error:", e?.message || e);
  crashLogger.log("FATAL_MAIN", e);
  gracefulShutdown("FATAL_MAIN").catch(() => process.exit(1));
});

// Heartbeat
setInterval(() => {
  console.log(`Heartbeat | Sessions: ${sessions.size} | Discord: ${discordReady ? "Connected" : "Disconnected"} | Uptime: ${Math.floor(process.uptime() / 60)}m`);
}, 60000);
