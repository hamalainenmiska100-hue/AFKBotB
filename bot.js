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
    ActivityType
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

// ==================== CONFIGURATION ====================
const CONFIG = {
    ADMIN_ID: "1144987924123881564",
    LOG_CHANNEL_ID: "1464615030111731753",
    SAVE_DEBOUNCE_MS: 500,
    AUTO_SAVE_INTERVAL_MS: 15000,
    MAX_RECONNECT_ATTEMPTS: 1000,
    RECONNECT_BASE_DELAY_MS: 5000,
    RECONNECT_MAX_DELAY_MS: 300000,
    CONNECTION_TIMEOUT_MS: 60000,
    KEEPALIVE_INTERVAL_MS: 15000,
    STALE_CONNECTION_TIMEOUT_MS: 60000,
    MEMORY_CHECK_INTERVAL_MS: 60000,
    MAX_MEMORY_MB: 2048,
    SESSION_HEARTBEAT_INTERVAL_MS: 30000,
    TOKEN_REFRESH_BUFFER_MS: 300000,
    NATIVE_CLEANUP_DELAY_MS: 2000,
    PING_TIMEOUT_MS: 10000,
    OPERATION_TIMEOUT_MS: 60000,
    MAX_DISCORD_RECONNECT_ATTEMPTS: 5,
};

// ==================== STORAGE SYSTEM ====================
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");
const REJOIN_STORE = path.join(DATA, "rejoin.json");
const CRASH_LOG = path.join(DATA, "crash.log");
const WAL_FILE = path.join(DATA, "wal.json");

function ensureDir(dir) {
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return true;
    } catch (e) {
        return false;
    }
}

if (!ensureDir(DATA) || !ensureDir(AUTH_ROOT)) {
    process.exit(1);
}

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
            return false;
        }
    }

    replay(targetStore) {
        if (!fs.existsSync(this.filePath)) return;
        try {
            const lines = fs.readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean);
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);
                    if (entry.operation === 'update' && entry.data) {
                        const data = JSON.parse(entry.data);
                        Object.assign(targetStore, data);
                    }
                } catch (e) { /* Skip corrupt entries */ }
            }
            fs.writeFileSync(this.filePath, '');
        } catch (e) {}
    }

    clear() {
        try {
            fs.writeFileSync(this.filePath, '');
        } catch (e) {}
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
                this._backupCorruptFile();
            }
        }
        return this.data;
    }

    _backupCorruptFile() {
        try {
            const backupPath = `${this.filePath}.backup.${Date.now()}`;
            fs.renameSync(this.filePath, backupPath);
        } catch (e) {}
    }

    set(key, value) {
        try {
            if (!this.data) this.data = {};
            this.data[key] = value;
            this.save();
        } catch (e) {}
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
                this.save();
            }
        } catch (e) {}
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
        } catch (e) {}
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
let healthCheckInterval = null;

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
            return false;
        },
        retries: 3,
        timeout: 30000
    },
    presence: {
        status: 'online',
        activities: [{ name: 'AFK Bot System', type: ActivityType.Watching }]
    }
});

// ==================== CRASH PREVENTION SYSTEM ====================
const crashLogger = {
    log: (type, err) => {
        try {
            const timestamp = new Date().toISOString();
            const errorMsg = `[${timestamp}] ${type}:\n${err?.stack || err?.message || err}\n\n`;
            fs.appendFileSync(CRASH_LOG, errorMsg);
        } catch (e) {}
    },
    
    isFatal: (err) => {
        const fatalCodes = ['EADDRINUSE', 'EACCES', 'ENOTFOUND', 'EAI_AGAIN'];
        return fatalCodes.includes(err?.code);
    }
};

process.on("uncaughtException", (err) => {
    try {
        crashLogger.log("UNCAUGHT EXCEPTION", err);
        if (crashLogger.isFatal(err)) {
            gracefulShutdown('FATAL_ERROR');
        }
    } catch (e) {}
});

