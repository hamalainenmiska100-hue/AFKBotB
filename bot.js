/**
 * HYPER-IMMORTAL DISCORD BEDROCK BOT (FIXED + RAM FRIENDLY)
 * ========================================================
 * - Fixes "This interaction failed"
 * - Fixes button + modal flow issues
 * - Fixes anti-AFK timer memory leak
 * - Fixes infinite reconnect attempts
 * - Fixes sessionStore null-leak (rejoin.json growing forever)
 * - Keeps the same core features: multi-layer error handling, safe file IO,
 *   auto reconnection, low-end optimizations, graceful shutdown, session restore.
 *
 * IMPORTANT:
 * - Use a supported Node.js version for your discord.js version.
 * - Set env vars: DISCORD_TOKEN, (optional) WEBHOOK_URL, (optional) FLY_VOLUME_PATH
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
  ActivityType,
} = require("discord.js");

// ==================== SAFE MODULE LOADING ====================
let bedrock;
try {
  bedrock = require("bedrock-protocol");
  console.log("[Immortal] bedrock-protocol loaded successfully");
} catch (e) {
  console.error("[FATAL] Failed to load bedrock-protocol:", e);
  process.exit(1);
}

let Authflow, Titles;
try {
  const prismarineAuth = require("prismarine-auth");
  Authflow = prismarineAuth.Authflow;
  Titles = prismarineAuth.Titles;
  console.log("[Immortal] prismarine-auth loaded successfully");
} catch (e) {
  console.error("[FATAL] Failed to load prismarine-auth:", e);
  process.exit(1);
}

const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { URL } = require("url");

// ==================== CONFIGURATION ====================
// Optimized for low-end devices
const CONFIG = {
  // Admin settings
  ADMIN_ID: "1144987924123881564",
  LOG_CHANNEL_ID: "146461503011173173",

  // File I/O
  SAVE_DEBOUNCE_MS: 750,            // slightly higher debounce = fewer writes
  AUTO_SAVE_INTERVAL_MS: 60000,     // save less often

  // Connection settings
  MAX_RECONNECT_ATTEMPTS: 5,
  RECONNECT_BASE_DELAY_MS: 15000,
  RECONNECT_MAX_DELAY_MS: 300000,
  CONNECTION_TIMEOUT_MS: 20000,
  KEEPALIVE_INTERVAL_MS: 30000,
  STALE_CONNECTION_TIMEOUT_MS: 120000,

  // Memory settings
  MEMORY_CHECK_INTERVAL_MS: 120000,
  MAX_MEMORY_MB: 512,
  MEMORY_GC_THRESHOLD_MB: 400,

  // Session settings
  SESSION_HEARTBEAT_INTERVAL_MS: 60000,
  NATIVE_CLEANUP_DELAY_MS: 3000,
  OPERATION_TIMEOUT_MS: 15000,

  // Rate limiting
  INTERACTION_COOLDOWN_MS: 1500,
  MAX_CONCURRENT_SESSIONS: 5,

  // Error recovery
  MAX_ERRORS_PER_MINUTE: 20,
  ERROR_WINDOW_MS: 60000,

  // Cleanup
  CLEANUP_INTERVAL_MS: 300000,
};

// ==================== PATHS ====================
const DATA = process.env.FLY_VOLUME_PATH || "/data";
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");
const REJOIN_STORE = path.join(DATA, "rejoin.json");
const CRASH_LOG = path.join(DATA, "crash.log");

// ==================== RUNTIME STATE ====================
let client = null;

let isShuttingDown = false;
let shutdownInProgress = false;

const sessions = new Map();                 // uid -> session
const pendingLink = new Map();              // uid -> {startTime}
const lastMsa = new Map();                  // uid -> {uri, code, at}
const interactionCooldowns = new Map();     // uid -> lastTime
const cleanupLocks = new Set();             // uid -> bool
const pendingOperations = new Map();        // uid -> {time, type}

let discordReady = false;

// Error tracking (RAM friendly): keep only timestamps for the last minute
const errorTimes = [];
function trackError(context, error) {
  const now = Date.now();
  errorTimes.push(now);

  // Remove old
  const cutoff = now - CONFIG.ERROR_WINDOW_MS;
  while (errorTimes.length && errorTimes[0] < cutoff) errorTimes.shift();

  if (errorTimes.length > CONFIG.MAX_ERRORS_PER_MINUTE) {
    console.error(`[ERROR TRACKER] Too many errors (${errorTimes.length}) in last minute. Throttling context=${context}`);
    return false;
  }

  // Log minimal info
  const msg = error?.message || String(error);
  console.error(`[Error] ${context}: ${msg}`);
  return true;
}

// ==================== PROCESS-LEVEL CRASH PROTECTION ====================
let fatalErrorCount = 0;
const FATAL_ERROR_THRESHOLD = 10;
const FATAL_ERROR_RESET_MS = 60000;

setInterval(() => {
  if (fatalErrorCount > 0) {
    console.log(`[Immortal] Resetting fatal error count: ${fatalErrorCount} -> 0`);
    fatalErrorCount = 0;
  }
}, FATAL_ERROR_RESET_MS);

process.on("uncaughtException", (err, origin) => {
  fatalErrorCount++;
  console.error(`[FATAL ${fatalErrorCount}/${FATAL_ERROR_THRESHOLD}] Uncaught Exception from ${origin}:`, err);

  try {
    const logEntry =
      `[${new Date().toISOString()}] FATAL ERROR #${fatalErrorCount}\n` +
      `${err?.stack || err?.message || String(err)}\nOrigin: ${origin}\n\n`;
    // sync write is OK here (this is already a fatal path)
    fsSync.appendFileSync(CRASH_LOG, logEntry);
  } catch {}

  if (fatalErrorCount >= FATAL_ERROR_THRESHOLD) {
    console.error("[FATAL] Too many fatal errors, allowing shutdown...");
    process.exit(1);
  }

  console.log("[Immortal] Continuing despite fatal error...");
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[REJECTION] Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("warning", (warning) => {
  console.warn("[WARNING] Node.js warning:", warning.name, warning.message);
  if (warning.stack) console.warn(warning.stack);
});

process.on("SIGTERM", () => {
  console.log("[Immortal] SIGTERM received, graceful shutdown...");
  gracefulShutdown("SIGTERM");
});

process.on("SIGINT", () => {
  console.log("[Immortal] SIGINT received, graceful shutdown...");
  gracefulShutdown("SIGINT");
});

async function gracefulShutdown(signal) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  isShuttingDown = true;

  console.log(`[Immortal] Starting graceful shutdown due to ${signal}...`);

  const forceExit = setTimeout(() => {
    console.error("[Immortal] Force exit triggered");
    process.exit(0);
  }, 10000);

  try {
    await safeCleanupAllSessions();
    await safeSaveAllData();

    if (client) {
      await client.destroy().catch(() => {});
    }

    clearTimeout(forceExit);
    console.log("[Immortal] Graceful shutdown completed");
    process.exit(0);
  } catch (e) {
    console.error("[Immortal] Error during shutdown:", e);
    process.exit(1);
  }
}

// ==================== SAFE FILE OPERATIONS ====================
async function safeEnsureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
    return true;
  } catch (e) {
    console.error(`[File] Failed to create directory ${dir}:`, e?.message);
    return false;
  }
}

async function safeWriteFile(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    await safeEnsureDir(dir);

    const tempPath = `${filePath}.tmp.${Date.now()}`;
    await fs.writeFile(tempPath, data, "utf8");
    await fs.rename(tempPath, filePath);
    return true;
  } catch (e) {
    console.error(`[File] Failed to write ${filePath}:`, e?.message);
    return false;
  }
}

async function safeReadFile(filePath, defaultVal = null) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return defaultVal;
    console.error(`[File] Failed to read ${filePath}:`, e?.message);
    return defaultVal;
  }
}

async function safeParseJSON(filePath, defaultVal = {}) {
  try {
    const content = await safeReadFile(filePath, null);
    if (content === null) return defaultVal;

    const trimmed = String(content).trim();
    if (!trimmed) return defaultVal;

    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") return parsed;
    return defaultVal;
  } catch (e) {
    console.error(`[File] JSON parse error in ${filePath}:`, e?.message);
    try {
      const backupPath = `${filePath}.corrupted.${Date.now()}`;
      await fs.rename(filePath, backupPath).catch(() => {});
    } catch {}
    return defaultVal;
  }
}

// ==================== PERSISTENT STORE ====================
class ImmortalStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
    this.saveTimeout = null;
    this.isSaving = false;
  }

  async load(defaultVal = {}) {
    this.data = await safeParseJSON(this.filePath, defaultVal);
    console.log(`[Store] Loaded ${this.filePath}: ${Object.keys(this.data).length} entries`);
    return this.data;
  }

  get(key) {
    try {
      return this.data?.[key];
    } catch {
      return undefined;
    }
  }

  set(key, value) {
    try {
      if (!this.data) this.data = {};
      // RAM friendly clone: structuredClone if available, else minimal fallback
      const cloned = typeof structuredClone === "function" ? structuredClone(value) : deepClone(value);
      this.data[key] = cloned;
      this.debouncedSave();
    } catch (e) {
      console.error("[Store] Set error:", e?.message);
    }
  }

  delete(key) {
    try {
      if (!this.data) return;
      delete this.data[key];
      this.debouncedSave();
    } catch (e) {
      console.error("[Store] Delete error:", e?.message);
    }
  }

  debouncedSave() {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.flush().catch(() => {});
    }, CONFIG.SAVE_DEBOUNCE_MS);
  }

  async flush() {
    if (this.isSaving) return;
    if (!this.data) return;
    this.isSaving = true;

    try {
      // no indentation = smaller files + less memory
      const jsonString = JSON.stringify(
        this.data,
        (k, v) => {
          if (typeof v === "bigint") return v.toString();
          if (v === undefined) return null;
          return v;
        }
      );

      await safeWriteFile(this.filePath, jsonString);
    } catch (e) {
      console.error("[Store] Flush error:", e?.message);
    } finally {
      this.isSaving = false;
    }
  }
}

function deepClone(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (obj instanceof Date) return new Date(obj.getTime());
  if (Array.isArray(obj)) return obj.map(deepClone);
  const out = {};
  for (const k of Object.keys(obj)) out[k] = deepClone(obj[k]);
  return out;
}

// ==================== INITIALIZE STORES ====================
const userStore = new ImmortalStore(STORE);
const sessionStore = new ImmortalStore(REJOIN_STORE);

let users = {};
let activeSessionsStore = {};
let storesInitialized = false;

async function initializeStores() {
  await safeEnsureDir(DATA);
  await safeEnsureDir(AUTH_ROOT);

  users = await userStore.load({});
  activeSessionsStore = await sessionStore.load({});

  storesInitialized = true;
  console.log(`[Immortal] Loaded ${Object.keys(users).length} users and ${Object.keys(activeSessionsStore).length} active sessions`);
}

async function safeSaveAllData() {
  await Promise.allSettled([userStore.flush(), sessionStore.flush()]);
}

// ==================== WEBHOOK LOGGING ====================
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

function postJson(url, payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!url) return resolve(false);

    // Use fetch if available
    if (typeof fetch === "function") {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);

      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
        .then(() => resolve(true))
        .catch(() => resolve(false))
        .finally(() => clearTimeout(t));
      return;
    }

    // Fallback to https
    try {
      const u = new URL(url);
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      const req = https.request(
        {
          method: "POST",
          hostname: u.hostname,
          path: u.pathname + u.search,
          port: u.port || 443,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": body.length,
          },
          timeout: timeoutMs,
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve(res.statusCode >= 200 && res.statusCode < 300));
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        try { req.destroy(); } catch {}
        resolve(false);
      });
      req.write(body);
      req.end();
    } catch {
      resolve(false);
    }
  });
}

async function logToDiscord(message) {
  if (!message || isShuttingDown || !WEBHOOK_URL) return;
  const payload = {
    embeds: [
      {
        color: 0x5865f2,
        description: String(message).slice(0, 4096),
        timestamp: new Date().toISOString(),
      },
    ],
  };
  await postJson(WEBHOOK_URL, payload, 5000);
}

// ==================== DISCORD HELPERS ====================
function isOnCooldown(uid) {
  const last = interactionCooldowns.get(uid) || 0;
  return Date.now() - last < CONFIG.INTERACTION_COOLDOWN_MS;
}

function touchCooldown(uid) {
  interactionCooldowns.set(uid, Date.now());
}

async function safeReply(interaction, content, ephemeral = true) {
  try {
    if (!interaction) return false;

    const payload = typeof content === "string" ? { content } : { ...content };
    if (ephemeral) payload.ephemeral = true;

    // If we've already acknowledged the interaction, follow up
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch((err) => {
        console.error("[Discord] followUp failed:", err?.message);
      });
    } else {
      await interaction.reply(payload).catch((err) => {
        console.error("[Discord] reply failed:", err?.message);
      });
    }
    return true;
  } catch (e) {
    console.error("[Discord] safeReply error:", e?.message);
    return false;
  }
}

async function safeDefer(interaction, ephemeral = true) {
  try {
    if (!interaction) return false;
    if (interaction.deferred || interaction.replied) return true;
    await interaction.deferReply({ ephemeral }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// ==================== USER MANAGEMENT ====================
function getUser(uid) {
  if (!uid || typeof uid !== "string" || !/^\d+$/.test(uid)) {
    return { connectionType: "online", bedrockVersion: "auto", _temp: true };
  }

  if (!users[uid]) {
    users[uid] = {
      connectionType: "online",
      bedrockVersion: "auto",
      createdAt: Date.now(),
      lastActive: Date.now(),
      linked: false,
    };
    userStore.set(uid, users[uid]);
  }

  users[uid].connectionType = users[uid].connectionType || "online";
  users[uid].bedrockVersion = users[uid].bedrockVersion || "auto";
  users[uid].lastActive = Date.now();

  return users[uid];
}

async function getUserAuthDir(uid) {
  if (!uid || typeof uid !== "string") return null;

  const safeUid = uid.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
  if (!safeUid) return null;

  const dir = path.join(AUTH_ROOT, safeUid);
  await safeEnsureDir(dir);
  return dir;
}

async function unlinkMicrosoft(uid) {
  if (!uid) return false;

  try {
    // Stop any active session first (more intuitive for users)
    if (sessions.has(uid)) {
      await stopSession(uid);
    }

    const dir = await getUserAuthDir(uid);
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    const u = getUser(uid);
    u.linked = false;
    u.authTokenExpiry = null;
    u.tokenAcquiredAt = null;

    userStore.set(uid, u);
    return true;
  } catch (e) {
    console.error("[Auth] Unlink error:", e?.message);
    return false;
  }
}

// ==================== VALIDATION ====================
function isValidIP(ip) {
  if (!ip || typeof ip !== "string") return false;
  if (ip.length > 253) return false;
  if (ip.includes("..") || ip.startsWith(".") || ip.endsWith(".")) return false;
  if (ip.includes("://")) return false;

  const ipv4Regex =
    /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
  const hostnameRegex =
    /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}(?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,63})*$/;

  return ipv4Regex.test(ip) || ipv6Regex.test(ip) || hostnameRegex.test(ip);
}

function isValidPort(port) {
  const num = typeof port === "number" ? port : parseInt(port, 10);
  return Number.isFinite(num) && num > 0 && num <= 65535;
}

// ==================== BEDROCK CLIENT (IMMORTAL) ====================
class ImmortalBedrockClient {
  constructor(uid, options) {
    this.uid = uid;
    this.options = options;

    this.client = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.isCleaningUp = false;

    this.listeners = new Map();
    this.lastActivity = Date.now();
    this.entityId = null;

    this.manualStop = false;

    // RAM friendly: keep only one anti-AFK timer handle
    this.antiAfkTimer = null;

    // callbacks (set by session)
    this.onConnected = null;
    this.onDisconnected = null;
  }

  async create() {
    if (this.isCleaningUp) {
      await this.waitForCleanup();
    }

    this.isConnecting = true;

    try {
      this.client = bedrock.createClient(this.options);
      if (!this.client) throw new Error("bedrock.createClient returned null");

      this.setupSafeListeners();
      return true;
    } catch (e) {
      console.error(`[Bedrock ${this.uid}] Create error:`, e?.message);
      this.isConnecting = false;
      return false;
    }
  }

  setupSafeListeners() {
    if (!this.client) return;

    const safeOn = (event, handler) => {
      const wrapped = (...args) => {
        try {
          handler(...args);
        } catch (e) {
          console.error(`[Bedrock ${this.uid}] Event ${event} error:`, e?.message);
        }
      };
      this.client.on(event, wrapped);
      this.listeners.set(event, wrapped);
    };

    safeOn("connect", () => {
      console.log(`[Bedrock ${this.uid}] Connected`);
      this.isConnected = true;
      this.isConnecting = false;
      if (typeof this.onConnected === "function") this.onConnected();
    });

    safeOn("spawn", () => {
      console.log(`[Bedrock ${this.uid}] Spawned`);
      logToDiscord(`Bot of <@${this.uid}> spawned`);
    });

    safeOn("start_game", (packet) => {
      if (packet && packet.runtime_entity_id !== undefined) {
        this.entityId = packet.runtime_entity_id;
        this.isConnected = true;
        this.isConnecting = false;
        if (typeof this.onConnected === "function") this.onConnected();

        this.startAntiAfk();
      }
    });

    safeOn("packet", () => {
      this.lastActivity = Date.now();
    });

    safeOn("disconnect", (packet) => {
      const reason = packet?.reason || "Unknown";
      console.log(`[Bedrock ${this.uid}] Disconnected: ${reason}`);
      logToDiscord(`Bot of <@${this.uid}> kicked: ${reason}`);

      if (typeof reason === "string" && (reason.includes("wait") || reason.includes("before"))) {
        this.manualStop = true;
      }

      this.isConnected = false;
      if (typeof this.onDisconnected === "function") this.onDisconnected(reason);
    });

    safeOn("error", (e) => {
      console.error(`[Bedrock ${this.uid}] Error:`, e?.message);
      trackError("bedrock_client", e);

      if (e?.message?.includes("auth") || e?.message?.includes("token")) {
        this.manualStop = true;
      }
    });

    safeOn("close", () => {
      console.log(`[Bedrock ${this.uid}] Connection closed`);
      this.isConnected = false;
      this.isConnecting = false;
      if (typeof this.onDisconnected === "function") this.onDisconnected("close");
    });
  }

  startAntiAfk() {
    if (!this.entityId || !this.client) return;

    const doAction = () => {
      if (!this.isConnected || !this.client || this.isCleaningUp) return;

      try {
        const action = Math.random();

        if (action < 0.6) {
          this.client.write("animate", {
            action_id: 1,
            runtime_entity_id: this.entityId,
          });
        } else if (action < 0.8) {
          this.client.write("player_action", {
            runtime_entity_id: this.entityId,
            action: 11,
            position: { x: 0, y: 0, z: 0 },
            result_code: 0,
            face: 0,
          });

          setTimeout(() => {
            if (this.isConnected && this.client && !this.isCleaningUp) {
              try {
                this.client.write("player_action", {
                  runtime_entity_id: this.entityId,
                  action: 12,
                  position: { x: 0, y: 0, z: 0 },
                  result_code: 0,
                  face: 0,
                });
              } catch {}
            }
          }, 2000 + Math.random() * 2000);
        }
      } catch {}

      const nextDelay = 8000 + Math.random() * 12000;
      this.antiAfkTimer = setTimeout(doAction, nextDelay);
    };

    if (this.antiAfkTimer) clearTimeout(this.antiAfkTimer);
    doAction();
  }

  async close() {
    if (this.isCleaningUp) return;

    this.isCleaningUp = true;
    console.log(`[Bedrock ${this.uid}] Starting safe close...`);

    if (this.antiAfkTimer) {
      clearTimeout(this.antiAfkTimer);
      this.antiAfkTimer = null;
    }

    await new Promise((r) => setTimeout(r, 100));

    if (this.client) {
      try {
        // Remove listeners first
        for (const [event, handler] of this.listeners) {
          try {
            this.client.removeListener(event, handler);
          } catch {}
        }
        this.listeners.clear();

        // Only close if we were connected or connecting
        if (this.isConnected || this.isConnecting) {
          await Promise.race([
            new Promise((resolve) => {
              try {
                this.client.once("close", resolve);
                this.client.close();
              } catch {
                resolve();
              }
            }),
            new Promise((resolve) => setTimeout(resolve, 2000)),
          ]);
        }
      } catch (e) {
        console.error(`[Bedrock ${this.uid}] Close error:`, e?.message);
      } finally {
        this.client = null;
      }
    }

    this.isConnected = false;
    this.isConnecting = false;
    this.isCleaningUp = false;
    this.entityId = null;

    console.log(`[Bedrock ${this.uid}] Safe close completed`);
  }

  waitForCleanup() {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.isCleaningUp) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
  }
}

// ==================== SESSION MANAGEMENT ====================
async function safeCleanupSession(uid, isReconnect = false) {
  if (!uid) return;

  if (cleanupLocks.has(uid)) {
    console.log(`[Session ${uid}] Cleanup already in progress`);
    return;
  }

  cleanupLocks.add(uid);

  try {
    const session = sessions.get(uid);
    if (!session) return;

    session.manualStop = !isReconnect;

    // Cancel any scheduled reconnect timer
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }

    // Clear timers
    if (Array.isArray(session.timers)) {
      for (const t of session.timers) {
        try { clearTimeout(t); } catch {}
        try { clearInterval(t); } catch {}
      }
      session.timers.length = 0;
    }

    if (session.bedrockClient) {
      await session.bedrockClient.close();
      session.bedrockClient = null;
    }

    sessions.delete(uid);

    if (global.gc && sessions.size === 0) {
      try { global.gc(); } catch {}
    }

    console.log(`[Session ${uid}] Cleanup completed`);
  } catch (e) {
    console.error(`[Session ${uid}] Cleanup error:`, e?.message);
  } finally {
    cleanupLocks.delete(uid);
  }
}

async function safeCleanupAllSessions() {
  const tasks = [];
  for (const [uid] of sessions) tasks.push(safeCleanupSession(uid));
  await Promise.allSettled(tasks);
}

async function saveSessionData(uid) {
  if (!uid) return;
  const u = getUser(uid);
  if (!u) return;

  try {
    activeSessionsStore[uid] = {
      startedAt: Date.now(),
      server: u.server,
      connectionType: u.connectionType,
      bedrockVersion: u.bedrockVersion,
      offlineUsername: u.offlineUsername,
      linked: u.linked,
      lastActive: Date.now(),
    };

    sessionStore.set(uid, activeSessionsStore[uid]);
  } catch (e) {
    console.error("[Session] Save error:", e?.message);
  }
}

async function clearSessionData(uid) {
  if (!uid) return;
  if (activeSessionsStore[uid]) delete activeSessionsStore[uid];

  // IMPORTANT FIX: delete key instead of setting null (prevents rejoin.json from growing forever)
  sessionStore.delete(uid);
}

async function stopSession(uid) {
  if (!uid) return false;

  const session = sessions.get(uid);
  if (session) session.manualStop = true;

  await clearSessionData(uid);
  await safeCleanupSession(uid);
  return true;
}

// ==================== RECONNECTION SYSTEM ====================
function scheduleAutoReconnect(uid, reason = "unknown") {
  if (!uid || isShuttingDown) return;

  const session = sessions.get(uid);
  if (!session || session.manualStop) return;

  session.reconnectAttempt = (session.reconnectAttempt || 0) + 1;
  const attempt = session.reconnectAttempt;

  if (attempt > CONFIG.MAX_RECONNECT_ATTEMPTS) {
    logToDiscord(`Bot of <@${uid}> stopped after max attempts (${reason})`);
    safeCleanupSession(uid).catch(() => {});
    clearSessionData(uid).catch(() => {});
    return;
  }

  const baseDelay = Math.min(
    CONFIG.RECONNECT_BASE_DELAY_MS * Math.pow(1.5, attempt - 1),
    CONFIG.RECONNECT_MAX_DELAY_MS
  );
  const delay = baseDelay + Math.random() * 3000;

  logToDiscord(`Bot of <@${uid}> reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt}, reason: ${reason})`);

  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  session.reconnectTimer = setTimeout(async () => {
    const s = sessions.get(uid);
    if (!s || isShuttingDown || s.manualStop) return;

    await safeCleanupSession(uid, true);
    await new Promise((r) => setTimeout(r, CONFIG.NATIVE_CLEANUP_DELAY_MS));

    if (!isShuttingDown) {
      await startSession(uid, null, true, attempt);
    }
  }, delay);
}

// ==================== MAIN SESSION FUNCTION ====================
async function startSession(uid, interaction = null, isReconnect = false, reconnectAttempt = 0) {
  if (!uid || isShuttingDown) return;

  // Capacity check
  if (!isReconnect && sessions.size >= CONFIG.MAX_CONCURRENT_SESSIONS) {
    if (interaction) await safeReply(interaction, "Server at capacity. Please try again later.");
    return;
  }

  // Stores must be ready
  if (!storesInitialized) {
    if (interaction) await safeReply(interaction, "System initializing, try again in a moment.");
    return;
  }

  // Ensure we ACK quickly if this call is from an interaction
  if (interaction) {
    // Do not defer if it's already deferred/replied
    await safeDefer(interaction, true);
  }

  // Wait for cleanup locks
  if (cleanupLocks.has(uid)) {
    let tries = 0;
    while (cleanupLocks.has(uid) && tries < 20) {
      await new Promise((r) => setTimeout(r, 250));
      tries++;
    }
  }

  const u = getUser(uid);
  if (!u) {
    if (interaction) await safeReply(interaction, "User data error.");
    return;
  }

  if (!u.linked) {
    if (interaction) await safeReply(interaction, "Please link your Microsoft account first.");
    return;
  }

  if (!u.server?.ip) {
    if (interaction) await safeReply(interaction, "Please configure server settings first.");
    return;
  }

  const { ip, port } = u.server;
  if (!isValidIP(ip) || !isValidPort(port)) {
    if (interaction) await safeReply(interaction, "Invalid server address.");
    return;
  }

  if (sessions.has(uid) && !isReconnect) {
    if (interaction) await safeReply(interaction, "Session already active. Use Stop first.");
    return;
  }

  if (isReconnect && sessions.has(uid)) {
    await safeCleanupSession(uid, true);
    await new Promise((r) => setTimeout(r, CONFIG.NATIVE_CLEANUP_DELAY_MS));
  }

  const authDir = await getUserAuthDir(uid);
  if (!authDir) {
    if (interaction) await safeReply(interaction, "Auth directory error.");
    return;
  }

  const opts = {
    host: ip,
    port: parseInt(port, 10),
    connectTimeout: CONFIG.CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    viewDistance: 1,            // low-end optimization
    profilesFolder: authDir,
    username: uid,
    offline: false,
    skipPing: true,
    autoInitPlayer: true,
    useTimeout: true,
    raknetBackend: "jsp-raknet", // JS backend (avoid native deps)
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  }

  const session = {
    uid,
    startedAt: Date.now(),
    manualStop: false,
    isReconnecting: isReconnect,
    reconnectAttempt: reconnectAttempt || 0,
    reconnectTimer: null,
    timers: [],
    bedrockClient: null,
  };

  sessions.set(uid, session);

  const bedrockClient = new ImmortalBedrockClient(uid, opts);
  session.bedrockClient = bedrockClient;

  bedrockClient.onConnected = () => {
    const s = sessions.get(uid);
    if (!s) return;
    s.reconnectAttempt = 0;
    if (s.reconnectTimer) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = null;
    }
  };

  bedrockClient.onDisconnected = (reason) => {
    const s = sessions.get(uid);
    if (!s || s.manualStop || isShuttingDown) return;

    // Trigger reconnect shortly after disconnect
    scheduleAutoReconnect(uid, String(reason || "disconnect"));
  };

  // Connection watchdog
  const watchdog = setInterval(() => {
    const s = sessions.get(uid);
    if (!s) return clearInterval(watchdog);

    const bc = s.bedrockClient;
    if (!bc) return;

    // Stale activity check (optional)
    const stale = Date.now() - bc.lastActivity > CONFIG.STALE_CONNECTION_TIMEOUT_MS;
    if (stale && bc.isConnected && !bc.isCleaningUp) {
      console.warn(`[Session ${uid}] Stale connection detected, forcing reconnect...`);
      scheduleAutoReconnect(uid, "stale");
    }
  }, 30000);

  session.timers.push(watchdog);

  try {
    const ok = await bedrockClient.create();
    if (!ok) throw new Error("Failed to create bedrock client");

    await saveSessionData(uid);

    if (interaction) {
      await safeReply(interaction, `🔄 Connecting to \`${ip}:${port}\`...`);
    }

  } catch (e) {
    console.error(`[Session ${uid}] Start error:`, e?.message);
    if (interaction) await safeReply(interaction, `❌ Connection failed: ${e?.message || "Unknown error"}`);

    // If it was a reconnect attempt, schedule another reconnect
    if (isReconnect) {
      scheduleAutoReconnect(uid, "start_error");
    } else {
      await safeCleanupSession(uid);
      await clearSessionData(uid);
    }
  }
}

// ==================== MICROSOFT AUTH ====================
async function linkMicrosoft(uid, interaction) {
  if (!uid || !interaction) return;

  if (pendingLink.has(uid)) {
    await safeReply(interaction, "Login already in progress. Check your DMs.");
    return;
  }

  await safeDefer(interaction, true);

  const authDir = await getUserAuthDir(uid);
  if (!authDir) {
    await safeReply(interaction, "System error: Cannot create auth directory.");
    return;
  }

  const u = getUser(uid);
  pendingLink.set(uid, { startTime: Date.now() });

  const timeoutId = setTimeout(() => {
    pendingLink.delete(uid);
    safeReply(interaction, "Login timed out after 5 minutes. Try again.").catch(() => {});
  }, 300000);

  try {
    const flow = new Authflow(
      uid,
      authDir,
      {
        flow: "live",
        authTitle: Titles?.MinecraftNintendoSwitch || "MinecraftNintendoSwitch",
        deviceType: "Nintendo",
      },
      async (data) => {
        const uri = data?.verification_uri_complete || data?.verification_uri || "https://www.microsoft.com/link";
        const code = data?.user_code || "(no code)";

        lastMsa.set(uid, { uri, code, at: Date.now() });

        const msg =
          `**Microsoft Authentication**\n\n` +
          `1) Visit: ${uri}\n` +
          `2) Enter Code: \`${code}\`\n\n` +
          `*Tokens are stored locally and never shared.*`;

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel("Open Microsoft").setStyle(ButtonStyle.Link).setURL(uri)
        );

        await safeReply(interaction, { content: msg, components: [row], ephemeral: true }, true);
      }
    );

    // Race token acquisition with timeout
    const tokenPromise = flow.getMsaToken();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Token acquisition timeout")), 240000)
    );

    await Promise.race([tokenPromise, timeoutPromise]);

    clearTimeout(timeoutId);
    pendingLink.delete(uid);

    u.linked = true;
    u.tokenAcquiredAt = Date.now();
    userStore.set(uid, u);

    await safeReply(interaction, "✅ Microsoft account linked successfully!");
  } catch (e) {
    clearTimeout(timeoutId);
    pendingLink.delete(uid);

    const msg = e?.message || "Unknown error";
    console.error(`[Auth ${uid}] Link error:`, msg);
    await safeReply(interaction, `❌ Login failed: ${msg}`);
  }
}

// ==================== UI COMPONENTS ====================
function panelRow(isJava = false) {
  const title = isJava ? "Java AFKBot Panel" : "Bedrock AFKBot Panel";
  const startCustomId = isJava ? "start_java" : "start_bedrock";

  return {
    content: `**${title}**\nUse the buttons below to control your bot.`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("link").setLabel("🔗 Link Microsoft").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("unlink").setLabel("🔓 Unlink").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(startCustomId).setLabel("▶️ Start").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("stop").setLabel("⏹️ Stop").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("settings").setLabel("⚙️ Settings").setStyle(ButtonStyle.Secondary)
      ),
    ],
  };
}

// ==================== DISCORD CLIENT ====================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
  ],
  failIfNotExists: false,
  allowedMentions: {
    parse: ["users", "roles"],
    repliedUser: false,
  },
  presence: {
    status: "online",
    activities: [
      {
        name: "AFK Bot System",
        type: ActivityType.Watching,
      },
    ],
  },
  shards: "auto",
});

// ==================== DISCORD ERROR HANDLING ====================
client.on("error", (error) => {
  console.error("[Discord] Client error:", error?.message);
  discordReady = false;
  trackError("discord_client", error);
});

client.on("shardError", (error, shardId) => {
  console.error(`[Discord] Shard ${shardId} error:`, error?.message);
  trackError("discord_shard", error);
});

// NOTE: discord.js v14 uses shard events, not "disconnect/reconnecting/resume"
client.on("shardDisconnect", (closeEvent, shardId) => {
  console.log(`[Discord] Shard ${shardId} disconnected`, closeEvent?.code);
  discordReady = false;
});

client.on("shardReconnecting", (shardId) => {
  console.log(`[Discord] Shard ${shardId} reconnecting...`);
});

client.on("shardResume", (replayed, shardId) => {
  console.log(`[Discord] Shard ${shardId} resumed, replayed: ${replayed}`);
  discordReady = true;
});

// ==================== READY ====================
client.once("ready", async () => {
  discordReady = true;
  console.log("[Discord] Client ready");

  try {
    const cmds = [
      new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
      new SlashCommandBuilder().setName("java").setDescription("Open Java AFKBot Panel"),
      new SlashCommandBuilder().setName("refresh").setDescription("Refresh Discord connection"),
    ];

    await client.application?.commands?.set(cmds);
    console.log("[Discord] Commands registered");
  } catch (e) {
    console.error("[Discord] Command registration failed:", e?.message);
  }

  // Memory monitoring
  setInterval(() => {
    const mem = process.memoryUsage();
    const mb = mem.rss / 1024 / 1024;

    if (mb > CONFIG.MEMORY_GC_THRESHOLD_MB) {
      console.warn(`[Memory] High usage: ${mb.toFixed(2)}MB`);
      if (global.gc) {
        try {
          global.gc();
          console.log("[Memory] GC triggered");
        } catch {}
      }
    }

    if (mb > CONFIG.MAX_MEMORY_MB) {
      console.error(`[Memory] CRITICAL: ${mb.toFixed(2)}MB, cleaning up sessions...`);
      safeCleanupAllSessions().catch(() => {});
    }
  }, CONFIG.MEMORY_CHECK_INTERVAL_MS);

  // Periodic cleanup
  setInterval(() => {
    const cutoff = Date.now() - 60000;

    for (const [uid, time] of interactionCooldowns) {
      if (time < cutoff) interactionCooldowns.delete(uid);
    }

    for (const [uid, data] of pendingOperations) {
      if (data?.time < cutoff) pendingOperations.delete(uid);
    }

    // Cleanup old msa links (RAM friendly)
    const msaCutoff = Date.now() - 10 * 60 * 1000;
    for (const [uid, data] of lastMsa) {
      if (data?.at < msaCutoff) lastMsa.delete(uid);
    }
  }, CONFIG.CLEANUP_INTERVAL_MS);

  // Restore sessions after delay
  setTimeout(() => {
    if (discordReady && !isShuttingDown) restoreSessions().catch(() => {});
  }, 10000);
});

// ==================== SESSION RESTORATION ====================
async function restoreSessions() {
  const previousSessions = Object.keys(activeSessionsStore || {});
  console.log(`[Restore] Found ${previousSessions.length} sessions to restore`);

  let delay = 0;
  for (const uid of previousSessions) {
    if (!/^\d+$/.test(uid)) continue;

    const sessionData = activeSessionsStore[uid];
    if (!sessionData) continue;

    // Restore user config in memory (no heavy disk writes)
    if (!users[uid]) users[uid] = {};
    if (sessionData.server) users[uid].server = sessionData.server;
    if (sessionData.connectionType) users[uid].connectionType = sessionData.connectionType;
    if (sessionData.linked !== undefined) users[uid].linked = sessionData.linked;
    if (sessionData.offlineUsername) users[uid].offlineUsername = sessionData.offlineUsername;

    setTimeout(() => {
      if (!isShuttingDown && sessions.size < CONFIG.MAX_CONCURRENT_SESSIONS) {
        console.log(`[Restore] Restoring session for ${uid}`);
        startSession(uid, null, true, 0).catch(() => {});
      }
    }, delay);

    delay += 10000;
  }
}

// ==================== INTERACTION HANDLER ====================
client.on(Events.InteractionCreate, async (i) => {
  const uid = i?.user?.id;

  try {
    if (!i || isShuttingDown) return;
    if (!uid) return;

    // Don't block modal submits with cooldown (user already typed data)
    const applyCooldown = !i.isModalSubmit();

    if (applyCooldown && isOnCooldown(uid)) {
      // Always reply (fixes "This interaction failed")
      return safeReply(i, "⏳ Please wait a moment before trying again.");
    }

    if (applyCooldown) touchCooldown(uid);

    pendingOperations.set(uid, { time: Date.now(), type: i.type });

    // ===== SLASH COMMANDS =====
    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") {
        return i.reply({ ...panelRow(false), ephemeral: true }).catch(() => {});
      }

      if (i.commandName === "java") {
        return i.reply({ ...panelRow(true), ephemeral: true }).catch(() => {});
      }

      if (i.commandName === "refresh") {
        await safeDefer(i, true);

        if (!discordReady) {
          return safeReply(i, "Already reconnecting...");
        }

        discordReady = false;
        try {
          await client.destroy().catch(() => {});
          await new Promise((r) => setTimeout(r, 1000));
          await client.login(DISCORD_TOKEN);

          // Wait for ready
          let tries = 0;
          while (!client.isReady() && tries < 20) {
            await new Promise((r) => setTimeout(r, 500));
            tries++;
          }

          discordReady = client.isReady();
          return safeReply(i, discordReady ? "✅ Connection refreshed!" : "❌ Refresh failed");
        } catch (err) {
          discordReady = false;
          return safeReply(i, `❌ Error: ${err?.message || "Unknown error"}`);
        }
      }
    }

    // ===== BUTTONS =====
    if (i.isButton()) {
      if (i.customId === "start_bedrock") {
        if (sessions.has(uid)) return safeReply(i, "❌ Session already active.");

        const embed = new EmbedBuilder()
          .setTitle("🎮 Start Bedrock Bot")
          .setDescription("Click **Start** to connect to your configured server.")
          .setColor(0x2ecc71);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("confirm_start").setLabel("▶️ Start").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("cancel").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary)
        );

        return i.reply({ embeds: [embed], components: [row], ephemeral: true }).catch(() => {});
      }

      if (i.customId === "start_java") {
        if (sessions.has(uid)) return safeReply(i, "❌ Session already active.");

        const embed = new EmbedBuilder()
          .setTitle("☕ Java Server Notice")
          .setDescription("For Java servers, ensure you have:\n• GeyserMC\n• Floodgate")
          .setColor(0xe67e22);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("confirm_start").setLabel("✅ Confirm & Start").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("cancel").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary)
        );

        return i.reply({ embeds: [embed], components: [row], ephemeral: true }).catch(() => {});
      }

      if (i.customId === "confirm_start") {
        await safeDefer(i, true);
        await safeReply(i, "🔄 Connecting...");

        // Start session (will send followUps)
        startSession(uid, i, false, 0).catch(() => {});
        return;
      }

      if (i.customId === "cancel") {
        return safeReply(i, "❌ Cancelled.");
      }

      if (i.customId === "stop") {
        await safeDefer(i, true);
        const ok = await stopSession(uid);
        return safeReply(i, ok ? "⏹️ Session stopped." : "No active session.");
      }

      if (i.customId === "link") {
        return linkMicrosoft(uid, i);
      }

      if (i.customId === "unlink") {
        await safeDefer(i, true);
        const ok = await unlinkMicrosoft(uid);
        return safeReply(i, ok ? "🔓 Account unlinked (and session stopped if active)." : "Failed to unlink.");
      }

      if (i.customId === "settings") {
        // showModal MUST be the first acknowledgement (do not defer/reply before)
        const u = getUser(uid);

        const modal = new ModalBuilder()
          .setCustomId("settings_modal")
          .setTitle("⚙️ Server Settings");

        const ipInput = new TextInputBuilder()
          .setCustomId("ip")
          .setLabel("Server IP / Hostname")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(u.server?.ip ? String(u.server.ip).slice(0, 253) : "")
          .setMaxLength(253);

        const portInput = new TextInputBuilder()
          .setCustomId("port")
          .setLabel("Port")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(u.server?.port || 19132))
          .setMaxLength(5);

        modal.addComponents(
          new ActionRowBuilder().addComponents(ipInput),
          new ActionRowBuilder().addComponents(portInput)
        );

        return i.showModal(modal).catch((err) => {
          console.error("[Modal] Show error:", err?.message);
          safeReply(i, "Failed to open settings. Try again.").catch(() => {});
        });
      }
    }

    // ===== MODAL SUBMIT =====
    if (i.isModalSubmit() && i.customId === "settings_modal") {
      // This must reply quickly
      const ip = i.fields?.getTextInputValue("ip")?.trim();
      const portStr = i.fields?.getTextInputValue("port")?.trim();
      const port = parseInt(portStr, 10);

      if (!ip || !portStr) return safeReply(i, "❌ IP and Port are required.");

      if (!isValidIP(ip)) return safeReply(i, "❌ Invalid IP/hostname.");
      if (!isValidPort(port)) return safeReply(i, "❌ Invalid port (1-65535).");

      const u = getUser(uid);
      u.server = { ip, port };
      userStore.set(uid, u);

      return safeReply(i, `✅ Saved: **${ip}:${port}**`);
    }

  } catch (e) {
    console.error("[Interaction] Handler error:", e?.message);
    trackError("interaction", e);

    // Best effort: avoid "interaction failed"
    try {
      await safeReply(i, "❌ An error occurred. Try again.");
    } catch {}
  } finally {
    if (uid) pendingOperations.delete(uid);
  }
});

// ==================== HEARTBEAT ====================
setInterval(() => {
  const mem = process.memoryUsage();
  console.log(
    `[Heartbeat] Sessions: ${sessions.size} | ` +
      `Discord: ${discordReady ? "OK" : "DISC"} | ` +
      `Memory: ${Math.round(mem.rss / 1024 / 1024)}MB | ` +
      `Uptime: ${Math.floor(process.uptime() / 60)}m`
  );
}, 60000);

// ==================== STARTUP ====================
async function main() {
  if (!DISCORD_TOKEN) {
    console.error("[FATAL] DISCORD_TOKEN missing");
    process.exit(1);
  }

  console.log("[Immortal] Starting HYPER-IMMORTAL bot...");
  console.log(`[Immortal] Node version: ${process.version}`);
  console.log(`[Immortal] Platform: ${os.platform()}`);
  console.log(`[Immortal] CPUs: ${os.cpus().length}`);
  console.log(`[Immortal] Memory: ${Math.round(os.totalmem() / 1024 / 1024)}MB`);

  await initializeStores();

  // Periodic background save
  setInterval(() => {
    safeSaveAllData().catch(() => {});
  }, CONFIG.AUTO_SAVE_INTERVAL_MS);

  // Discord login with retries
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    try {
      await client.login(DISCORD_TOKEN);
      console.log("[Immortal] Discord login successful");
      return;
    } catch (err) {
      attempts++;
      console.error(`[Immortal] Login attempt ${attempts} failed:`, err?.message);

      if (attempts >= maxAttempts) {
        console.error("[FATAL] Max login attempts reached");
        process.exit(1);
      }

      await new Promise((r) => setTimeout(r, 5000 * attempts));
    }
  }
}

main().catch((e) => {
  console.error("[FATAL] Main error:", e);
  process.exit(1);
});
