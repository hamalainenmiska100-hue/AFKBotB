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
const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");
const EventEmitter = require('events');

// Increase default max listeners to prevent warnings during reconnects
EventEmitter.defaultMaxListeners = 50;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
    console.error("❌ DISCORD_TOKEN missing");
    process.exit(1);
}

// ==================== CONFIGURATION ====================
const CONFIG = {
    ADMIN_ID: "1144987924123881564",
    LOG_CHANNEL_ID: "1473388236884676729",
    SAVE_DEBOUNCE_MS: 500,
    AUTO_SAVE_INTERVAL_MS: 15000,
    MAX_RECONNECT_ATTEMPTS: Infinity,
    RECONNECT_BASE_DELAY_MS: 10000,
    RECONNECT_MAX_DELAY_MS: 300000,
    CONNECTION_TIMEOUT_MS: 30000,
    KEEPALIVE_INTERVAL_MS: 15000,
    STALE_CONNECTION_TIMEOUT_MS: 60000,
    MEMORY_CHECK_INTERVAL_MS: 60000,
    MAX_MEMORY_MB: 1536,
    SESSION_HEARTBEAT_INTERVAL_MS: 30000,
    TOKEN_REFRESH_BUFFER_MS: 300000,
    NATIVE_CLEANUP_DELAY_MS: 3000,
    PING_TIMEOUT_MS: 5000,
    OPERATION_TIMEOUT_MS: 30000,
    MAX_DISCORD_RECONNECT_ATTEMPTS: Infinity,
    DISCORD_REFRESH_INTERVAL_MS: 120000,
};

// ==================== STORAGE SYSTEM ====================
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");
const REJOIN_STORE = path.join(DATA, "rejoin.json");
const CRASH_LOG = path.join(DATA, "crash.log");
const WAL_FILE = path.join(DATA, "wal.json");
const DEBUG_LOG = path.join(DATA, "debug.log");

function ensureDir(dir) {
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return true;
    } catch (e) {
        console.error(`❌ Failed to create directory ${dir}:`, e.message);
        return false;
    }
}

if (!ensureDir(DATA) || !ensureDir(AUTH_ROOT)) {
    console.error("❌ Critical: Cannot create data directories");
    process.exit(1);
}

// ==================== ENHANCED LOGGING ====================
const debugLogger = {
    log: (type, data) => {
        try {
            const timestamp = new Date().toISOString();
            const entry = `[${timestamp}] [${type}] ${typeof data === 'object' ? JSON.stringify(data) : data}\n`;
            fs.appendFileSync(DEBUG_LOG, entry);
        } catch (e) {}
    }
};

// ==================== WRITE-AHEAD LOGGING SYSTEM ====================
class WriteAheadLog {
    constructor(filePath) {
        this.filePath = filePath;
    }

    write(operation, data) {
        try {
            const entry = {
                timestamp: Date.now(),
                operation,
                data: JSON.stringify(data),
                checksum: this._checksum(data)
            };
            fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
            return true;
        } catch (e) {
            console.error("❌ WAL Write Error:", e.message);
            return false;
        }
    }

    replay(targetStore) {
        if (!fs.existsSync(this.filePath)) return;
        try {
            const lines = fs.readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean);
            let replayed = 0;
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);
                    if (entry.operation === 'update' && entry.data) {
                        const data = JSON.parse(entry.data);
                        Object.assign(targetStore, data);
                        replayed++;
                    }
                } catch (e) { 
                    console.warn("⚠️ Corrupt WAL entry skipped");
                }
            }
            if (replayed > 0) console.log(`📋 WAL Replayed: ${replayed} entries`);
            fs.writeFileSync(this.filePath, '');
        } catch (e) {
            console.error("❌ WAL Replay Error:", e.message);
        }
    }

    clear() {
        try {
            fs.writeFileSync(this.filePath, '');
        } catch (e) {
            console.error("❌ WAL Clear Error:", e.message);
        }
    }

    _checksum(data) {
        const str = JSON.stringify(data);
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash;
    }
}

// ==================== ENHANCED PERSISTENT STORE ====================
class PersistentStore {
    constructor(filePath, wal) {
        this.filePath = filePath;
        this.wal = wal;
        this.data = null;
        this.saveTimeout = null;
        this.isSaving = false;
        this.saveQueue = [];
        this.lastSaveTime = 0;
        this.saveCount = 0;
    }

    load(defaultVal = {}) {
        this.data = defaultVal;
        if (this.wal) {
            this.wal.replay(this.data);
        }
        
        if (fs.existsSync(this.filePath)) {
            try {
                const content = fs.readFileSync(this.filePath, "utf8");
                if (content.trim()) {
                    const parsed = JSON.parse(content);
                    if (typeof parsed === 'object' && parsed !== null) {
                        this.data = { ...this.data, ...parsed };
                    }
                }
            } catch (e) {
                console.error(`❌ Failed to load ${this.filePath}:`, e.message);
                this._backupCorruptFile();
            }
        }
        return this.data;
    }

    _backupCorruptFile() {
        try {
            const backupPath = `${this.filePath}.backup.${Date.now()}`;
            fs.renameSync(this.filePath, backupPath);
            console.log(`💾 Backed up corrupt file to ${backupPath}`);
        } catch (e) {
            console.error("❌ Failed to backup corrupt file:", e.message);
        }
    }

    set(key, value) {
        try {
            if (!this.data) this.data = {};
            this.data[key] = value;
            this.save();
        } catch (e) {
            console.error("❌ Store Set Error:", e.message);
        }
    }

    get(key) {
        try {
            return this.data?.[key];
        } catch (e) {
            console.error("❌ Store Get Error:", e.message);
            return undefined;
        }
    }

    delete(key) {
        try {
            if (this.data) {
                delete this.data[key];
                this.save();
            }
        } catch (e) {
            console.error("❌ Store Delete Error:", e.message);
        }
    }

    save(immediate = false) {
        return new Promise((resolve) => {
            try {
                this.saveQueue.push(resolve);
                
                if (immediate) {
                    this._flush();
                    return;
                }

                if (this.saveTimeout) clearTimeout(this.saveTimeout);
                this.saveTimeout = setTimeout(() => this._flush(), CONFIG.SAVE_DEBOUNCE_MS);
            } catch (e) {
                console.error("❌ Save Schedule Error:", e.message);
                resolve(false);
            }
        });
    }

