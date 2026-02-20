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
const fs = require("fs").promises;
const fsSync = require("fs");
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
    SAVE_DEBOUNCE_MS: 100,
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
};

// ==================== STORAGE SYSTEM ====================
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");
const REJOIN_STORE = path.join(DATA, "rejoin.json");
const CRASH_LOG = path.join(DATA, "crash.log");
const WAL_FILE = path.join(DATA, "wal.json");

async function ensureDir(dir) {
    try {
        await fs.mkdir(dir, { recursive: true });
        return true;
    } catch (e) {
        return false;
    }
}

// Initialize dirs immediately but don't block
ensureDir(DATA);
ensureDir(AUTH_ROOT);

// ==================== WRITE-AHEAD LOGGING SYSTEM ====================
class WriteAheadLog {
    constructor(filePath) {
        this.filePath = filePath;
        this.writeQueue = [];
        this.writing = false;
    }

    async write(operation, data) {
        try {
            const entry = {
                timestamp: Date.now(),
                operation,
                data: JSON.stringify(data),
                checksum: this._checksum(data)
            };
            // Fire-and-forget, don't await
            fs.appendFile(this.filePath, JSON.stringify(entry) + '\n').catch(() => {});
            return true;
        } catch (e) {
            return false;
        }
    }

    async replay(targetStore) {
        try {
            if (!await fs.access(this.filePath).then(() => true).catch(() => false)) return;
            const content = await fs.readFile(this.filePath, 'utf8');
            const lines = content.split('\n').filter(Boolean);
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);
                    if (entry.operation === 'update' && entry.data) {
                        const data = JSON.parse(entry.data);
                        Object.assign(targetStore, data);
                    }
                } catch (e) { /* Skip corrupt entries */ }
            }
            await fs.writeFile(this.filePath, '');
        } catch (e) {}
    }

    async clear() {
        try {
            await fs.writeFile(this.filePath, '');
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
        this.pendingWrites = [];
    }

    async load(defaultVal = {}) {
        this.data = defaultVal;
        if (this.wal) {
            await this.wal.replay(this.data);
        }
        
        try {
            const content = await fs.readFile(this.filePath, "utf8");
            if (content.trim()) {
                const parsed = JSON.parse(content);
                if (typeof parsed === 'object' && parsed !== null) {
                    this.data = { ...this.data, ...parsed };
                }
            }
        } catch (e) {
            await this._backupCorruptFile();
        }
        return this.data;
    }

    async _backupCorruptFile() {
        try {
            const backupPath = `${this.filePath}.backup.${Date.now()}`;
            await fs.rename(this.filePath, backupPath);
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
        // Return immediately, handle async in background
        if (immediate) {
            this._flush();
        } else {
            if (this.saveTimeout) clearTimeout(this.saveTimeout);
            this.saveTimeout = setTimeout(() => this._flush(), CONFIG.SAVE_DEBOUNCE_MS);
        }
        return Promise.resolve(true);
    }

    async _flush() {
        if (this.isSaving) return;
        this.isSaving = true;

        try {
            if (this.wal) {
                await this.wal.write('update', this.data);
            }

            const dir = path.dirname(this.filePath);
            await fs.mkdir(dir, { recursive: true });

            const jsonString = JSON.stringify(this.data);
            
            // Atomic write
            await fs.writeFile(`${this.filePath}.tmp`, jsonString);
            await fs.rename(`${this.filePath}.tmp`, this.filePath);
            
            if (this.wal) {
                await this.wal.clear();
            }

            this.lastSaveTime = Date.now();
            this.saveCount++;
        } catch (e) {
            this._emergencyBackup();
        } finally {
            this.isSaving = false;
        }
    }

    async _emergencyBackup() {
        try {
            const emergencyPath = `${this.filePath}.emergency.${Date.now()}`;
            await fs.writeFile(emergencyPath, JSON.stringify(this.data));
        } catch (e) {}
    }
}

// Initialize stores
const wal = new WriteAheadLog(WAL_FILE);
const userStore = new PersistentStore(STORE, wal);
const sessionStore = new PersistentStore(REJOIN_STORE, wal);

let users = {};
let activeSessionsStore = {};

// Async init
(async () => {
    users = await userStore.load({});
    activeSessionsStore = await sessionStore.load({});
})();

// ==================== RUNTIME STATE ====================
const sessions = new Map();
const pendingLink = new Map();
const lastMsa = new Map();
let isShuttingDown = false;
let discordReady = false;
let discordReconnectAttempts = 0;

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
        rejectOnRateLimit: () => false,
        retries: 2,
        timeout: 15000
    },
    presence: {
        status: 'online',
        activities: [{ name: 'AFK Bot System', type: ActivityType.Watching }]
    }
});