process.on("unhandledRejection", (reason, promise) => {
    try {
        crashLogger.log("UNHANDLED REJECTION", reason);
    } catch (e) {}
});

process.on("warning", (warning) => {});

// ==================== DISCORD CONNECTION RESILIENCE ====================
client.on("error", (error) => {
    try {
        crashLogger.log("DISCORD ERROR", error);
        discordReady = false;
        
        // Attempt reconnect with backoff
        discordReconnectAttempts++;
        if (discordReconnectAttempts > CONFIG.MAX_DISCORD_RECONNECT_ATTEMPTS) {
            console.error(`Discord reconnect failed ${discordReconnectAttempts} times, forcing exit...`);
            process.exit(1);
        }
        
        setTimeout(() => {
            if (!client.isReady()) {
                console.log(`Discord reconnect attempt ${discordReconnectAttempts}...`);
                client.login(DISCORD_TOKEN).catch((err) => {
                    console.error("Discord reconnect error:", err.message);
                });
            }
        }, 5000 * discordReconnectAttempts);
    } catch (e) {}
});

client.on("shardError", (error) => {
    crashLogger.log("SHARD ERROR", error);
});

client.on("warn", (warning) => {});

client.on("disconnect", (event) => {
    try {
        discordReady = false;
        discordReconnectAttempts++;
        
        console.log(`Discord disconnected (code: ${event?.code}), attempt ${discordReconnectAttempts}`);
        
        if (discordReconnectAttempts > CONFIG.MAX_DISCORD_RECONNECT_ATTEMPTS) {
            console.error("Max Discord reconnect attempts reached, exiting for restart...");
            process.exit(1);
        }
        
        setTimeout(() => {
            if (!client.isReady()) {
                client.login(DISCORD_TOKEN).catch((err) => {
                    console.error("Discord reconnect on disconnect failed:", err.message);
                    // Next disconnect event will trigger another attempt
                });
            }
        }, 5000 * discordReconnectAttempts);
    } catch (e) {}
});

client.on("reconnecting", () => {
    console.log("Discord reconnecting...");
});

client.on("resume", (replayed) => {
    try {
        discordReady = true;
        discordReconnectAttempts = 0; // Reset on successful resume
        console.log("Discord connection resumed");
    } catch (e) {}
});

