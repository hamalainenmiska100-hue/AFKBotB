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
    EmbedBuilder
} = require("discord.js");
const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// --- Dependencies for Chunk Scanning & Bed Detection ---
let Vec3, PrismarineChunk, PrismarineRegistry;
try {
    Vec3 = require("vec3");
    PrismarineChunk = require("prismarine-chunk");
    PrismarineRegistry = require("prismarine-registry");
} catch (e) {
    console.log("⚠️ Advanced features (Bed Detection/Physics) disabled! Missing optional dependencies.");
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
    console.error("❌ DISCORD_TOKEN missing");
    process.exit(1);
}

// ----------------- Config -----------------
const ADMIN_ID = "1144987924123881564";
const LOG_CHANNEL_ID = "1464615030111731753";
const SAVE_DEBOUNCE_MS = 1000; // Debounce rapid saves
const AUTO_SAVE_INTERVAL_MS = 30000; // Auto-save every 30s
const MAX_RECONNECT_ATTEMPTS = 80; // Prevent infinite reconnection loops
const RECONNECT_BASE_DELAY_MS = 30000; // Start with 30s, exponential backoff

// ----------------- Storage -----------------
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");
const REJOIN_STORE = path.join(DATA, "ReJoin.json");
const CRASH_LOG = path.join(DATA, "crash.log");

// Safe directory initialization with recursive retry
function ensureDir(dir, retries = 3) {
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return true;
    } catch (e) {
        if (retries > 0 && e.code === 'EBUSY') {
            setTimeout(() => ensureDir(dir, retries - 1), 100);
            return false;
        }
        console.error(`❌ Fatal: Cannot create directory ${dir}:`, e);
        return false;
    }
}

if (!ensureDir(DATA) || !ensureDir(AUTH_ROOT)) {
    process.exit(1);
}

// Enhanced Safe Load Helper with schema validation
function loadJson(filePath, defaultVal = {}) {
    if (!fs.existsSync(filePath)) return defaultVal;
    try {
        const data = fs.readFileSync(filePath, "utf8");
        if (!data || data.trim() === "") return defaultVal;
        const parsed = JSON.parse(data);
        // Validate it's an object (not array/string)
        if (typeof parsed !== 'object' || parsed === null) return defaultVal;
        return parsed;
    } catch (e) {
        console.error(`⚠️ Corrupt JSON at ${filePath}:`, e.message);
        try {
            const backupPath = `${filePath}.backup.${Date.now()}`;
            fs.renameSync(filePath, backupPath);
            console.log(`📦 Backed up corrupt file to ${backupPath}`);
        } catch (backupErr) {
            console.error("Failed to backup corrupt file:", backupErr.message);
        }
        return defaultVal;
    }
}

// Enhanced Save System with debouncing and queue
class PersistentStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = null;
        this.saveTimeout = null;
        this.isSaving = false;
        this.saveQueue = [];
    }

    load(defaultVal = {}) {
        this.data = loadJson(this.filePath, defaultVal);
        return this.data;
    }

    // Debounced save to prevent disk thrashing
    save(immediate = false) {
        return new Promise((resolve) => {
            this.saveQueue.push(resolve);
            
            if (immediate) {
                this._flush();
                return;
            }

            if (this.saveTimeout) clearTimeout(this.saveTimeout);
            this.saveTimeout = setTimeout(() => this._flush(), SAVE_DEBOUNCE_MS);
        });
    }

    async _flush() {
        if (this.isSaving) {
            // Retry after current save completes
            setTimeout(() => this._flush(), 100);
            return;
        }

        this.isSaving = true;
        const resolvers = [...this.saveQueue];
        this.saveQueue = [];

        const tempPath = `${this.filePath}.tmp`;
        let success = false;

        try {
            // Ensure directory still exists (Docker volume issues)
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const jsonString = JSON.stringify(this.data, null, 2);
            
            // Atomic write: write temp, then rename
            fs.writeFileSync(tempPath, jsonString, { encoding: 'utf8', flag: 'w' });
            fs.renameSync(tempPath, this.filePath);
            success = true;
        } catch (e) {
            console.error(`❌ Save failed for ${this.filePath}:`, e.message);
            // Attempt emergency backup
            try {
                const emergencyPath = `${this.filePath}.emergency.${Date.now()}`;
                fs.writeFileSync(emergencyPath, JSON.stringify(this.data));
                console.log(`🆘 Emergency backup saved to ${emergencyPath}`);
            } catch (emergencyErr) {
                console.error("🆘 CRITICAL: Even emergency backup failed:", emergencyErr.message);
            }
        } finally {
            this.isSaving = false;
            // Resolve all waiting promises
            resolvers.forEach(r => r(success));
            if (this.saveQueue.length > 0) {
                setTimeout(() => this._flush(), 10);
            }
        }
    }
}