// ==================== CRASH PREVENTION SYSTEM ====================
const crashLogger = {
    log: async (type, err) => {
        try {
            const timestamp = new Date().toISOString();
            const errorMsg = `[${timestamp}] ${type}:\n${err?.stack || err?.message || err}\n\n`;
            await fs.appendFile(CRASH_LOG, errorMsg).catch(() => {});
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

process.on("unhandledRejection", (reason) => {
    crashLogger.log("UNHANDLED REJECTION", reason);
});

// ==================== DISCORD CONNECTION RESILIENCE ====================
client.on("error", (error) => {
    console.error("DISCORD ERROR:", error?.message);
    discordReady = false;
});

client.on("shardError", (error) => {
    console.error("SHARD ERROR:", error?.message);
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
    discordReconnectAttempts = 0;
    console.log(`Discord resumed. Replayed: ${replayed}`);
});

// ==================== GRACEFUL SHUTDOWN ====================
async function gracefulShutdown(signal) {
    isShuttingDown = true;
    const forceExit = setTimeout(() => process.exit(1), 15000);
    
    try {
        await Promise.all([
            userStore.save(true),
            sessionStore.save(true)
        ]);
        await cleanupAllSessions();
        await client.destroy();
        clearTimeout(forceExit);
        process.exit(0);
    } catch (e) {
        process.exit(1);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ==================== SESSION MANAGEMENT ====================
async function cleanupSession(uid) {
    if (!uid) return;
    const s = sessions.get(uid);
    if (!s || s.isCleaningUp) return;

    s.isCleaningUp = true;
    
    // Clear all timers immediately
    const timers = ['reconnectTimer', 'afkTimeout', 'keepaliveTimer', 'staleCheckTimer', 'tokenRefreshTimer'];
    timers.forEach(timer => {
        if (s[timer]) {
            clearTimeout(s[timer]);
            clearInterval(s[timer]);
            s[timer] = null;
        }
    });

    if (s.client) {
        s.client.removeAllListeners();
        s.client.close();
        s.client = null;
    }
    
    sessions.delete(uid);
}

async function cleanupAllSessions() {
    const promises = [];
    for (const [uid] of sessions) {
        promises.push(cleanupSession(uid));
    }
    await Promise.all(promises);
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
    
    if (activeSessionsStore[uid]) {
        delete activeSessionsStore[uid];
        sessionStore.save();
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
        logToDiscord(`🚫 Bot of <@${uid}> stopped after max failed attempts.`);
        cleanupSession(uid);
        delete activeSessionsStore[uid];
        sessionStore.save();
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
    const delay = baseDelay + jitter;
    
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
        try {
            if (!s.connected || !s.client) return;
            s.client.queue('client_cache_status', { enabled: false });
            s.lastKeepalive = Date.now();
        } catch (e) {
            if (!s.isReconnecting && !s.isCleaningUp && !s.manualStop) {
                handleAutoReconnect(uid, s.reconnectAttempt + 1);
            }
        }
    }, CONFIG.KEEPALIVE_INTERVAL_MS);

    s.staleCheckTimer = setInterval(() => {
        try {
            if (!s.connected) return;
            const lastActivity = Math.max(s.lastPacketTime || 0, s.lastKeepalive || 0);
            if (Date.now() - lastActivity > CONFIG.STALE_CONNECTION_TIMEOUT_MS) {
                s.client?.close();
                if (!s.isReconnecting && !s.isCleaningUp && !s.manualStop) {
                    handleAutoReconnect(uid, s.reconnectAttempt + 1);
                }
            }
        } catch (e) {}
    }, CONFIG.STALE_CONNECTION_TIMEOUT_MS);
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
        userStore.save();
    }
    
    users[uid].connectionType = users[uid].connectionType || "online";
    users[uid].bedrockVersion = users[uid].bedrockVersion || "auto";
    users[uid].lastActive = Date.now();
    
    return users[uid];
}

async function getUserAuthDir(uid) {
    if (!uid || typeof uid !== 'string') return null;
    const safeUid = uid.replace(/[^a-zA-Z0-9]/g, '');
    if (!safeUid) return null;
    
    const dir = path.join(AUTH_ROOT, safeUid);
    await ensureDir(dir);
    return dir;
}

async function unlinkMicrosoft(uid) {
    if (!uid) return false;
    const dir = await getUserAuthDir(uid);
    if (dir) {
        try { 
            await fs.rm(dir, { recursive: true, force: true }); 
        } catch (e) {}
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
        const channel = await client.channels.fetch(CONFIG.LOG_CHANNEL_ID);
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
}

// ==================== MICROSOFT AUTHENTICATION ====================
async function linkMicrosoft(uid, interaction) {
    if (!uid || !interaction) return;
    
    // DEFER IMMEDIATELY - This is critical for speed
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(() => {});
    
    if (pendingLink.has(uid)) {
        return interaction.editReply({ content: "⏳ Login already in progress. Check your DMs or use the last code." }).catch(() => {});
    }
    
    const authDir = await getUserAuthDir(uid);
    if (!authDir) {
        return interaction.editReply({ content: "❌ System error: Cannot create auth directory." }).catch(() => {});
    }
    
    const u = getUser(uid);
    let codeShown = false;

    const timeoutId = setTimeout(() => {
        pendingLink.delete(uid);
        interaction.editReply({ content: "⏰ Login timed out after 5 minutes." }).catch(() => {});
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
                codeShown = true;
                
                const msg = `🔐 **Microsoft Authentication Required**\n\n1. Visit: ${uri}\n2. Enter Code: \`${code}\`\n\n🔒 **Security Notice:** Your account tokens are saved locally and are never shared.`;
                
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setLabel("🌐 Open link")
                        .setStyle(ButtonStyle.Link)
                        .setURL(uri)
                );
                
                await interaction.editReply({ content: msg, components: [row] }).catch(() => {});
            }
        );

        flow.getMsaToken().then(async () => {
            clearTimeout(timeoutId);
            u.linked = true;
            u.tokenAcquiredAt = Date.now();
            await userStore.save();
            await interaction.followUp({ content: "✅ Microsoft account linked!", flags: [MessageFlags.Ephemeral] }).catch(() => {});
            pendingLink.delete(uid);
        }).catch(async (e) => {
            clearTimeout(timeoutId);
            const errorMsg = e?.message || "Unknown error";
            await interaction.editReply({ content: `❌ Login failed: ${errorMsg}` }).catch(() => {});
            pendingLink.delete(uid);
        });
        
        pendingLink.set(uid, true);
        
    } catch (e) {
        clearTimeout(timeoutId);
        pendingLink.delete(uid);
        await interaction.editReply({ content: "❌ Authentication system error." }).catch(() => {});
    }
}

// ==================== MAIN SESSION FUNCTION ====================
async function startSession(uid, interaction, isReconnect = false, reconnectAttempt = 1) {
    if (!uid || isShuttingDown) return;
    
    // If interaction exists, defer immediately so Discord doesn't timeout
    if (interaction && !interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    
    const existingSession = sessions.get(uid);
    if (existingSession?.isCleaningUp) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const u = getUser(uid);
    if (!u) {
        if (interaction) interaction.editReply({ content: "❌ User data error." }).catch(() => {});
        return;
    }

    if (!activeSessionsStore[uid]) {
        activeSessionsStore[uid] = { 
            startedAt: Date.now(),
            server: u.server,
            reconnectCount: 0
        };
        sessionStore.save();
    }

    if (!u.server?.ip) {
        if (interaction) interaction.editReply({ content: "⚠️ Please configure your server settings first." }).catch(() => {});
        delete activeSessionsStore[uid];
        sessionStore.save();
        return;
    }

    const { ip, port } = u.server;
    
    if (!isValidIP(ip) || !isValidPort(port)) {
        if (interaction) interaction.editReply({ content: "❌ Invalid server IP or port format." }).catch(() => {});
        delete activeSessionsStore[uid];
        sessionStore.save();
        return;
    }

    if (sessions.has(uid) && !isReconnect) {
        if (interaction) interaction.editReply({ content: "⚠️ **Session Conflict**: Active session exists. Use `/stop` first." }).catch(() => {});
        return;
    }

    if (isReconnect && sessions.has(uid)) {
        await cleanupSession(uid);
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Quick ping in background
    if (!isReconnect && interaction) {
        try {
            await bedrock.ping({ 
                host: ip, 
                port: parseInt(port) || 19132, 
                timeout: CONFIG.PING_TIMEOUT_MS 
            });
        } catch (err) {
            // Continue anyway even if ping fails
        }
    }

    const authDir = await getUserAuthDir(uid);
    if (!authDir) {
        if (interaction) interaction.editReply({ content: "❌ Auth directory error." }).catch(() => {});
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
        mc = bedrock.createClient(opts);
    } catch (err) {
        if (interaction) interaction.editReply({ content: "❌ Failed to create client." }).catch(() => {});
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

    mc.on('disconnect', (packet) => {
        const reason = packet?.reason || "Unknown reason";
        logToDiscord(`⚠️ Bot of <@${uid}> was kicked: ${reason}`);
        
        if (reason.includes("wait") || reason.includes("etwas") || reason.includes("before")) {
            currentSession.manualStop = true;
            delete activeSessionsStore[uid];
            sessionStore.save();
        }
    });

    const performAntiAfk = () => {
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
                    }, Math.random() * 2000 + 2000);
                }
            }
        } catch (e) {}

        const nextDelay = Math.random() * 12000 + 8000;
        s.afkTimeout = setTimeout(performAntiAfk, nextDelay);
    };

    mc.on("spawn", () => {
        logToDiscord(`✅ Bot of <@${uid}> spawned on **${ip}:${port}**` + (isReconnect ? ` (Attempt ${reconnectAttempt})` : ""));
        if (interaction) interaction.editReply({ content: `🟢 **Online** on \`${ip}:${port}\`` }).catch(() => {});
    });

    mc.on("start_game", (packet) => {
        if (!packet || !currentSession) return;
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
    });

    mc.on('packet', () => {
        if (currentSession) {
            currentSession.lastPacketTime = Date.now();
        }
    });

    mc.on("error", (e) => {
        if (!currentSession.manualStop && !currentSession.isReconnecting && !currentSession.isCleaningUp) {
            handleAutoReconnect(uid, currentSession.reconnectAttempt);
        }
        logToDiscord(`❌ Bot of <@${uid}> error: \`${e?.message || 'Unknown error'}\``);
    });

    mc.on("close", () => {
        if (!currentSession.manualStop && !currentSession.isReconnecting && !currentSession.isCleaningUp) {
            handleAutoReconnect(uid, currentSession.reconnectAttempt);
        } else {
            logToDiscord(`🔌 Bot of <@${uid}> disconnected manually.`);
        }
    });
}