// ==================== GRACEFUL SHUTDOWN ====================
function gracefulShutdown(signal) {
    try {
        isShuttingDown = true;
        const forceExit = setTimeout(() => {
            process.exit(1);
        }, 15000);
        
        Promise.all([
            userStore.save(true),
            sessionStore.save(true)
        ]).then(() => {
            return cleanupAllSessions();
        }).then(() => {
            return client.destroy();
        }).then(() => {
            clearTimeout(forceExit);
            process.exit(0);
        }).catch(() => {
            process.exit(1);
        });
    } catch (e) {
        process.exit(1);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ==================== MEMORY MANAGEMENT FIXES ====================
function clearChunkCache(mcClient) {
    try {
        if (mcClient?.world?.columns) {
            const keys = Object.keys(mcClient.world.columns);
            if (keys.length > 100) {
                mcClient.world.columns = {};
                console.log(`🗑️ Cleared ${keys.length} chunks from cache`);
            }
        }
    } catch (e) {}
}

// ==================== SESSION MANAGEMENT ====================
async function cleanupSession(uid) {
    if (!uid) return;
    const s = sessions.get(uid);
    if (!s) return;

    if (s.isCleaningUp) return;
    s.isCleaningUp = true;
    
    try {
        const timers = ['reconnectTimer', 'afkTimeout', 
                       'keepaliveTimer', 'staleCheckTimer', 'tokenRefreshTimer', 'chunkCleanupTimer'];
        timers.forEach(timer => {
            try {
                if (s[timer]) {
                    clearTimeout(s[timer]);
                    clearInterval(s[timer]);
                    s[timer] = null;
                }
            } catch (e) {}
        });

        if (s.client) {
            try {
                clearChunkCache(s.client);
                
                try {
                    if (s.client.queue) {
                        s.client.queue('disconnect', { reason: 'Disconnected by user' });
                    }
                } catch (e) {}
                
                await new Promise(r => setTimeout(r, 500));
                
                try {
                    if (typeof s.client.disconnect === 'function') {
                        s.client.disconnect();
                    } else if (typeof s.client.close === 'function') {
                        s.client.close();
                    }
                } catch (e) {}
                
                try {
                    s.client.removeAllListeners();
                } catch (e) {}
                
                s.client = null;
            } catch (e) {}
        }
        
        await new Promise(resolve => setTimeout(resolve, CONFIG.NATIVE_CLEANUP_DELAY_MS));
    } catch (e) {}
    
    try {
        sessions.delete(uid);
    } catch (e) {}
}

async function cleanupAllSessions() {
    try {
        const promises = [];
        for (const [uid, session] of sessions) {
            promises.push(cleanupSession(uid));
        }
        await Promise.all(promises);
    } catch (e) {}
}

async function stopSession(uid) {
    if (!uid) return false;
    
    try {
        const session = sessions.get(uid);
        if (session) {
            session.manualStop = true;
            if (session.reconnectTimer) {
                clearTimeout(session.reconnectTimer);
                session.reconnectTimer = null;
            }
        }
        
        if (activeSessionsStore[uid]) {
            delete activeSessionsStore[uid];
            await sessionStore.save();
        }
        await cleanupSession(uid);
    } catch (e) {}
    return true;
}

// ==================== RECONNECTION SYSTEM ====================
function handleAutoReconnect(uid, attempt = 1) {
    try {
        if (!uid || isShuttingDown) return;
        const s = sessions.get(uid);
        if (!s || s.manualStop || s.isReconnecting || s.isCleaningUp) return;

        if (attempt > CONFIG.MAX_RECONNECT_ATTEMPTS) {
            try {
                logToDiscord(`🚫 Bot of <@${uid}> stopped after max failed attempts.`);
                cleanupSession(uid);
                delete activeSessionsStore[uid];
                sessionStore.save();
            } catch (e) {}
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
        
        try {
            logToDiscord(`⏳ Bot of <@${uid}> disconnected. Reconnecting in ${Math.round(delay/1000)}s (Attempt ${attempt})...`);
        } catch (e) {}

        s.reconnectTimer = setTimeout(() => {
            try {
                if (!isShuttingDown && !s.manualStop) {
                    startSession(uid, null, true, attempt + 1);
                } else {
                    cleanupSession(uid);
                }
            } catch (e) {}
        }, delay);
    } catch (e) {}
}

// ==================== CONNECTION HEALTH MONITORING ====================
function startHealthMonitoring(uid) {
    try {
        const s = sessions.get(uid);
        if (!s) return;

        s.keepaliveTimer = setInterval(() => {
            try {
                if (!s.connected || !s.client) return;
                s.client.queue('client_cache_status', { enabled: false });
                s.lastKeepalive = Date.now();
            } catch (e) {
                try {
                    if (!s.isReconnecting && !s.isCleaningUp) handleAutoReconnect(uid, s.reconnectAttempt + 1);
                } catch (err) {}
            }
        }, CONFIG.KEEPALIVE_INTERVAL_MS);

        s.chunkCleanupTimer = setInterval(() => {
            try {
                if (s.client && s.connected) {
                    clearChunkCache(s.client);
                }
            } catch (e) {}
        }, 60000);

        s.staleCheckTimer = setInterval(() => {
            try {
                if (!s.connected) return;
                const lastActivity = Math.max(s.lastPacketTime || 0, s.lastKeepalive || 0);
                if (Date.now() - lastActivity > CONFIG.STALE_CONNECTION_TIMEOUT_MS) {
                    try {
                        s.client?.close();
                    } catch (e) {}
                    if (!s.isReconnecting && !s.isCleaningUp) handleAutoReconnect(uid, s.reconnectAttempt + 1);
                }
            } catch (e) {}
        }, CONFIG.STALE_CONNECTION_TIMEOUT_MS);
    } catch (e) {}
}

// ==================== USER MANAGEMENT ====================
function getUser(uid) {
    try {
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
            userStore.save();
        }
        
        users[uid].connectionType = users[uid].connectionType || "online";
        users[uid].bedrockVersion = users[uid].bedrockVersion || "auto";
        users[uid].lastActive = Date.now();
        
        return users[uid];
    } catch (e) {
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
            } catch (e) {}
        }
        const u = getUser(uid);
        u.linked = false;
        u.authTokenExpiry = null;
        await userStore.save();
        return true;
    } catch (e) {
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
        return false;
    }
}

