'use strict';

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

// Optional: Vec3 for physics (graceful degradation if missing)
let Vec3;
try {
    Vec3 = require("vec3");
} catch (e) {
    console.warn("[INIT] Vec3 not available - physics disabled");
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
    console.error("[FATAL] DISCORD_TOKEN missing");
    process.exit(1);
}

// ==================== CONFIGURATION ====================
const CONFIG = {
    ADMIN_ID: "1144987924123881564",
    LOG_CHANNEL_ID: "1464615030111731753",
    SAVE_DEBOUNCE_MS: 1000,
    MAX_RECONNECT_ATTEMPTS: 50, // Reduced for production stability
    RECONNECT_BASE_DELAY_MS: 5000,
    RECONNECT_MAX_DELAY_MS: 300000,
    CONNECTION_TIMEOUT_MS: 30000,
    KEEPALIVE_INTERVAL_MS: 15000,
    STALE_CONNECTION_TIMEOUT_MS: 60000,
    MEMORY_CHECK_INTERVAL_MS: 60000,
    MAX_MEMORY_MB: 2048,
    SWING_INTERVAL_MS: 3000,
    PHYSICS_TICK_MS: 50,
    GRACEFUL_SHUTDOWN_TIMEOUT_MS: 20000,
};

// ==================== STORAGE SYSTEM ====================
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");
const REJOIN_STORE = path.join(DATA, "rejoin.json");
const CRASH_LOG = path.join(DATA, "crash.log");

function ensureDir(dir) {
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return true;
    } catch (e) {
        console.error(`[FATAL] Cannot create directory ${dir}:`, e);
        return false;
    }
}

if (!ensureDir(DATA) || !ensureDir(AUTH_ROOT)) {
    process.exit(1);
}

// ==================== PERSISTENT STORE (Simplified for stability) ====================
class PersistentStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = {};
        this.saveTimeout = null;
        this.lastSave = 0;
    }

    load(defaultVal = {}) {
        if (fs.existsSync(this.filePath)) {
            try {
                const content = fs.readFileSync(this.filePath, "utf8");
                if (content.trim()) {
                    this.data = { ...defaultVal, ...JSON.parse(content) };
                } else {
                    this.data = defaultVal;
                }
            } catch (e) {
                console.error(`[STORE] Corrupt JSON at ${this.filePath}, backing up:`, e.message);
                this._backupCorrupt();
                this.data = defaultVal;
            }
        } else {
            this.data = defaultVal;
        }
        return this.data;
    }

    _backupCorrupt() {
        try {
            if (fs.existsSync(this.filePath)) {
                fs.renameSync(this.filePath, `${this.filePath}.corrupt.${Date.now()}`);
            }
        } catch (e) {
            console.error("[STORE] Failed to backup corrupt file:", e);
        }
    }

    set(key, value) {
        this.data[key] = value;
        this.save();
    }

    get(key) {
        return this.data[key];
    }

    delete(key) {
        delete this.data[key];
        this.save();
    }

    save(immediate = false) {
        clearTimeout(this.saveTimeout);
        
        const performSave = () => {
            try {
                const tempPath = `${this.filePath}.tmp`;
                fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
                fs.renameSync(tempPath, this.filePath);
                this.lastSave = Date.now();
            } catch (e) {
                console.error(`[STORE] Save failed:`, e);
            }
        };

        if (immediate) {
            performSave();
        } else {
            this.saveTimeout = setTimeout(performSave, CONFIG.SAVE_DEBOUNCE_MS);
        }
    }
}

const userStore = new PersistentStore(STORE);
const sessionStore = new PersistentStore(REJOIN_STORE);

let users = userStore.load({});
let activeSessionsStore = sessionStore.load({});

// ==================== RUNTIME STATE ====================
const sessions = new Map();
const pendingLink = new Map();
let lastAdminMessage = null;
let isShuttingDown = false;
let discordReady = false;
let metrics = {
    starts: 0,
    reconnects: 0,
    crashes: 0,
    startTime: Date.now()
};

// ==================== DISCORD CLIENT ====================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessages
    ],
    failIfNotExists: false,
    allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
    rest: {
        retries: 3,
        timeout: 30000
    },
    presence: {
        status: 'online',
        activities: [{ name: 'AFK Bot System', type: ActivityType.Watching }]
    }
});