// ==================== DISCORD EVENTS ====================
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
        console.error("Failed to register commands:", e);
    }

    // Memory check (non-blocking)
    setInterval(() => {
        const mem = process.memoryUsage();
        const mb = mem.rss / 1024 / 1024;
        if (mb > CONFIG.MAX_MEMORY_MB) {
            console.warn(`High memory usage: ${mb.toFixed(2)}MB`);
        }
    }, CONFIG.MEMORY_CHECK_INTERVAL_MS);

    // Restore previous sessions with staggered delays
    setTimeout(() => {
        const previousSessions = Object.keys(activeSessionsStore || {});
        let delay = 0;
        for (const uid of previousSessions) {
            if (typeof uid === 'string' && uid.match(/^\d+$/)) {
                setTimeout(() => {
                    if (!isShuttingDown) startSession(uid, null, true);
                }, delay);
                delay += 5000; // Staggered to prevent overload
            }
        }
    }, 5000);
});

client.on(Events.InteractionCreate, async (i) => {
    try {
        if (!i || isShuttingDown) return;
        if (!i.user?.id) return;
        
        const uid = i.user.id;
        
        // Rate limiting (1 second per user)
        const lastInteraction = i.user.lastInteraction || 0;
        if (Date.now() - lastInteraction < 1000) {
            return safeReply(i, { content: "⏳ Please wait a moment before clicking again.", flags: [MessageFlags.Ephemeral] });
        }
        i.user.lastInteraction = Date.now();

        if (i.isChatInputCommand()) {
            if (i.commandName === "panel") return safeReply(i, panelRow(false));
            if (i.commandName === "java") return safeReply(i, panelRow(true));
            
            if (i.commandName === "refresh") {
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                try {
                    if (!discordReady) {
                        return i.editReply({ content: "⚠️ Discord already reconnecting, please wait..." });
                    }
                    
                    discordReady = false;
                    await client.destroy();
                    await new Promise(r => setTimeout(r, 1000));
                    
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
                    return i.editReply({ content: "✅ Discord connection refreshed successfully!" });
                } catch (err) {
                    discordReady = false;
                    return i.editReply({ content: `❌ Refresh failed: ${err.message}` });
                }
            }
        }

        if (i.isButton()) {
            // ALL button handlers must defer immediately if they do any work
            if (i.customId === "refresh_discord") {
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                try {
                    if (!discordReady) {
                        return i.editReply({ content: "⚠️ Already reconnecting, please wait..." });
                    }
                    
                    discordReady = false;
                    await client.destroy();
                    await new Promise(r => setTimeout(r, 1000));
                    await client.login(DISCORD_TOKEN);
                    
                    let attempts = 0;
                    while (!client.isReady() && attempts < 20) {
                        await new Promise(r => setTimeout(r, 500));
                        attempts++;
                    }
                    
                    if (client.isReady()) {
                        discordReady = true;
                        return i.editReply({ content: "✅ Connection refreshed!" });
                    } else {
                        throw new Error("Did not become ready in time");
                    }
                } catch (err) {
                    discordReady = false;
                    return i.editReply({ content: `❌ Failed: ${err.message}` });
                }
            }

            if (i.customId === "start_bedrock") {
                if (sessions.has(uid)) {
                    return safeReply(i, { content: "⚠️ **Session Conflict**: Active session exists.", flags: [MessageFlags.Ephemeral] });
                }
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                const embed = new EmbedBuilder()
                    .setTitle("Bedrock Connection")
                    .setDescription("Start bot?")
                    .setColor("#2ECC71");
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("confirm_start").setLabel("Start").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );
                return i.editReply({ embeds: [embed], components: [row] });
            }

            if (i.customId === "start_java") {
                if (sessions.has(uid)) {
                    return safeReply(i, { content: "⚠️ **Session Conflict**: Active session exists.", flags: [MessageFlags.Ephemeral] });
                }
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                const embed = new EmbedBuilder()
                    .setTitle("⚙️ Java Compatibility Check")
                    .setDescription("For a successful connection to a Java server, ensure the following plugins are installed.")
                    .addFields({ name: "Required Plugins", value: "• GeyserMC\n• Floodgate" })
                    .setColor("#E67E22");
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("confirm_start").setLabel("Confirm & Start").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );
                return i.editReply({ embeds: [embed], components: [row] });
            }

            if (i.customId === "confirm_start") {
                await i.deferUpdate(); // Fast acknowledgment
                // Run session start in background
                startSession(uid, i, false);
                return;
            }

            if (i.customId === "cancel") {
                await i.deferUpdate();
                return i.editReply({ content: "❌ Cancelled.", embeds: [], components: [] }).catch(() => {});
            }

            if (i.customId === "stop") {
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                const ok = await stopSession(uid);
                return i.editReply({ content: ok ? "⏹ **Session Terminated.**" : "No active sessions." });
            }

            if (i.customId === "link") {
                // linkMicrosoft handles its own defer
                return linkMicrosoft(uid, i);
            }

            if (i.customId === "unlink") {
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                await unlinkMicrosoft(uid);
                return i.editReply({ content: "🗑 Unlinked Microsoft account." });
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
        }
    } catch (e) {
        console.error("Interaction error:", e);
    }
});

// ==================== STARTUP ====================
client.login(DISCORD_TOKEN).catch((err) => {
    console.error("Initial login failed:", err);
    process.exit(1);
});

setInterval(() => {
    console.log(`💓 Heartbeat | Sessions: ${sessions.size} | Discord: ${discordReady ? 'Connected' : 'Disconnected'} | Uptime: ${Math.floor(process.uptime() / 60)}m`);
}, 60000);
