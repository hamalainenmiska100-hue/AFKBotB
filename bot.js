/**
 * HYPER-IMMORTAL DISCORD BEDROCK BOT (FIXED + RAM FRIENDLY)
 * ========================================================
 * Fixes in this build (2026-02-22):
 * - Fix: prevents jsp-raknet/bedrock-protocol crash: "Cannot destructure property 'reason' of 'undefined'"
 * - Fix: extends Bedrock pre-ping timeout (default 1000ms is too short on some hosts)
 * - Fix: uses bedrock-protocol 'join' event (not only 'spawn') so it doesn't look stuck forever
 * - Fix: prefers IPv4 when a hostname resolves to both IPv4/IPv6 (common cause of UDP timeouts)
 * - Adds: optional "Bedrock Version" field in Settings (use this if your server blocks ping/version detection)
 * - Adds: better error messages for Ping timed out / UDP connectivity issues
 *
 * IMPORTANT:
 * - Env vars: DISCORD_TOKEN, (optional) WEBHOOK_URL, (optional) FLY_VOLUME_PATH
 * - This bot uses RakNet/UDP to connect to Bedrock servers. If your host blocks outbound UDP, it cannot connect.
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
const dns = require("dns").promises;
const { URL } = require("url");

// ==================== RUNTIME PATCHES (NO node_modules EDITS) ====================
// Patch #1: jsp-raknet sometimes emits 'disconnect' without an argument.
// Some bedrock-protocol versions destructure { reason } from the event argument and crash if it's undefined.
// We patch jsp-raknet's Client.emit to always pass an object for 'disconnect'/'close' if missing.
function patchJspRaknetEmitSafety() {
  const candidates = [
    () => require("jsp-raknet"), // usually exports { Client, Server, ... }
    () => require("jsp-raknet/js/Client"), // fallback (depends on build)
    () => require("jsp-raknet/js/Client.js"),
  ];

  for (const load of candidates) {
    try {
      const mod = load();
      const ClientClass = mod?.Client || mod?.default || mod;
      if (!ClientClass?.prototype) continue;

      if (ClientClass.prototype.__immortalEmitPatched) {
        return true;
      }

      const originalEmit = ClientClass.prototype.emit;
      if (typeof originalEmit !== "function") continue;

      ClientClass.prototype.emit = function (event, ...args) {
        try {
          if ((event === "disconnect" || event === "close") && (args.length === 0 || args[0] === undefined)) {
            return originalEmit.call(this, event, { reason: event });
          }
        } catch {}
        return originalEmit.call(this, event, ...args);
      };

      ClientClass.prototype.__immortalEmitPatched = true;
      console.log("[Immortal] Patched jsp-raknet Client.emit (disconnect/close payload safety)");
      return true;
    } catch (e) {
      // keep trying candidates
    }
  }

  console.warn("[Immortal] Warning: could not patch jsp-raknet emit (module shape/path may differ)");
  return false;
}

// Patch #2: bedrock-protocol rak ping default timeout is 1000ms.
// That is often too aggressive and produces "Ping timed out" even when the server is reachable.
// We patch RakClient.prototype.ping default behavior to use a higher timeout unless explicitly provided.
function patchBedrockPingDefaultTimeout(defaultTimeoutMs) {
  try {
    const rakFactory = require("bedrock-protocol/src/rak");
    const { RakClient } = rakFactory("jsp-raknet"); // this should exist if jsp-raknet is installed
    if (!RakClient?.prototype?.ping || RakClient.prototype.__immortalPingPatched) return true;

    const originalPing = RakClient.prototype.ping;
    RakClient.prototype.ping = function (timeout) {
      const t = Number.isFinite(timeout) && timeout > 0 ? timeout : defaultTimeoutMs;
      return originalPing.call(this, t);
    };

    RakClient.prototype.__immortalPingPatched = true;
    console.log(`[Immortal] Patched bedrock-protocol RakClient.ping default timeout -> ${defaultTimeoutMs}ms`);
    return true;
  } catch (e) {
    console.warn("[Immortal] Warning: could not patch bedrock-protocol ping timeout:", e?.message);
    return false;
  }
}

// Apply patches early
patchJspRaknetEmitSafety();
patchBedrockPingDefaultTimeout(parseInt(process.env.BEDROCK_PING_TIMEOUT_MS || "5000", 10));

// ==================== CONFIGURATION ====================
// Optimized for low-end devices
const CONFIG = {
  // Admin settings
  ADMIN_ID: "1144987924123881564",
  LOG_CHANNEL_ID: "146461503011173173",

  // File I/O
  SAVE_DEBOUNCE_MS: 750,
  AUTO_SAVE_INTERVAL_MS: 60000,

  // Connection settings
  MAX_RECONNECT_ATTEMPTS: 5,
  RECONNECT_BASE_DELAY_MS: 15000,
  RECONNECT_MAX_DELAY_MS: 300000,
  CONNECTION_TIMEOUT_MS: 20000,
  KEEPALIVE_INTERVAL_MS: 30000,
  STALE_CONNECTION_TIMEOUT_MS: 120000,

  // Extra connection tuning
  JOIN_WATCHDOG_EXTRA_MS: 15000,  // extra time beyond connectTimeout to reach 'join'
  SPAWN_WATCHDOG_MS: 120000,      // time after 'join' to reach 'spawn' (chunks)
  DNS_CACHE_MS: 10 * 60 * 1000,

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
  MAX_CONCURRENT_SESSIONS: 20,

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

// DNS cache (RAM friendly)
const dnsCache = new Map(); // host -> {addr, family, at}

// Error tracking (RAM friendly): keep only timestamps for the last minute
const errorTimes = [];
function trackError(context, error) {
  const now = Date.now();
  errorTimes.push(now);

  const cutoff = now - CONFIG.ERROR_WINDOW_MS;
  while (errorTimes.length && errorTimes[0] < cutoff) errorTimes.shift();

  if (errorTimes.length > CONFIG.MAX_ERRORS_PER_MINUTE) {
    console.error(`[ERROR TRACKER] Too many errors (${errorTimes.length}) in last minute. Throttling context=${context}`);
    return false;
  }

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

async function safeDM(uid, contentOrPayload) {
  try {
    if (!client || !uid) return false;
    const user = await client.users.fetch(uid).catch(() => null);
    if (!user) return false;

    const payload = typeof contentOrPayload === "string" ? { content: contentOrPayload } : { ...contentOrPayload };
    await user.send(payload).catch(() => null);
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
      lastKnownGoodVersion: null,
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

function normalizeBedrockVersion(v) {
  const s = String(v || "").trim();
  if (!s) return "auto";
  const lower = s.toLowerCase();
  if (lower === "auto") return "auto";
  // Accept x.y.z or x.y.z.w (some builds)
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(s)) return null;
  return s;
}

function normalizeClientVersion(maybeVersion) {
  if (!maybeVersion) return null;
  if (typeof maybeVersion === "string") return maybeVersion;
  if (typeof maybeVersion === "object") {
    if (typeof maybeVersion.version === "string") return maybeVersion.version;
    if (typeof maybeVersion.minecraftVersion === "string") return maybeVersion.minecraftVersion;
    if (typeof maybeVersion.toString === "function") {
      const s = maybeVersion.toString();
      if (typeof s === "string" && s.includes(".")) return s;
    }
  }
  return null;
}

// Prefer IPv4 when resolving hostnames (common issue on some hosts)
async function resolveHostPreferIpv4(host) {
  try {
    if (!host || typeof host !== "string") return { host, family: 0, resolved: false };
    const cached = dnsCache.get(host);
    const now = Date.now();
    if (cached && now - cached.at < CONFIG.DNS_CACHE_MS) {
      return { host: cached.addr, family: cached.family, resolved: true, original: host, cached: true };
    }

    // If already an IP, return as-is
    const isIpv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(host);
    const isIpv6 = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/.test(host);
    if (isIpv4) return { host, family: 4, resolved: true, original: host };
    if (isIpv6) return { host, family: 6, resolved: true, original: host };

    const addrs = await dns.lookup(host, { all: true, verbatim: true }).catch(() => []);
    if (!Array.isArray(addrs) || addrs.length === 0) return { host, family: 0, resolved: false, original: host };

    const ipv4 = addrs.find((a) => a && a.family === 4);
    const chosen = ipv4 || addrs[0];

    if (chosen?.address) {
      dnsCache.set(host, { addr: chosen.address, family: chosen.family || 0, at: now });
      return { host: chosen.address, family: chosen.family || 0, resolved: true, original: host };
    }

    return { host, family: 0, resolved: false, original: host };
  } catch {
    return { host, family: 0, resolved: false, original: host };
  }
}

// ==================== BEDROCK CLIENT (IMMORTAL) ====================
class ImmortalBedrockClient {
  constructor(uid, options) {
    this.uid = uid;
    this.options = options;

    this.client = null;
    this.isConnected = false;   // "joined"
    this.isConnecting = false;
    this.isCleaningUp = false;

    this.listeners = new Map();
    this.lastActivity = Date.now();
    this.entityId = null;

    this.manualStop = false;
    this.disconnectHandled = false;

    this.joinReady = false;
    this.spawnReady = false;

    this.authTick = 0;
    this.position = { x: 0, y: 0, z: 0 };
    this.rotation = { pitch: 0, yaw: 0, headYaw: 0 };

    this.antiAfkTimer = null;

    // callbacks
    this.onJoined = null;
    this.onSpawned = null;
    this.onDisconnected = null;
    this.onStatus = null;
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

    const handleDisconnectOnce = (reason) => {
      if (this.disconnectHandled) return;
      this.disconnectHandled = true;

      this.joinReady = false;
      this.spawnReady = false;

      this.isConnected = false;
      this.isConnecting = false;

      if (typeof this.onDisconnected === "function") this.onDisconnected(reason);
    };

    safeOn("connect", () => {
      console.log(`[Bedrock ${this.uid}] Connected (handshaking)`);
      this.isConnecting = true;
      this.disconnectHandled = false;
    });

    safeOn("status", (st) => {
      if (typeof this.onStatus === "function") this.onStatus(st);
    });

    // IMPORTANT: 'join' happens after authentication/encryption and indicates a "real" connection
    safeOn("join", () => {
      console.log(`[Bedrock ${this.uid}] Joined (authenticated)`);
      this.joinReady = true;
      this.isConnected = true;
      this.isConnecting = false;
      if (typeof this.onJoined === "function") this.onJoined();
    });

    safeOn("spawn", () => {
      console.log(`[Bedrock ${this.uid}] Spawned`);
      logToDiscord(`Bot of <@${this.uid}> spawned`);

      if (!this.spawnReady) {
        this.spawnReady = true;
        if (typeof this.onSpawned === "function") this.onSpawned();
        this.startAntiAfk();
      }
    });

    safeOn("start_game", (packet) => {
      if (packet && packet.runtime_entity_id !== undefined) {
        this.entityId = packet.runtime_entity_id;
        this.position = packet.player_position || this.position;
      }
    });

    safeOn("packet", (packet) => {
      this.lastActivity = Date.now();

      if (packet?.name === "move_player" && packet.params?.position) {
        this.position = packet.params.position;
        this.rotation.pitch = packet.params.pitch ?? this.rotation.pitch;
        this.rotation.yaw = packet.params.yaw ?? this.rotation.yaw;
        this.rotation.headYaw = packet.params.head_yaw ?? this.rotation.headYaw;
      }
    });

    safeOn("kick", (packet) => {
      const reason = packet?.message || packet?.reason || "kicked";
      console.log(`[Bedrock ${this.uid}] Kicked: ${reason}`);
      logToDiscord(`Bot of <@${this.uid}> kicked: ${reason}`);

      handleDisconnectOnce(`kick: ${reason}`);
    });

    safeOn("disconnect", (packet) => {
      const reason = packet?.reason || packet?.message || "disconnect";
      console.log(`[Bedrock ${this.uid}] Disconnected: ${reason}`);
      logToDiscord(`Bot of <@${this.uid}> disconnected: ${reason}`);

      if (typeof reason === "string" && (reason.includes("wait") || reason.includes("before"))) {
        this.manualStop = true;
      }

      handleDisconnectOnce(reason);
    });

    safeOn("error", (e) => {
      const msg = e?.message || String(e || "unknown error");
      console.error(`[Bedrock ${this.uid}] Error:`, msg);
      trackError("bedrock_client", e);

      // Common failure: ping/version detection timeout
      if (msg.toLowerCase().includes("ping timed out")) {
        // Mark as disconnected quickly so reconnect logic can happen
        handleDisconnectOnce("Ping timed out (UDP)");
      }

      if (msg.includes("auth") || msg.includes("token") || msg.includes("jwt")) {
        this.manualStop = true;
      }
    });

    safeOn("close", (arg) => {
      const reason = arg?.reason || "close";
      console.log(`[Bedrock ${this.uid}] Connection closed`);
      handleDisconnectOnce(reason);
    });
  }

  startAntiAfk() {
    if (!this.entityId || !this.client) return;

    const doAction = () => {
      if (!this.isConnected || !this.client || this.isCleaningUp) return;

      const currentPosition = {
        x: Number(this.position?.x || 0),
        y: Number(this.position?.y || 0),
        z: Number(this.position?.z || 0),
      };

      const sendPlayerAction = (action) => {
        this.client.write("player_action", {
          runtime_entity_id: this.entityId,
          action,
          position: currentPosition,
          result_position: currentPosition,
          face: 0,
        });
      };

      try {
        const action = Math.random();

        if (action < 0.4) {
          const animateActions = [1, 3, 4, 5, 128, 129];
          const action_id = animateActions[Math.floor(Math.random() * animateActions.length)];
          const payload = {
            action_id,
            runtime_entity_id: this.entityId,
          };
          if (action_id === 128 || action_id === 129) {
            payload.boat_rowing_time = Math.random();
          }
          this.client.write("animate", payload);
        } else if (action < 0.6) {
          sendPlayerAction("start_sneak");
          setTimeout(() => {
            if (this.isConnected && this.client && !this.isCleaningUp) {
              try {
                sendPlayerAction("stop_sneak");
              } catch {}
            }
          }, 1200 + Math.random() * 1200);
        } else if (action < 0.8) {
          const toggleActions = ["jump", "start_sprint", "stop_sprint"];
          sendPlayerAction(toggleActions[Math.floor(Math.random() * toggleActions.length)]);
        } else {
          this.authTick += 1;
          const moveX = (Math.random() - 0.5) * 0.6;
          const moveZ = 0.2 + Math.random() * 0.8;
          const delta = { x: moveX * 0.25, y: 0, z: moveZ * 0.25 };

          const authInputPayload = {
            pitch: this.rotation.pitch,
            yaw: this.rotation.yaw,
            position: currentPosition,
            move_vector: { x: moveX, y: moveZ },
            head_yaw: this.rotation.headYaw,
            input_data: {
              up: true,
              down: false,
              left: moveX < 0,
              right: moveX > 0,
              start_sprinting: Math.random() > 0.6,
              stop_sprinting: false,
              jumping: false,
              start_jumping: false,
              stop_sneaking: true,
            },
            input_mode: "mouse",
            play_mode: "normal",
            interaction_model: "crosshair",
            interact_rotation: { x: this.rotation.yaw, y: this.rotation.pitch },
            tick: this.authTick,
            delta,
          };

          try {
            this.client.write("player_auth_input", authInputPayload);
            this.position = {
              x: currentPosition.x + delta.x,
              y: currentPosition.y,
              z: currentPosition.z + delta.z,
            };
          } catch (e) {
            console.warn(`[Bedrock ${this.uid}] player_auth_input failed, using move_player fallback: ${e?.message || "unknown"}`);
            this.client.write("move_player", {
              runtime_id: Number(this.entityId) || 0,
              position: {
                x: currentPosition.x + delta.x,
                y: currentPosition.y,
                z: currentPosition.z + delta.z,
              },
              pitch: this.rotation.pitch,
              yaw: this.rotation.yaw,
              head_yaw: this.rotation.headYaw,
              mode: "normal",
              on_ground: true,
              ridden_runtime_id: 0,
              tick: this.authTick,
            });
            this.position = {
              x: currentPosition.x + delta.x,
              y: currentPosition.y,
              z: currentPosition.z + delta.z,
            };
          }
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
        for (const [event, handler] of this.listeners) {
          try {
            this.client.removeListener(event, handler);
          } catch {}
        }
        this.listeners.clear();

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

    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }

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

  if (session.reconnectScheduled) return;

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
  session.reconnectScheduled = true;
  session.reconnectTimer = setTimeout(async () => {
    const s = sessions.get(uid);
    if (!s || isShuttingDown || s.manualStop) return;

    s.reconnectScheduled = false;

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

  if (!isReconnect && sessions.size >= CONFIG.MAX_CONCURRENT_SESSIONS) {
    if (interaction) await safeReply(interaction, "Server at capacity. Please try again later.");
    return;
  }

  if (!storesInitialized) {
    if (interaction) await safeReply(interaction, "System initializing, try again in a moment.");
    return;
  }

  if (interaction) {
    await safeDefer(interaction, true);
  }

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

  // Resolve host (prefer IPv4)
  const resolved = await resolveHostPreferIpv4(ip);
  const connectHost = resolved?.host || ip;

  // Decide version strategy:
  // - If user set a version (or we have lastKnownGoodVersion), set opts.version and skip ping
  // - Otherwise allow ping to auto-match (but we globally patched ping default timeout)
  const normalizedVersion = normalizeBedrockVersion(u.bedrockVersion || "auto");
  const lastGood = normalizeBedrockVersion(u.lastKnownGoodVersion || "auto");
  const desiredVersion = normalizedVersion && normalizedVersion !== "auto"
    ? normalizedVersion
    : (lastGood && lastGood !== "auto" ? lastGood : null);

  const opts = {
    host: connectHost,
    port: parseInt(port, 10),
    connectTimeout: CONFIG.CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    viewDistance: 1,            // low-end optimization
    profilesFolder: authDir,
    username: uid,
    offline: false,
    // If we know the version, skip ping/version detection (helps when ping is blocked)
    skipPing: !!desiredVersion,
    autoInitPlayer: true,
    raknetBackend: "jsp-raknet", // JS backend (avoid native deps)
    onMsaCode: async (data) => {
      // If tokens are missing/expired, bedrock-protocol can request device-code auth
      const uri = data?.verification_uri_complete || data?.verification_uri || "https://www.microsoft.com/link";
      const code = data?.user_code || "(no code)";
      lastMsa.set(uid, { uri, code, at: Date.now() });

      const msg =
        `**Microsoft Authentication Required**\n\n` +
        `1) Open: ${uri}\n` +
        `2) Enter Code: \`${code}\`\n\n` +
        `If your DMs are closed, use /panel and press Link Microsoft.`;

      // Try interaction followUp first, otherwise DM
      if (interaction) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel("Open Microsoft").setStyle(ButtonStyle.Link).setURL(uri)
        );
        await safeReply(interaction, { content: msg, components: [row] }, true);
      } else {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel("Open Microsoft").setStyle(ButtonStyle.Link).setURL(uri)
        );
        await safeDM(uid, { content: msg, components: [row] });
      }
    },
  };

  if (desiredVersion) {
    opts.version = desiredVersion;
  }

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  } else {
    // If user hasn't linked yet, we still allow connect (onMsaCode will trigger),
    // but we keep your original UX requiring link by default:
    if (!u.linked) {
      if (interaction) await safeReply(interaction, "Please link your Microsoft account first (Link Microsoft).");
      return;
    }
    // Some servers can require authTitle; use Nintendo Switch title by default when available.
    if (Titles?.MinecraftNintendoSwitch) {
      opts.authTitle = Titles.MinecraftNintendoSwitch;
    }
  }

  const session = {
    uid,
    startedAt: Date.now(),
    manualStop: false,
    isReconnecting: isReconnect,
    reconnectAttempt: reconnectAttempt || 0,
    reconnectScheduled: false,
    reconnectTimer: null,
    timers: [],
    bedrockClient: null,
    notifiedJoin: false,
    notifiedSpawn: false,
    lastConnectMsgAt: 0,
    lastErrorMsgAt: 0,
  };

  sessions.set(uid, session);

  // Join watchdog: if we never reach 'join', reconnect (prevents "connecting forever")
  const joinWatchdog = setTimeout(async () => {
    const s = sessions.get(uid);
    if (!s || isShuttingDown || s.manualStop) return;

    const bc = s.bedrockClient;
    if (!bc) return;

    if (!bc.isConnected) {
      console.warn(`[Session ${uid}] Join watchdog timeout -> reconnect`);
      bc.close().catch(() => {});
      scheduleAutoReconnect(uid, "join_watchdog_timeout");
    }
  }, CONFIG.CONNECTION_TIMEOUT_MS + CONFIG.JOIN_WATCHDOG_EXTRA_MS);

  session.timers.push(joinWatchdog);

  // Spawn watchdog: if we joined but never spawned (chunks), reconnect (optional safety)
  const spawnWatchdog = setTimeout(async () => {
    const s = sessions.get(uid);
    if (!s || isShuttingDown || s.manualStop) return;

    const bc = s.bedrockClient;
    if (!bc) return;

    if (bc.isConnected && !bc.spawnReady) {
      console.warn(`[Session ${uid}] Spawn watchdog timeout -> reconnect`);
      bc.close().catch(() => {});
      scheduleAutoReconnect(uid, "spawn_watchdog_timeout");
    }
  }, CONFIG.SPAWN_WATCHDOG_MS);

  session.timers.push(spawnWatchdog);

  const bedrockClient = new ImmortalBedrockClient(uid, opts);
  session.bedrockClient = bedrockClient;

  // Notify about resolved host/version
  const prettyTarget = resolved?.resolved && resolved?.original && resolved?.original !== connectHost
    ? `${resolved.original} → ${connectHost}:${port}`
    : `${ip}:${port}`;

  bedrockClient.onJoined = async () => {
    const s = sessions.get(uid);
    if (!s) return;

    s.reconnectAttempt = 0;
    s.reconnectScheduled = false;
    if (s.reconnectTimer) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = null;
    }

    // Save session as active once joined
    await saveSessionData(uid);

    // Cache last known good version if we can infer it
    try {
      const v =
        normalizeClientVersion(bedrockClient.client?.options?.version) ||
        normalizeClientVersion(bedrockClient.client?.version) ||
        normalizeClientVersion(opts.version);
      if (v && /^\d+\.\d+\.\d+/.test(v)) {
        const u2 = getUser(uid);
        if (u2 && u2.lastKnownGoodVersion !== v) {
          u2.lastKnownGoodVersion = v;
          userStore.set(uid, u2);
        }
      }
    } catch {}

    if (!s.notifiedJoin) {
      s.notifiedJoin = true;
      if (interaction) {
        safeReply(interaction, `✅ Joined **${prettyTarget}**. Waiting for spawn/chunks...`).catch(() => {});
      } else {
        logToDiscord(`Bot of <@${uid}> joined ${prettyTarget}`);
      }
    }
  };

  bedrockClient.onSpawned = async () => {
    const s = sessions.get(uid);
    if (!s) return;
    if (s.notifiedSpawn) return;
    s.notifiedSpawn = true;

    if (interaction) {
      safeReply(interaction, "✅ Spawned! Anti‑AFK + movement active.").catch(() => {});
    }
  };

  bedrockClient.onDisconnected = async (reason) => {
    const s = sessions.get(uid);
    if (!s || s.manualStop || isShuttingDown) return;

    // If the underlying client marked manualStop, do not reconnect
    if (s.bedrockClient?.manualStop) {
      console.warn(`[Session ${uid}] manualStop=true, not reconnecting (${reason})`);
      clearSessionData(uid).catch(() => {});
      safeCleanupSession(uid).catch(() => {});
      return;
    }

    // If ping timed out, provide a more useful hint once
    const msg = String(reason || "");
    if (interaction && msg.toLowerCase().includes("ping timed out")) {
      const now = Date.now();
      if (now - s.lastErrorMsgAt > 15000) {
        s.lastErrorMsgAt = now;
        safeReply(
          interaction,
          "⚠️ **Ping timed out.** This usually means UDP to the server is blocked/unreachable (wrong IP/port, firewall, host blocks UDP, or IPv6/hostname issues).\n" +
            "If your server blocks ping/version detection, set **Bedrock Version** in Settings (e.g. `1.21.0`) and try again."
        ).catch(() => {});
      }
    }

    scheduleAutoReconnect(uid, msg || "disconnect");
  };

  // Stale connection watchdog
  const staleWatchdog = setInterval(() => {
    const s = sessions.get(uid);
    if (!s) return clearInterval(staleWatchdog);

    const bc = s.bedrockClient;
    if (!bc) return;

    const stale = Date.now() - bc.lastActivity > CONFIG.STALE_CONNECTION_TIMEOUT_MS;
    if (stale && bc.isConnected && !bc.isCleaningUp) {
      console.warn(`[Session ${uid}] Stale connection detected, forcing reconnect...`);
      scheduleAutoReconnect(uid, "stale");
    }
  }, 30000);

  session.timers.push(staleWatchdog);

  try {
    const ok = await bedrockClient.create();
    if (!ok) throw new Error("Failed to create bedrock client");

    if (interaction) {
      await safeReply(
        interaction,
        `🔄 Connecting to \`${prettyTarget}\`...\n` +
          (desiredVersion ? `• Using version: \`${desiredVersion}\` (skip ping)\n` : "• Using auto version detect (ping)\n") +
          (resolved?.resolved && resolved?.original && resolved?.original !== connectHost ? "• IPv4 preferred for hostname\n" : "")
      );
    }
  } catch (e) {
    console.error(`[Session ${uid}] Start error:`, e?.message);
    if (interaction) await safeReply(interaction, `❌ Connection failed: ${e?.message || "Unknown error"}`);

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

  setInterval(() => {
    const cutoff = Date.now() - 60000;

    for (const [uid, time] of interactionCooldowns) {
      if (time < cutoff) interactionCooldowns.delete(uid);
    }

    for (const [uid, data] of pendingOperations) {
      if (data?.time < cutoff) pendingOperations.delete(uid);
    }

    const msaCutoff = Date.now() - 10 * 60 * 1000;
    for (const [uid, data] of lastMsa) {
      if (data?.at < msaCutoff) lastMsa.delete(uid);
    }

    // DNS cache cleanup
    const dnsCutoff = Date.now() - CONFIG.DNS_CACHE_MS;
    for (const [host, data] of dnsCache) {
      if (data?.at < dnsCutoff) dnsCache.delete(host);
    }
  }, CONFIG.CLEANUP_INTERVAL_MS);

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

    if (!users[uid]) users[uid] = {};
    if (sessionData.server) users[uid].server = sessionData.server;
    if (sessionData.connectionType) users[uid].connectionType = sessionData.connectionType;
    if (sessionData.bedrockVersion) users[uid].bedrockVersion = sessionData.bedrockVersion;
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

    const applyCooldown = !i.isModalSubmit();

    if (applyCooldown && isOnCooldown(uid)) {
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

        const versionInput = new TextInputBuilder()
          .setCustomId("version")
          .setLabel("Bedrock Version (e.g. 1.21.0 or auto)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(u.bedrockVersion || "auto").slice(0, 16))
          .setMaxLength(16);

        modal.addComponents(
          new ActionRowBuilder().addComponents(ipInput),
          new ActionRowBuilder().addComponents(portInput),
          new ActionRowBuilder().addComponents(versionInput)
        );

        return i.showModal(modal).catch((err) => {
          console.error("[Modal] Show error:", err?.message);
          safeReply(i, "Failed to open settings. Try again.").catch(() => {});
        });
      }
    }

    // ===== MODAL SUBMIT =====
    if (i.isModalSubmit() && i.customId === "settings_modal") {
      const ip = i.fields?.getTextInputValue("ip")?.trim();
      const portStr = i.fields?.getTextInputValue("port")?.trim();
      const versionStr = i.fields?.getTextInputValue("version")?.trim();

      const port = parseInt(portStr, 10);

      if (!ip || !portStr) return safeReply(i, "❌ IP and Port are required.");

      if (!isValidIP(ip)) return safeReply(i, "❌ Invalid IP/hostname.");
      if (!isValidPort(port)) return safeReply(i, "❌ Invalid port (1-65535).");

      const normV = normalizeBedrockVersion(versionStr);
      if (!normV) return safeReply(i, "❌ Invalid version. Use `auto` or a version like `1.21.0`.");

      const u = getUser(uid);
      u.server = { ip, port };
      u.bedrockVersion = normV;
      userStore.set(uid, u);

      return safeReply(i, `✅ Saved: **${ip}:${port}** | Version: **${normV}**`);
    }

  } catch (e) {
    console.error("[Interaction] Handler error:", e?.message);
    trackError("interaction", e);

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

  setInterval(() => {
    safeSaveAllData().catch(() => {});
  }, CONFIG.AUTO_SAVE_INTERVAL_MS);

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