// Initialize stores
const userStore = new PersistentStore(STORE);
const sessionStore = new PersistentStore(REJOIN_STORE);

let users = userStore.load({});
let activeSessionsStore = sessionStore.load({});

// Auto-save interval
setInterval(() => {
    userStore.save().catch(e => console.error("Auto-save error:", e));
    sessionStore.save().catch(e => console.error("Session auto-save error:", e));
}, AUTO_SAVE_INTERVAL_MS);

// ----------------- User Management -----------------
function getUser(uid) {
    if (!uid || typeof uid !== 'string' || !/^\d+$/.test(uid)) {
        console.warn(`Invalid UID access attempt: ${uid}`);
        return { connectionType: "online", bedrockVersion: "auto", _temp: true };
    }
    
    if (!users[uid]) {
        users[uid] = {
            connectionType: "online",
            bedrockVersion: "auto",
            createdAt: Date.now()
        };
        userStore.save(); // Auto-save new users
    }
    
    // Ensure defaults for missing fields
    users[uid].connectionType = users[uid].connectionType || "online";
    if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
    
    return users[uid];
}

function getUserAuthDir(uid) {
    if (!uid || typeof uid !== 'string') return null;
    // Sanitize UID to prevent path traversal
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
            console.error("Error removing auth dir:", e.message);
        }
    }
    const u = getUser(uid);
    u.linked = false;
    await userStore.save();
    return true;
}

// ----------------- Runtime -----------------
const sessions = new Map();
const pendingLink = new Map();
const lastMsa = new Map();
let lastAdminMessage = null;
let isShuttingDown = false;

// ----------------- Discord client -----------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessages
    ],
    failIfNotExists: false,
    allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
    // Crash prevention: don't crash on cache errors
    rest: {
        rejectOnRateLimit: () => false,
    }
});

// ==========================================================
// 🛡️ ENHANCED CRASH PREVENTION SYSTEM
// ==========================================================

// Global error handlers with logging
process.on("uncaughtException", (err) => {
    const timestamp = new Date().toISOString();
    const errorMsg = `[${timestamp}] UNCAUGHT EXCEPTION:\n${err.stack || err.message}\n\n`;
    console.error("🔥", errorMsg);
    
    // Write to crash log for debugging
    try {
        fs.appendFileSync(CRASH_LOG, errorMsg);
    } catch (e) { /* ignore */ }
    
    // Keep alive unless it's a fatal error
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        process.exit(1);
    }
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("🔥 Unhandled Rejection at:", promise, "reason:", reason);
    // Log but don't crash
});

// Discord client error handlers
client.on("error", (error) => {
    console.error("⚠️ Discord Client Error:", error?.message || error);
    // Attempt reconnect after delay
    setTimeout(() => {
        if (client.isReady()) return;
        client.login(DISCORD_TOKEN).catch(e => console.error("Re-login failed:", e));
    }, 10000);
});

client.on("shardError", (error) => {
    console.error("⚠️ WebSocket Error:", error?.message || error);
});

client.on("warn", (warning) => {
    console.warn("⚠️ Discord Warning:", warning);
});