    async _flush() {
        if (this.isSaving) {
            setTimeout(() => this._flush(), 50);
            return;
        }

        this.isSaving = true;
        const resolvers = [...this.saveQueue];
        this.saveQueue = [];

        const tempPath = `${this.filePath}.tmp`;
        const backupPath = `${this.filePath}.bak`;
        let success = false;

        try {
            if (this.wal) {
                this.wal.write('update', this.data);
            }

            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const jsonString = JSON.stringify(this.data, null, 2);
            
            if (fs.existsSync(this.filePath)) {
                fs.copyFileSync(this.filePath, backupPath);
            }

            fs.writeFileSync(tempPath, jsonString, { encoding: 'utf8', flag: 'w' });
            fs.renameSync(tempPath, this.filePath);
            
            if (this.wal) {
                this.wal.clear();
            }

            this.lastSaveTime = Date.now();
            this.saveCount++;
            success = true;

            if (fs.existsSync(backupPath)) {
                fs.unlinkSync(backupPath);
            }
        } catch (e) {
            console.error("❌ Flush Error:", e.message);
            this._emergencyBackup();
        } finally {
            this.isSaving = false;
            resolvers.forEach(r => r(success));
            
            if (this.saveQueue.length > 0) {
                setTimeout(() => this._flush(), 10);
            }
        }
    }

    _emergencyBackup() {
        try {
            const emergencyPath = `${this.filePath}.emergency.${Date.now()}`;
            fs.writeFileSync(emergencyPath, JSON.stringify(this.data));
            console.log(`🚨 Emergency backup saved to ${emergencyPath}`);
        } catch (e) {
            console.error("❌ Emergency Backup Failed:", e.message);
        }
    }
}

// Initialize stores with WAL
const wal = new WriteAheadLog(WAL_FILE);
const userStore = new PersistentStore(STORE, wal);
const sessionStore = new PersistentStore(REJOIN_STORE, wal);

let users = userStore.load({});
let activeSessionsStore = sessionStore.load({});

// ==================== RUNTIME STATE ====================
const sessions = new Map();
const pendingLink = new Map();
const lastMsa = new Map();
let isShuttingDown = false;
let discordReady = false;
let discordReconnectAttempts = 0;
let isFirstReady = true;
let memoryCheckInterval = null;

// ==================== ENHANCED DISCORD CLIENT ====================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessages
    ],
    failIfNotExists: false,
    allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
    rest: {
        rejectOnRateLimit: (data) => {
            console.warn(`⚠️ Rate Limit Hit: ${data.route} - ${data.retryAfter}ms`);
            return false;
        },
        retries: 3,
        timeout: 30000
    },
    presence: {
        status: 'online',
        activities: [{ name: 'AFK Bot System', type: ActivityType.Watching }]
    },
    ws: {
        large_threshold: 50,
        compress: false
    }
});

