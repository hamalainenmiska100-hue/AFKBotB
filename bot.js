/* 
 * Enhanced AFK bot for Minecraft Bedrock Edition.
 *
 * This script runs a Discord-controlled bot capable of connecting to Bedrock
 * servers using the `bedrock-protocol` library. It includes comprehensive
 * error handling, persistent session storage, automatic reconnection logic,
 * memory leak prevention and crash resilience.  The bot can authenticate via
 * Xbox Live through an interactive Discord interface and exposes slash
 * commands to start, stop and configure server connections.  To avoid being
 * kicked for inactivity, the bot periodically performs anti-AFK actions
 * including realistic walking, crouching and jumping in addition to hand
 * swinging.  All timings and behaviours are randomized to reduce pattern
 * detection.  This file is intentionally self-contained so it can be run via
 * `node bot.js` after installing dependencies and setting the `DISCORD_TOKEN`
 * environment variable.
 */

const {
    Client,
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Events,
    Partials,
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

// ==================== ENVIRONMENT & CONFIGURATION ====================

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
    console.error("DISCORD_TOKEN missing");
    process.exit(1);
}

// Central configuration for timeouts, reconnect behaviour, memory limits, etc.
const CONFIG = {
    ADMIN_ID: "1144987924123881564",
    LOG_CHANNEL_ID: "1464615030111731753",
    SAVE_DEBOUNCE_MS: 100,
    AUTO_SAVE_INTERVAL_MS: 15000,
    MAX_RECONNECT_ATTEMPTS: 10,
    RECONNECT_BASE_DELAY_MS: 10000,
    RECONNECT_MAX_DELAY_MS: 300000,
    CONNECTION_TIMEOUT_MS: 30000,
    KEEPALIVE_INTERVAL_MS: 15000,
    STALE_CONNECTION_TIMEOUT_MS: 60000,
    MEMORY_CHECK_INTERVAL_MS: 60000,
    MAX_MEMORY_MB: 1536,
    SESSION_HEARTBEAT_INTERVAL_MS: 30000,
    TOKEN_REFRESH_BUFFER_MS: 300000,
    NATIVE_CLEANUP_DELAY_MS: 5000,
    PING_TIMEOUT_MS: 5000,
    OPERATION_TIMEOUT_MS: 30000,
    MAX_DISCORD_RECONNECT_ATTEMPTS: 5,
};

// Determine base path for persisting user and session data. Fly.io exposes
// FLY_VOLUME_PATH, but falls back to /data locally.
const DATA = process.env.FLY_VOLUME_PATH || "/data";
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");
const REJOIN_STORE = path.join(DATA, "rejoin.json");
const CRASH_LOG = path.join(DATA, "crash.log");