// Graceful shutdown with cleanup timeout
function gracefulShutdown(signal) {
    console.log(`🛑 ${signal} received. Initiating graceful shutdown...`);
    isShuttingDown = true;
    
    // Force exit after 10s regardless
    const forceExit = setTimeout(() => {
        console.error("⚠️ Forced exit after timeout");
        process.exit(1);
    }, 10000);
    
    Promise.all([
        userStore.save(true),
        sessionStore.save(true)
    ]).then(() => {
        cleanupAllSessions();
        return client.destroy();
    }).then(() => {
        clearTimeout(forceExit);
        process.exit(0);
    }).catch(err => {
        console.error("Error during shutdown:", err);
        process.exit(1);
    });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Enhanced cleanup
function cleanupAllSessions() {
    console.log(`🧹 Cleaning up ${sessions.size} sessions...`);
    const promises = [];
    for (const [uid, session] of sessions) {
        try {
            promises.push(cleanupSession(uid));
        } catch (e) {
            console.error(`Error cleaning up session ${uid}:`, e);
        }
    }
    return Promise.all(promises);
}

async function logToDiscord(message) {
    if (!message || isShuttingDown) return;
    try {
        const channel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (!channel || !channel.send) return;
        
        const embed = new EmbedBuilder()
            .setColor("#5865F2")
            .setDescription(String(message).slice(0, 4096))
            .setTimestamp();
            
        await channel.send({ embeds: [embed] }).catch(() => {});
    } catch (e) {
        // Silent fail
    }
}

// ----------------- UI helpers (unchanged mostly) -----------------
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
            new ButtonBuilder().setCustomId("admin_stop_all").setLabel("🛑 Force Stop All").setStyle(ButtonStyle.Danger)
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
    let memory = { rss: 0 };
    try {
        memory = process.memoryUsage();
    } catch (e) {}
    
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
            { name: "💾 Persisted Sessions", value: `**Saved for Restart:** ${Object.keys(activeSessionsStore || {}).length}`, inline: true }
        )
        .setFooter({ text: "Auto-refreshing every 30s • Administrative Access Only" })
        .setTimestamp();

    if (sessions.size > 0) {
        let botList = "";
        for (const [uid, s] of sessions) {
            const status = s?.connected ? "🟢 Online" : (s?.isReconnecting ? "⏳ Reconnecting" : "🔴 Offline");
            botList += `<@${uid}>: ${status}\n`;
        }
        if (botList.length > 1024) botList = botList.slice(0, 1021) + "...";
        embed.addFields({ name: "📋 Active Bot Registry", value: botList || "None" });
    }
    return embed;
}