// ==================== CRASH PREVENTION SYSTEM ====================
const crashLogger = {
    log: (type, err) => {
        try {
            const timestamp = new Date().toISOString();
            const errorMsg = `[${timestamp}] ${type}:\n${err?.stack || err?.message || err}\n\n`;
            fs.appendFileSync(CRASH_LOG, errorMsg);
            debugLogger.log('ERROR', { type, message: err?.message, stack: err?.stack });
        } catch (e) {
            console.error("Failed to write to crash log:", e);
        }
    },
    
    isFatal: (err) => {
        const fatalCodes = ['EADDRINUSE', 'EACCES', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'];
        return fatalCodes.includes(err?.code) || fatalCodes.includes(err?.syscall);
    }
};

// ==================== PROCESS ERROR LISTENERS ====================
process.on("uncaughtException", (err) => {
    console.error("💥 UNCAUGHT EXCEPTION:", err);
    crashLogger.log("UNCAUGHT EXCEPTION", err);
    if (crashLogger.isFatal(err)) {
        console.error("🚨 Fatal error detected, shutting down...");
        gracefulShutdown('FATAL_ERROR');
    }
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("💥 UNHANDLED REJECTION at:", promise, "reason:", reason);
    crashLogger.log("UNHANDLED REJECTION", reason);
});

process.on("warning", (warning) => {
    console.warn("⚠️ PROCESS WARNING:", warning.name, warning.message);
    if (warning.name === 'MaxListenersExceededWarning') {
        console.error('🚨 Max Listeners Exceeded - potential memory leak');
        crashLogger.log('MAX_LISTENERS_WARNING', warning);
    }
    if (warning.name === 'DeprecationWarning') {
        debugLogger.log('DEPRECATION', warning.message);
    }
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('beforeExit', (code) => {
    console.log(`🔚 Process beforeExit with code: ${code}`);
});

process.on('exit', (code) => {
    console.log(`🔚 Process exit with code: ${code}`);
});

// Monitor EventEmitter leaks globally
const originalOn = EventEmitter.prototype.on;
EventEmitter.prototype.on = function(event, listener) {
    const count = this.listenerCount(event);
    if (count >= 10) {
        console.warn(`⚠️ High listener count (${count}) for event "${event}" on ${this.constructor.name}`);
    }
    return originalOn.call(this, event, listener);
};

// ==================== DISCORD CONNECTION RESILIENCE ====================
client.on("error", (error) => {
    console.error("❌ DISCORD CLIENT ERROR:", error.message, error.code ? `(Code: ${error.code})` : '');
    crashLogger.log("DISCORD CLIENT ERROR", error);
});

client.on("shardError", (error) => {
    console.error("❌ SHARD ERROR:", error.message);
    crashLogger.log("SHARD ERROR", error);
});

client.on("warn", (warning) => {
    console.warn("⚠️ DISCORD WARN:", warning);
});

client.on("disconnect", (event) => {
    discordReady = false;
    console.log(`🔌 Discord websocket closed (code: ${event?.code || 'unknown'}, reason: ${event?.reason || 'unknown'})`);
});

client.on("reconnecting", () => {
    console.log("🔄 Discord reconnecting...");
});

client.on("ready", () => {
    discordReady = true;
    discordReconnectAttempts = 0;
    console.log("✅ Discord connected successfully");
});

// NEW: Session invalidation listener (critical auth error)
client.on("invalidated", () => {
    console.error("🚨 DISCORD SESSION INVALIDATED - The session became invalid");
    crashLogger.log("SESSION_INVALIDATED", new Error("Discord session invalidated"));
    discordReady = false;
});

// NEW: Rate limit listener
client.on("rateLimit", (rateLimitInfo) => {
    console.warn(`⏳ RATE LIMITED: ${rateLimitInfo.method} ${rateLimitInfo.route} - Retry after: ${rateLimitInfo.retryAfter}ms`);
    debugLogger.log('RATE_LIMIT', rateLimitInfo);
});

// NEW: Debug listener (verbose, but catches low-level issues)
client.on("debug", (info) => {
    if (info.includes('error') || info.includes('Error') || info.includes('failed') || info.includes('timeout')) {
        console.log(`🔍 Discord Debug (Error-related): ${info}`);
        debugLogger.log('DISCORD_DEBUG', info);
    }
});

// NEW: Guild availability errors
client.on("guildUnavailable", (guild) => {
    console.warn(`🏰 Guild became unavailable: ${guild.name} (${guild.id})`);
});

client.on("guildCreate", (guild) => {
    console.log(`🏰 Joined new guild: ${guild.name} (${guild.id})`);
});

client.on("guildDelete", (guild) => {
    console.log(`🏰 Left guild: ${guild.name} (${guild.id})`);
});

// ==================== GRACEFUL SHUTDOWN ====================
function gracefulShutdown(signal) {
    try {
        console.log(`🛑 Graceful shutdown initiated (${signal})...`);
        isShuttingDown = true;
        const forceExit = setTimeout(() => {
            console.error("💥 Force exit after timeout");
            process.exit(1);
        }, 15000);
        
        Promise.all([
            userStore.save(true),
            sessionStore.save(true)
        ]).then(() => {
            console.log("💾 Data saved");
            return cleanupAllSessions();
        }).then(() => {
            console.log("🔌 Sessions cleaned up");
            return client.destroy();
        }).then(() => {
            console.log("✅ Discord client destroyed");
            clearTimeout(forceExit);
            process.exit(0);
        }).catch((err) => {
            console.error("❌ Error during shutdown:", err);
            process.exit(1);
        });
    } catch (e) {
        console.error("❌ Critical shutdown error:", e);
        process.exit(1);
    }
}

// ==================== SESSION MANAGEMENT ====================
async function cleanupSession(uid) {
    if (!uid) return;
    const s = sessions.get(uid);
    if (!s) return;

    if (s.isCleaningUp) {
        console.log(`⚠️ Session ${uid} already cleaning up`);
        return;
    }
    s.isCleaningUp = true;
    
    console.log(`🧹 Cleaning up session ${uid}...`);
    
    try {
        const timers = ['reconnectTimer', 'afkTimeout', 'keepaliveTimer', 'staleCheckTimer', 'tokenRefreshTimer'];
        timers.forEach(timer => {
            try {
                if (s[timer]) {
                    clearTimeout(s[timer]);
                    clearInterval(s[timer]);
                    s[timer] = null;
                }
            } catch (e) {
                console.error(`❌ Error clearing ${timer} for ${uid}:`, e.message);
            }
        });

        if (s.client) {
            try {
                console.log(`🔌 Closing bedrock client for ${uid}`);
                s.client.removeAllListeners();
                await new Promise(r => setTimeout(r, 500));
                s.client.close();
                s.client = null;
            } catch (e) {
                console.error(`❌ Error closing client for ${uid}:`, e.message);
            }
        }
        
        await new Promise(resolve => setTimeout(resolve, CONFIG.NATIVE_CLEANUP_DELAY_MS));
    } catch (e) {
        console.error(`❌ Cleanup error for ${uid}:`, e.message);
    }
    
    try {
        sessions.delete(uid);
        console.log(`✅ Session ${uid} cleaned up`);
    } catch (e) {
        console.error(`❌ Error deleting session ${uid} from Map:`, e.message);
    }
}

async function cleanupAllSessions() {
    console.log(`🧹 Cleaning up ${sessions.size} sessions...`);
    try {
        const promises = [];
        for (const [uid, session] of sessions) {
            promises.push(cleanupSession(uid));
        }
        await Promise.all(promises);
        console.log("✅ All sessions cleaned up");
    } catch (e) {
        console.error("❌ Error in cleanupAllSessions:", e.message);
    }
}

async function stopSession(uid) {
    if (!uid) return false;
    
    try {
        console.log(`⏹ Stopping session ${uid}...`);
        const s = sessions.get(uid);
        if (s) {
            s.manualStop = true;
            if (s.reconnectTimer) {
                clearTimeout(s.reconnectTimer);
                s.reconnectTimer = null;
            }
        }
        
        if (activeSessionsStore[uid]) {
            delete activeSessionsStore[uid];
            await sessionStore.save();
        }
        await cleanupSession(uid);
        console.log(`✅ Session ${uid} stopped`);
    } catch (e) {
        console.error(`❌ Error stopping session ${uid}:`, e.message);
        return false;
    }
    return true;
}

// ==================== RECONNECTION SYSTEM ====================
function handleAutoReconnect(uid, attempt = 1) {
    try {
        if (!uid || isShuttingDown) {
            console.log(`🚫 Reconnect blocked for ${uid} (shutting down: ${isShuttingDown})`);
            return;
        }
        const s = sessions.get(uid);
        if (!s || s.manualStop || s.isReconnecting || s.isCleaningUp) {
            console.log(`🚫 Reconnect blocked for ${uid} (manualStop: ${s?.manualStop}, isReconnecting: ${s?.isReconnecting}, isCleaningUp: ${s?.isCleaningUp})`);
            return;
        }

        if (attempt > CONFIG.MAX_RECONNECT_ATTEMPTS) {
            try {
                logToDiscord(`🚫 Bot of <@${uid}> stopped after max failed attempts.`);
                cleanupSession(uid);
                delete activeSessionsStore[uid];
                sessionStore.save();
            } catch (e) {
                console.error("❌ Error in max reconnect handler:", e.message);
            }
            return;
        }

        if (s.reconnectTimer) clearTimeout(s.reconnectTimer);

        s.isReconnecting = true;
        s.reconnectAttempt = attempt;
        
        const baseDelay = Math.min(
            CONFIG.RECONNECT_BASE_DELAY_MS * Math.pow(1.5, attempt - 1),
            CONFIG.RECONNECT_MAX_DELAY_MS
        );
        const jitter = Math.random() * 5000;
        const nativeDelay = attempt === 1 ? CONFIG.NATIVE_CLEANUP_DELAY_MS : 0;
        const delay = baseDelay + jitter + nativeDelay;
        
        console.log(`⏳ Scheduling reconnect for ${uid} in ${Math.round(delay/1000)}s (Attempt ${attempt})`);
        
        try {
            logToDiscord(`⏳ Bot of <@${uid}> disconnected. Reconnecting in ${Math.round(delay/1000)}s (Attempt ${attempt})...`);
        } catch (e) {
            console.error("❌ Error logging to Discord:", e.message);
        }

        s.reconnectTimer = setTimeout(() => {
            try {
                if (!isShuttingDown && !s.manualStop) {
                    console.log(`🔄 Executing reconnect for ${uid} (Attempt ${attempt})`);
                    startSession(uid, null, true, attempt + 1);
                } else {
                    console.log(`🚫 Reconnect cancelled for ${uid} (shutting down or manual stop)`);
                    cleanupSession(uid);
                }
            } catch (e) {
                console.error(`❌ Error in reconnect timeout for ${uid}:`, e.message);
            }
        }, delay);
    } catch (e) {
        console.error(`❌ Error in handleAutoReconnect for ${uid}:`, e.message);
    }
}

// ==================== CONNECTION HEALTH MONITORING ====================
function startHealthMonitoring(uid) {
    try {
        const s = sessions.get(uid);
        if (!s) {
            console.error(`❌ Cannot start health monitoring - session ${uid} not found`);
            return;
        }

        console.log(`🏥 Starting health monitoring for ${uid}`);

        s.keepaliveTimer = setInterval(() => {
            try {
                if (!s.connected || !s.client) return;
                s.client.queue('client_cache_status', { enabled: false });
                s.lastKeepalive = Date.now();
            } catch (e) {
                console.error(`❌ Keepalive error for ${uid}:`, e.message);
                try {
                    if (!s.isReconnecting && !s.isCleaningUp && !s.manualStop) handleAutoReconnect(uid, s.reconnectAttempt + 1);
                } catch (err) {
                    console.error(`❌ Error triggering reconnect from keepalive for ${uid}:`, err.message);
                }
            }
        }, CONFIG.KEEPALIVE_INTERVAL_MS);

        s.staleCheckTimer = setInterval(() => {
            try {
                if (!s.connected) return;
                const lastActivity = Math.max(s.lastPacketTime || 0, s.lastKeepalive || 0);
                if (Date.now() - lastActivity > CONFIG.STALE_CONNECTION_TIMEOUT_MS) {
                    console.warn(`⚠️ Stale connection detected for ${uid} (Last activity: ${Math.round((Date.now() - lastActivity)/1000)}s ago)`);
                    try {
                        s.client?.close();
                    } catch (e) {
                        console.error(`❌ Error closing stale connection for ${uid}:`, e.message);
                    }
                    if (!s.isReconnecting && !s.isCleaningUp && !s.manualStop) handleAutoReconnect(uid, s.reconnectAttempt + 1);
                }
            } catch (e) {
                console.error(`❌ Stale check error for ${uid}:`, e.message);
            }
        }, CONFIG.STALE_CONNECTION_TIMEOUT_MS);
    } catch (e) {
        console.error(`❌ Error starting health monitoring for ${uid}:`, e.message);
    }
}

// ==================== USER MANAGEMENT ====================
function getUser(uid) {
    try {
        if (!uid || typeof uid !== 'string' || !/^\d+$/.test(uid)) {
            console.error(`❌ Invalid UID format: ${uid}`);
            return { connectionType: "online", bedrockVersion: "auto", _temp: true };
        }
        
        if (!users[uid]) {
            users[uid] = {
                connectionType: "online",
                bedrockVersion: "auto",
                createdAt: Date.now(),
                lastActive: Date.now()
            };
            userStore.save();
        }
        
        users[uid].connectionType = users[uid].connectionType || "online";
        users[uid].bedrockVersion = users[uid].bedrockVersion || "auto";
        users[uid].lastActive = Date.now();
        
        return users[uid];
    } catch (e) {
        console.error(`❌ Error in getUser(${uid}):`, e.message);
        return { connectionType: "online", bedrockVersion: "auto", _temp: true };
    }
}

function getUserAuthDir(uid) {
    try {
        if (!uid || typeof uid !== 'string') return null;
        const safeUid = uid.replace(/[^a-zA-Z0-9]/g, '');
        if (!safeUid) return null;
        
        const dir = path.join(AUTH_ROOT, safeUid);
        if (!ensureDir(dir)) return null;
        return dir;
    } catch (e) {
        console.error(`❌ Error getting auth dir for ${uid}:`, e.message);
        return null;
    }
}

async function unlinkMicrosoft(uid) {
    try {
        if (!uid) return false;
        const dir = getUserAuthDir(uid);
        if (dir) {
            try { 
                fs.rmSync(dir, { recursive: true, force: true });
                console.log(`🗑 Removed auth directory for ${uid}`);
            } catch (e) {
                console.error(`❌ Error removing auth dir for ${uid}:`, e.message);
            }
        }
        const u = getUser(uid);
        u.linked = false;
        u.authTokenExpiry = null;
        await userStore.save();
        return true;
    } catch (e) {
        console.error(`❌ Error unlinking Microsoft for ${uid}:`, e.message);
        return false;
    }
}

// ==================== VALIDATION ====================
function isValidIP(ip) {
    try {
        if (!ip || typeof ip !== 'string') return false;
        if (ip.length > 253) return false;
        if (ip.includes('..') || ip.startsWith('.') || ip.endsWith('.')) return false;
        if (ip.includes('://')) return false;
        
        const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
        const hostnameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
        
        return ipv4Regex.test(ip) || ipv6Regex.test(ip) || hostnameRegex.test(ip);
    } catch (e) {
        console.error("❌ Error in isValidIP:", e.message);
        return false;
    }
}

function isValidPort(port) {
    try {
        const num = parseInt(port, 10);
        return !isNaN(num) && num > 0 && num <= 65535;
    } catch (e) {
        console.error("❌ Error in isValidPort:", e.message);
        return false;
    }
}

// ==================== DISCORD HELPERS ====================
async function logToDiscord(message) {
    try {
        if (!message || isShuttingDown || !discordReady) return;
        const channel = await client.channels.fetch(CONFIG.LOG_CHANNEL_ID).catch((e) => {
            console.error("❌ Failed to fetch log channel:", e.message);
            return null;
        });
        if (!channel) return;
        
        const embed = new EmbedBuilder()
            .setColor("#5865F2")
            .setDescription(String(message).slice(0, 4096))
            .setTimestamp();
            
        await channel.send({ embeds: [embed] }).catch((e) => {
            console.error("❌ Failed to send log message:", e.message);
        });
    } catch (e) {
        console.error("❌ Error in logToDiscord:", e.message);
    }
}

async function safeReply(interaction, content) {
    try {
        if (!interaction || !client.isReady()) {
            console.log("⚠️ safeReply: Interaction or client not ready");
            return;
        }
        
        const created = interaction.createdTimestamp;
        if (Date.now() - created > 900000) {
            console.log("⚠️ safeReply: Interaction too old");
            return;
        }
        
        const payload = typeof content === 'string' ? { content } : content;
        
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply(payload).catch((e) => {
                console.error("❌ EditReply error:", e.message);
            });
        } else {
            await interaction.reply(payload).catch((err) => {
                if (err.code === 10062) {
                    console.log("⚠️ Interaction expired (10062)");
                    return;
                }
                console.error("❌ Reply error:", err.message);
            });
        }
    } catch (e) {
        console.error("❌ Error in safeReply:", e.message);
    }
}

// ==================== UI COMPONENTS ====================
function panelRow(isJava = false) {
    try {
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
                    new ButtonBuilder().setCustomId("refresh_discord").setLabel("🔄 Check Status").setStyle(ButtonStyle.Primary)
                )
            ]
        };
    } catch (e) {
        console.error("❌ Error in panelRow:", e.message);
        return { content: "Error generating panel", components: [] };
    }
}