// ==================== ERROR HANDLING ====================
process.on("uncaughtException", (err) => {
    console.error("[CRASH] Uncaught Exception:", err);
    metrics.crashes++;
    try {
        fs.appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] UNCAUGHT: ${err.stack}\n`);
    } catch (e) {}
    
    // Don't exit on non-fatal errors
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        gracefulShutdown('FATAL_ERROR');
    }
});

process.on("unhandledRejection", (reason) => {
    console.error("[CRASH] Unhandled Rejection:", reason);
    metrics.crashes++;
    try {
        fs.appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] REJECTION: ${reason}\n`);
    } catch (e) {}
});

// ==================== SESSION MANAGEMENT ====================
/**
 * Complete cleanup of session resources to prevent memory leaks
 */
async function cleanupSession(uid) {
    if (!uid) return;
    const session = sessions.get(uid);
    if (!session) return;

    console.log(`[SESSION] Cleaning up ${uid}`);

    try {
        // Clear all timers
        const timerKeys = [
            'reconnectTimer', 'physicsLoop', 'afkTimeout', 
            'keepaliveTimer', 'staleCheckTimer', 'swingTimer'
        ];
        
        for (const key of timerKeys) {
            if (session[key]) {
                clearTimeout(session[key]);
                clearInterval(session[key]);
                session[key] = null;
            }
        }

        // Remove Discord interaction references to prevent memory leaks
        session.interaction = null;
        session.startInteraction = null;

        // Clean up bedrock client
        if (session.client) {
            // Remove all listeners first to prevent callbacks during close
            session.client.removeAllListeners();
            
            try {
                if (typeof session.client.close === 'function' && !session.client.destroyed) {
                    session.client.close();
                }
            } catch (e) {
                // Ignore close errors
            }
            
            session.client = null;
        }

        // Clear position references
        session.position = null;
        session.targetPosition = null;
        session.velocity = null;
        
    } catch (e) {
        console.error(`[SESSION] Cleanup error for ${uid}:`, e);
    }
    
    sessions.delete(uid);
    
    // Force garbage collection hint (if available)
    if (global.gc && sessions.size === 0) {
        try {
            global.gc();
        } catch (e) {}
    }
}

async function cleanupAllSessions() {
    console.log(`[SHUTDOWN] Cleaning up ${sessions.size} sessions...`);
    const promises = [];
    for (const [uid] of sessions) {
        promises.push(cleanupSession(uid));
    }
    await Promise.all(promises);
}

async function stopSession(uid) {
    if (!uid) return false;
    
    const session = sessions.get(uid);
    if (session) {
        session.manualStop = true;
    }
    
    if (activeSessionsStore[uid]) {
        delete activeSessionsStore[uid];
        sessionStore.save(true);
    }

    await cleanupSession(uid);
    return true;
}

// ==================== RECONNECTION SYSTEM ====================
function scheduleReconnect(uid, attempt = 1) {
    if (!uid || isShuttingDown) return;
    
    const session = sessions.get(uid);
    if (!session || session.manualStop) return;

    if (attempt > CONFIG.MAX_RECONNECT_ATTEMPTS) {
        console.log(`[RECONNECT] Max attempts reached for ${uid}`);
        logToDiscord(`🚫 Bot <@${uid}> stopped after max failed attempts.`);
        cleanupSession(uid);
        delete activeSessionsStore[uid];
        sessionStore.save();
        return;
    }

    if (session.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
    }

    session.isReconnecting = true;
    session.reconnectAttempt = attempt;
    metrics.reconnects++;
    
    const baseDelay = Math.min(
        CONFIG.RECONNECT_BASE_DELAY_MS * Math.pow(1.5, attempt - 1),
        CONFIG.RECONNECT_MAX_DELAY_MS
    );
    const jitter = Math.random() * 5000;
    const delay = baseDelay + jitter;
    
    console.log(`[RECONNECT] ${uid} waiting ${Math.round(delay/1000)}s (attempt ${attempt})`);
    logToDiscord(`⏳ Bot <@${uid}> reconnecting in ${Math.round(delay/1000)}s (attempt ${attempt})...`);

    session.reconnectTimer = setTimeout(() => {
        if (!isShuttingDown && !session.manualStop) {
            startSession(uid, null, true, attempt + 1);
        } else {
            cleanupSession(uid);
        }
    }, delay);
}