async function ensureDir(dir) {
    try {
        await fs.mkdir(dir, { recursive: true });
        return true;
    } catch (e) {
        console.error(`Failed to create directory ${dir}:`, e.message);
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
        this.lastSaveTime = 0;
        this.saveCount = 0;
    }

    async load(defaultVal = {}) {
        this.data = defaultVal;
        try {
            const content = await fs.readFile(this.filePath, "utf8");
            if (content.trim()) {
                const parsed = JSON.parse(content);
                if (typeof parsed === 'object' && parsed !== null) {
                    this.data = { ...this.data, ...parsed };
                }
            }
        } catch (e) {
            if (e?.code !== 'ENOENT') {
                console.error(`Failed to load ${this.filePath}:`, e.message);
                await this._backupCorruptFile();
            }
        }
        return this.data;
    }

    async _backupCorruptFile() {
        try {
            const backupPath = `${this.filePath}.backup.${Date.now()}`;
            await fs.rename(this.filePath, backupPath);
        } catch (e) {
            // ignore
        }
    }

    set(key, value) {
        try {
            if (!this.data) this.data = {};
            this.data[key] = value;
            this.save();
        } catch (e) {
            console.error("Store set error:", e.message);
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
                this.save();
            }
        } catch (e) {
            console.error("Store delete error:", e.message);
        }
    }

    save(immediate = false) {
        if (immediate) {
            return this._flush();
        } else {
            if (this.saveTimeout) clearTimeout(this.saveTimeout);
            this.saveTimeout = setTimeout(() => this._flush(), CONFIG.SAVE_DEBOUNCE_MS);
            return Promise.resolve(true);
        }
    }

    async _flush() {
        if (this.isSaving) return;
        this.isSaving = true;
        try {
            const dir = path.dirname(this.filePath);
            await fs.mkdir(dir, { recursive: true });
            // Convert BigInt to string to avoid serialization errors
            const jsonString = JSON.stringify(this.data, (key, value) =>
                typeof value === 'bigint' ? value.toString() : value, null, 2);
            await fs.writeFile(`${this.filePath}.tmp`, jsonString);
            await fs.rename(`${this.filePath}.tmp`, this.filePath);
            this.lastSaveTime = Date.now();
            this.saveCount++;
        } catch (e) {
            console.error("Store flush error:", e.message);
            this._emergencyBackup();
        } finally {
            this.isSaving = false;
        }
    }

    async _emergencyBackup() {
        try {
            const emergencyPath = `${this.filePath}.emergency.${Date.now()}`;
            await fs.writeFile(emergencyPath, JSON.stringify(this.data, (key, value) =>
                typeof value === 'bigint' ? value.toString() : value));
        } catch (e) {
            // ignore
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
    console.log(`Loaded ${Object.keys(users).length} users and ${Object.keys(activeSessionsStore).length} active sessions`);
}

// ==================== RUNTIME STATE ====================

const sessions = new Map();
const pendingLink = new Map();
const lastMsa = new Map();
const lastInteractionAt = new Map();
let isShuttingDown = false;
let discordReady = false;
let discordReconnectAttempts = 0;
const cleanupLocks = new Set();

// ==================== ENHANCED DISCORD CLIENT ====================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessages
    ],
    // Required for reliable DM handling in discord.js v14+
    partials: [Partials.Channel, Partials.Message, Partials.User],
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

client.on(Events.ShardError, (error) => {
    console.error("SHARD ERROR:", error?.message);
});

client.on(Events.ShardDisconnect, () => {
    discordReady = false;
    console.log("Discord shard disconnected. Auto-reconnecting...");
});

client.on(Events.ShardReconnecting, () => {
    console.log("Discord shard reconnecting...");
});

client.on(Events.ShardResume, (_shardId, replayed) => {
    discordReady = true;
    discordReconnectAttempts = 0;
    console.log(`Discord shard resumed. Replayed: ${replayed}`);
});

// ==================== GRACEFUL SHUTDOWN ====================