// ----------------- Events: Ready & Startup Rejoin -----------------
client.once("ready", async () => {
    console.log("🟢 Online as", client.user?.tag || "Unknown");

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
        if (lastAdminMessage && !isShuttingDown) {
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

    console.log("📂 Checking ReJoin.json for previous sessions...");
    const previousSessions = Object.keys(activeSessionsStore || {});

    if (previousSessions.length > 0) {
        console.log(`♻️ Found ${previousSessions.length} bots to restore. Starting them now...`);
        let delay = 0;
        for (const uid of previousSessions) {
            if (typeof uid === 'string' && uid.match(/^\d+$/)) {
                setTimeout(() => {
                    if (!isShuttingDown) startSession(uid, null, true);
                }, delay);
                delay += 5000; // Staggered startup to prevent rate limits
            }
        }
    } else {
        console.log("⚪ No previous sessions found.");
    }
});

// ----------------- Microsoft link (Enhanced) -----------------
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

    // Timeout handler
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
            await userStore.save(); // Ensure save completes
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

// ----------------- Session Logic (Hardened) -----------------
async function cleanupSession(uid) {
    if (!uid) return;
    const s = sessions.get(uid);
    if (!s) return;

    try {
        // Clear all timers
        const timers = ['reconnectTimer', 'physicsLoop', 'afkTimeout', 'chunkGCLoop'];
        timers.forEach(timer => {
            if (s[timer]) {
                clearTimeout(s[timer]);
                clearInterval(s[timer]);
                s[timer] = null;
            }
        });

        // Remove listeners before closing to prevent event firing during cleanup
        if (s.client) {
            s.client.removeAllListeners();
            try {
                s.client.close();
            } catch (e) {
                // Ignore close errors
            }
            s.client = null;
        }
    } catch (e) {
        console.error(`Error in cleanupSession for ${uid}:`, e);
    }
    
    sessions.delete(uid);
}

async function stopSession(uid) {
    if (!uid) return false;
    
    // Remove from persistent store immediately
    if (activeSessionsStore[uid]) {
        delete activeSessionsStore[uid];
        await sessionStore.save(); // Wait for save
    }

    await cleanupSession(uid);
    return true;
}

function handleAutoReconnect(uid, attempt = 1) {
    if (!uid || isShuttingDown) return;
    const s = sessions.get(uid);
    if (!s || s.manualStop) return;

    // Max retry limit to prevent infinite loops
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
        console.log(`🚫 Max reconnection attempts reached for ${uid}`);
        logToDiscord(`🚫 Bot of <@${uid}> stopped after ${MAX_RECONNECT_ATTEMPTS} failed reconnection attempts.`);
        cleanupSession(uid);
        delete activeSessionsStore[uid];
        sessionStore.save();
        return;
    }

    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);

    s.isReconnecting = true;
    s.reconnectAttempt = attempt;
    
    // Exponential backoff: 30s, 60s, 120s, 240s, 480s
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1), 600000); // Max 10 minutes
    
    logToDiscord(`⏳ Bot of <@${uid}> disconnected. Reconnecting in ${delay/1000}s (Attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})...`);

    s.reconnectTimer = setTimeout(() => {
        if (!isShuttingDown && !s.manualStop) {
            startSession(uid, null, true, attempt + 1);
        } else {
            cleanupSession(uid);
        }
    }, delay);
}

async function safeReply(interaction, content) {
    if (!interaction) return;
    try {
        // Handle both string and object content
        const payload = typeof content === 'string' ? { content } : content;
        
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply(payload).catch(() => {});
        } else {
            if (payload.ephemeral) {
                await interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
            } else {
                await interaction.reply(payload).catch(() => {});
            }
        }
    } catch (e) {
        // Silent fail - don't crash on Discord API errors
    }
}

// Enhanced validation
function isValidIP(ip) {
    if (!ip || typeof ip !== 'string') return false;
    if (ip.length > 253) return false;
    
    // Prevent injection attempts
    if (ip.includes('..') || ip.startsWith('.') || ip.endsWith('.')) return false;
    if (ip.includes('://')) return false; // No protocols
    
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
    const hostnameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
    
    return ipv4Regex.test(ip) || ipv6Regex.test(ip) || hostnameRegex.test(ip);
}

function isValidPort(port) {
    const num = parseInt(port, 10);
    return !isNaN(num) && num > 0 && num <= 65535;
}