function isValidPort(port) {
    try {
        const num = parseInt(port, 10);
        return !isNaN(num) && num > 0 && num <= 65535;
    } catch (e) {
        return false;
    }
}

// ==================== DISCORD HELPERS ====================
async function logToDiscord(message) {
    try {
        if (!message || isShuttingDown || !discordReady) return;
        const channel = await client.channels.fetch(CONFIG.LOG_CHANNEL_ID).catch(() => null);
        if (!channel) return;
        
        const embed = new EmbedBuilder()
            .setColor("#5865F2")
            .setDescription(String(message).slice(0, 4096))
            .setTimestamp();
            
        await channel.send({ embeds: [embed] }).catch(() => {});
    } catch (e) {}
}

async function safeReply(interaction, content) {
    try {
        if (!interaction) return;
        const payload = typeof content === 'string' ? { content } : content;
        
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply(payload).catch(() => {});
        } else {
            await interaction.reply(payload).catch(() => {});
        }
    } catch (e) {}
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
                    new ButtonBuilder().setCustomId("refresh_discord").setLabel("🔄 Refresh Connection").setStyle(ButtonStyle.Primary)
                )
            ]
        };
    } catch (e) {
        return { content: "Error", components: [] };
    }
}

// ==================== MICROSOFT AUTHENTICATION ====================
async function linkMicrosoft(uid, interaction) {
    try {
        if (!uid || !interaction) return;
        
        if (pendingLink.has(uid)) {
            return safeReply(interaction, "⏳ Login already in progress. Check your DMs or use the last code.");
        }
        
        const authDir = getUserAuthDir(uid);
        if (!authDir) {
            return safeReply(interaction, "❌ System error: Cannot create auth directory.");
        }
        
        const u = getUser(uid);
        let codeShown = false;

        const timeoutId = setTimeout(() => {
            try {
                if (pendingLink.has(uid)) {
                    pendingLink.delete(uid);
                    safeReply(interaction, "⏰ Login timed out after 5 minutes.").catch(() => {});
                }
            } catch (e) {}
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
                        
                        await interaction.editReply({ content: msg, components: [row] }).catch(() => {});
                    } catch (e) {}
                }
            );

            const authPromise = flow.getMsaToken().then(async () => {
                try {
                    clearTimeout(timeoutId);
                    u.linked = true;
                    u.tokenAcquiredAt = Date.now();
                    await userStore.save();
                    await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account linked! You can now start the bot." }).catch(() => {});
                } catch (e) {}
            }).catch(async (e) => {
                try {
                    clearTimeout(timeoutId);
                    const errorMsg = e?.message || "Unknown error";
                    await interaction.editReply(`❌ Login failed: ${errorMsg}`).catch(() => {});
                } catch (err) {}
            }).finally(() => { 
                try {
                    pendingLink.delete(uid);
                } catch (e) {}
            });
            
            pendingLink.set(uid, authPromise);
            
        } catch (e) {
            try {
                clearTimeout(timeoutId);
                pendingLink.delete(uid);
                safeReply(interaction, "❌ Authentication system error.");
            } catch (err) {}
        }
    } catch (e) {}
}