async function gracefulShutdown(signal) {
    console.log(`Shutting down due to ${signal}...`);
    isShuttingDown = true;
    const forceExit = setTimeout(() => process.exit(1), 15000);
    try {
        await saveAllSessionData();
        await Promise.all([
            userStore.save(true),
            sessionStore.save(true)
        ]);
        await cleanupAllSessions();
        await client.destroy();
        clearTimeout(forceExit);
        process.exit(0);
    } catch (e) {
        console.error("Shutdown error:", e);
        process.exit(1);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ==================== SESSION DATA MANAGEMENT ====================

async function saveSessionData(uid) {
    if (!uid) return;
    const u = getUser(uid);
    if (!u) return;
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
    for (const [uid] of sessions) {
        await saveSessionData(uid);
    }
}

async function clearSessionData(uid) {
    if (activeSessionsStore[uid]) {
        delete activeSessionsStore[uid];
        await sessionStore.save();
    }
}

// ==================== SESSION MANAGEMENT ====================

async function cleanupSession(uid) {
    if (!uid) return;
    if (cleanupLocks.has(uid)) {
        console.log(`Cleanup already in progress for ${uid}, skipping...`);
        return;
    }
    cleanupLocks.add(uid);
    try {
        const s = sessions.get(uid);
        if (!s) return;
        s.isCleaningUp = true;
        s.manualStop = true;
        const timers = ['reconnectTimer', 'afkTimeout', 'keepaliveTimer', 'staleCheckTimer', 'tokenRefreshTimer'];
        timers.forEach(timer => {
            if (s[timer]) {
                clearTimeout(s[timer]);
                clearInterval(s[timer]);
                s[timer] = null;
            }
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        if (s.client) {
            try {
                s.client.removeAllListeners('packet');
                s.client.removeAllListeners('spawn');
                s.client.removeAllListeners('start_game');
                await new Promise((resolve) => {
                    const client = s.client;
                    if (!client) {
                        resolve();
                        return;
                    }
                    const timeout = setTimeout(() => {
                        console.log(`Force closing client for ${uid}`);
                        resolve();
                    }, 2000);
                    try {
                        client.once('close', () => {
                            clearTimeout(timeout);
                            resolve();
                        });
                        client.close();
                    } catch (e) {
                        clearTimeout(timeout);
                        resolve();
                    }
                });
            } catch (e) {
                console.error(`Error closing client for ${uid}:`, e);
            } finally {
                s.client = null;
            }
        }
        sessions.delete(uid);
        if (global.gc) {
            global.gc();
        }
    } finally {
        cleanupLocks.delete(uid);
    }
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
    await clearSessionData(uid);
    await cleanupSession(uid);
    return true;
}

// ==================== RECONNECTION SYSTEM ====================

async function handleAutoReconnect(uid, attempt = 1) {
    if (!uid || isShuttingDown) return;
    const s = sessions.get(uid);
    if (!s || s.manualStop || s.isCleaningUp) return;
    attempt = Math.max(1, attempt);
    if (attempt > CONFIG.MAX_RECONNECT_ATTEMPTS) {
        logToDiscord(`Bot of <@${uid}> stopped after max failed attempts.`);
        await cleanupSession(uid);
        await clearSessionData(uid);
        return;
    }
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    s.isReconnecting = true;
    s.reconnectAttempt = attempt;
    const baseDelay = Math.min(CONFIG.RECONNECT_BASE_DELAY_MS * Math.pow(1.5, attempt - 1), CONFIG.RECONNECT_MAX_DELAY_MS);
    const jitter = Math.random() * 5000;
    const delay = baseDelay + jitter;
    logToDiscord(`Bot of <@${uid}> disconnected. Reconnecting in ${Math.round(delay/1000)}s (Attempt ${attempt})...`);
    s.reconnectTimer = setTimeout(async () => {
        if (!isShuttingDown && !s.manualStop) {
            await cleanupSession(uid);
            await new Promise(resolve => setTimeout(resolve, CONFIG.NATIVE_CLEANUP_DELAY_MS));
            if (!isShuttingDown) {
                await startSession(uid, null, true, attempt);
            }
        } else {
            await cleanupSession(uid);
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
            s.client.queue('client_cache_status', { enabled: false });
            s.lastKeepalive = Date.now();
        } catch (e) {
            if (!s.isReconnecting && !s.isCleaningUp && !s.manualStop) {
                handleAutoReconnect(uid, (s.reconnectAttempt || 0) + 1);
            }
        }
    }, CONFIG.KEEPALIVE_INTERVAL_MS);
    s.staleCheckTimer = setInterval(() => {
        try {
            if (!s.connected || s.isCleaningUp) return;
            const lastActivity = Math.max(s.lastPacketTime || 0, s.lastKeepalive || 0);
            if (Date.now() - lastActivity > CONFIG.STALE_CONNECTION_TIMEOUT_MS) {
                if (s.client && !s.isCleaningUp) {
                    try {
                        s.client.close();
                    } catch (e) {}
                }
                if (!s.isReconnecting && !s.isCleaningUp && !s.manualStop) {
                    handleAutoReconnect(uid, (s.reconnectAttempt || 0) + 1);
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
    u.tokenAcquiredAt = null;
    await userStore.save();
    return true;
}

// ==================== VALIDATION HELPERS ====================

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

async function safeReply(interaction, content, ephemeral = true) {
    try {
        if (!interaction) return;
        const payload = typeof content === 'string' ? { content } : content;
        if (ephemeral && payload.ephemeral === undefined) {
            payload.ephemeral = true;
        }
        if (interaction.replied || interaction.deferred) {
            try {
                await interaction.followUp(payload);
            } catch (err) {
                console.error("Failed to send followUp:", err);
            }
        } else {
            await interaction.reply(payload);
        }
    } catch (e) {
        console.error("SafeReply error:", e);
    }
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
                const msg = `**Microsoft Authentication Required**\n\n1. Visit: ${uri}\n2. Enter Code: \`${code}\`\n\n**Security Notice:** Your account tokens are saved locally and are never shared.`;
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setLabel("Open link").setStyle(ButtonStyle.Link).setURL(uri)
                );
                await interaction.followUp({ content: msg, components: [row], ephemeral: true }).catch(() => {});
            }
        );
        flow.getMsaToken().then(async () => {
            clearTimeout(timeoutId);
            u.linked = true;
            u.tokenAcquiredAt = Date.now();
            await userStore.save();
            await interaction.followUp({ content: "Microsoft account linked!", ephemeral: true }).catch(() => {});
            pendingLink.delete(uid);
        }).catch(async (e) => {
            clearTimeout(timeoutId);
            const errorMsg = e?.message || "Unknown error";
            await interaction.followUp({ content: `Login failed: ${errorMsg}`, ephemeral: true }).catch(() => {});
            pendingLink.delete(uid);
        });
        pendingLink.set(uid, true);
    } catch (e) {
        clearTimeout(timeoutId);
        pendingLink.delete(uid);
        await interaction.followUp({ content: "Authentication system error.", ephemeral: true }).catch(() => {});
    }
}

// ==================== MAIN SESSION FUNCTION ====================

async function startSession(uid, interaction, isReconnect = false, reconnectAttempt = 1) {
    if (!uid || isShuttingDown) return;

    if (!storesInitialized) {
        console.log("Waiting for stores to initialize...");
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (!storesInitialized) {
            if (interaction) safeReply(interaction, "System initializing, please try again.");
            return;
        }
    }

    if (interaction && !interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
    }

    if (cleanupLocks.has(uid)) {
        console.log(`Waiting for cleanup to finish for ${uid}...`);
        let attempts = 0;
        while (cleanupLocks.has(uid) && attempts < 10) {
            await new Promise(resolve => setTimeout(resolve, 500));
            attempts++;
        }
    }

    const u = getUser(uid);
    if (!u) {
        if (interaction) safeReply(interaction, "User data error.");
        return;
    }

    if (!u.linked) {
        if (interaction) safeReply(interaction, "Please auth with Xbox to use the bot");
        else await clearSessionData(uid);
        return;
    }

    await saveSessionData(uid);

    if (!u.server?.ip) {
        if (interaction) safeReply(interaction, "Please configure your server settings first.");
        await clearSessionData(uid);
        return;
    }

    const { ip, port } = u.server;

    if (!isValidIP(ip) || !isValidPort(port)) {
        if (interaction) safeReply(interaction, "Invalid server IP or port format.");
        await clearSessionData(uid);
        return;
    }

    if (sessions.has(uid) && !isReconnect) {
        if (interaction) safeReply(interaction, "**Session Conflict**: Active session exists. Use `/stop` first.");
        return;
    }

    if (isReconnect && sessions.has(uid)) {
        await cleanupSession(uid);
        await new Promise(resolve => setTimeout(resolve, CONFIG.NATIVE_CLEANUP_DELAY_MS));
    }

    if (!isReconnect && interaction) {
        try {
            await bedrock.ping({
                host: ip,
                port: parseInt(port) || 19132,
                timeout: CONFIG.PING_TIMEOUT_MS
            });
        } catch (err) {}
    }

    const authDir = await getUserAuthDir(uid);
    if (!authDir) {
        if (interaction) safeReply(interaction, "Auth directory error.");
        return;
    }

    // --- Joining logic preserved ---
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
    // -----------------------------

    const currentSession = {
        client: null,
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
        packetsReceived: 0,
        position: { x: 0, y: 0, z: 0 },
        yaw: 0,
        pitch: 0,
        tick: 0
    };

    sessions.set(uid, currentSession);

    let mc;
    try {
        mc = bedrock.createClient(opts);
        currentSession.client = mc;
    } catch (err) {
        console.error("Failed to create client:", err);
        if (interaction) safeReply(interaction, "Failed to create client.");
        if (isReconnect) handleAutoReconnect(uid, (reconnectAttempt || 0) + 1);
        else await cleanupSession(uid);
        return;
    }

    if (!mc) {
        console.error("Client creation returned null");
        await cleanupSession(uid);
        return;
    }

    mc.on('disconnect', (packet) => {
        if (currentSession.isCleaningUp) return;
        const reason = packet?.reason || "Unknown reason";
        logToDiscord(`Bot of <@${uid}> was kicked: ${reason}`);
        if (reason.includes("wait") || reason.includes("etwas") || reason.includes("before")) {
            currentSession.manualStop = true;
            clearSessionData(uid);
        }
    });

    const performAntiAfk = () => {
        if (!sessions.has(uid) || isShuttingDown) return;
        const s = sessions.get(uid);
        if (!s || !s.connected || s.isCleaningUp) return;

        try {
            if (s.entityId && s.client && !s.isCleaningUp) {
                const r = Math.random();

                // Hand swing
                if (r < 0.4) {
                    s.client.write('animate', { action_id: 1, runtime_entity_id: s.entityId });

                // Crouch: start sneak = 11, stop sneak = 12
                } else if (r < 0.6) {
                    s.client.write('player_action', {
                        runtime_entity_id: s.entityId,
                        action: 11,
                        position: s.position,
                        result_position: s.position,
                        face: 0
                    });
                    const stopDelay = 2000 + Math.random() * 2000;
                    setTimeout(() => {
                        const cur = sessions.get(uid);
                        if (cur?.connected && cur?.client && cur?.entityId && !cur.isCleaningUp) {
                            cur.client.write('player_action', {
                                runtime_entity_id: cur.entityId,
                                action: 12,
                                position: cur.position,
                                result_position: cur.position,
                                face: 0
                            });
                        }
                    }, stopDelay);

                // Jump: action = 8 + small vertical move
                } else if (r < 0.8) {
                    s.client.write('player_action', {
                        runtime_entity_id: s.entityId,
                        action: 8,
                        position: s.position,
                        result_position: s.position,
                        face: 0
                    });

                    const original = { ...s.position };
                    const jumpPos = { x: original.x, y: original.y + 0.5, z: original.z };

                    s.tick = (s.tick || 0) + 1;
                    s.client.queue('move_player', {
                        runtime_entity_id: s.entityId,
                        position: jumpPos,
                        pitch: s.pitch || 0,
                        yaw: s.yaw || 0,
                        head_yaw: s.yaw || 0,
                        on_ground: false,
                        mode: 0,
                        tick: s.tick
                    });

                    setTimeout(() => {
                        const cur = sessions.get(uid);
                        if (cur?.connected && cur?.client && cur?.entityId && !cur.isCleaningUp) {
                            cur.tick = (cur.tick || 0) + 1;
                            cur.client.queue('move_player', {
                                runtime_entity_id: cur.entityId,
                                position: original,
                                pitch: cur.pitch || 0,
                                yaw: cur.yaw || 0,
                                head_yaw: cur.yaw || 0,
                                on_ground: true,
                                mode: 0,
                                tick: cur.tick
                            });
                            cur.position = { x: original.x, y: original.y, z: original.z };
                        }
                    }, 400 + Math.random() * 200);

                // Walk: small random step
                } else {
                    const dx = (Math.random() - 0.5) * 0.5;
                    const dz = (Math.random() - 0.5) * 0.5;
                    s.position.x += dx;
                    s.position.z += dz;

                    s.tick = (s.tick || 0) + 1;
                    s.client.queue('move_player', {
                        runtime_entity_id: s.entityId,
                        position: { x: s.position.x, y: s.position.y, z: s.position.z },
                        pitch: s.pitch || 0,
                        yaw: s.yaw || 0,
                        head_yaw: s.yaw || 0,
                        on_ground: true,
                        mode: 0,
                        tick: s.tick
                    });
                }
            }
        } catch (e) {}

        const nextDelay = Math.random() * 12000 + 8000;
        s.afkTimeout = setTimeout(performAntiAfk, nextDelay);
    };

    mc.on("spawn", () => {
        if (currentSession.isCleaningUp) return;
        logToDiscord(`Bot of <@${uid}> spawned on **${ip}:${port}**` + (isReconnect ? ` (Attempt ${reconnectAttempt})` : ""));
        if (interaction) safeReply(interaction, `**Online** on \`${ip}:${port}\``);
    });

    mc.on("start_game", (packet) => {
        if (!packet || currentSession.isCleaningUp) return;

        currentSession.entityId = packet.runtime_entity_id;
        currentSession.connected = true;
        currentSession.isReconnecting = false;
        currentSession.reconnectAttempt = 0;
        currentSession.lastPacketTime = Date.now();

        currentSession.position = {
            x: packet.player_position?.x || 0,
            y: packet.player_position?.y || 0,
            z: packet.player_position?.z || 0
        };

        currentSession.yaw = (packet.rotation && packet.rotation.y) || 0;
        currentSession.pitch = (packet.rotation && packet.rotation.x) || 0;

        if (activeSessionsStore[uid]) {
            activeSessionsStore[uid].lastConnected = Date.now();
            activeSessionsStore[uid].entityId = packet.runtime_entity_id;
            sessionStore.save();
        }

        startHealthMonitoring(uid);

        setTimeout(() => {
            const s = sessions.get(uid);
            if (s && s.connected && !s.isCleaningUp) performAntiAfk();
        }, 5000);
    });
    // Track packets for connection health and server-provided move_player updates for position sync
    mc.on('packet', (data, meta) => {
        if (currentSession && !currentSession.isCleaningUp) {
            currentSession.lastPacketTime = Date.now();
        }
        try {
            if (!data || !meta || currentSession.isCleaningUp) return;
            if (meta.name === 'move_player' && data?.position) {
                currentSession.position = { x: data.position.x, y: data.position.y, z: data.position.z };
                if (typeof data.yaw === 'number') currentSession.yaw = data.yaw;
                if (typeof data.pitch === 'number') currentSession.pitch = data.pitch;
            }
        } catch (e) {}
    });

    mc.on("error", (e) => {
        console.error(`Session error for ${uid}:`, e);
        if (!currentSession.manualStop && !currentSession.isReconnecting && !currentSession.isCleaningUp) {
            handleAutoReconnect(uid, (currentSession.reconnectAttempt || 0) + 1);
        }
        logToDiscord(`Bot of <@${uid}> error: \`${e?.message || 'Unknown error'}\``);
    });

    mc.on("close", () => {
        if (currentSession.isCleaningUp) return;
        if (!currentSession.manualStop && !currentSession.isReconnecting) {
            handleAutoReconnect(uid, (currentSession.reconnectAttempt || 0) + 1);
        } else {
            logToDiscord(`Bot of <@${uid}> disconnected manually.`);
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

    setInterval(() => {
        const mem = process.memoryUsage();
        const mb = mem.rss / 1024 / 1024;
        if (mb > CONFIG.MAX_MEMORY_MB) {
            console.warn(`High memory usage: ${mb.toFixed(2)}MB`);
            if (global.gc) global.gc();
        }
    }, CONFIG.MEMORY_CHECK_INTERVAL_MS);

    setTimeout(() => {
        restoreSessions();
    }, 10000);
});

// ==================== SESSION RESTORATION ====================

async function restoreSessions() {
    const previousSessions = Object.keys(activeSessionsStore || {});
    console.log(`Found ${previousSessions.length} sessions to restore`);

    let delay = 0;
    for (const uid of previousSessions) {
        if (typeof uid === 'string' && uid.match(/^\d+$/)) {
            const sessionData = activeSessionsStore[uid];
            if (!sessionData) continue;

            const hasServer = !!(sessionData.server && sessionData.server.ip && sessionData.server.port);
            const isLinked = sessionData.linked === true;
            if (!hasServer || !isLinked) {
                console.log(`Skipping restore for user ${uid}: missing server settings or not linked.`);
                await clearSessionData(uid);
                continue;
            }

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
                    startSession(uid, null, true);
                }
            }, delay);

            delay += 8000;
        }
    }
}

client.on(Events.InteractionCreate, async (i) => {
    try {
        if (!i || isShuttingDown) return;
        if (!i.user?.id) return;
        const uid = i.user.id;

        const lastInteraction = lastInteractionAt.get(uid) || 0;
        if (Date.now() - lastInteraction < 1000) {
            return safeReply(i, "Please wait a moment before clicking again.");
        }
        lastInteractionAt.set(uid, Date.now());

        if (i.isChatInputCommand()) {
            if (i.commandName === "panel") return i.reply(panelRow(false)).catch(() => {});
            if (i.commandName === "java") return i.reply(panelRow(true)).catch(() => {});
        }

        if (i.isButton()) {
            if (i.customId === "start_bedrock" || i.customId === "start_java") {
                if (sessions.has(uid)) return safeReply(i, "**Session Conflict**: Active session exists.");
                await i.deferReply({ ephemeral: true });

                const embed = i.customId === "start_java"
                    ? new EmbedBuilder()
                        .setTitle("Java Compatibility Check")
                        .setDescription("For a successful connection to a Java server, ensure the following plugins are installed.")
                        .addFields({ name: "Required Plugins", value: "GeyserMC\nFloodgate" })
                        .setColor("#E67E22")
                    : new EmbedBuilder()
                        .setTitle("Bedrock Connection")
                        .setDescription("Start bot?")
                        .setColor("#2ECC71");

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("confirm_start").setLabel("Start").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );

                return i.followUp({ embeds: [embed], components: [row], ephemeral: true }).catch(() => {});
            }

            if (i.customId === "confirm_start") {
                await i.deferReply({ ephemeral: true }).catch(() => {});
                safeReply(i, "**Connecting...**", true);
                startSession(uid, i, false);
                return;
            }

            if (i.customId === "cancel") return safeReply(i, "Cancelled.");

            if (i.customId === "stop") {
                await i.deferReply({ ephemeral: true });
                const ok = await stopSession(uid);
                return safeReply(i, ok ? "**Session Terminated.**" : "No active sessions.");
            }

            if (i.customId === "link") return linkMicrosoft(uid, i);

            if (i.customId === "unlink") {
                await i.deferReply({ ephemeral: true });
                await unlinkMicrosoft(uid);
                return safeReply(i, "Unlinked Microsoft account.");
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

            if (!ip || !portStr) return safeReply(i, "IP and Port are required.");
            if (!isValidIP(ip)) return safeReply(i, "Invalid IP address format.");
            if (!isValidPort(port)) return safeReply(i, "Invalid port (must be 1-65535).");

            const u = getUser(uid);
            u.server = { ip, port };
            await userStore.save();
            return safeReply(i, `Saved: **${ip}:${port}**`);
        }
    } catch (e) {
        console.error("Interaction error:", e);
    }
});

// ==================== STARTUP ====================

async function main() {
    await initializeStores();
    client.login(DISCORD_TOKEN).catch((err) => {
        console.error("Initial login failed:", err);
        process.exit(1);
    });
}

main();

setInterval(() => {
    console.log(`Heartbeat | Sessions: ${sessions.size} | Discord: ${discordReady ? 'Connected' : 'Disconnected'} | Uptime: ${Math.floor(process.uptime() / 60)}m`);
}, 60000);