// ==================== HEALTH MONITORING ====================
function startHealthMonitoring(uid) {
    const session = sessions.get(uid);
    if (!session) return;

    // Keepalive
    session.keepaliveTimer = setInterval(() => {
        if (!session.connected || !session.client || session.client.destroyed) {
            return;
        }
        
        try {
            session.client.queue('client_cache_status', { enabled: false });
            session.lastKeepalive = Date.now();
        } catch (e) {
            console.log(`[HEALTH] Keepalive failed for ${uid}`);
            scheduleReconnect(uid, session.reconnectAttempt + 1);
        }
    }, CONFIG.KEEPALIVE_INTERVAL_MS);

    // Stale connection detection
    session.staleCheckTimer = setInterval(() => {
        if (!session.connected) return;
        
        const lastActivity = Math.max(session.lastPacketTime || 0, session.lastKeepalive || 0);
        const staleTime = Date.now() - lastActivity;
        
        if (staleTime > CONFIG.STALE_CONNECTION_TIMEOUT_MS) {
            console.log(`[HEALTH] Stale connection for ${uid} (${staleTime}ms)`);
            logToDiscord(`⚠️ Stale connection for <@${uid}>, reconnecting...`);
            
            if (session.client && !session.client.destroyed) {
                try {
                    session.client.close();
                } catch (e) {}
            }
            scheduleReconnect(uid, session.reconnectAttempt + 1);
        }
    }, CONFIG.STALE_CONNECTION_TIMEOUT_MS);
}

// ==================== UTILITY FUNCTIONS ====================
function getUser(uid) {
    if (!uid || typeof uid !== 'string' || !/^\d+$/.test(uid)) {
        console.warn(`[AUTH] Invalid UID access: ${uid}`);
        return { connectionType: "online", _temp: true };
    }
    
    if (!users[uid]) {
        users[uid] = {
            connectionType: "online",
            createdAt: Date.now(),
            lastActive: Date.now()
        };
        userStore.save();
    }
    
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
            console.error("[AUTH] Error removing auth dir:", e);
        }
    }
    const u = getUser(uid);
    u.linked = false;
    userStore.save();
    return true;
}

function isValidIP(ip) {
    if (!ip || typeof ip !== 'string') return false;
    if (ip.length > 253) return false;
    if (ip.includes('..') || ip.startsWith('.') || ip.endsWith('.')) return false;
    if (ip.includes('://')) return false;
    
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const hostnameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
    
    return ipv4Regex.test(ip) || hostnameRegex.test(ip);
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
    } catch (e) {
        // Silent fail to prevent crashes
    }
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
                new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink").setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(startCustomId).setLabel("▶ Start").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
            )
        ]
    };
}

function getAdminStatsEmbed() {
    let memory = { rss: 0, heapUsed: 0 };
    try {
        memory = process.memoryUsage();
    } catch (e) {}
    
    const ramMB = (memory.rss / 1024 / 1024).toFixed(2);
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);

    return new EmbedBuilder()
        .setTitle("🛠 Admin Panel")
        .setColor("#2f3136")
        .addFields(
            { name: "📊 Memory", value: `${ramMB} MB`, inline: true },
            { name: "🤖 Sessions", value: `${sessions.size}`, inline: true },
            { name: "⏱️ Uptime", value: `${hours}h ${minutes}m`, inline: true },
            { name: "📈 Metrics", value: `Starts: ${metrics.starts}\nReconnects: ${metrics.reconnects}\nCrashes: ${metrics.crashes}`, inline: true }
        )
        .setFooter({ text: `PID: ${process.pid}` })
        .setTimestamp();
}

function adminPanelComponents() {
    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("admin_refresh").setLabel("🔄 Refresh").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("admin_stop_all").setLabel("🛑 Stop All").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("admin_save_data").setLabel("💾 Save").setStyle(ButtonStyle.Secondary)
        )
    ];

    if (sessions.size > 0) {
        const options = [];
        let count = 0;
        for (const [uid, session] of sessions) {
            if (count >= 25) break;
            options.push({ 
                label: `User: ${uid.slice(0, 8)}...`, 
                description: session?.connected ? 'Online' : 'Connecting',
                value: uid 
            });
            count++;
        }
        if (options.length > 0) {
            rows.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId("admin_force_stop_select")
                    .setPlaceholder("Force Stop Bot")
                    .addOptions(options)
            ));
        }
    }
    return rows;
}

