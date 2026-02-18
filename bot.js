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
    CONNECTION_TIMEOUT_MS: 30000,
    KEEPALIVE_INTERVAL_MS: 15000,
    STALE_CONNECTION_TIMEOUT_MS: 60000,
    MEMORY_CHECK_INTERVAL_MS: 60000,
    MAX_MEMORY_MB: 2048,
    SESSION_HEARTBEAT_INTERVAL_MS: 30000,
    TOKEN_REFRESH_BUFFER_MS: 300000,
    NATIVE_CLEANUP_DELAY_MS: 2000, // Delay to prevent native memory corruption
};

// ==================== STORAGE SYSTEM ====================
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");
const REJOIN_STORE = path.join(DATA, "rejoin.json");
const CRASH_LOG = path.join(DATA, "crash.log");
const WAL_FILE = path.join(DATA, "wal.json");

// Ensure directories exist
function ensureDir(dir) {
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return true;
    } catch (e) {
        console.error(`❌ Cannot create directory ${dir}:`, e);
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
            console.error("WAL write failed:", e);
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
        } catch (e) {
            console.error("WAL replay failed:", e);
        }
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
                console.error(`⚠️ Corrupt JSON at ${this.filePath}:`, e.message);
                this._backupCorruptFile();
            }
        }
        return this.data;
    }

    _backupCorruptFile() {
        try {
            const backupPath = `${this.filePath}.backup.${Date.now()}`;
            fs.renameSync(this.filePath, backupPath);
            console.log(`📦 Backed up corrupt file to ${backupPath}`);
        } catch (e) {
            console.error("Failed to backup corrupt file:", e);
        }
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
        if (this.data) {
            delete this.data[key];
            this.save();
        }
    }

    save(immediate = false) {
        return new Promise((resolve) => {
            this.saveQueue.push(resolve);
            
            if (immediate) {
                this._flush();
                return;
            }

            if (this.saveTimeout) clearTimeout(this.saveTimeout);
            this.saveTimeout = setTimeout(() => this._flush(), CONFIG.SAVE_DEBOUNCE_MS);
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
            console.error(`❌ Save failed for ${this.filePath}:`, e.message);
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
            console.log(`🆘 Emergency backup saved to ${emergencyPath}`);
        } catch (e) {
            console.error("🆘 CRITICAL: Emergency backup failed:", e);
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
let lastAdminMessage = null;
let isShuttingDown = false;
let discordReady = false;
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
            console.warn(`Rate limited on ${data.route}, retrying after ${data.timeToReset}ms`);
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
        const timestamp = new Date().toISOString();
        const errorMsg = `[${timestamp}] ${type}:\n${err?.stack || err?.message || err}\n\n`;
        console.error("🔥", errorMsg);
        try {
            fs.appendFileSync(CRASH_LOG, errorMsg);
        } catch (e) {}
    },
    
    isFatal: (err) => {
        const fatalCodes = ['EADDRINUSE', 'EACCES', 'ENOTFOUND', 'EAI_AGAIN'];
        return fatalCodes.includes(err?.code);
    }
};

process.on("uncaughtException", (err) => {
    crashLogger.log("UNCAUGHT EXCEPTION", err);
    if (crashLogger.isFatal(err)) {
        gracefulShutdown('FATAL_ERROR');
    }
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("🔥 Unhandled Rejection:", reason);
    crashLogger.log("UNHANDLED REJECTION", reason);
});

process.on("warning", (warning) => {
    console.warn("⚠️ Node Warning:", warning.name, warning.message);
});

// ==================== DISCORD CONNECTION RESILIENCE ====================
client.on("error", (error) => {
    console.error("⚠️ Discord Client Error:", error?.message);
    crashLogger.log("DISCORD ERROR", error);
    
    setTimeout(() => {
        if (!client.isReady()) {
            console.log("🔄 Attempting Discord re-login...");
            client.login(DISCORD_TOKEN).catch(e => {
                console.error("Re-login failed:", e);
                setTimeout(() => process.exit(1), 5000);
            });
        }
    }, 10000);
});

client.on("shardError", (error) => {
    console.error("⚠️ WebSocket Error:", error?.message);
});

client.on("warn", (warning) => {
    console.warn("⚠️ Discord Warning:", warning);
});

client.on("disconnect", (event) => {
    console.log(`📡 Discord disconnected: ${event.code} - ${event.reason}`);
    discordReady = false;
    
    setTimeout(() => {
        if (!client.isReady()) {
            client.login(DISCORD_TOKEN).catch(console.error);
        }
    }, 5000);
});

client.on("reconnecting", () => {
    console.log("🔄 Discord reconnecting...");
});

client.on("resume", (replayed) => {
    console.log(`✅ Discord resumed, ${replayed} events replayed`);
    discordReady = true;
});

// ==================== GRACEFUL SHUTDOWN ====================
function gracefulShutdown(signal) {
    console.log(`🛑 ${signal} received. Initiating graceful shutdown...`);
    isShuttingDown = true;
    
    const forceExit = setTimeout(() => {
        console.error("⚠️ Forced exit after timeout");
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
        console.log("✅ Clean shutdown complete");
        process.exit(0);
    }).catch(err => {
        console.error("Error during shutdown:", err);
        process.exit(1);
    });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ==================== SESSION MANAGEMENT ====================
async function cleanupSession(uid) {
    if (!uid) return;
    const s = sessions.get(uid);
    if (!s) return;

    console.log(`🧹 Cleaning up session ${uid}`);
    
    // Prevent concurrent cleanup
    if (s.isCleaningUp) return;
    s.isCleaningUp = true;
    
    try {
        const timers = ['reconnectTimer', 'afkTimeout', 
                       'keepaliveTimer', 'staleCheckTimer', 'tokenRefreshTimer'];
        timers.forEach(timer => {
            if (s[timer]) {
                clearTimeout(s[timer]);
                clearInterval(s[timer]);
                s[timer] = null;
            }
        });

        if (s.client) {
            s.client.removeAllListeners();
            try {
                s.client.close();
            } catch (e) {}
            s.client = null;
        }
        
        // CRITICAL: Wait for native resources to cleanup to prevent "free(): invalid pointer"
        await new Promise(resolve => setTimeout(resolve, CONFIG.NATIVE_CLEANUP_DELAY_MS));
        
    } catch (e) {
        console.error(`Error in cleanupSession for ${uid}:`, e);
    }
    
    sessions.delete(uid);
}

async function cleanupAllSessions() {
    console.log(`🧹 Cleaning up ${sessions.size} sessions...`);
    const promises = [];
    for (const [uid, session] of sessions) {
        promises.push(cleanupSession(uid));
    }
    await Promise.all(promises);
}

async function stopSession(uid) {
    if (!uid) return false;
    
    if (activeSessionsStore[uid]) {
        delete activeSessionsStore[uid];
        await sessionStore.save();
    }

    await cleanupSession(uid);
    return true;
}

// ==================== RECONNECTION SYSTEM ====================
function handleAutoReconnect(uid, attempt = 1) {
    if (!uid || isShuttingDown) return;
    const s = sessions.get(uid);
    if (!s || s.manualStop || s.isReconnecting || s.isCleaningUp) return;

    if (attempt > CONFIG.MAX_RECONNECT_ATTEMPTS) {
        console.log(`🚫 Max reconnection attempts reached for ${uid}`);
        logToDiscord(`🚫 Bot of <@${uid}> stopped after max failed attempts.`);
        cleanupSession(uid);
        delete activeSessionsStore[uid];
        sessionStore.save();
        return;
    }

    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);

    s.isReconnecting = true;
    s.reconnectAttempt = attempt;
    
    // Add extra delay for native cleanup on first reconnect attempt
    const baseDelay = Math.min(
        CONFIG.RECONNECT_BASE_DELAY_MS * Math.pow(1.5, attempt - 1),
        CONFIG.RECONNECT_MAX_DELAY_MS
    );
    const jitter = Math.random() * 5000;
    const nativeDelay = attempt === 1 ? CONFIG.NATIVE_CLEANUP_DELAY_MS : 0;
    const delay = baseDelay + jitter + nativeDelay;
    
    logToDiscord(`⏳ Bot of <@${uid}> disconnected. Reconnecting in ${Math.round(delay/1000)}s (Attempt ${attempt})...`);

    s.reconnectTimer = setTimeout(() => {
        if (!isShuttingDown && !s.manualStop) {
            startSession(uid, null, true, attempt + 1);
        } else {
            cleanupSession(uid);
        }
    }, delay);
}

// ==================== CONNECTION HEALTH MONITORING ====================
function startHealthMonitoring(uid) {
    const s = sessions.get(uid);
    if (!s) return;

    s.keepaliveTimer = setInterval(() => {
        if (!s.connected || !s.client) return;
        try {
            s.client.queue('client_cache_status', { enabled: false });
            s.lastKeepalive = Date.now();
        } catch (e) {
            console.log(`Keepalive failed for ${uid}, triggering reconnect`);
            if (!s.isReconnecting && !s.isCleaningUp) handleAutoReconnect(uid, s.reconnectAttempt + 1);
        }
    }, CONFIG.KEEPALIVE_INTERVAL_MS);

    s.staleCheckTimer = setInterval(() => {
        if (!s.connected) return;
        const lastActivity = Math.max(s.lastPacketTime || 0, s.lastKeepalive || 0);
        if (Date.now() - lastActivity > CONFIG.STALE_CONNECTION_TIMEOUT_MS) {
            console.log(`Stale connection detected for ${uid}`);
            logToDiscord(`⚠️ Stale connection for <@${uid}>, forcing reconnect...`);
            try {
                s.client?.close();
            } catch (e) {}
            if (!s.isReconnecting && !s.isCleaningUp) handleAutoReconnect(uid, s.reconnectAttempt + 1);
        }
    }, CONFIG.STALE_CONNECTION_TIMEOUT_MS);
}

// ==================== USER MANAGEMENT ====================
function getUser(uid) {
    if (!uid || typeof uid !== 'string' || !/^\d+$/.test(uid)) {
        console.warn(`Invalid UID access attempt: ${uid}`);
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
}

function getUserAuthDir(uid) {
    if (!uid || typeof uid !== 'string') return null;
    const safeUid = uid.replace(/[^a-zA-Z0-9]/g, '');
    if (!safeUid) return null;
    
    const dir = path.join(AUTH_ROOT, safeUid);
    if (!ensureDir(dir)) return null;
    return dir;
}

async function unlinkMicrosoft(uid) {
    if (!uid) return false;
    const dir = getUserAuthDir(uid);
    if (dir) {
        try { 
            fs.rmSync(dir, { recursive: true, force: true }); 
        } catch (e) {
            console.error("Error removing auth dir:", e);
        }
    }
    const u = getUser(uid);
    u.linked = false;
    u.authTokenExpiry = null;
    await userStore.save();
    return true;
}

// ==================== VALIDATION ====================
function isValidIP(ip) {
    if (!ip || typeof ip !== 'string') return false;
    if (ip.length > 253) return false;
    if (ip.includes('..') || ip.startsWith('.') || ip.endsWith('.')) return false;
    if (ip.includes('://')) return false;
    
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
    const hostnameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
    
    return ipv4Regex.test(ip) || ipv6Regex.test(ip) || hostnameRegex.test(ip);
}

function isValidPort(port) {
    const num = parseInt(port, 10);
    return !isNaN(num) && num > 0 && num <= 65535;
}

// ==================== DISCORD HELPERS ====================
async function logToDiscord(message) {
    if (!message || isShuttingDown || !discordReady) return;
    try {
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
    if (!interaction) return;
    try {
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
            new ButtonBuilder().setCustomId("admin_stop_all").setLabel("🛑 Force Stop All").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("admin_save_data").setLabel("💾 Force Save").setStyle(ButtonStyle.Secondary)
        )
    ];

    if (sessions.size > 0) {
        const options = [];
        let count = 0;
        for (const [uid, session] of sessions) {
            if (count >= 25) break;
            const label = `User: ${uid.slice(0, 8)}...`;
            const desc = session?.startedAt 
                ? `Started: ${new Date(session.startedAt).toLocaleTimeString()}` 
                : 'Unknown';
            options.push({ label, description: desc, value: uid });
            count++;
        }
        if (options.length > 0) {
            rows.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId("admin_force_stop_select")
                    .setPlaceholder("Select bot to Force Stop")
                    .addOptions(options)
            ));
        }
    }
    return rows;
}