// ==================== MAIN SESSION FUNCTION ====================
async function startSession(uid, interaction, isReconnect = false, reconnectAttempt = 1) {
    try {
        if (!uid || isShuttingDown) return;
        
        const existingSession = sessions.get(uid);
        if (existingSession?.isCleaningUp) {
            try {
                await new Promise(resolve => setTimeout(resolve, CONFIG.NATIVE_CLEANUP_DELAY_MS + 500));
            } catch (e) {}
        }
        
        const u = getUser(uid);
        if (!u) {
            if (!isReconnect) safeReply(interaction, "❌ User data error.");
            return;
        }

        if (u.connectionType !== "offline") {
            const tokenAge = Date.now() - (u.tokenAcquiredAt || 0);
            const isTokenExpired = !u.linked || !u.tokenAcquiredAt || (tokenAge > CONFIG.TOKEN_REFRESH_BUFFER_MS);
            
            if (isTokenExpired) {
                if (!isReconnect && interaction) {
                    return linkMicrosoft(uid, interaction);
                } else {
                    logToDiscord(`⛔ Bot of <@${uid}> stopped: Microsoft authentication required or token expired.`);
                    delete activeSessionsStore[uid];
                    await sessionStore.save();
                    return;
                }
            }
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
            } catch (e) {}
        }

        if (!u.server || !u.server.ip) {
            if (!isReconnect) safeReply(interaction, "⚠️ Please configure your server settings first.");
            try {
                delete activeSessionsStore[uid];
                await sessionStore.save();
            } catch (e) {}
            return;
        }

        const { ip, port } = u.server;
        
        if (!isValidIP(ip) || !isValidPort(port)) {
            if (!isReconnect) safeReply(interaction, "❌ Invalid server IP or port format.");
            try {
                delete activeSessionsStore[uid];
                await sessionStore.save();
            } catch (e) {}
            return;
        }

        if (sessions.has(uid) && !isReconnect) {
            return safeReply(interaction, { 
                ephemeral: true, 
                content: "⚠️ **Session Conflict**: Active session already exists. Use `/stop` first." 
            });
        }

        if (isReconnect && sessions.has(uid)) {
            await cleanupSession(uid);
            try {
                await new Promise(resolve => setTimeout(resolve, CONFIG.NATIVE_CLEANUP_DELAY_MS));
            } catch (e) {}
        }

        const connectionEmbed = new EmbedBuilder()
            .setColor("#5865F2")
            .setTitle("Bot Initialization")
            .setThumbnail("https://files.catbox.moe/9mqpoz.gif");

        let pingSuccess = false;
        if (!isReconnect && interaction) {
            try {
                connectionEmbed.setDescription(`🔍 **Pinging server...**\n🌐 **Target:** \`${ip}:${port}\``);
                await safeReply(interaction, { embeds: [connectionEmbed], content: null, components: [] });

                const pingPromise = bedrock.ping({ 
                    host: ip, 
                    port: parseInt(port) || 19132, 
                    timeout: CONFIG.PING_TIMEOUT_MS 
                });
                
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Ping timeout')), CONFIG.PING_TIMEOUT_MS)
                );
                
                await Promise.race([pingPromise, timeoutPromise]);
                pingSuccess = true;

                connectionEmbed.setDescription(`✅ **Server responded! Joining...**\n🌐 **Target:** \`${ip}:${port}\``);
                await safeReply(interaction, { embeds: [connectionEmbed] });
            } catch (err) {
                try {
                    connectionEmbed.setDescription(`⚠️ **Ping failed or timed out, attempting direct connection...**\n🌐 **Target:** \`${ip}:${port}\``);
                    await safeReply(interaction, { embeds: [connectionEmbed] });
                } catch (e) {}
            }
        }

        const authDir = getUserAuthDir(uid);
        if (!authDir) {
            if (!isReconnect) safeReply(interaction, "❌ Auth directory error.");
            return;
        }

        const opts = {
            host: ip,
            port: parseInt(port),
            connectTimeout: CONFIG.CONNECTION_TIMEOUT_MS,
            keepAlive: true,
            viewDistance: 4,
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
        let clientError = null;
        
        try {
            mc = bedrock.createClient(opts);
            
            await new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    reject(new Error('Connection timeout'));
                }, CONFIG.CONNECTION_TIMEOUT_MS);
                
                mc.once('connect', () => {
                    clearTimeout(timeoutId);
                    resolve();
                });
                
                mc.once('error', (err) => {
                    clearTimeout(timeoutId);
                    reject(err);
                });
            });
            
        } catch (err) {
            clientError = err;
            if (!isReconnect) {
                try {
                    connectionEmbed.setDescription(`❌ **Failed to create client:** ${err.message}`);
                    await safeReply(interaction, { embeds: [connectionEmbed] });
                } catch (e) {
                    safeReply(interaction, "❌ Failed to create client.");
                }
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
            chunkCleanupTimer: null,
            lastPacketTime: Date.now(),
            lastKeepalive: Date.now(),
            packetsReceived: 0
        };
        
        try {
            sessions.set(uid, currentSession);
        } catch (e) {
            return;
        }

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
                                } catch (e) {}
                            }, Math.random() * 2000 + 2000);
                        }
                    }
                } catch (e) {}

                const nextDelay = Math.random() * 12000 + 8000;
                s.afkTimeout = setTimeout(performAntiAfk, nextDelay);
            } catch (e) {}
        };

        mc.on("spawn", () => {
            try {
                logToDiscord(`✅ Bot of <@${uid}> spawned on **${ip}:${port}**` + (isReconnect ? ` (Attempt ${reconnectAttempt})` : ""));
                if (!isReconnect) safeReply(interaction, { content: `🟢 **Online** on \`${ip}:${port}\``, embeds: [] });
            } catch (e) {}
        });

        mc.on("start_game", (packet) => {
            try {
                if (!packet || !currentSession) return;
                currentSession.entityId = packet.runtime_entity_id;
                currentSession.connected = true;
                currentSession.isReconnecting = false;
                currentSession.reconnectAttempt = 0;
                currentSession.lastPacketTime = Date.now();

                try {
                    if (activeSessionsStore[uid]) {
                        activeSessionsStore[uid].lastConnected = Date.now();
                        sessionStore.save();
                    }
                } catch (e) {}

                startHealthMonitoring(uid);
                performAntiAfk();
            } catch (e) {}
        });

        mc.on('packet', (packet) => {
            try {
                if (currentSession) {
                    currentSession.lastPacketTime = Date.now();
                }
            } catch (e) {}
        });

        mc.on("error", (e) => {
            try {
                if (!currentSession.manualStop && !currentSession.isReconnecting && !currentSession.isCleaningUp) {
                    handleAutoReconnect(uid, currentSession.reconnectAttempt);
                }
                logToDiscord(`❌ Bot of <@${uid}> error: \`${e?.message || 'Unknown error'}\``);
            } catch (err) {}
        });

        mc.on("close", () => {
            try {
                if (!currentSession.manualStop && !currentSession.isReconnecting && !currentSession.isCleaningUp) {
                    handleAutoReconnect(uid, currentSession.reconnectAttempt);
                }
                else {
                    try {
                        logToDiscord(`🔌 Bot of <@${uid}> disconnected manually.`);
                    } catch (e) {}
                }
            } catch (e) {}
        });
        
        mc.on('packet_error', (err) => {});
    } catch (e) {}
}