// ==================== MICROSOFT AUTH ====================
async function linkMicrosoft(uid, interaction) {
    if (!uid || !interaction) return;
    
    if (pendingLink.has(uid)) {
        return safeReply(interaction, "⏳ Login already in progress.");
    }
    
    const authDir = getUserAuthDir(uid);
    if (!authDir) {
        return safeReply(interaction, "❌ System error: Cannot create auth directory.");
    }

    const timeoutId = setTimeout(() => {
        pendingLink.delete(uid);
        safeReply(interaction, "⏰ Login timed out.").catch(() => {});
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
                    const uri = data?.verification_uri_complete || "https://www.microsoft.com/link";
                                       const code = data?.user_code;
                    
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setLabel("Open Link")
                            .setStyle(ButtonStyle.Link)
                            .setURL(uri)
                    );
                    
                    await interaction.editReply({ 
                        content: `🔐 **Code:** \`${code}\`\n🔗 **Link:** ${uri}`, 
                        components: [row] 
                    }).catch(() => {});
                } catch (e) {
                    console.error("[AUTH] Callback error:", e);
                }
            }
        );

        const authPromise = flow.getMsaToken().then(async () => {
            clearTimeout(timeoutId);
            getUser(uid).linked = true;
            userStore.save();
            await interaction.followUp({ ephemeral: true, content: "✅ Account linked!" }).catch(() => {});
        }).catch(async (e) => {
            clearTimeout(timeoutId);
            await interaction.editReply(`❌ Failed: ${e?.message || 'Unknown error'}`).catch(() => {});
        }).finally(() => { 
            pendingLink.delete(uid); 
        });
        
        pendingLink.set(uid, authPromise);
        
    } catch (e) {
        clearTimeout(timeoutId);
        pendingLink.delete(uid);
        console.error("[AUTH] Flow creation error:", e);
        safeReply(interaction, "❌ Authentication system error.");
    }
}