// ==================== MICROSOFT AUTHENTICATION ====================
async function linkMicrosoft(uid, interaction) {
    try {
        if (!uid || !interaction) {
            console.error("❌ linkMicrosoft: Missing uid or interaction");
            return;
        }
        
        if (pendingLink.has(uid)) {
            return safeReply(interaction, { content: "⏳ Login already in progress. Check your DMs or use the last code.", flags: [MessageFlags.Ephemeral] });
        }
        
        const authDir = getUserAuthDir(uid);
        if (!authDir) {
            return safeReply(interaction, { content: "❌ System error: Cannot create auth directory.", flags: [MessageFlags.Ephemeral] });
        }
        
        const u = getUser(uid);
        let codeShown = false;

        const timeoutId = setTimeout(() => {
            try {
                if (pendingLink.has(uid)) {
                    pendingLink.delete(uid);
                    console.log(`⏰ Auth timeout for ${uid}`);
                    safeReply(interaction, { content: "⏰ Login timed out after 5 minutes.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
                }
            } catch (e) {
                console.error("❌ Error in auth timeout handler:", e.message);
            }
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
                    try {
                        const uri = data?.verification_uri_complete || data?.verification_uri || "https://www.microsoft.com/link";
                        const code = data?.user_code || "(no code)";
                        lastMsa.set(uid, { uri, code, at: Date.now() });
                        codeShown = true;
                        
                        const msg = `🔐 **Microsoft Authentication Required**\n\n1. Visit: ${uri}\n2. Enter Code: \`${code}\`\n\n🔒 **Security Notice:** Your account tokens are saved locally and are never shared.`;
                        
                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setLabel("🌐 Open link")
                                .setStyle(ButtonStyle.Link)
                                .setURL(uri)
                        );
                        
                        await interaction.editReply({ content: msg, components: [row] }).catch((e) => {
                            console.error("❌ Error editing reply with auth code:", e.message);
                        });
                    } catch (e) {
                        console.error("❌ Error in auth callback:", e.message);
                    }
                }
            );

            const authPromise = flow.getMsaToken().then(async () => {
                try {
                    clearTimeout(timeoutId);
                    u.linked = true;
                    u.tokenAcquiredAt = Date.now();
                    await userStore.save();
                    await interaction.followUp({ content: "✅ Microsoft account linked!", flags: [MessageFlags.Ephemeral] }).catch((e) => {
                        console.error("❌ Error sending auth success followUp:", e.message);
                    });
                } catch (e) {
                    console.error("❌ Error in auth success handler:", e.message);
                }
            }).catch(async (e) => {
                try {
                    clearTimeout(timeoutId);
                    const errorMsg = e?.message || "Unknown error";
                    console.error(`❌ Auth failed for ${uid}:`, errorMsg);
                    await interaction.editReply({ content: `❌ Login failed: ${errorMsg}` }).catch((e) => {
                        console.error("❌ Error editing reply with auth failure:", e.message);
                    });
                } catch (err) {
                    console.error("❌ Error in auth error handler:", err.message);
                }
            }).finally(() => { 
                try {
                    pendingLink.delete(uid);
                } catch (e) {
                    console.error("❌ Error cleaning up pendingLink:", e.message);
                }
            });
            
            pendingLink.set(uid, authPromise);
            
        } catch (e) {
            try {
                clearTimeout(timeoutId);
                pendingLink.delete(uid);
                console.error("❌ Auth system error:", e.message);
                safeReply(interaction, { content: "❌ Authentication system error.", flags: [MessageFlags.Ephemeral] });
            } catch (err) {
                console.error("❌ Error in auth catch block:", err.message);
            }
        }
    } catch (e) {
        console.error("❌ Critical error in linkMicrosoft:", e.message);
    }
}