// ==================== DISCORD EVENTS ====================
client.once("ready", async () => {
    try {
        discordReady = true;
        discordReconnectAttempts = 0; // Reset counter on successful connection
        console.log("Discord client ready");

        try {
            const cmds = [
                new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
                new SlashCommandBuilder().setName("java").setDescription("Open Java AFKBot Panel"),
                new SlashCommandBuilder().setName("refresh").setDescription("Refresh Discord connection without restart")
            ];
            await client.application?.commands?.set(cmds);
        } catch (e) {
            console.error("Failed to register commands:", e);
        }

        setInterval(() => {
            try {
                const mem = process.memoryUsage();
                const mb = mem.rss / 1024 / 1024;
                if (mb > CONFIG.MAX_MEMORY_MB) {
                    if (global.gc) {
                        global.gc();
                    }
                }
            } catch (e) {}
        }, CONFIG.MEMORY_CHECK_INTERVAL_MS);

        // Restore previous sessions
        const previousSessions = Object.keys(activeSessionsStore || {});
        if (previousSessions.length > 0) {
            let delay = 0;
            for (const uid of previousSessions) {
                if (typeof uid === 'string' && uid.match(/^\d+$/)) {
                    setTimeout(() => {
                        try {
                            if (!isShuttingDown) {
                                startSession(uid, null, true);
                            }
                        } catch (e) {}
                    }, delay);
                    delay += 5000;
                }
            }
        }
    } catch (e) {
        console.error("Error in ready event:", e);
    }
});