// ==================== MAIN SESSION ====================
async function startSession(uid, interaction, isReconnect = false, reconnectAttempt = 1) {
    if (!uid || isShuttingDown) return;
    
    metrics.starts++;
    const u = getUser(uid);
    
    if (!u.server?.ip) {
        if (!isReconnect) safeReply(interaction, "⚠️ Configure server settings first.");
        return;
    }

    const { ip, port } = u.server;
    
    if (!isValidIP(ip) || !isValidPort(port)) {
        if (!isReconnect) safeReply(interaction, "❌ Invalid server address.");
        return;
    }

    // Conflict check
    if (sessions.has(uid) && !isReconnect) {
        return safeReply(interaction, { 
            ephemeral: true, 
            content: "⚠️ Active session exists. Use Stop first." 
        });
    }

    // Cleanup old if reconnecting
    if (isReconnect && sessions.has(uid)) {
        await cleanupSession(uid);
    }

    // Ping check
    try {
        await bedrock.ping({ host: ip, port: parseInt(port), timeout: 5000 });
    } catch (err) {
        if (isReconnect) {
            scheduleReconnect(uid, reconnectAttempt);
        } else {
            safeReply(interaction, { content: `❌ Server offline: ${ip}:${port}` });
        }
        return;
    }

    const authDir = getUserAuthDir(uid);
    if (!authDir) {
        if (!isReconnect) safeReply(interaction, "❌ Auth error.");
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
        offline: u.connectionType === "offline",
        skipPing: true,
        autoInitPlayer: true
    };

    if (u.connectionType === "offline") {
        opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    }

    let mc;
    try {
        mc = bedrock.createClient(opts);
    } catch (err) {
        console.error("[SESSION] Create client error:", err);
        if (isReconnect) scheduleReconnect(uid, reconnectAttempt);
        else safeReply(interaction, "❌ Failed to create client.");
        return;
    }

    // Initialize session state
    const session = {
        client: mc,
        startedAt: Date.now(),
        manualStop: false,
        connected: false,
        isReconnecting: false,
        reconnectAttempt: reconnectAttempt,
        entityId: null,
        position: Vec3 ? new Vec3(0, 64, 0) : null,
        velocity: Vec3 ? new Vec3(0, 0, 0) : null,
        yaw: 0,
        pitch: 0,
        onGround: false,
        lastPacketTime: Date.now(),
        lastKeepalive: Date.now(),
        // Timer references
        reconnectTimer: null,
        physicsLoop: null,
        afkTimeout: null,
        keepaliveTimer: null,
        staleCheckTimer: null,
        swingTimer: null
    };
    
    sessions.set(uid, session);

    // Safe packet writer with state checks
    const safeWrite = (packetName, params) => {
        try {
            if (mc && !mc.destroyed && session.connected && !isShuttingDown) {
                mc.write(packetName, params);
                return true;
            }
        } catch (e) {
            if (!e.message?.includes('closed')) {
                console.error(`[PACKET] Write error (${packetName}):`, e.message);
            }
        }
        return false;
    };

    // Physics loop (simplified, no chunk dependency)
    if (Vec3) {
        session.physicsLoop = setInterval(() => {
            if (!session.connected || !session.position || mc.destroyed) return;

            try {
                // Simple gravity
                if (!session.onGround && session.velocity) {
                    session.velocity.y -= 0.08;
                    if (session.velocity.y < -3.92) session.velocity.y = -3.92;
                    session.position.y += session.velocity.y;
                    
                    // Floor collision (simplified)
                    if (session.position.y < 64) {
                        session.position.y = 64;
                        session.velocity.y = 0;
                        session.onGround = true;
                    }
                }

                safeWrite("player_auth_input", {
                    pitch: session.pitch, 
                    yaw: session.yaw,
                    position: { 
                        x: session.position.x, 
                        y: session.position.y, 
                        z: session.position.z 
                    },
                    move_vector: { x: 0, z: 0 }, 
                    head_yaw: session.yaw, 
                    input_data: 0n,
                    input_mode: "mouse", 
                    play_mode: "screen", 
                    interaction_model: "touch", 
                    tick: BigInt(Date.now()) // Use timestamp as tick
                });
            } catch (e) {}
        }, CONFIG.PHYSICS_TICK_MS);
    }

    // AFK Logic (anti-kick)
    const performAntiAfk = () => {
        if (!sessions.has(uid) || isShuttingDown || !session.connected) return;
        
        try {
            // Random rotation
            session.yaw += (Math.random() - 0.5) * 30;
            session.pitch = Math.max(-90, Math.min(90, session.pitch + (Math.random() - 0.5) * 20));
            
            // Random jump
            if (session.onGround && session.velocity && Math.random() > 0.7) {
                session.velocity.y = 0.42;
                session.onGround = false;
            }
        } catch (e) {}

        session.afkTimeout = setTimeout(performAntiAfk, 10000 + Math.random() * 10000);
    };

    // Swing logic (hand waving)
    const startSwinging = () => {
        session.swingTimer = setInterval(() => {
            if (!session.connected || !session.entityId) return;
            safeWrite('animate', { 
                action_id: 1, // Swing arm
                runtime_entity_id: session.entityId 
            });
        }, CONFIG.SWING_INTERVAL_MS);
    };

    // Event Handlers
    mc.on("spawn", () => {
        console.log(`[SESSION] ${uid} spawned on ${ip}:${port}`);
        logToDiscord(`✅ <@${uid}> connected to ${ip}:${port}`);
        if (!isReconnect && interaction) {
            safeReply(interaction, { content: `🟢 Online: ${ip}:${port}`, embeds: [] });
        }
    });

    mc.on("start_game", (packet) => {
        if (!packet || !session) return;
        
        try {
            if (session.position && packet.player_position) {
                session.position.set(
                    packet.player_position.x || 0, 
                    packet.player_position.y || 64, 
                    packet.player_position.z || 0
                );
            }
            
            session.entityId = packet.runtime_entity_id;
            session.connected = true;
            session.isReconnecting = false;
            session.reconnectAttempt = 0;
            session.lastPacketTime = Date.now();

            // Persist session
            activeSessionsStore[uid] = { 
                startedAt: Date.now(), 
                server: u.server 
            };
            sessionStore.save();

            startHealthMonitoring(uid);
            performAntiAfk();
            startSwinging();
            
        } catch (e) {
            console.error("[SESSION] Start game error:", e);
        }
    });

    mc.on("move_player", (packet) => {
        if (!packet || !session || packet.runtime_id !== session.entityId) return;
        
        session.lastPacketTime = Date.now();
        
        if (packet.position && session.position) {
            session.position.set(
                packet.position.x || session.position.x, 
                packet.position.y || session.position.y, 
                packet.position.z || session.position.z
            );
            
            // Simple ground detection
            if (session.velocity) {
                session.onGround = packet.position.y <= Math.floor(packet.position.y) + 0.1;
                if (session.onGround) session.velocity.y = 0;
            }
        }
    });

    mc.on("respawn", (packet) => {
        logToDiscord(`💀 <@${uid}> died and respawned`);
        if (packet?.position && session?.position) {
            session.position.set(
                packet.position.x || 0, 
                packet.position.y || 64, 
                packet.position.z || 0
            );
            if (session.velocity) session.velocity.set(0, 0, 0);
            session.onGround = true;
        }
    });

    mc.on('packet', () => {
        if (session) session.lastPacketTime = Date.now();
    });

    mc.on("error", (e) => {
        console.error(`[SESSION] ${uid} error:`, e.message);
        if (!session.manualStop) scheduleReconnect(uid, reconnectAttempt);
        logToDiscord(`❌ <@${uid}> error: ${e?.message || 'Unknown'}`);
    });

    mc.on("close", () => {
        console.log(`[SESSION] ${uid} connection closed`);
        if (!session.manualStop) {
            scheduleReconnect(uid, reconnectAttempt);
        } else {
            logToDiscord(`🔌 <@${uid}> disconnected`);
        }
    });
}