// ----------------- MAIN SESSION FUNCTION (Hardened) -----------------
async function startSession(uid, interaction, isReconnect = false, reconnectAttempt = 1) {
    if (!uid || isShuttingDown) return;
    
    const u = getUser(uid);
    if (!u) {
        if (!isReconnect) safeReply(interaction, "❌ User data error.");
        return;
    }

    // Validate user data exists
    if (!activeSessionsStore) activeSessionsStore = {};
    
    // Only add to active sessions if not already there (prevents duplicate keys)
    if (!activeSessionsStore[uid]) {
        activeSessionsStore[uid] = { 
            startedAt: Date.now(),
            server: u.server // Cache server info for recovery
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

    // Session conflict check
    if (sessions.has(uid) && !isReconnect) {
        return safeReply(interaction, { 
            ephemeral: true, 
            content: "⚠️ **Session Conflict**: Active session already exists. Use `/stop` first." 
        });
    }

    // If reconnecting, clean up old session first
    if (isReconnect && sessions.has(uid)) {
        await cleanupSession(uid);
    }

    const connectionEmbed = new EmbedBuilder()
        .setColor("#5865F2")
        .setTitle("Bot Initialization")
        .setThumbnail("https://files.catbox.moe/9mqpoz.gif");

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

        if (!isReconnect && interaction) {
            connectionEmbed.setDescription(`✅ **Server found! Joining...**\n🌐 **Target:** \`${ip}:${port}\``);
            await safeReply(interaction, { embeds: [connectionEmbed] });
        }
    } catch (err) {
        logToDiscord(`❌ Connection failure for <@${uid}>: Server ${ip}:${port} unreachable.`);
        if (isReconnect) handleAutoReconnect(uid, reconnectAttempt);
        else if (interaction) {
            await safeReply(interaction, { 
                content: `❌ **Connection Failed**: The server at \`${ip}:${port}\` is currently offline or unreachable.`, 
                embeds: [] 
            });
        }
        return;
    }

    const authDir = getUserAuthDir(uid);
    if (!authDir) {
        if (!isReconnect) safeReply(interaction, "❌ Auth directory error.");
        return;
    }

    const opts = {
        host: ip,
        port: parseInt(port),
        connectTimeout: 60000,
        keepAlive: true,
        viewDistance: 4,
        profilesFolder: authDir,
        username: uid,
        offline: false,
        skipPing: true
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
        reconnectAttempt: reconnectAttempt,
        position: null,
        velocity: Vec3 ? new Vec3(0, 0, 0) : null,
        yaw: 0,
        pitch: 0,
        onGround: false,
        isWalking: false,
        targetPosition: null,
        isTryingToSleep: false,
        chunks: new Map(),
        registry: null,
        Chunk: null,
        reconnectTimer: null,
        physicsLoop: null,
        afkTimeout: null,
        chunkGCLoop: null,
        entityId: null,
        packetQueue: [] // Queue for packets sent before fully connected
    };
    sessions.set(uid, currentSession);

    // ==========================================
    // 🍎 ADVANCED PHYSICS & CHUNK ENGINE (Hardened)
    // ==========================================
    if (Vec3 && PrismarineChunk && currentSession.velocity) {
        try {
            currentSession.registry = PrismarineRegistry('bedrock_1.20.0');
            currentSession.Chunk = PrismarineChunk(currentSession.registry);
        } catch (e) {
            logToDiscord(`Could not initialize chunk manager for <@${uid}>. Bed detection disabled.`);
            currentSession.Chunk = null;
        }

        mc.on('level_chunk', (packet) => {
            if (!currentSession?.Chunk || !packet) return;
            try {
                const chunk = new currentSession.Chunk();
                if (packet.payload) chunk.load(packet.payload);
                if (packet.x !== undefined && packet.z !== undefined) {
                    currentSession.chunks.set(`${packet.x},${packet.z}`, chunk);
                }
            } catch (e) { 
                // Ignore chunk errors silently
            }
        });

        // More frequent GC for memory management
        currentSession.chunkGCLoop = setInterval(() => {
            try {
                if (currentSession.chunks && currentSession.chunks.size > 15) { // Lower threshold
                    // Keep only chunks near player instead of clearing all
                    if (currentSession.position) {
                        const px = Math.floor(currentSession.position.x / 16);
                        const pz = Math.floor(currentSession.position.z / 16);
                        const toDelete = [];
                        for (const key of currentSession.chunks.keys()) {
                            const [cx, cz] = key.split(',').map(Number);
                            const dist = Math.abs(cx - px) + Math.abs(cz - pz);
                            if (dist > 3) toDelete.push(key); // Keep only within 3 chunks
                        }
                        toDelete.forEach(k => currentSession.chunks.delete(k));
                    } else {
                        currentSession.chunks.clear();
                    }
                }
            } catch (e) {}
        }, 10000); // Check every 10s
    }

    // Safe packet writer wrapper
    function safeWrite(packetName, params) {
        try {
            if (mc && mc.write && !mc.destroyed && currentSession?.connected) {
                mc.write(packetName, params);
                return true;
            }
        } catch (e) {
            console.error(`Packet write error (${packetName}):`, e.message);
        }
        return false;
    }

    // Physics loop with error isolation
    if (currentSession.physicsLoop) clearInterval(currentSession.physicsLoop);
    
    currentSession.physicsLoop = setInterval(() => {
        try {
            if (!currentSession?.connected || !currentSession.position || !currentSession.velocity) return;

            const gravity = 0.08;
            const moveVector = { x: 0, z: 0 };

            if (currentSession.isWalking && currentSession.targetPosition) {
                const distance = currentSession.position.distanceTo(currentSession.targetPosition);
                if (distance > 0.5) {
                    const direction = currentSession.targetPosition.minus(currentSession.position).normalize();
                    moveVector.x = direction.x;
                    moveVector.z = direction.z;
                } else {
                    currentSession.isWalking = false;
                }
            }

            if (!currentSession.onGround) {
                currentSession.velocity.y -= gravity;
            }

            if (currentSession.velocity.y < -3.92) currentSession.velocity.y = -3.92;

            currentSession.position.add(currentSession.velocity);

            // Void death prevention
            if (currentSession.position.y < -64) {
                currentSession.position.y = 320;
                currentSession.velocity.y = 0;
            }

            // Send packet safely
            safeWrite("player_auth_input", {
                pitch: currentSession.pitch || 0, 
                yaw: currentSession.yaw || 0,
                position: { 
                    x: currentSession.position.x, 
                    y: currentSession.position.y, 
                    z: currentSession.position.z 
                },
                move_vector: moveVector, 
                head_yaw: currentSession.yaw || 0, 
                input_data: 0n,
                input_mode: "mouse", 
                play_mode: "screen", 
                interaction_model: "touch", 
                tick: 0n
            });
        } catch (e) { 
            // Isolate physics errors
        }
    }, 50);

    // ==========================================
    // 🤖 ANTI-AFK CONTROLLER (Hardened)
    // ==========================================
    const performAntiAfk = () => {
        if (!sessions.has(uid) || isShuttingDown) return;
        const s = sessions.get(uid);
        if (!s) return;

        if (!s.connected || !s.position) {
            s.afkTimeout = setTimeout(performAntiAfk, 5000);
            return;
        }

        try {
            // Only scan for bed occasionally to save CPU
            if (Math.random() > 0.7) scanForBedAndSleep(uid);

            const action = Math.random();
            if (action > 0.5 && !s.isWalking) {
                s.isWalking = true;
                // Pick random target within 5 blocks
                if (s.targetPosition && s.position) {
                    s.targetPosition = s.position.offset(
                        (Math.random() - 0.5) * 10,
                        0,
                        (Math.random() - 0.5) * 10
                    );
                }
            } else {
                s.yaw += (Math.random() - 0.5) * 20;
                s.pitch += (Math.random() - 0.5) * 10;
                if (s.onGround && Math.random() > 0.9 && s.velocity) {
                    s.velocity.y = 0.42; // Jump
                    s.onGround = false;
                }
            }

            // Swing animation
            if (s.entityId) {
                safeWrite('animate', { action_id: 1, runtime_entity_id: s.entityId });
            }
        } catch (e) {}

        const nextDelay = Math.random() * 20000 + 10000;
        s.afkTimeout = setTimeout(performAntiAfk, nextDelay);
    };

    // ==========================================
    // 🛌 BED DETECTION AI (Hardened)
    // ==========================================
    function scanForBedAndSleep(uid) {
        const s = sessions.get(uid);
        if (!s || !s.Chunk || !s.position || s.isTryingToSleep || !Vec3) return;

        try {
            const searchRadius = 3;
            const playerPos = s.position.floored();

            for (let x = -searchRadius; x <= searchRadius; x++) {
                for (let y = -searchRadius; y <= searchRadius; y++) {
                    for (let z = -searchRadius; z <= searchRadius; z++) {
                        const checkPos = playerPos.offset(x, y, z);
                        const chunkX = Math.floor(checkPos.x / 16);
                        const chunkZ = Math.floor(checkPos.z / 16);
                        const chunk = s.chunks.get(`${chunkX},${chunkZ}`);

                        if (chunk && chunk.getBlock) {
                            try {
                                const block = chunk.getBlock(checkPos);
                                if (block && block.name && block.name.includes('bed')) {
                                    logToDiscord(`🛌 Bed found for <@${uid}>. Attempting to sleep.`);
                                    s.isTryingToSleep = true;

                                    // Attempt to sleep
                                    safeWrite('inventory_transaction', {
                                        transaction: {
                                            transaction_type: 'item_use_on_block', 
                                            action_type: 0,
                                            block_position: checkPos, 
                                            block_face: 1, 
                                            hotbar_slot: 0,
                                            item_in_hand: { network_id: 0 }, 
                                            player_position: s.position,
                                            click_position: { x: 0, y: 0, z: 0 }
                                        }
                                    });

                                    safeWrite('player_action', {
                                        runtime_entity_id: s.entityId || 0n,
                                        action: 'start_sleeping',
                                        position: checkPos,
                                        result_code: 0,
                                        face: 0
                                    });
                                    
                                    // Reset sleep flag after delay
                                    setTimeout(() => {
                                        if (sessions.has(uid)) {
                                            sessions.get(uid).isTryingToSleep = false;
                                        }
                                    }, 10000);
                                    return;
                                }
                            } catch (err) {
                                // Ignore chunk read errors
                            }
                        }
                    }
                }
            }
        } catch (e) {
            // Ignore bed scan errors
        }
    }

    // --- EVENTS (Hardened) ---
    mc.on("spawn", () => {
        logToDiscord(`✅ Bot of <@${uid}> spawned on **${ip}:${port}**` + (isReconnect ? ` (Attempt ${reconnectAttempt})` : ""));
        if (!isReconnect) safeReply(interaction, { content: `🟢 **Online** on \`${ip}:${port}\``, embeds: [] });
    });

    mc.on("start_game", (packet) => {
        if (!packet || !currentSession) return;
        try {
            if (Vec3 && currentSession.position) {
                currentSession.position.set(
                    packet.player_position?.x || 0, 
                    packet.player_position?.y || 0, 
                    packet.player_position?.z || 0
                );
                currentSession.targetPosition = currentSession.position.clone();
            }
            currentSession.entityId = packet.runtime_entity_id;
            currentSession.connected = true;
            currentSession.isReconnecting = false;
            currentSession.reconnectAttempt = 0; // Reset counter on success

            performAntiAfk();
        } catch (e) {
            console.error("Error in start_game handler:", e);
        }
    });

    mc.on("move_player", (packet) => {
        if (!packet || !currentSession) return;
        try {
            if (packet.runtime_id === currentSession.entityId && currentSession.position) {
                // Ground detection
                if (packet.position && packet.position.y > currentSession.position.y && currentSession.velocity) {
                    currentSession.onGround = true;
                    currentSession.velocity.y = 0;
                } else {
                    currentSession.onGround = false;
                }
                
                currentSession.isTryingToSleep = false;
                currentSession.position.set(
                    packet.position?.x || 0, 
                    packet.position?.y || 0, 
                    packet.position?.z || 0
                );
            }
        } catch (e) {
            console.error("Error in move_player handler:", e);
        }
    });

    mc.on("respawn", (packet) => {
        logToDiscord(`💀 Bot of <@${uid}> died and respawned.`);
        if (!packet || !currentSession) return;
        try {
            if (currentSession.position) {
                currentSession.position.set(
                    packet.position?.x || 0, 
                    packet.position?.y || 0, 
                    packet.position?.z || 0
                );
                if (currentSession.targetPosition) {
                    currentSession.targetPosition.set(currentSession.position.x, currentSession.position.y, currentSession.position.z);
                }
                if (currentSession.velocity) currentSession.velocity.set(0, 0, 0);
                currentSession.isTryingToSleep = false;
                currentSession.onGround = true;
            }
        } catch (e) {
            console.error("Error in respawn handler:", e);
        }
    });

    mc.on("error", (e) => {
        console.error(`Session error for ${uid}:`, e);
        if (!currentSession.manualStop) handleAutoReconnect(uid, reconnectAttempt);
        logToDiscord(`❌ Bot of <@${uid}> error: \`${e?.message || 'Unknown error'}\``);
    });

    mc.on("close", () => {
        console.log(`Connection closed for ${uid}`);
        if (!currentSession.manualStop) handleAutoReconnect(uid, reconnectAttempt);
        else logToDiscord(`🔌 Bot of <@${uid}> disconnected manually.`);
    });
    
    // Packet error handler (prevents protocol errors from crashing)
    mc.on('packet_error', (err) => {
        console.error(`Packet error for ${uid}:`, err);
    });
}

// ----------------- Interactions (Hardened) -----------------
client.on(Events.InteractionCreate, async (i) => {
    if (!i || isShuttingDown) return;
    
    try {
        // Validate interaction has user
        if (!i.user?.id) {
            console.warn("Interaction without user received");
            return;
        }
        
        const uid = i.user.id;
        
        // Rate limiting check (basic)
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
                if (uid !== ADMIN_ID) return safeReply(i, { content: "⛔ Access restricted.", ephemeral: true });
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
                const targetUid = i.values?.[0];
                if (targetUid && typeof targetUid === 'string') {
                    await stopSession(targetUid);
                    return i.update({ 
                        content: `🛑 Forced stop for <@${targetUid}>`, 
                        embeds: [getAdminStatsEmbed()], 
                        components: adminPanelComponents() 
                    }).catch(() => {});
                }
            }
        }

        if (i.isButton()) {
            // Handle admin buttons
            if (i.customId === "admin_refresh") {
                return i.update({ 
                    embeds: [getAdminStatsEmbed()], 
                    components: adminPanelComponents() 
                }).catch(() => {});
            }

            if (i.customId === "admin_stop_all") {
                if (uid !== ADMIN_ID) return;
                const stopPromises = [];
                sessions.forEach((_, sUid) => stopPromises.push(stopSession(sUid)));
                await Promise.all(stopPromises);
                return i.update({ 
                    content: "🛑 All sessions stopped.", 
                    embeds: [getAdminStatsEmbed()], 
                    components: adminPanelComponents() 
                }).catch(() => {});
            }

            // User buttons
            if (i.customId === "start_bedrock") {
                if (sessions.has(uid)) {
                    return safeReply(i, { ephemeral: true, content: "⚠️ **Session Conflict**: Active session exists." });
                }
                const embed = new EmbedBuilder()
                    .setTitle("Bedrock Connection")
                    .setDescription("Start bot?")
                    .setColor("#2ECC71");
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("confirm_start").setLabel("Start").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );
                return i.reply({ embeds: [embed], components: [row], ephemeral: true }).catch(() => {});
            }

            if (i.customId === "start_java") {
                if (sessions.has(uid)) {
                    return safeReply(i, { ephemeral: true, content: "⚠️ **Session Conflict**: Active session exists." });
                }
                const embed = new EmbedBuilder()
                    .setTitle("⚙️ Java Compatibility Check")
                    .setDescription("For a successful connection to a Java server, ensure the following plugins are installed.")
                    .addFields({ name: "Required Plugins", value: "• GeyserMC\n• Floodgate" })
                    .setColor("#E67E22");
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("confirm_start").setLabel("Confirm & Start").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );
                return i.reply({ embeds: [embed], components: [row], ephemeral: true }).catch(() => {});
            }

            if (i.customId === "confirm_start") {
                await i.deferUpdate().catch(() => {});
                return startSession(uid, i, false);
            }

            if (i.customId === "cancel") {
                return i.update({ content: "❌ Cancelled.", embeds: [], components: [] }).catch(() => {});
            }

            if (i.customId === "stop") {
                const ok = await stopSession(uid);
                return safeReply(i, { ephemeral: true, content: ok ? "⏹ **Session Terminated.**" : "No active sessions." });
            }

            if (i.customId === "link") {
                await i.deferReply({ ephemeral: true }).catch(() => {});
                return linkMicrosoft(uid, i);
            }

            if (i.customId === "unlink") {
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
                await userStore.save(); // Ensure save completes before replying
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

client.login(DISCORD_TOKEN).catch(e => {
    console.error("❌ Failed to login to Discord:", e);
    process.exit(1);
});