client.on(Events.InteractionCreate, async (i) => {
    try {
        if (!i || isShuttingDown) return;
        
        if (!i.user?.id) return;
        
        const uid = i.user.id;
        
        if (i.isButton() || i.isChatInputCommand()) {
            try {
                const lastInteraction = i.user.lastInteraction || 0;
                if (Date.now() - lastInteraction < 1000) {
                    return safeReply(i, { ephemeral: true, content: "⏳ Please wait a moment before clicking again." });
                }
                i.user.lastInteraction = Date.now();
            } catch (e) {}
        }

        if (i.isChatInputCommand()) {
            try {
                if (i.commandName === "panel") return safeReply(i, panelRow(false));
                if (i.commandName === "java") return safeReply(i, panelRow(true));
                
                if (i.commandName === "refresh") {
                    await i.deferReply({ ephemeral: true });
                    try {
                        if (!discordReady) {
                            return safeReply(i, "⚠️ Discord already reconnecting, please wait...");
                        }
                        
                        discordReady = false;
                        console.log("Manual Discord refresh requested");
                        
                        // Destroy and recreate connection
                        await client.destroy();
                        await new Promise(r => setTimeout(r, 1000));
                        
                        // Reset counter and login
                        discordReconnectAttempts = 0;
                        await client.login(DISCORD_TOKEN);
                        
                        // Wait for ready
                        await new Promise((resolve, reject) => {
                            const timeout = setTimeout(() => reject(new Error("Timeout")), 10000);
                            const checkReady = setInterval(() => {
                                if (client.isReady()) {
                                    clearTimeout(timeout);
                                    clearInterval(checkReady);
                                    resolve();
                                }
                            }, 500);
                        });
                        
                        discordReady = true;
                        discordReconnectAttempts = 0;
                        
                        return safeReply(i, "✅ Discord connection refreshed successfully!");
                    } catch (err) {
                        console.error("Refresh failed:", err);
                        discordReady = false;
                        return safeReply(i, `❌ Refresh failed: ${err.message}`);
                    }
                }
            } catch (e) {}
        }

        if (i.isButton()) {
            try {
                // Handle refresh button
                if (i.customId === "refresh_discord") {
                    await i.deferReply({ ephemeral: true });
                    try {
                        if (!discordReady) {
                            return safeReply(i, "⚠️ Already reconnecting, please wait...");
                        }
                        
                        discordReady = false;
                        console.log("Refresh button clicked");
                        
                        await client.destroy();
                        await new Promise(r => setTimeout(r, 1000));
                        
                        discordReconnectAttempts = 0;
                        await client.login(DISCORD_TOKEN);
                        
                        // Wait for ready state
                        let attempts = 0;
                        while (!client.isReady() && attempts < 20) {
                            await new Promise(r => setTimeout(r, 500));
                            attempts++;
                        }
                        
                        if (client.isReady()) {
                            discordReady = true;
                            discordReconnectAttempts = 0;
                            return safeReply(i, "✅ Connection refreshed!");
                        } else {
                            throw new Error("Did not become ready in time");
                        }
                    } catch (err) {
                        discordReady = false;
                        return safeReply(i, `❌ Failed: ${err.message}`);
                    }
                }

                if (i.customId === "start_bedrock") {
                    if (sessions.has(uid)) {
                        return safeReply(i, { ephemeral: true, content: "⚠️ **Session Conflict**: Active session exists." });
                    }
                    await i.deferReply({ ephemeral: true }).catch(() => {});
                    const embed = new EmbedBuilder()
                        .setTitle("Bedrock Connection")
                        .setDescription("Start bot?")
                        .setColor("#2ECC71");
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId("confirm_start").setLabel("Start").setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                    );
                    return i.editReply({ embeds: [embed], components: [row] }).catch(() => {});
                }

                if (i.customId === "start_java") {
                    if (sessions.has(uid)) {
                        return safeReply(i, { ephemeral: true, content: "⚠️ **Session Conflict**: Active session exists." });
                    }
                    await i.deferReply({ ephemeral: true }).catch(() => {});
                    const embed = new EmbedBuilder()
                        .setTitle("⚙️ Java Compatibility Check")
                        .setDescription("For a successful connection to a Java server, ensure the following plugins are installed.")
                        .addFields({ name: "Required Plugins", value: "• GeyserMC\n• Floodgate" })
                        .setColor("#E67E22");
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId("confirm_start").setLabel("Confirm & Start").setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                    );
                    return i.editReply({ embeds: [embed], components: [row] }).catch(() => {});
                }

                if (i.customId === "confirm_start") {
                    await i.deferUpdate().catch(() => {});
                    return startSession(uid, i, false);
                }

                if (i.customId === "cancel") {
                    await i.deferUpdate().catch(() => {});
                    return i.editReply({ content: "❌ Cancelled.", embeds: [], components: [] }).catch(() => {});
                }

                if (i.customId === "stop") {
                    await i.deferReply({ ephemeral: true }).catch(() => {});
                    const ok = await stopSession(uid);
                    return safeReply(i, { ephemeral: true, content: ok ? "⏹ **Session Terminated.**" : "No active sessions." });
                }

                if (i.customId === "link") {
                    await i.deferReply({ ephemeral: true }).catch(() => {});
                    return linkMicrosoft(uid, i);
                }

                if (i.customId === "unlink") {
                    await i.deferReply({ ephemeral: true }).catch(() => {});
                    await unlinkMicrosoft(uid);
                    return safeReply(i, { ephemeral: true, content: "🗑 Unlinked Microsoft account." });
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
            } catch (e) {}
        }

        if (i.isModalSubmit() && i.customId === "settings_modal") {
            try {
                const ip = i.fields?.getTextInputValue("ip")?.trim();
                const portStr = i.fields?.getTextInputValue("port")?.trim();
                const port = parseInt(portStr, 10);

                if (!ip || !portStr) {
                    return safeReply(i, { ephemeral: true, content: "❌ IP and Port are required." });
                }

                if (!isValidIP(ip)) {
                    return safeReply(i, { ephemeral: true, content: "❌ Invalid IP address format." });
                }

                if (!isValidPort(port)) {
                    return safeReply(i, { ephemeral: true, content: "❌ Invalid port (must be 1-65535)." });
                }

                const u = getUser(uid);
                u.server = { ip, port };
                await userStore.save();
                return safeReply(i, { ephemeral: true, content: `✅ Saved: **${ip}:${port}**` });
            } catch (e) {
                return safeReply(i, { ephemeral: true, content: "❌ Failed to save settings." });
            }
        }
    } catch (e) {}
});

// ==================== STARTUP ====================
client.login(DISCORD_TOKEN).catch((err) => {
    console.error("Initial login failed:", err);
    process.exit(1);
});

setInterval(() => {
    try {
        console.log(`💓 Heartbeat | Sessions: ${sessions.size} | Discord: ${discordReady ? 'Connected' : 'Disconnected'} | Uptime: ${Math.floor(process.uptime() / 60)}m`);
    } catch (e) {}
}, 60000);