// ==================== DISCORD EVENTS ====================
client.once("ready", async () => {
    console.log(`[DISCORD] Logged in as ${client.user?.tag}`);
    discordReady = true;

    try {
        await client.application.commands.set([
            new SlashCommandBuilder().setName("panel").setDescription("Open AFK panel"),
            new SlashCommandBuilder().setName("admin").setDescription("Admin panel")
        ]);
    } catch (e) {
        console.error("[DISCORD] Command registration failed:", e);
    }

    // Admin panel updater
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

    // Memory monitor
    setInterval(() => {
        const mem = process.memoryUsage();
        const mb = mem.rss / 1024 / 1024;
        if (mb > CONFIG.MAX_MEMORY_MB) {
            console.warn(`[MEMORY] High usage: ${mb.toFixed(2)} MB`);
            if (global.gc) {
                try {
                    global.gc();
                    console.log("[MEMORY] GC triggered");
                } catch (e) {}
            }
        }
    }, CONFIG.MEMORY_CHECK_INTERVAL_MS);

    // Restore sessions
    console.log("[INIT] Restoring sessions...");
    const toRestore = Object.keys(activeSessionsStore || {});
    
    if (toRestore.length > 0) {
        console.log(`[INIT] Restoring ${toRestore.length} sessions`);
        let delay = 0;
        for (const uid of toRestore) {
            if (/^\d+$/.test(uid)) {
                setTimeout(() => {
                    if (!isShuttingDown) startSession(uid, null, true);
                }, delay);
                delay += 5000; // 5s stagger to prevent overload
            }
        }
    }
});