function getAdminStatsEmbed() {
    let memory = { rss: 0, heapUsed: 0 };
    try {
        memory = process.memoryUsage();
    } catch (e) {}
    
    const ramMB = (memory.rss / 1024 / 1024).toFixed(2);
    const heapMB = (memory.heapUsed / 1024 / 1024).toFixed(2);
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);

    const embed = new EmbedBuilder()
        .setTitle("🛠 Admin Panel")
        .setColor("#2f3136")
        .addFields(
            { name: "📊 Performance", value: `**RAM:** ${ramMB} MB\n**Heap:** ${heapMB} MB\n**Uptime:** ${hours}h ${minutes}m`, inline: true },
            { name: "🤖 Active Sessions", value: `**Total Bots:** ${sessions.size}`, inline: true },
            { name: "💾 Persisted Sessions", value: `**Saved for Restart:** ${Object.keys(activeSessionsStore || {}).length}`, inline: true }
        )
        .setFooter({ text: `Auto-refreshing • Saves: ${userStore.saveCount} | PID: ${process.pid}` })
        .setTimestamp();

    if (sessions.size > 0) {
        let botList = "";
        for (const [uid, s] of sessions) {
            const status = s?.connected ? "🟢 Online" : (s?.isReconnecting ? "⏳ Reconnecting" : "🔴 Offline");
            const attempt = s?.reconnectAttempt ? ` (R${s.reconnectAttempt})` : '';
            botList += `<@${uid}>: ${status}${attempt}\n`;
        }
        if (botList.length > 1024) botList = botList.slice(0, 1021) + "...";
        embed.addFields({ name: "📋 Active Bot Registry", value: botList || "None" });
    }
    return embed;
}