// ==================== MAIN SESSION FUNCTION ====================
async function startSession(uid, interaction, isReconnect = false, reconnectAttempt = 1) {
    try {
        if (!uid || isShuttingDown) {
            console.log(`🚫 startSession blocked for ${uid} (shutting down: ${isShuttingDown})`);
            return;
        }
        
        console.log(`🚀 Starting session for ${uid} (Reconnect: ${isReconnect}, Attempt: ${reconnectAttempt})`);
        
        const existingSession = sessions.get(uid);
        if (existingSession?.isCleaningUp) {
            console.log(`⏳ Waiting for cleanup of ${uid}...`);
            try {
                await new Promise(resolve => setTimeout(resolve, CONFIG.NATIVE_CLEANUP_DELAY_MS + 500));
            } catch (e) {
                console.error("❌ Error in cleanup wait:", e.message);
            }
        }
        
        const u = getUser(uid);
        if (!u) {
            console.error(`❌ User data error for ${uid}`);
            if (!isReconnect) safeReply(interaction, { content: "❌ User data error.", flags: [MessageFlags.Ephemeral] });
            return;
        }

        if (!activeSessionsStore) activeSessionsStore = {};
        
        if (!activeSessionsStore[uid]) {
            try {
                activeSessionsStore[uid] = { 
                    startedAt: Date.now(),
                    server: u.server,
                    reconnectCount: 0
                };
                await sessionStore.save();
            } catch (e) {
                console.error("❌ Error saving session store:", e.message);
            }
        }

        if (!u.server || !u.server.ip) {
            console.log(`⚠️ No server configured for ${uid}`);
            if (!isReconnect) safeReply(interaction, { content: "⚠️ Please configure your server settings first.", flags: [MessageFlags.Ephemeral] });
            try {
                delete activeSessionsStore[uid];
                await sessionStore.save();
            } catch (e) {
                console.error("❌ Error clearing session store:", e.message);
            }
            return;
        }

        const { ip, port } = u.server;
        
        if (!isValidIP(ip) || !isValidPort(port)) {
            console.error(`❌ Invalid server config for ${uid}: ${ip}:${port}`);
            if (!isReconnect) safeReply(interaction, { content: "❌ Invalid server IP or port format.", flags: [MessageFlags.Ephemeral] });
            try {
                delete activeSessionsStore[uid];
                await sessionStore.save();
            } catch (e) {
                console.error("❌ Error saving after validation fail:", e.message);
            }
            return;
        }

        if (sessions.has(uid) && !isReconnect) {
            console.log(`⚠️ Session conflict for ${uid}`);
            return safeReply(interaction, { 
                content: "⚠️ **Session Conflict**: Active session already exists. Use `/stop` first.", 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        if (isReconnect && sessions.has(uid)) {
            console.log(`🧹 Cleaning up existing session for reconnect ${uid}`);
            await cleanupSession(uid);
            try {
                await new Promise(resolve => setTimeout(resolve, CONFIG.NATIVE_CLEANUP_DELAY_MS));
            } catch (e) {
                console.error("❌ Error in reconnect delay:", e.message);
            }
        }

        const connectionEmbed = new EmbedBuilder()
            .setColor("#5865F2")
            .setTitle("Bot Initialization")
            .setThumbnail("https://files.catbox.moe/9mqpoz.gif");

        if (!isReconnect && interaction) {
            try {
                connectionEmbed.setDescription(`🔍 **Pinging server...**\n🌐 **Target:** \`${ip}:${port}\``);
                await safeReply(interaction, { embeds: [connectionEmbed], components: [] });

                try {
                    await bedrock.ping({ 
                        host: ip, 
                        port: parseInt(port) || 19132, 
                        timeout: CONFIG.PING_TIMEOUT_MS 
                    });
                    connectionEmbed.setDescription(`✅ **Server responded! Joining...**\n🌐 **Target:** \`${ip}:${port}\``);
                } catch (err) {
                    console.warn(`⚠️ Ping failed for ${ip}:${port} -`, err.message);
                    connectionEmbed.setDescription(`⚠️ **Ping failed, attempting direct connection...**\n🌐 **Target:** \`${ip}:${port}\``);
                }
                
                await safeReply(interaction, { embeds: [connectionEmbed] });
            } catch (err) {
                console.error("❌ Ping error:", err.message);
            }
        }

        const authDir = getUserAuthDir(uid);
        if (!authDir) {
            console.error(`❌ Auth directory error for ${uid}`);
            if (!isReconnect) safeReply(interaction, { content: "❌ Auth directory error.", flags: [MessageFlags.Ephemeral] });
            return;
        }

        const opts = {
            host: ip,
            port: parseInt(port),
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

        let mc;
        try {
            console.log(`🔌 Creating bedrock client for ${uid} -> ${ip}:${port}`);
            mc = bedrock.createClient(opts);
        } catch (err) {
            console.error("❌ Create client error:", err.message);
            if (!isReconnect) {
                safeReply(interaction, { content: "❌ Failed to create client.", flags: [MessageFlags.Ephemeral] });
            }
            if (isReconnect) handleAutoReconnect(uid, reconnectAttempt);
            return;
        }

        const currentSession = {
            client: mc,
            startedAt: Date.now(),
            manualStop: false,
            connected: false,
            isReconnecting: false,
            isCleaningUp: false,
            reconnectAttempt: reconnectAttempt,
            entityId: null,
            reconnectTimer: null,
            afkTimeout: null,
            keepaliveTimer: null,
            staleCheckTimer: null,
            lastPacketTime: Date.now(),
            lastKeepalive: Date.now(),
            packetsReceived: 0
        };
        
        try {
            sessions.set(uid, currentSession);
            console.log(`✅ Session ${uid} registered in Map`);
        } catch (e) {
            console.error("❌ Error registering session:", e.message);
            return;
        }

        // ==================== BEDROCK CLIENT LISTENERS ====================
        
        // NEW: Connection established (TCP level)
        mc.on('connect', () => {
            console.log(`[${uid}] 🔌 TCP Connected to ${ip}:${port}`);
        });

        // NEW: Login packet exchange complete
        mc.on('login', () => {
            console.log(`[${uid}] 📤 Login packet exchanged`);
        });

        mc.on('disconnect', (packet) => {
            try {
                const reason = packet?.reason || "Unknown reason";
                console.log(`[${uid}] 📴 Server requested disconnect: ${reason}`);
                logToDiscord(`⚠️ Bot of <@${uid}> was kicked: ${reason}`);
                
                if (reason.includes("wait") || reason.includes("etwas") || reason.includes("before")) {
                    console.log(`[${uid}] ⛔ Rate limited by server, stopping reconnects`);
                    currentSession.manualStop = true;
                    delete activeSessionsStore[uid];
                    sessionStore.save().catch(e => console.error("❌ Error saving after rate limit:", e.message));
                }
            } catch (e) {
                console.error(`[${uid}] ❌ Error in disconnect handler:`, e.message);
            }
        });

        // NEW: Session end listener
        mc.on('session_end', (reason) => {
            console.log(`[${uid}] 🏁 Session ended:`, reason);
        });

        // NEW: Connection error (pre-spawn)
        mc.on('conn_error', (err) => {
            console.error(`[${uid}] 💥 Connection Error:`, err.message);
        });

        const performAntiAfk = () => {
            try {
                if (!sessions.has(uid) || isShuttingDown) return;
                const s = sessions.get(uid);
                if (!s || !s.connected || s.isCleaningUp) return;

                try {
                    if (s.entityId && s.client) {
                        const action = Math.random();
                        
                        if (action < 0.6) {
                            s.client.write('animate', { 
                                action_id: 1, 
                                runtime_entity_id: s.entityId 
                            });
                        } else if (action < 0.8) {
                            s.client.write('player_action', {
                                runtime_entity_id: s.entityId,
                                action: 11,
                                position: { x: 0, y: 0, z: 0 },
                                result_code: 0,
                                face: 0
                            });
                            
                            setTimeout(() => {
                                try {
                                    const currentS = sessions.get(uid);
                                    if (currentS?.connected && currentS?.client && currentS?.entityId && !currentS.isCleaningUp) {
                                        currentS.client.write('player_action', {
                                            runtime_entity_id: currentS.entityId,
                                            action: 12,
                                            position: { x: 0, y: 0, z: 0 },
                                            result_code: 0,
                                            face: 0
                                        });
                                    }
                                } catch (e) {
                                    console.error(`[${uid}] ❌ Error in anti-AFK reset:`, e.message);
                                }
                            }, Math.random() * 2000 + 2000);
                        }
                    }
                } catch (e) {
                    console.error(`[${uid}] ❌ Error in anti-AFK action:`, e.message);
                }

                const nextDelay = Math.random() * 12000 + 8000;
                s.afkTimeout = setTimeout(performAntiAfk, nextDelay);
            } catch (e) {
                console.error(`[${uid}] ❌ Error in performAntiAfk:`, e.message);
            }
        };

        mc.on("spawn", () => {
            try {
                console.log(`[${uid}] 🎮 Spawned in world`);
                logToDiscord(`✅ Bot of <@${uid}> spawned on **${ip}:${port}**` + (isReconnect ? ` (Attempt ${reconnectAttempt})` : ""));
                if (!isReconnect) safeReply(interaction, { content: `🟢 **Online** on \`${ip}:${port}\``, embeds: [] });
            } catch (e) {
                console.error(`[${uid}] ❌ Error in spawn handler:`, e.message);
            }
        });

        mc.on("start_game", (packet) => {
            try {
                if (!packet || !currentSession) {
                    console.error(`[${uid}] ⚠️ start_game packet or session missing`);
                    return;
                }
                currentSession.entityId = packet.runtime_entity_id;
                currentSession.connected = true;
                currentSession.isReconnecting = false;
                currentSession.reconnectAttempt = 0;
                currentSession.lastPacketTime = Date.now();

                try {
                    if (activeSessionsStore[uid]) {
                        activeSessionsStore[uid].lastConnected = Date.now();
                        sessionStore.save().catch(e => console.error("❌ Error saving start_game state:", e.message));
                    }
                } catch (e) {
                    console.error(`[${uid}] ❌ Error updating session store:`, e.message);
                }

                startHealthMonitoring(uid);
                performAntiAfk();
            } catch (e) {
                console.error(`[${uid}] ❌ Error in start_game handler:`, e.message);
            }
        });

        mc.on('packet', (packet) => {
            try {
                if (currentSession) {
                    currentSession.lastPacketTime = Date.now();
                    currentSession.packetsReceived++;
                }
            } catch (e) {
                console.error(`[${uid}] ❌ Error in packet handler:`, e.message);
            }
        });

        mc.on("error", (e) => {
            try {
                console.error(`[${uid}] ❌ Bot error:`, e?.message || e);
                crashLogger.log(`BOT_ERROR_${uid}`, e);
                if (!currentSession.manualStop && !currentSession.isReconnecting && !currentSession.isCleaningUp) {
                    handleAutoReconnect(uid, currentSession.reconnectAttempt);
                }
                logToDiscord(`❌ Bot of <@${uid}> error: \`${e?.message || 'Unknown error'}\``);
            } catch (err) {
                console.error(`[${uid}] ❌ Error in error handler:`, err.message);
            }
        });

        mc.on("close", () => {
            try {
                console.log(`[${uid}] 🔒 Connection closed`);
                if (!currentSession.manualStop && !currentSession.isReconnecting && !currentSession.isCleaningUp) {
                    handleAutoReconnect(uid, currentSession.reconnectAttempt);
                } else {
                    try {
                        logToDiscord(`🔌 Bot of <@${uid}> disconnected manually.`);
                    } catch (e) {
                        console.error(`[${uid}] ❌ Error logging manual disconnect:`, e.message);
                    }
                }
            } catch (e) {
                console.error(`[${uid}] ❌ Error in close handler:`, e.message);
            }
        });
        
        mc.on('packet_error', (err) => {
            console.error(`[${uid}] 📦 Packet decode error:`, err?.message);
            debugLogger.log('PACKET_ERROR', { uid, error: err?.message, stack: err?.stack });
        });

        // NEW: Kick listener (explicit kick packet)
        mc.on('kick', (reason) => {
            console.warn(`[${uid}] 👢 Kicked from server:`, reason);
            logToDiscord(`👢 Bot of <@${uid}> was kicked: ${reason}`);
        });

    } catch (e) {
        console.error(`[${uid}] ❌ Critical error in startSession:`, e.message);
        crashLogger.log('START_SESSION_CRITICAL', e);
    }
}

// ==================== DISCORD EVENTS ====================
client.on("ready", async () => {
    try {
        discordReady = true;
        discordReconnectAttempts = 0;
        console.log("✅ Discord client ready");

        if (isFirstReady) {
            isFirstReady = false;
            
            try {
                const cmds = [
                    new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
                    new SlashCommandBuilder().setName("java").setDescription("Open Java AFKBot Panel"),
                    new SlashCommandBuilder().setName("refresh").setDescription("Check Discord connection status")
                ];
                await client.application?.commands?.set(cmds);
                console.log("✅ Slash commands registered");
            } catch (e) {
                console.error("❌ Failed to register commands:", e.message);
            }

            if (!memoryCheckInterval) {
                memoryCheckInterval = setInterval(() => {
                    try {
                        const mem = process.memoryUsage();
                        const mb = mem.rss / 1024 / 1024;
                        if (mb > CONFIG.MAX_MEMORY_MB) {
                            console.warn(`⚠️ High memory usage: ${mb.toFixed(2)}MB (limit: ${CONFIG.MAX_MEMORY_MB}MB)`);
                        }
                    } catch (e) {
                        console.error("❌ Error in memory check:", e.message);
                    }
                }, CONFIG.MEMORY_CHECK_INTERVAL_MS);
            }

            const previousSessions = Object.keys(activeSessionsStore || {});
            if (previousSessions.length > 0) {
                console.log(`🔄 Restoring ${previousSessions.length} previous sessions...`);
                let delay = 0;
                for (const uid of previousSessions) {
                    if (typeof uid === 'string' && uid.match(/^\d+$/)) {
                        setTimeout(() => {
                            try {
                                if (!isShuttingDown) {
                                    startSession(uid, null, true);
                                }
                            } catch (e) {
                                console.error(`❌ Error restoring session ${uid}:`, e.message);
                            }
                        }, delay);
                        delay += 8000;
                    }
                }
            }
        } else {
            console.log("🔄 Discord reconnected (not first ready)");
        }
    } catch (e) {
        console.error("❌ Error in ready event:", e.message);
        crashLogger.log('READY_EVENT_ERROR', e);
    }
});

client.on(Events.InteractionCreate, async (i) => {
    try {
        if (!i || isShuttingDown) return;
        
        if (!i.user?.id) {
            console.log("⚠️ Interaction without user ID");
            return;
        }
        
        const uid = i.user.id;
        
        if (i.isButton() || i.isChatInputCommand()) {
            try {
                const lastInteraction = i.user.lastInteraction || 0;
                if (Date.now() - lastInteraction < 1000) {
                    return safeReply(i, { content: "⏳ Please wait a moment before clicking again.", flags: [MessageFlags.Ephemeral] });
                }
                i.user.lastInteraction = Date.now();
            } catch (e) {
                console.error("❌ Error in rate limiting:", e.message);
            }
        }

        if (i.isChatInputCommand()) {
            try {
                if (i.commandName === "panel") return safeReply(i, panelRow(false));
                if (i.commandName === "java") return safeReply(i, panelRow(true));
                
                if (i.commandName === "refresh") {
                    await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                    const status = client.isReady() ? "🟢 Connected" : "🔴 Disconnected";
                    const wsStatus = client.ws?.status;
                    const wsText = wsStatus === 0 ? "Ready" : wsStatus === 1 ? "Connecting" : wsStatus === 2 ? "Reconnecting" : "Disconnected";
                    return safeReply(i, { 
                        content: `**Discord Status:** ${status}\n**WebSocket:** ${wsText}\n**Ping:** ${client.ws?.ping || 'N/A'}ms`, 
                        flags: [MessageFlags.Ephemeral] 
                    });
                }
            } catch (e) {
                console.error("❌ Error handling command:", e.message);
            }
        }

        if (i.isButton()) {
            try {
                if (i.customId === "refresh_discord") {
                    await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                    const isReady = client.isReady();
                    const status = isReady ? "🟢 Online" : "🔴 Offline";
                    const ping = client.ws?.ping || 0;
                    return safeReply(i, { 
                        content: `${status} | Ping: ${ping}ms | WS Status: ${client.ws?.status || 'unknown'}`, 
                        flags: [MessageFlags.Ephemeral] 
                    });
                }

                if (i.customId === "start_bedrock") {
                    if (sessions.has(uid)) {
                        return safeReply(i, { content: "⚠️ **Session Conflict**: Active session exists.", flags: [MessageFlags.Ephemeral] });
                    }
                    await i.deferReply({ flags: [MessageFlags.Ephemeral] }).catch((e) => {
                        console.error("❌ Error deferring start_bedrock:", e.message);
                    });
                    const embed = new EmbedBuilder()
                        .setTitle("Bedrock Connection")
                        .setDescription("Start bot?")
                        .setColor("#2ECC71");
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId("confirm_start").setLabel("Start").setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                    );
                    return i.editReply({ embeds: [embed], components: [row] }).catch((e) => {
                        console.error("❌ Error editing start reply:", e.message);
                    });
                }

                if (i.customId === "start_java") {
                    if (sessions.has(uid)) {
                        return safeReply(i, { content: "⚠️ **Session Conflict**: Active session exists.", flags: [MessageFlags.Ephemeral] });
                    }
                    await i.deferReply({ flags: [MessageFlags.Ephemeral] }).catch((e) => {
                        console.error("❌ Error deferring start_java:", e.message);
                    });
                    const embed = new EmbedBuilder()
                        .setTitle("⚙️ Java Compatibility Check")
                        .setDescription("For a successful connection to a Java server, ensure the following plugins are installed.")
                        .addFields({ name: "Required Plugins", value: "• GeyserMC\n• Floodgate" })
                        .setColor("#E67E22");
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId("confirm_start").setLabel("Confirm & Start").setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                    );
                    return i.editReply({ embeds: [embed], components: [row] }).catch((e) => {
                        console.error("❌ Error editing java reply:", e.message);
                    });
                }

                if (i.customId === "confirm_start") {
                    await i.deferUpdate().catch((e) => {
                        console.error("❌ Error deferring confirm:", e.message);
                    });
                    return startSession(uid, i, false);
                }

                if (i.customId === "cancel") {
                    await i.deferUpdate().catch((e) => {
                        console.error("❌ Error deferring cancel:", e.message);
                    });
                    return i.editReply({ content: "❌ Cancelled.", embeds: [], components: [] }).catch((e) => {
                        console.error("❌ Error editing cancel:", e.message);
                    });
                }

                if (i.customId === "stop") {
                    await i.deferReply({ flags: [MessageFlags.Ephemeral] }).catch((e) => {
                        console.error("❌ Error deferring stop:", e.message);
                    });
                    const ok = await stopSession(uid);
                    return safeReply(i, { content: ok ? "⏹ **Session Terminated.**" : "No active sessions.", flags: [MessageFlags.Ephemeral] });
                }

                if (i.customId === "link") {
                    await i.deferReply({ flags: [MessageFlags.Ephemeral] }).catch((e) => {
                        console.error("❌ Error deferring link:", e.message);
                    });
                    return linkMicrosoft(uid, i);
                }

                if (i.customId === "unlink") {
                    await i.deferReply({ flags: [MessageFlags.Ephemeral] }).catch((e) => {
                        console.error("❌ Error deferring unlink:", e.message);
                    });
                    await unlinkMicrosoft(uid);
                    return safeReply(i, { content: "🗑 Unlinked Microsoft account.", flags: [MessageFlags.Ephemeral] });
                }

                if (i.customId === "settings") {
                    const u = getUser(uid);
                    const modal = new ModalBuilder()
                        .setCustomId("settings_modal")
                        .setTitle("Configuration");
                    
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
                    return i.showModal(modal);
                }
            } catch (e) {
                console.error("❌ Error handling button interaction:", e.message);
            }
        }

        if (i.isModalSubmit() && i.customId === "settings_modal") {
            try {
                const ip = i.fields?.getTextInputValue("ip")?.trim();
                const portStr = i.fields?.getTextInputValue("port")?.trim();
                const port = parseInt(portStr, 10);

                if (!ip || !portStr) {
                    return safeReply(i, { content: "❌ IP and Port are required.", flags: [MessageFlags.Ephemeral] });
                }

                if (!isValidIP(ip)) {
                    return safeReply(i, { content: "❌ Invalid IP address format.", flags: [MessageFlags.Ephemeral] });
                }

                if (!isValidPort(port)) {
                    return safeReply(i, { content: "❌ Invalid port (must be 1-65535).", flags: [MessageFlags.Ephemeral] });
                }

                const u = getUser(uid);
                u.server = { ip, port };
                await userStore.save();
                return safeReply(i, { content: `✅ Saved: **${ip}:${port}**`, flags: [MessageFlags.Ephemeral] });
            } catch (e) {
                console.error("❌ Error handling modal submit:", e.message);
                return safeReply(i, { content: "❌ Failed to save settings.", flags: [MessageFlags.Ephemeral] });
            }
        }
    } catch (e) {
        console.error("❌ Critical error in InteractionCreate:", e.message);
        crashLogger.log('INTERACTION_CREATE_ERROR', e);
    }
});

// ==================== STARTUP ====================
console.log("🚀 Starting bot...");

client.login(DISCORD_TOKEN).catch((err) => {
    console.error("❌ Initial login failed:", err.message);
    crashLogger.log('INITIAL_LOGIN_FAILED', err);
    process.exit(1);
});

// Heartbeat logging with error catching
setInterval(() => {
    try {
        console.log(`💓 Heartbeat | Sessions: ${sessions.size} | Discord: ${discordReady ? 'Connected' : 'Disconnected'} | Uptime: ${Math.floor(process.uptime() / 60)}m`);
    } catch (e) {
        console.error("❌ Heartbeat error:", e.message);
    }
}, 60000);

// Discord refresh with comprehensive error catching
setInterval(() => {
    try {
        if (!isShuttingDown && client.isReady()) {
            console.log("🔄 Scheduled Discord WebSocket refresh (2min interval)");
            client.ws.destroy();
        }
    } catch (e) {
        console.error("❌ Discord refresh error:", e.message);
        crashLogger.log('DISCORD_REFRESH_ERROR', e);
    }
}, CONFIG.DISCORD_REFRESH_INTERVAL_MS);

console.log("✅ Bot initialization complete");