client.on(Events.InteractionCreate, async (i) => {
    if (!i?.user?.id || isShuttingDown) return;
    
    const uid = i.user.id;
    
    // Rate limit (1s)
    if (i.isButton() || i.isChatInputCommand()) {
        const last = i.user.lastInteraction || 0;
        if (Date.now() - last < 1000) {
            return safeReply(i, { ephemeral: true, content: "⏳ Please wait..." });
        }
        i.user.lastInteraction = Date.now();
    }

    try {
        if (i.isChatInputCommand()) {
            if (i.commandName === "panel") {
                return safeReply(i, panelRow(false));
            }
            if (i.commandName === "admin") {
                if (uid !== CONFIG.ADMIN_ID) {
                    return safeReply(i, { content: "⛔ Access denied", ephemeral: true });
                }
                const msg = await i.reply({ 
                    embeds: [getAdminStatsEmbed()], 
                    components: adminPanelComponents(), 
                    fetchReply: true 
                });
                lastAdminMessage = msg;
                return;
            }
        }

        if (i.isStringSelectMenu() && i.customId === "admin_force_stop_select") {
            const target = i.values?.[0];
            if (target) {
                await stopSession(target);
                return i.update({ 
                    content: `🛑 Stopped <@${target}>`, 
                    embeds: [getAdminStatsEmbed()], 
                    components: adminPanelComponents() 
                }).catch(() => {});
            }
        }

        if (i.isButton()) {
            // Admin buttons
            if (i.customId === "admin_refresh") {
                return i.update({ 
                    embeds: [getAdminStatsEmbed()], 
                    components: adminPanelComponents() 
                }).catch(() => {});
            }
            
            if (i.customId === "admin_stop_all") {
                if (uid !== CONFIG.ADMIN_ID) return;
                const promises = [];
                sessions.forEach((_, id) => promises.push(stopSession(id)));
                await Promise.all(promises);
                return i.update({ 
                    content: "🛑 All stopped", 
                    embeds: [getAdminStatsEmbed()], 
                    components: adminPanelComponents() 
                }).catch(() => {});
            }
            
            if (i.customId === "admin_save_data") {
                if (uid !== CONFIG.ADMIN_ID) return;
                userStore.save(true);
                sessionStore.save(true);
                return i.update({ 
                    content: "💾 Saved", 
                    embeds: [getAdminStatsEmbed()], 
                    components: adminPanelComponents() 
                }).catch(() => {});
            }

            // User buttons
            if (i.customId === "start_bedrock" || i.customId === "start_java") {
                if (sessions.has(uid)) {
                    return safeReply(i, { ephemeral: true, content: "⚠️ Already running" });
                }
                
                const isJava = i.customId === "start_java";
                const embed = new EmbedBuilder()
                    .setTitle(isJava ? "Java Connection" : "Bedrock Connection")
                    .setDescription(isJava ? "Requires GeyserMC" : "Start bot?")
                    .setColor(isJava ? "#E67E22" : "#2ECC71");
                    
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("confirm_start").setLabel("Start").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );
                return i.reply({ embeds: [embed], components: [row], ephemeral: true });
            }

            if (i.customId === "confirm_start") {
                await i.deferUpdate().catch(() => {});
                return startSession(uid, i, false);
            }

            if (i.customId === "cancel") {
                return i.update({ content: "❌ Cancelled", embeds: [], components: [] }).catch(() => {});
            }

            if (i.customId === "stop") {
                const ok = await stopSession(uid);
                return safeReply(i, { ephemeral: true, content: ok ? "⏹ Stopped" : "No session" });
            }

            if (i.customId === "link") {
                await i.deferReply({ ephemeral: true });
                return linkMicrosoft(uid, i);
            }

            if (i.customId === "unlink") {
                await unlinkMicrosoft(uid);
                return safeReply(i, { ephemeral: true, content: "🗑 Unlinked" });
            }

            if (i.customId === "settings") {
                const u = getUser(uid);
                const modal = new ModalBuilder()
                    .setCustomId("settings_modal")
                    .setTitle("Configuration");
                
                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId("ip")
                            .setLabel("Server IP")
                            .setStyle(TextInputStyle.Short)
                            .setValue(u.server?.ip || "")
                            .setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId("port")
                            .setLabel("Port")
                            .setStyle(TextInputStyle.Short)
                            .setValue(String(u.server?.port || 19132))
                            .setRequired(true)
                    )
                );
                return i.showModal(modal);
            }
        }

        if (i.isModalSubmit() && i.customId === "settings_modal") {
            const ip = i.fields.getTextInputValue("ip")?.trim();
            const port = parseInt(i.fields.getTextInputValue("port"));
            
            if (!ip || !port || !isValidPort(port)) {
                return safeReply(i, { ephemeral: true, content: "❌ Invalid input" });
            }
            
            getUser(uid).server = { ip, port };
            userStore.save();
            return safeReply(i, { ephemeral: true, content: `✅ Saved: ${ip}:${port}` });
        }

    } catch (e) {
        console.error("[INTERACTION] Error:", e);
    }
});

// ==================== SHUTDOWN HANDLING ====================
function gracefulShutdown(signal) {
    console.log(`[SHUTDOWN] ${signal} received`);
    isShuttingDown = true;
    
    const forceExit = setTimeout(() => {
        console.error("[SHUTDOWN] Forced exit");
        process.exit(1);
    }, CONFIG.GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    
    Promise.all([
        userStore.save(true),
        sessionStore.save(true),
        cleanupAllSessions()
    ]).then(() => {
        return client.destroy();
    }).then(() => {
        clearTimeout(forceExit);
        console.log("[SHUTDOWN] Clean exit");
        process.exit(0);
    }).catch(err => {
        console.error("[SHUTDOWN] Error:", err);
        process.exit(1);
    });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ==================== STARTUP ====================
client.login(DISCORD_TOKEN).catch(e => {
    console.error("[FATAL] Discord login failed:", e);
    process.exit(1);
});

// Heartbeat log
setInterval(() => {
    console.log(`[HEARTBEAT] Sessions: ${sessions.size} | Uptime: ${Math.floor(process.uptime()/60)}m`);
}, 60000);