// ==================== MICROSOFT AUTHENTICATION ====================
async function linkMicrosoft(uid, interaction) {
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
        if (pendingLink.has(uid)) {
            pendingLink.delete(uid);
            safeReply(interaction, "⏰ Login timed out after 5 minutes.").catch(() => {});
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
                    
                    await interaction.editReply({ content: msg, components: [row] }).catch(() => {});
                } catch (e) {
                    console.error("Error in auth callback:", e);
                }
            }
        );

        const authPromise = flow.getMsaToken().then(async () => {
            clearTimeout(timeoutId);
            u.linked = true;
            u.tokenAcquiredAt = Date.now();
            await userStore.save();
            await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account linked!" }).catch(() => {});
        }).catch(async (e) => {
            clearTimeout(timeoutId);
            const errorMsg = e?.message || "Unknown error";
            await interaction.editReply(`❌ Login failed: ${errorMsg}`).catch(() => {});
        }).finally(() => { 
            pendingLink.delete(uid); 
        });
        
        pendingLink.set(uid, authPromise);
        
    } catch (e) {
        clearTimeout(timeoutId);
        pendingLink.delete(uid);
        console.error("Authflow creation error:", e);
        safeReply(interaction, "❌ Authentication system error.");
    }
}

// ==================== MAIN SESSION FUNCTION ====================
async function startSession(uid, interaction, isReconnect = false, reconnectAttempt = 1) {
    if (!uid || isShuttingDown) return;
    
    // Prevent starting if cleanup is in progress for this user
    const existingSession = sessions.get(uid);
    if (existingSession?.isCleaningUp) {
        console.log(`⏳ Waiting for cleanup to finish for ${uid}...`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.NATIVE_CLEANUP_DELAY_MS + 500));
    }
    
    const u = getUser(uid);
    if (!u) {
        if (!isReconnect) safeReply(interaction, "❌ User data error.");
        return;
    }

    if (!activeSessionsStore) activeSessionsStore = {};
    
    if (!activeSessionsStore[uid]) {
        activeSessionsStore[uid] = { 
            startedAt: Date.now(),
            server: u.server,
            reconnectCount: 0
        };
        await sessionStore.save();
    }

    if (!u.server || !u.server.ip) {
        if (!isReconnect) safeReply(interaction, "⚠️ Please configure your server settings first.");
        delete activeSessionsStore[uid];
        await sessionStore.save();
        return;
    }

    const { ip, port } = u.server;
    
    if (!isValidIP(ip) || !isValidPort(port)) {
        if (!isReconnect) safeReply(interaction, "❌ Invalid server IP or port format.");
        delete activeSessionsStore[uid];
        await sessionStore.save();
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
        // Extra delay after cleanup before reconnect to prevent native memory corruption
        await new Promise(resolve => setTimeout(resolve, CONFIG.NATIVE_CLEANUP_DELAY_MS));
    }

    const connectionEmbed = new EmbedBuilder()
        .setColor("#5865F2")
        .setTitle("Bot Initialization")
        .setThumbnail("https://files.catbox.moe/9mqpoz.gif");

    let pingSuccess = false;
    try {
        if (!isReconnect && interaction) {
            connectionEmbed.setDescription(`🔍 **Pinging server...**\n🌐 **Target:** \`${ip}:${port}\``);
            await safeReply(interaction, { embeds: [connectionEmbed], content: null, components: [] });
        }

        await bedrock.ping({ 
            host: ip, 
            port: parseInt(port) || 19132, 
            timeout: 5000 
        });
        pingSuccess = true;

        if (!isReconnect && interaction) {
            connectionEmbed.setDescription(`✅ **Server responded! Joining...**\n🌐 **Target:** \`${ip}:${port}\``);
            await safeReply(interaction, { embeds: [connectionEmbed] });
        }
    } catch (err) {
        console.log(`[PING] Ping failed for ${ip}:${port}, attempting direct connection anyway...`);
        if (!isReconnect && interaction) {
            connectionEmbed.setDescription(`⚠️ **Ping blocked (firewall?), attempting direct connection...**\n🌐 **Target:** \`${ip}:${port}\``);
            await safeReply(interaction, { embeds: [connectionEmbed] });
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
    try {
        mc = bedrock.createClient(opts);
    } catch (err) {
        console.error("Create Client Error:", err);
        if (!isReconnect) safeReply(interaction, "❌ Failed to create client.");
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
    sessions.set(uid, currentSession);

    // Anti-AFK with animations: hand swing and crouch
    const performAntiAfk = () => {
        if (!sessions.has(uid) || isShuttingDown) return;
        const s = sessions.get(uid);
        if (!s || !s.connected || s.isCleaningUp) return;

        try {
            if (s.entityId && s.client) {
                // Random action: 0 = nothing, 1 = swing, 2 = crouch start, 3 = crouch stop
                const action = Math.random();
                
                if (action < 0.6) {
                    // 60% chance: Swing arm (action_id: 1)
                    s.client.write('animate', { 
                        action_id: 1, 
                        runtime_entity_id: s.entityId 
                    });
                } else if (action < 0.8) {
                    // 20% chance: Start crouching (action_id: 11 for start_sneaking)
                    s.client.write('player_action', {
                        runtime_entity_id: s.entityId,
                        action: 11, // start_sneaking
                        position: { x: 0, y: 0, z: 0 },
                        result_code: 0,
                        face: 0
                    });
                    
                    // Stop crouching after 2-4 seconds
                    setTimeout(() => {
                        const currentS = sessions.get(uid);
                        if (currentS?.connected && currentS?.client && currentS?.entityId && !currentS.isCleaningUp) {
                            try {
                                currentS.client.write('player_action', {
                                    runtime_entity_id: currentS.entityId,
                                    action: 12, // stop_sneaking
                                    position: { x: 0, y: 0, z: 0 },
                                    result_code: 0,
                                    face: 0
                                });
                            } catch (e) {}
                        }
                    }, Math.random() * 2000 + 2000);
                }
                // 20% chance: do nothing this cycle
            }
        } catch (e) {}

        // Next check in 8-20 seconds
        const nextDelay = Math.random() * 12000 + 8000;
        s.afkTimeout = setTimeout(performAntiAfk, nextDelay);
    };

    mc.on("spawn", () => {
        logToDiscord(`✅ Bot of <@${uid}> spawned on **${ip}:${port}**` + (isReconnect ? ` (Attempt ${reconnectAttempt})` : ""));
        if (!isReconnect) safeReply(interaction, { content: `🟢 **Online** on \`${ip}:${port}\``, embeds: [] });
    });

    mc.on("start_game", (packet) => {
        if (!packet || !currentSession) return;
        try {
            currentSession.entityId = packet.runtime_entity_id;
            currentSession.connected = true;
            currentSession.isReconnecting = false;
            currentSession.reconnectAttempt = 0;
            currentSession.lastPacketTime = Date.now();

            if (activeSessionsStore[uid]) {
                activeSessionsStore[uid].lastConnected = Date.now();
                sessionStore.save();
            }

            startHealthMonitoring(uid);
            performAntiAfk();
        } catch (e) {
            console.error("Error in start_game handler:", e);
        }
    });

    mc.on('packet', (packet) => {
        if (currentSession) {
            currentSession.lastPacketTime = Date.now();
        }
    });

    mc.on("error", (e) => {
        console.error(`Session error for ${uid}:`, e);
        if (!currentSession.manualStop && !currentSession.isReconnecting && !currentSession.isCleaningUp) {
            handleAutoReconnect(uid, currentSession.reconnectAttempt);
        }
        logToDiscord(`❌ Bot of <@${uid}> error: \`${e?.message || 'Unknown error'}\``);
    });

    mc.on("close", () => {
        console.log(`Connection closed for ${uid}`);
        if (!currentSession.manualStop && !currentSession.isReconnecting && !currentSession.isCleaningUp) {
            handleAutoReconnect(uid, currentSession.reconnectAttempt);
        }
        else logToDiscord(`🔌 Bot of <@${uid}> disconnected manually.`);
    });
    
    mc.on('packet_error', (err) => {
        console.error(`Packet error for ${uid}:`, err);
    });
}

// ==================== DISCORD EVENTS ====================
client.once("ready", async () => {
    console.log("🟢 Online as", client.user?.tag || "Unknown");
    discordReady = true;

    try {
        const cmds = [
            new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
            new SlashCommandBuilder().setName("java").setDescription("Open Java AFKBot Panel"),
            new SlashCommandBuilder().setName("admin").setDescription("Open Admin Control Panel")
        ];
        await client.application?.commands?.set(cmds);
    } catch (e) {
        console.error("❌ Failed to register commands:", e);
    }

    setInterval(async () => {
        if (lastAdminMessage && !isShuttingDown && discordReady) {
            try {
                await lastAdminMessage.edit({ 
                    embeds: [getAdminStatsEmbed()], 
                    components: adminPanelComponents() 
                }).catch(() => { lastAdminMessage = null; });
            } catch (e) { 
                lastAdminMessage = null; 
            }
        }
    }, 30000);

    setInterval(() => {
        const mem = process.memoryUsage();
        const mb = mem.rss / 1024 / 1024;
        if (mb > CONFIG.MAX_MEMORY_MB) {
            console.warn(`⚠️ High memory usage: ${mb.toFixed(2)} MB`);
            if (global.gc) {
                global.gc();
                console.log("🧹 Garbage collection triggered");
            }
        }
    }, CONFIG.MEMORY_CHECK_INTERVAL_MS);

    console.log("📂 Checking for previous sessions...");
    const previousSessions = Object.keys(activeSessionsStore || {});

    if (previousSessions.length > 0) {
        console.log(`♻️ Found ${previousSessions.length} bots to restore.`);
        let delay = 0;
        for (const uid of previousSessions) {
            if (typeof uid === 'string' && uid.match(/^\d+$/)) {
                setTimeout(() => {
                    if (!isShuttingDown) {
                        console.log(`🔄 Restoring session for ${uid}`);
                        startSession(uid, null, true);
                    }
                }, delay);
                delay += 5000; // Increased delay between restarts to prevent native crashes
            }
        }
    } else {
        console.log("⚪ No previous sessions found.");
    }
});

client.on(Events.InteractionCreate, async (i) => {
    if (!i || isShuttingDown) return;
    
    try {
        if (!i.user?.id) {
            console.warn("Interaction without user received");
            return;
        }
        
        const uid = i.user.id;
        
        if (i.isButton() || i.isChatInputCommand()) {
            const lastInteraction = i.user.lastInteraction || 0;
            if (Date.now() - lastInteraction < 1000) {
                return safeReply(i, { ephemeral: true, content: "⏳ Please wait a moment before clicking again." });
            }
            i.user.lastInteraction = Date.now();
        }

        if (i.isChatInputCommand()) {
            if (i.commandName === "panel") return safeReply(i, panelRow(false));
            if (i.commandName === "java") return safeReply(i, panelRow(true));
            if (i.commandName === "admin") {
                if (uid !== CONFIG.ADMIN_ID) return safeReply(i, { content: "⛔ Access restricted.", ephemeral: true });
                try {
                    const msg = await i.reply({ 
                        embeds: [getAdminStatsEmbed()], 
                        components: adminPanelComponents(), 
                        fetchReply: true 
                    });
                    lastAdminMessage = msg;
                } catch (e) {
                    console.error("Admin panel error:", e);
                }
                return;
            }
        }

        if (i.isStringSelectMenu()) {
            if (i.customId === "admin_force_stop_select") {
                await i.deferUpdate().catch(() => {});
                const targetUid = i.values?.[0];
                if (targetUid && typeof targetUid === 'string') {
                    await stopSession(targetUid);
                    return i.editReply({ 
                        content: `🛑 Forced stop for <@${targetUid}>`, 
                        embeds: [getAdminStatsEmbed()], 
                        components: adminPanelComponents() 
                    }).catch(() => {});
                }
            }
        }

        if (i.isButton()) {
            if (i.customId === "admin_refresh") {
                await i.deferUpdate().catch(() => {});
                return i.editReply({ 
                    embeds: [getAdminStatsEmbed()], 
                    components: adminPanelComponents() 
                }).catch(() => {});
            }

            if (i.customId === "admin_stop_all") {
                if (uid !== CONFIG.ADMIN_ID) return;
                await i.deferUpdate().catch(() => {});
                const stopPromises = [];
                sessions.forEach((_, sUid) => stopPromises.push(stopSession(sUid)));
                await Promise.all(stopPromises);
                return i.editReply({ 
                    content: "🛑 All sessions stopped.", 
                    embeds: [getAdminStatsEmbed()], 
                    components: adminPanelComponents() 
                }).catch(() => {});
            }

            if (i.customId === "admin_save_data") {
                if (uid !== CONFIG.ADMIN_ID) return;
                await i.deferUpdate().catch(() => {});
                await userStore.save(true);
                await sessionStore.save(true);
                return i.editReply({ 
                    content: "💾 Data saved to disk.", 
                    embeds: [getAdminStatsEmbed()], 
                    components: adminPanelComponents() 
                }).catch(() => {});
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
                console.error("Settings save error:", e);
                return safeReply(i, { ephemeral: true, content: "❌ Failed to save settings." });
            }
        }

    } catch (e) { 
        console.error("Interaction error:", e); 
    }
});

// ==================== STARTUP ====================
client.login(DISCORD_TOKEN).catch(e => {
    console.error("❌ Failed to login to Discord:", e);
    process.exit(1);
});

setInterval(() => {
    console.log(`💓 Heartbeat | Sessions: ${sessions.size} | Uptime: ${Math.floor(process.uptime() / 60)}m`);
}, 60000);
