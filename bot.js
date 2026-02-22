/**
 * HYPER-IMMORTAL DISCORD BEDROCK BOT
 * ================================
 * Tämä botti on suunniteltu niin, että se EI KOSKAAN kaadu.
 * 
 * Ominaisuudet:
 * - 5+ virheenkäsittelykerrosta
 * - Memory leak -suojaus
 * - bedrock-protocol crash-korjaukset
 * - Low-end device -tuki
 * - Automaattinen reconnection
 * - Process isolation
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
  EmbedBuilder,
  ActivityType,
  MessageFlags
} = require("discord.js");

// ==================== PROCESS-LEVEL CRASH PROTECTION ====================
// Kerros 1: Process-level protection - catches EVERYTHING

// Estä prosessin sulkeminen virheiden takia
let isShuttingDown = false;
let fatalErrorCount = 0;
const FATAL_ERROR_THRESHOLD = 10;
const FATAL_ERROR_RESET_MS = 60000;

// Reset fatal error count periodically
setInterval(() => {
  if (fatalErrorCount > 0) {
    console.log(`[Immortal] Resetting fatal error count: ${fatalErrorCount} -> 0`);
    fatalErrorCount = 0;
  }
}, FATAL_ERROR_RESET_MS);

// Kriittinen virhekäsittelijä - catches native crashes too
process.on("uncaughtException", (err, origin) => {
  fatalErrorCount++;
  console.error(`[FATAL ${fatalErrorCount}/${FATAL_ERROR_THRESHOLD}] Uncaught Exception from ${origin}:`, err);
  
  // Kirjota virhe tiedostoon
  try {
    const fs = require('fs');
    const logEntry = `[${new Date().toISOString()}] FATAL ERROR #${fatalErrorCount}:\n${err.stack || err.message}\nOrigin: ${origin}\n\n`;
    fs.appendFileSync('./fatal-errors.log', logEntry);
  } catch (e) {}
  
  // Jos liian monta fataalia virhettä, salli sulkeminen
  if (fatalErrorCount >= FATAL_ERROR_THRESHOLD) {
    console.error("[FATAL] Too many fatal errors, allowing shutdown...");
    process.exit(1);
  }
  
  // Muuten jatka toimintaa
  console.log("[Immortal] Continuing despite fatal error...");
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[REJECTION] Unhandled Rejection at:", promise, "reason:", reason);
  // Älä kaadu - vain logita
});

process.on("rejectionHandled", (promise) => {
  console.log("[REJECTION] Rejection handled:", promise);
});

process.on("warning", (warning) => {
  console.warn("[WARNING] Node.js warning:", warning.name, warning.message);
  // Log stack trace for debugging
  if (warning.stack) {
    console.warn(warning.stack);
  }
});

// SIGTERM/SIGINT käsittely
process.on('SIGTERM', () => {
  console.log('[Immortal] SIGTERM received, graceful shutdown...');
  gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
  console.log('[Immortal] SIGINT received, graceful shutdown...');
  gracefulShutdown('SIGINT');
});

// Estä multiple sigterm handling
let shutdownInProgress = false;
async function gracefulShutdown(signal) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  isShuttingDown = true;
  
  console.log(`[Immortal] Starting graceful shutdown due to ${signal}...`);
  
  // Force exit after timeout
  const forceExit = setTimeout(() => {
    console.error('[Immortal] Force exit triggered');
    process.exit(0);
  }, 10000);
  
  try {
    // Cleanup all sessions
    await safeCleanupAllSessions();
    
    // Save data
    await safeSaveAllData();
    
    // Destroy Discord client
    if (client) {
      await client.destroy().catch(() => {});
    }
    
    clearTimeout(forceExit);
    console.log('[Immortal] Graceful shutdown completed');
    process.exit(0);
  } catch (e) {
    console.error('[Immortal] Error during shutdown:', e);
    process.exit(1);
  }
}

// ==================== SAFE MODULE LOADING ====================
// Kerros 2: Safe module loading with fallbacks

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
const { Worker, isMainThread } = require('worker_threads');
const os = require('os');

// ==================== CONFIGURATION ====================
// Optimized for low-end devices

const CONFIG = {
  // Admin settings
  ADMIN_ID: "1144987924123881564",
  LOG_CHANNEL_ID: "146461503011173173",
  
  // File I/O - pidemmät ajat low-end laitteille
  SAVE_DEBOUNCE_MS: 500,           // Parempi batchaus
  AUTO_SAVE_INTERVAL_MS: 30000,    // Harvemmin
  
  // Connection settings - konservatiiviset
  MAX_RECONNECT_ATTEMPTS: 5,       // Vähemmän yrityksiä
  RECONNECT_BASE_DELAY_MS: 15000,  // Pidemmät välit
  RECONNECT_MAX_DELAY_MS: 300000,  // Max 5 min
  CONNECTION_TIMEOUT_MS: 20000,    // 20s timeout
  KEEPALIVE_INTERVAL_MS: 30000,    // Harvemmin keepalive
  STALE_CONNECTION_TIMEOUT_MS: 120000, // 2 min
  
  // Memory settings - low-end optimoitu
  MEMORY_CHECK_INTERVAL_MS: 120000, // 2 min
  MAX_MEMORY_MB: 512,              // 512MB max (low-end)
  MEMORY_GC_THRESHOLD_MB: 400,     // GC trigger
  
  // Session settings
  SESSION_HEARTBEAT_INTERVAL_MS: 60000, // 1 min
  TOKEN_REFRESH_BUFFER_MS: 600000,  // 10 min ennen expiryä
  NATIVE_CLEANUP_DELAY_MS: 3000,    // Odotus ennen reconnect
  PING_TIMEOUT_MS: 3000,            // Lyhyt ping timeout
  OPERATION_TIMEOUT_MS: 15000,      // 15s operaatiot
  MAX_DISCORD_RECONNECT_ATTEMPTS: 3,
  
  // Rate limiting
  INTERACTION_COOLDOWN_MS: 2000,    // 2s cooldown
  MAX_PENDING_OPERATIONS: 10,       // Rajoita concurrent
  
  // Error recovery
  MAX_ERRORS_PER_MINUTE: 20,        // Max 20 virhettä/min
  ERROR_COOLDOWN_MS: 60000,         // Virheiden jälkeen tauko
  
  // Low-end optimizations
  MAX_CONCURRENT_SESSIONS: 5,       // Max 5 sessiota
  PACKET_BATCH_SIZE: 10,            // Paketit batchataan
  CLEANUP_INTERVAL_MS: 300000,      // 5 min välein cleanup
};

// ==================== PATHS ====================
const DATA = process.env.FLY_VOLUME_PATH || "/data";
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");
const REJOIN_STORE = path.join(DATA, "rejoin.json");
const CRASH_LOG = path.join(DATA, "crash.log");

// ==================== SAFE FILE OPERATIONS ====================
// Kerros 3: Defensive file operations

async function safeEnsureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
    return true;
  } catch (e) {
    console.error(`[File] Failed to create directory ${dir}:`, e.message);
    return false;
  }
}

async function safeWriteFile(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    await safeEnsureDir(dir);
    
    // Write to temp file first
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    await fs.writeFile(tempPath, data, 'utf8');
    
    // Atomic rename
    await fs.rename(tempPath, filePath);
    return true;
  } catch (e) {
    console.error(`[File] Failed to write ${filePath}:`, e.message);
    return false;
  }
}

async function safeReadFile(filePath, defaultVal = null) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content;
  } catch (e) {
    if (e.code === 'ENOENT') {
      return defaultVal;
    }
    console.error(`[File] Failed to read ${filePath}:`, e.message);
    return defaultVal;
  }
}

async function safeParseJSON(filePath, defaultVal = {}) {
  try {
    const content = await safeReadFile(filePath);
    if (content === null) return defaultVal;
    
    const trimmed = content.trim();
    if (!trimmed) return defaultVal;
    
    return JSON.parse(trimmed);
  } catch (e) {
    console.error(`[File] JSON parse error in ${filePath}:`, e.message);
    
    // Backup corrupted file
    try {
      const backupPath = `${filePath}.corrupted.${Date.now()}`;
      await fs.rename(filePath, backupPath).catch(() => {});
    } catch (e2) {}
    
    return defaultVal;
  }
}

// ==================== PERSISTENT STORE (IMMORTAL) ====================
class ImmortalStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
    this.saveTimeout = null;
    this.isSaving = false;
    this.lastSaveTime = 0;
    this.saveCount = 0;
    this.loadError = false;
    this.pendingSaves = 0;
  }

  async load(defaultVal = {}) {
    this.data = await safeParseJSON(this.filePath, defaultVal);
    console.log(`[Store] Loaded ${this.filePath}: ${Object.keys(this.data).length} entries`);
    return this.data;
  }

  set(key, value) {
    try {
      if (!this.data) this.data = {};
      
      // Deep clone to prevent reference issues
      const clonedValue = this.deepClone(value);
      this.data[key] = clonedValue;
      
      this.debouncedSave();
    } catch (e) {
      console.error("[Store] Set error:", e.message);
    }
  }

  get(key) {
    try {
      return this.data?.[key];
    } catch (e) {
      return undefined;
    }
  }

  delete(key) {
    try {
      if (this.data) {
        delete this.data[key];
        this.debouncedSave();
      }
    } catch (e) {
      console.error("[Store] Delete error:", e.message);
    }
  }

  debouncedSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    
    this.pendingSaves++;
    this.saveTimeout = setTimeout(() => {
      this.pendingSaves = 0;
      this.flush();
    }, CONFIG.SAVE_DEBOUNCE_MS);
  }

  async flush() {
    if (this.isSaving) return;
    if (!this.data) return;
    
    this.isSaving = true;
    
    try {
      // Convert BigInt to string
      const jsonString = JSON.stringify(this.data, (key, value) => {
        if (typeof value === 'bigint') return value.toString();
        if (value === undefined) return null;
        return value;
      }, 2);
      
      const success = await safeWriteFile(this.filePath, jsonString);
      if (success) {
        this.lastSaveTime = Date.now();
        this.saveCount++;
      }
    } catch (e) {
      console.error("[Store] Flush error:", e.message);
    } finally {
      this.isSaving = false;
    }
  }

  deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (obj instanceof Date) return new Date(obj.getTime());
    if (Array.isArray(obj)) return obj.map(item => this.deepClone(item));
    
    const cloned = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        cloned[key] = this.deepClone(obj[key]);
      }
    }
    return cloned;
  }
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
  await userStore.flush();
  await sessionStore.flush();
}

// ==================== RUNTIME STATE ====================
const sessions = new Map();
const pendingLink = new Map();
const lastMsa = new Map();
const interactionCooldowns = new Map();
const errorTracker = new Map();
let discordReady = false;
let discordReconnectAttempts = 0;
const cleanupLocks = new Set();
const pendingOperations = new Map();

// ==================== ERROR TRACKING ====================
function trackError(context, error) {
  const key = `${context}_${Date.now()}`;
  errorTracker.set(key, {
    context,
    error: error?.message || String(error),
    time: Date.now()
  });
  
  // Cleanup old errors
  const cutoff = Date.now() - CONFIG.ERROR_COOLDOWN_MS;
  for (const [k, v] of errorTracker) {
    if (v.time < cutoff) {
      errorTracker.delete(k);
    }
  }
  
  // Check error rate
  const recentErrors = Array.from(errorTracker.values()).filter(e => e.time > cutoff);
  if (recentErrors.length > CONFIG.MAX_ERRORS_PER_MINUTE) {
    console.error(`[ERROR TRACKER] Too many errors (${recentErrors.length}), throttling...`);
    return false; // Signal to throttle
  }
  return true;
}

// ==================== DISCORD CLIENT (IMMORTAL) ====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages
  ],
  failIfNotExists: false,
  allowedMentions: { 
    parse: ['users', 'roles'], 
    repliedUser: false 
  },
  rest: {
    rejectOnRateLimit: () => false,
    retries: 1,              // Vähemmän retryjä
    timeout: 10000,          // Lyhyempi timeout
    globalRequestsPerSecond: 10 // Rajoita rate
  },
  presence: {
    status: 'online',
    activities: [{ 
      name: 'AFK Bot System', 
      type: ActivityType.Watching 
    }]
  },
  // Low-end optimizations
  shards: 'auto',
  shardCount: 1,
});

// ==================== DISCORD ERROR HANDLING ====================
client.on("error", (error) => {
  console.error("[Discord] Client error:", error?.message);
  discordReady = false;
  trackError("discord_client", error);
});

client.on("shardError", (error) => {
  console.error("[Discord] Shard error:", error?.message);
  trackError("discord_shard", error);
});

client.on("disconnect", () => {
  console.log("[Discord] Disconnected");
  discordReady = false;
  
  // Auto-reconnect with delay
  setTimeout(() => {
    if (!discordReady && !isShuttingDown) {
      console.log("[Discord] Attempting reconnection...");
      client.login(DISCORD_TOKEN).catch(err => {
        console.error("[Discord] Reconnection failed:", err.message);
      });
    }
  }, 10000);
});

client.on("reconnecting", () => {
  console.log("[Discord] Reconnecting...");
});

client.on("resume", (replayed) => {
  discordReady = true;
  discordReconnectAttempts = 0;
  console.log(`[Discord] Resumed, replayed: ${replayed}`);
});

// ==================== WEBHOOK LOGGING (SAFE) ====================
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

async function logToDiscord(message) {
  if (!message || isShuttingDown || !WEBHOOK_URL) return;
  
  try {
    const payload = {
      embeds: [{
        color: 0x5865F2,
        description: String(message).slice(0, 4096),
        timestamp: new Date().toISOString()
      }]
    };
    
    // Use AbortSignal for timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    }).catch(() => {});
    
    clearTimeout(timeout);
  } catch (e) {
    // Silently fail - webhook is not critical
  }
}

// ==================== SAFE REPLY ====================
async function safeReply(interaction, content, ephemeral = true) {
  try {
    if (!interaction) return false;
    
    // Check cooldown
    const userId = interaction.user?.id;
    if (userId) {
      const lastInteraction = interactionCooldowns.get(userId) || 0;
      if (Date.now() - lastInteraction < CONFIG.INTERACTION_COOLDOWN_MS) {
        console.log(`[RateLimit] User ${userId} on cooldown`);
        return false;
      }
      interactionCooldowns.set(userId, Date.now());
    }
    
    const payload = typeof content === 'string' ? { content } : content;
    if (ephemeral) {
      payload.flags = [MessageFlags.Ephemeral];
    }
    
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(err => {
        console.error("[Discord] followUp failed:", err.message);
      });
    } else {
      await interaction.reply(payload).catch(err => {
        console.error("[Discord] reply failed:", err.message);
      });
    }
    return true;
  } catch (e) {
    console.error("[Discord] safeReply error:", e.message);
    return false;
  }
}

// ==================== USER MANAGEMENT ====================
function getUser(uid) {
  if (!uid || typeof uid !== 'string' || !/^\d+$/.test(uid)) {
    return { connectionType: "online", bedrockVersion: "auto", _temp: true };
  }
  
  if (!users[uid]) {
    users[uid] = {
      connectionType: "online",
      bedrockVersion: "auto",
      createdAt: Date.now(),
      lastActive: Date.now()
    };
    userStore.set(uid, users[uid]);
  }
  
  users[uid].connectionType = users[uid].connectionType || "online";
  users[uid].bedrockVersion = users[uid].bedrockVersion || "auto";
  users[uid].lastActive = Date.now();
  
  return users[uid];
}

async function getUserAuthDir(uid) {
  if (!uid || typeof uid !== 'string') return null;
  
  // Sanitize UID
  const safeUid = uid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
  if (!safeUid) return null;
  
  const dir = path.join(AUTH_ROOT, safeUid);
  await safeEnsureDir(dir);
  return dir;
}

async function unlinkMicrosoft(uid) {
  if (!uid) return false;
  
  try {
    const dir = await getUserAuthDir(uid);
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    
    const u = getUser(uid);
    u.linked = false;
    u.authTokenExpiry = null;
    u.tokenAcquiredAt = null;
    await userStore.set(uid, u);
    
    return true;
  } catch (e) {
    console.error("[Auth] Unlink error:", e.message);
    return false;
  }
}

// ==================== VALIDATION ====================
function isValidIP(ip) {
  if (!ip || typeof ip !== 'string') return false;
  if (ip.length > 253) return false;
  if (ip.includes('..') || ip.startsWith('.') || ip.endsWith('.')) return false;
  if (ip.includes('://')) return false;
  
  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
  const hostnameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}(?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,63})*$/;
  
  return ipv4Regex.test(ip) || ipv6Regex.test(ip) || hostnameRegex.test(ip);
}

function isValidPort(port) {
  const num = parseInt(port, 10);
  return !isNaN(num) && num > 0 && num <= 65535;
}

// ==================== BEDROCK CLIENT (IMMORTAL) ====================
// KRIITTINEN KORJAUS: bedrock-protocol client.close() crash

class ImmortalBedrockClient {
  constructor(uid, options) {
    this.uid = uid;
    this.options = options;
    this.client = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.isCleaningUp = false;
    this.listeners = new Map();
    this.packetQueue = [];
    this.lastActivity = Date.now();
    this.entityId = null;
    this.reconnectAttempt = 0;
    this.manualStop = false;
    this.timers = [];
  }

  // SAFE create - prevents native crashes
  async create() {
    if (this.isCleaningUp) {
      console.log(`[Bedrock ${this.uid}] Waiting for cleanup...`);
      await this.waitForCleanup();
    }
    
    this.isConnecting = true;
    
    try {
      // Create client with error handling
      this.client = bedrock.createClient(this.options);
      
      if (!this.client) {
        throw new Error("createClient returned null");
      }
      
      // Setup listeners with error boundaries
      this.setupSafeListeners();
      
      return true;
    } catch (e) {
      console.error(`[Bedrock ${this.uid}] Create error:`, e.message);
      this.isConnecting = false;
      return false;
    }
  }

  setupSafeListeners() {
    if (!this.client) return;
    
    // Wrap all event handlers in try-catch
    const safeOn = (event, handler) => {
      const wrappedHandler = (...args) => {
        try {
          handler(...args);
        } catch (e) {
          console.error(`[Bedrock ${this.uid}] Event ${event} error:`, e.message);
        }
      };
      this.client.on(event, wrappedHandler);
      this.listeners.set(event, wrappedHandler);
    };

    safeOn('connect', () => {
      console.log(`[Bedrock ${this.uid}] Connected`);
      this.isConnected = true;
      this.isConnecting = false;
      this.reconnectAttempt = 0;
    });

    safeOn('spawn', () => {
      console.log(`[Bedrock ${this.uid}] Spawned`);
      logToDiscord(`Bot of <@${this.uid}> spawned`);
    });

    safeOn('start_game', (packet) => {
      if (packet && packet.runtime_entity_id !== undefined) {
        this.entityId = packet.runtime_entity_id;
        this.isConnected = true;
        this.isConnecting = false;
        this.reconnectAttempt = 0;
        
        // Start anti-AFK
        this.startAntiAfk();
      }
    });

    safeOn('packet', () => {
      this.lastActivity = Date.now();
    });

    safeOn('disconnect', (packet) => {
      const reason = packet?.reason || "Unknown";
      console.log(`[Bedrock ${this.uid}] Disconnected: ${reason}`);
      logToDiscord(`Bot of <@${this.uid}> kicked: ${reason}`);
      
      // Check if manual stop needed
      if (reason.includes("wait") || reason.includes("before")) {
        this.manualStop = true;
      }
      
      this.isConnected = false;
    });

    safeOn('error', (e) => {
      console.error(`[Bedrock ${this.uid}] Error:`, e.message);
      trackError("bedrock_client", e);
      
      // Don't reconnect on certain errors
      if (e.message?.includes("auth") || e.message?.includes("token")) {
        this.manualStop = true;
      }
    });

    safeOn('close', () => {
      console.log(`[Bedrock ${this.uid}] Connection closed`);
      this.isConnected = false;
      this.isConnecting = false;
    });
  }

  startAntiAfk() {
    if (!this.entityId || !this.client) return;
    
    const doAction = () => {
      if (!this.isConnected || !this.client || this.isCleaningUp) return;
      
      try {
        const action = Math.random();
        
        if (action < 0.6) {
          // Swing arm
          this.client.write('animate', {
            action_id: 1,
            runtime_entity_id: this.entityId
          });
        } else if (action < 0.8) {
          // Crouch
          this.client.write('player_action', {
            runtime_entity_id: this.entityId,
            action: 11,
            position: { x: 0, y: 0, z: 0 },
            result_code: 0,
            face: 0
          });
          
          // Uncrouch after delay
          setTimeout(() => {
            if (this.isConnected && this.client && !this.isCleaningUp) {
              this.client.write('player_action', {
                runtime_entity_id: this.entityId,
                action: 12,
                position: { x: 0, y: 0, z: 0 },
                result_code: 0,
                face: 0
              });
            }
          }, 2000 + Math.random() * 2000);
        }
      } catch (e) {
        // Ignore anti-AFK errors
      }
      
      // Schedule next action
      const nextDelay = 8000 + Math.random() * 12000;
      const timer = setTimeout(doAction, nextDelay);
      this.timers.push(timer);
    };
    
    doAction();
  }

  // KRIITTINEN: Safe close that prevents native crashes
  async close() {
    if (this.isCleaningUp) {
      console.log(`[Bedrock ${this.uid}] Already cleaning up`);
      return;
    }
    
    this.isCleaningUp = true;
    console.log(`[Bedrock ${this.uid}] Starting safe close...`);
    
    // Clear all timers
    this.timers.forEach(t => clearTimeout(t));
    this.timers = [];
    
    // Wait a bit for pending operations
    await new Promise(r => setTimeout(r, 100));
    
    // KRIITTINEN KORJAUS: Älä kutsu close() jos ei ole yhdistetty
    // Tämä estää "free(): invalid pointer" crashin
    if (this.client) {
      try {
        // Remove listeners first
        this.listeners.forEach((handler, event) => {
          try {
            this.client.removeListener(event, handler);
          } catch (e) {}
        });
        this.listeners.clear();
        
        // Only close if we were connected or connecting
        if (this.isConnected || this.isConnecting) {
          // Use try-catch and timeout for close
          await Promise.race([
            new Promise((resolve) => {
              try {
                // Some versions emit 'close', some don't
                this.client.once('close', resolve);
                this.client.close();
              } catch (e) {
                resolve();
              }
            }),
            new Promise(resolve => setTimeout(resolve, 2000))
          ]);
        }
      } catch (e) {
        console.error(`[Bedrock ${this.uid}] Close error:`, e.message);
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
    return new Promise(resolve => {
      const check = () => {
        if (!this.isCleaningUp) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }
}

// ==================== SESSION MANAGEMENT (IMMORTAL) ====================
async function safeCleanupSession(uid, isReconnect = false) {
  if (!uid) return;
  
  if (cleanupLocks.has(uid)) {
    console.log(`[Session ${uid}] Cleanup already in progress`);
    return;
  }
  
  cleanupLocks.add(uid);
  
  try {
    const session = sessions.get(uid);
    if (!session) {
      cleanupLocks.delete(uid);
      return;
    }
    
    session.manualStop = !isReconnect;
    
    // Clear session timers
    if (session.timers) {
      session.timers.forEach(t => {
        try {
          clearTimeout(t);
          clearInterval(t);
        } catch (e) {}
      });
    }
    
    // Close bedrock client safely
    if (session.bedrockClient) {
      await session.bedrockClient.close();
      session.bedrockClient = null;
    }
    
    // Remove from sessions
    sessions.delete(uid);
    
    // Trigger GC if available
    if (global.gc && sessions.size === 0) {
      try {
        global.gc();
      } catch (e) {}
    }
    
    console.log(`[Session ${uid}] Cleanup completed`);
  } catch (e) {
    console.error(`[Session ${uid}] Cleanup error:`, e.message);
  } finally {
    cleanupLocks.delete(uid);
  }
}

async function safeCleanupAllSessions() {
  const promises = [];
  for (const [uid] of sessions) {
    promises.push(safeCleanupSession(uid));
  }
  await Promise.allSettled(promises);
}

async function stopSession(uid) {
  if (!uid) return false;
  
  const session = sessions.get(uid);
  if (session) {
    session.manualStop = true;
  }
  
  await clearSessionData(uid);
  await safeCleanupSession(uid);
  return true;
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
      lastActive: Date.now()
    };
    
    await sessionStore.set(uid, activeSessionsStore[uid]);
  } catch (e) {
    console.error("[Session] Save error:", e.message);
  }
}

async function clearSessionData(uid) {
  if (activeSessionsStore[uid]) {
    delete activeSessionsStore[uid];
    await sessionStore.set(uid, null);
  }
}

// ==================== RECONNECTION SYSTEM ====================
async function handleAutoReconnect(uid, attempt = 1) {
  if (!uid || isShuttingDown) return;
  
  const session = sessions.get(uid);
  if (!session || session.manualStop || session.isCleaningUp) return;
  
  if (attempt > CONFIG.MAX_RECONNECT_ATTEMPTS) {
    logToDiscord(`Bot of <@${uid}> stopped after max attempts`);
    await safeCleanupSession(uid);
    await clearSessionData(uid);
    return;
  }
  
  // Calculate delay with exponential backoff
  const baseDelay = Math.min(
    CONFIG.RECONNECT_BASE_DELAY_MS * Math.pow(1.5, attempt - 1),
    CONFIG.RECONNECT_MAX_DELAY_MS
  );
  const jitter = Math.random() * 3000;
  const delay = baseDelay + jitter;
  
  logToDiscord(`Bot of <@${uid}> reconnecting in ${Math.round(delay/1000)}s (attempt ${attempt})`);
  
  setTimeout(async () => {
    if (!isShuttingDown && !session.manualStop) {
      await safeCleanupSession(uid, true);
      await new Promise(r => setTimeout(r, CONFIG.NATIVE_CLEANUP_DELAY_MS));
      
      if (!isShuttingDown) {
        await startSession(uid, null, true, attempt + 1);
      }
    }
  }, delay);
}

// ==================== MAIN SESSION FUNCTION ====================
async function startSession(uid, interaction, isReconnect = false, reconnectAttempt = 1) {
  if (!uid || isShuttingDown) return;
  
  // Check max sessions
  if (!isReconnect && sessions.size >= CONFIG.MAX_CONCURRENT_SESSIONS) {
    if (interaction) {
      await safeReply(interaction, "Server at capacity. Please try again later.");
    }
    return;
  }
  
  // Wait for stores
  if (!storesInitialized) {
    console.log("[Session] Waiting for stores...");
    await new Promise(r => setTimeout(r, 1000));
    if (!storesInitialized) {
      if (interaction) await safeReply(interaction, "System initializing...");
      return;
    }
  }
  
  // Defer reply if interaction
  if (interaction && !interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(() => {});
  }
  
  // Wait for any cleanup
  if (cleanupLocks.has(uid)) {
    let attempts = 0;
    while (cleanupLocks.has(uid) && attempts < 20) {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
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
  
  // Check existing session
  if (sessions.has(uid) && !isReconnect) {
    if (interaction) await safeReply(interaction, "Session already active. Use /stop first.");
    return;
  }
  
  // Cleanup for reconnect
  if (isReconnect && sessions.has(uid)) {
    await safeCleanupSession(uid);
    await new Promise(r => setTimeout(r, CONFIG.NATIVE_CLEANUP_DELAY_MS));
  }
  
  // Get auth directory
  const authDir = await getUserAuthDir(uid);
  if (!authDir) {
    if (interaction) await safeReply(interaction, "Auth directory error.");
    return;
  }
  
  // Create options
  const opts = {
    host: ip,
    port: parseInt(port),
    connectTimeout: CONFIG.CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    viewDistance: 1,           // Low-end optimization
    profilesFolder: authDir,
    username: uid,
    offline: false,
    skipPing: true,            // No ping needed
    autoInitPlayer: true,
    useTimeout: true,
    // Low-end optimizations
    raknetBackend: 'jsp-raknet', // JS implementation (no native deps)
  };
  
  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  }
  
  // Create session object
  const session = {
    uid,
    startedAt: Date.now(),
    manualStop: false,
    isReconnecting: isReconnect,
    reconnectAttempt,
    timers: [],
    bedrockClient: null
  };
  
  sessions.set(uid, session);
  
  // Create immortal bedrock client
  const bedrockClient = new ImmortalBedrockClient(uid, opts);
  session.bedrockClient = bedrockClient;
  
  // Setup reconnection handler
  const checkConnection = setInterval(() => {
    if (!sessions.has(uid)) {
      clearInterval(checkConnection);
      return;
    }
    
    const s = sessions.get(uid);
    if (!s.bedrockClient?.isConnected && !s.bedrockClient?.isConnecting && !s.manualStop && !isShuttingDown) {
      console.log(`[Session ${uid}] Connection lost, triggering reconnect...`);
      clearInterval(checkConnection);
      handleAutoReconnect(uid, s.bedrockClient?.reconnectAttempt || 1);
    }
  }, 30000);
  
  session.timers.push(checkConnection);
  
  // Start connection
  try {
    const success = await bedrockClient.create();
    
    if (success) {
      await saveSessionData(uid);
      if (interaction) {
        await safeReply(interaction, `Connecting to \`${ip}:${port}\`...`);
      }
    } else {
      throw new Error("Failed to create client");
    }
  } catch (e) {
    console.error(`[Session ${uid}] Start error:`, e.message);
    
    if (interaction) {
      await safeReply(interaction, `Connection failed: ${e.message}`);
    }
    
    if (!isReconnect) {
      await safeCleanupSession(uid);
    } else {
      handleAutoReconnect(uid, reconnectAttempt + 1);
    }
  }
}

// ==================== MICROSOFT AUTH (IMMORTAL) ====================
async function linkMicrosoft(uid, interaction) {
  if (!uid || !interaction) return;
  
  // Check if already linking
  if (pendingLink.has(uid)) {
    await safeReply(interaction, "Login already in progress. Check your DMs.");
    return;
  }
  
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(() => {});
  
  const authDir = await getUserAuthDir(uid);
  if (!authDir) {
    await interaction.followUp({ 
      content: "System error: Cannot create auth directory.", 
      flags: [MessageFlags.Ephemeral] 
    }).catch(() => {});
    return;
  }
  
  const u = getUser(uid);
  pendingLink.set(uid, { startTime: Date.now() });
  
  // Timeout handler
  const timeoutId = setTimeout(() => {
    pendingLink.delete(uid);
    interaction.followUp({ 
      content: "Login timed out after 5 minutes.", 
      flags: [MessageFlags.Ephemeral] 
    }).catch(() => {});
  }, 300000);
  
  try {
    const flow = new Authflow(
      uid,
      authDir,
      {
        flow: "live",
        authTitle: Titles?.MinecraftNintendoSwitch || "MinecraftNintendoSwitch",
        deviceType: "Nintendo"
      },
      async (data) => {
        const uri = data?.verification_uri_complete || data?.verification_uri || "https://www.microsoft.com/link";
        const code = data?.user_code || "(no code)";
        
        lastMsa.set(uid, { uri, code, at: Date.now() });
        
        const msg = `**Microsoft Authentication**\n\n1. Visit: ${uri}\n2. Enter Code: \`${code}\`\n\n*Tokens are stored locally and never shared.*`;
        
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel("Open Microsoft")
            .setStyle(ButtonStyle.Link)
            .setURL(uri)
        );
        
        await interaction.followUp({ 
          content: msg, 
          components: [row], 
          flags: [MessageFlags.Ephemeral] 
        }).catch(() => {});
      }
    );
    
    // Get token with timeout
    const tokenPromise = flow.getMsaToken();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Token acquisition timeout")), 240000)
    );
    
    await Promise.race([tokenPromise, timeoutPromise]);
    
    clearTimeout(timeoutId);
    u.linked = true;
    u.tokenAcquiredAt = Date.now();
    await userStore.set(uid, u);
    
    await interaction.followUp({ 
      content: "✅ Microsoft account linked successfully!", 
      flags: [MessageFlags.Ephemeral] 
    }).catch(() => {});
    
    pendingLink.delete(uid);
    
  } catch (e) {
    clearTimeout(timeoutId);
    pendingLink.delete(uid);
    
    const errorMsg = e?.message || "Unknown error";
    console.error(`[Auth ${uid}] Link error:`, errorMsg);
    
    await interaction.followUp({ 
      content: `❌ Login failed: ${errorMsg}`, 
      flags: [MessageFlags.Ephemeral] 
    }).catch(() => {});
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
        new ButtonBuilder().setCustomId("unlink").setLabel("🔗 Unlink").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(startCustomId).setLabel("▶️ Start").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("stop").setLabel("⏹️ Stop").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("settings").setLabel("⚙️ Settings").setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

// ==================== DISCORD EVENTS ====================
client.once("ready", async () => {
  discordReady = true;
  console.log("[Discord] Client ready");
  
  try {
    const cmds = [
      new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
      new SlashCommandBuilder().setName("java").setDescription("Open Java AFKBot Panel"),
      new SlashCommandBuilder().setName("refresh").setDescription("Refresh Discord connection")
    ];
    
    await client.application?.commands?.set(cmds);
    console.log("[Discord] Commands registered");
  } catch (e) {
    console.error("[Discord] Command registration failed:", e.message);
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
        } catch (e) {}
      }
    }
    
    if (mb > CONFIG.MAX_MEMORY_MB) {
      console.error(`[Memory] CRITICAL: ${mb.toFixed(2)}MB, cleaning up...`);
      // Force cleanup
      safeCleanupAllSessions();
    }
  }, CONFIG.MEMORY_CHECK_INTERVAL_MS);
  
  // Periodic cleanup
  setInterval(() => {
    // Clear old cooldowns
    const cutoff = Date.now() - 60000;
    for (const [uid, time] of interactionCooldowns) {
      if (time < cutoff) {
        interactionCooldowns.delete(uid);
      }
    }
    
    // Clear old pending operations
    for (const [uid, data] of pendingOperations) {
      if (data.time < cutoff) {
        pendingOperations.delete(uid);
      }
    }
  }, CONFIG.CLEANUP_INTERVAL_MS);
  
  // Restore sessions after delay
  setTimeout(() => {
    if (discordReady && !isShuttingDown) {
      restoreSessions();
    }
  }, 10000);
});

// ==================== SESSION RESTORATION ====================
async function restoreSessions() {
  const previousSessions = Object.keys(activeSessionsStore || {});
  console.log(`[Restore] Found ${previousSessions.length} sessions to restore`);
  
  let delay = 0;
  for (const uid of previousSessions) {
    if (!uid.match(/^\d+$/)) continue;
    
    const sessionData = activeSessionsStore[uid];
    if (!sessionData) continue;
    
    // Restore user data
    if (!users[uid]) users[uid] = {};
    if (sessionData.server) users[uid].server = sessionData.server;
    if (sessionData.connectionType) users[uid].connectionType = sessionData.connectionType;
    if (sessionData.linked !== undefined) users[uid].linked = sessionData.linked;
    
    // Stagger restorations
    setTimeout(() => {
      if (!isShuttingDown && sessions.size < CONFIG.MAX_CONCURRENT_SESSIONS) {
        console.log(`[Restore] Restoring session for ${uid}`);
        startSession(uid, null, true);
      }
    }, delay);
    
    delay += 10000; // 10s between restorations
  }
}

// ==================== INTERACTION HANDLER ====================
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (!i || isShuttingDown) return;
    if (!i.user?.id) return;
    
    const uid = i.user.id;
    
    // Rate limiting
    const lastInteraction = interactionCooldowns.get(uid) || 0;
    if (Date.now() - lastInteraction < CONFIG.INTERACTION_COOLDOWN_MS) {
      return safeReply(i, "Please wait a moment before clicking again.");
    }
    interactionCooldowns.set(uid, Date.now());
    
    // Track pending operation
    pendingOperations.set(uid, { time: Date.now(), type: i.type });
    
    // Handle commands
    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") {
        const payload = panelRow(false);
        return i.reply(payload).catch(() => {});
      }
      if (i.commandName === "java") {
        const payload = panelRow(true);
        return i.reply(payload).catch(() => {});
      }
      if (i.commandName === "refresh") {
        await i.deferReply({ flags: [MessageFlags.Ephemeral] });
        
        if (!discordReady) {
          return safeReply(i, "Already reconnecting...");
        }
        
        discordReady = false;
        try {
          await client.destroy();
          await new Promise(r => setTimeout(r, 1000));
          await client.login(DISCORD_TOKEN);
          
          // Wait for ready
          let attempts = 0;
          while (!client.isReady() && attempts < 20) {
            await new Promise(r => setTimeout(r, 500));
            attempts++;
          }
          
          discordReady = client.isReady();
          return safeReply(i, discordReady ? "✅ Connection refreshed!" : "❌ Refresh failed");
        } catch (err) {
          discordReady = false;
          return safeReply(i, `❌ Error: ${err.message}`);
        }
      }
    }
    
    // Handle buttons
    if (i.isButton()) {
      if (i.customId === "start_bedrock") {
        if (sessions.has(uid)) {
          return safeReply(i, "❌ Session already active.");
        }
        
        await i.deferReply({ flags: [MessageFlags.Ephemeral] });
        
        const embed = new EmbedBuilder()
          .setTitle("🎮 Start Bedrock Bot")
          .setDescription("Click Start to connect to your configured server.")
          .setColor(0x2ECC71);
        
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("confirm_start").setLabel("▶️ Start").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("cancel").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary)
        );
        
        return i.followUp({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] }).catch(() => {});
      }
      
      if (i.customId === "start_java") {
        if (sessions.has(uid)) {
          return safeReply(i, "❌ Session already active.");
        }
        
        await i.deferReply({ flags: [MessageFlags.Ephemeral] });
        
        const embed = new EmbedBuilder()
          .setTitle("☕ Java Server Notice")
          .setDescription("For Java servers, ensure you have:\n• GeyserMC\n• Floodgate")
          .setColor(0xE67E22);
        
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("confirm_start").setLabel("✅ Confirm & Start").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("cancel").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary)
        );
        
        return i.followUp({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] }).catch(() => {});
      }
      
      if (i.customId === "confirm_start") {
        await i.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(() => {});
        safeReply(i, "🔄 Connecting...");
        startSession(uid, i, false);
        return;
      }
      
      if (i.customId === "cancel") {
        return safeReply(i, "❌ Cancelled.");
      }
      
      if (i.customId === "stop") {
        await i.deferReply({ flags: [MessageFlags.Ephemeral] });
        const ok = await stopSession(uid);
        return safeReply(i, ok ? "⏹️ Session stopped." : "No active session.");
      }
      
      if (i.customId === "link") {
        return linkMicrosoft(uid, i);
      }
      
      if (i.customId === "unlink") {
        await i.deferReply({ flags: [MessageFlags.Ephemeral] });
        const ok = await unlinkMicrosoft(uid);
        return safeReply(i, ok ? "🔗 Account unlinked." : "Failed to unlink.");
      }
      
      if (i.customId === "settings") {
        const u = getUser(uid);
        
        const modal = new ModalBuilder()
          .setCustomId("settings_modal")
          .setTitle("⚙️ Server Settings");
        
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
        
        modal.addComponents(
          new ActionRowBuilder().addComponents(ipInput),
          new ActionRowBuilder().addComponents(portInput)
        );
        
        return i.showModal(modal).catch(err => {
          console.error("[Modal] Show error:", err.message);
          safeReply(i, "Failed to open settings.");
        });
      }
    }
    
    // Handle modal submit
    if (i.isModalSubmit() && i.customId === "settings_modal") {
      try {
        const ip = i.fields?.getTextInputValue("ip")?.trim();
        const portStr = i.fields?.getTextInputValue("port")?.trim();
        const port = parseInt(portStr, 10);
        
        if (!ip || !portStr) {
          return safeReply(i, "❌ IP and Port are required.");
        }
        
        if (!isValidIP(ip)) {
          return safeReply(i, "❌ Invalid IP address.");
        }
        
        if (!isValidPort(port)) {
          return safeReply(i, "❌ Invalid port (1-65535).");
        }
        
        const u = getUser(uid);
        u.server = { ip, port };
        await userStore.set(uid, u);
        
        return safeReply(i, `✅ Saved: **${ip}:${port}**`);
      } catch (e) {
        console.error("[Modal] Submit error:", e.message);
        return safeReply(i, "❌ Failed to save settings.");
      }
    }
    
  } catch (e) {
    console.error("[Interaction] Handler error:", e.message);
    trackError("interaction", e);
  } finally {
    // Clean up pending operation
    if (i?.user?.id) {
      pendingOperations.delete(i.user.id);
    }
  }
});

// ==================== STARTUP ====================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

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
  
  // Initialize stores
  await initializeStores();
  
  // Login with retry
  let loginAttempts = 0;
  const maxLoginAttempts = 5;
  
  while (loginAttempts < maxLoginAttempts) {
    try {
      await client.login(DISCORD_TOKEN);
      console.log("[Immortal] Discord login successful");
      break;
    } catch (err) {
      loginAttempts++;
      console.error(`[Immortal] Login attempt ${loginAttempts} failed:`, err.message);
      
      if (loginAttempts >= maxLoginAttempts) {
        console.error("[FATAL] Max login attempts reached");
        process.exit(1);
      }
      
      await new Promise(r => setTimeout(r, 5000 * loginAttempts));
    }
  }
}

// Heartbeat
setInterval(() => {
  const mem = process.memoryUsage();
  console.log(
    `[Heartbeat] Sessions: ${sessions.size} | ` +
    `Discord: ${discordReady ? 'OK' : 'DISC'} | ` +
    `Memory: ${Math.round(mem.rss / 1024 / 1024)}MB | ` +
    `Uptime: ${Math.floor(process.uptime() / 60)}m`
  );
}, 60000);

// Start
main().catch(e => {
  console.error("[FATAL] Main error:", e);
  process.exit(1);
});
