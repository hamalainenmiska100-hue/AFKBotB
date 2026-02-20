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
    MessageFlags,
    Options
} = require("discord.js");
const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
    console.error("❌ Token missing");
    process.exit(1);
}

// ==================== MINIMAL CONFIG ====================
const CONFIG = {
    ADMIN_ID: "1144987924123881564",
    LOG_CHANNEL_ID: "1464615030111731753",
    MAX_CONCURRENT: 1, // VAIN 1 kerrallaan - säästä RAM
    SESSION_DELAY: 20000, // 20s väliä
    CHUNK_CACHE_SIZE: 0, // EI chunk-cachea
    VIEW_DISTANCE: 1,
    MAX_MEMORY_MB: 400, // Varoituskynnys
};

// ==================== MINIMAL STORAGE ====================
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");
const REJOIN_STORE = path.join(DATA, "rejoin.json");

const ensureDir = (dir) => {
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return true;
    } catch (e) { return false; }
};

ensureDir(DATA);
ensureDir(AUTH_ROOT);

// Simple JSON store (no WAL to save memory)
const loadJson = (file, def = {}) => {
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {}
    return def;
};

const saveJson = (file, data) => {
    try {
        fs.writeFileSync(file + ".tmp", JSON.stringify(data));
        fs.renameSync(file + ".tmp", file);
    } catch (e) {}
};

let users = loadJson(STORE, {});
let activeSessionsStore = loadJson(REJOIN_STORE, {});
let sessionQueue = []; // Queue for session starts

// ==================== MINIMAL DISCORD CLIENT ====================
// Disable ALL caching to save RAM
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    presence: {
        status: 'online',
        activities: [{ name: 'AFK', type: ActivityType.Watching }]
    },
    // Memory optimizations:
    sweepInterval: 300, // Clean cache every 5min
    sweepFilter: () => () => true, // Sweep everything
    messageCacheLifetime: 60, // 1min cache
    messageSweepInterval: 120, // Clean every 2min
    makeCache: Options.cacheWithLimits({
        MessageManager: 0, // No message cache
        PresenceManager: 0, // No presence cache
        GuildMemberManager: 50, // Max 50 members
        UserManager: 50, // Max 50 users
        ChannelManager: 10, // Max 10 channels
    }),
});

// ==================== MINIMAL ERROR HANDLING ====================
process.on("uncaughtException", (err) => {
    console.error("💥", err.message);
    if (err.message.includes("ENOMEM") || err.message.includes("memory")) {
        if (global.gc) global.gc();
    }
});

process.on("unhandledRejection", () => {}); // Silent

// ==================== MINIMAL SESSION MANAGEMENT ====================
const sessions = new Map();
const pendingLink = new Map();
let activeCount = 0;
let isShuttingDown = false;

const cleanupSession = async (uid) => {
    const s = sessions.get(uid);
    if (!s || s.cleaning) return;
    s.cleaning = true;
    
    // Clear all timers
    if (s.afkTimer) clearTimeout(s.afkTimer);
    if (s.healthTimer) clearInterval(s.healthTimer);
    
    if (s.client) {
        try {
            s.client.removeAllListeners();
            s.client.close();
        } catch (e) {}
        s.client = null;
    }
    
    sessions.delete(uid);
    activeCount = Math.max(0, activeCount - 1);
    
    // Force GC if available
    if (global.gc && activeCount === 0) {
        setTimeout(() => global.gc(), 1000);
    }
    
    // Process queue
    processQueue();
};

const processQueue = () => {
    if (sessionQueue.length === 0 || activeCount >= CONFIG.MAX_CONCURRENT) return;
    const next = sessionQueue.shift();
    if (next) setTimeout(() => startSession(next.uid, next.interaction, next.isReconnect), 100);
};

const stopSession = async (uid) => {
    if (!uid) return false;
    const s = sessions.get(uid);
    if (s) {
        s.manualStop = true;
        delete activeSessionsStore[uid];
        saveJson(REJOIN_STORE, activeSessionsStore);
    }
    await cleanupSession(uid);
    return true;
};

// ==================== MINIMAL USER MANAGEMENT ====================
const getUser = (uid) => {
    if (!users[uid]) {
        users[uid] = { connectionType: "online", server: null };
        saveJson(STORE, users);
    }
    return users[uid];
};

const getAuthDir = (uid) => {
    const dir = path.join(AUTH_ROOT, uid.replace(/[^a-zA-Z0-9]/g, ''));
    ensureDir(dir);
    return dir;
};

// ==================== VALIDATION ====================
const isValidIP = (ip) => ip && ip.length < 100 && !ip.includes('..') && !ip.includes('://');
const isValidPort = (port) => {
    const n = parseInt(port);
    return n > 0 && n <= 65535;
};

// ==================== MINIMAL DISCORD HELPERS ====================
const logToDiscord = async (msg) => {
    try {
        const ch = await client.channels.fetch(CONFIG.LOG_CHANNEL_ID).catch(() => null);
        if (ch) await ch.send({ content: msg.slice(0, 2000) }).catch(() => {});
    } catch (e) {}
};

const safeReply = async (i, content) => {
    try {
        if (i.replied || i.deferred) await i.editReply(content).catch(() => {});
        else await i.reply(content).catch(() => {});
    } catch (e) {}
};

const panelRow = (isJava = false) => ({
    content: `**${isJava ? "Java" : "Bedrock"} AFKBot Panel**`,
    components: [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("link").setLabel("🔑 Link").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(isJava ? "start_java" : "start_bedrock").setLabel("▶ Start").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
        )
    ]
});

// ==================== MINIMAL AUTH ====================
const linkMicrosoft = async (uid, interaction) => {
    if (pendingLink.has(uid)) return safeReply(interaction, { content: "Already linking...", flags: [MessageFlags.Ephemeral] });
    
    const authDir = getAuthDir(uid);
    const timeout = setTimeout(() => pendingLink.delete(uid), 300000);
    
    try {
        const flow = new Authflow(uid, authDir, { 
            flow: "live", 
            authTitle: Titles?.MinecraftNintendoSwitch || "Minecraft", 
            deviceType: "Nintendo" 
        }, async (data) => {
            const uri = data?.verification_uri_complete || "https://www.microsoft.com/link";
            const code = data?.user_code;
            await interaction.editReply({ 
                content: `🔐 **Auth Required**\nCode: \`${code}\`\nLink: ${uri}`,
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open").setStyle(ButtonStyle.Link).setURL(uri))]
            }).catch(() => {});
        });

        const promise = flow.getMsaToken().then(async () => {
            clearTimeout(timeout);
            pendingLink.delete(uid);
            getUser(uid).linked = true;
            saveJson(STORE, users);
            await interaction.followUp({ content: "✅ Linked!", flags: [MessageFlags.Ephemeral] }).catch(() => {});
        }).catch(async (e) => {
            clearTimeout(timeout);
            pendingLink.delete(uid);
            await interaction.editReply({ content: `❌ Failed: ${e.message}` }).catch(() => {});
        });
        
        pendingLink.set(uid, promise);
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        
    } catch (e) {
        clearTimeout(timeout);
        pendingLink.delete(uid);
    }
};

// ==================== MINIMAL SESSION ====================
const startSession = async (uid, interaction, isReconnect = false) => {
    if (isShuttingDown) return;
    
    // Queue if max concurrent reached
    if (activeCount >= CONFIG.MAX_CONCURRENT) {
        sessionQueue.push({ uid, interaction, isReconnect });
        if (interaction) safeReply(interaction, { content: `⏳ Queue position: ${sessionQueue.length}`, flags: [MessageFlags.Ephemeral] });
        return;
    }
    
    activeCount++;
    const u = getUser(uid);
    
    if (!u.server?.ip || !isValidIP(u.server.ip) || !isValidPort(u.server.port)) {
        activeCount--;
        if (interaction) safeReply(interaction, { content: "❌ Configure server first", flags: [MessageFlags.Ephemeral] });
        processQueue();
        return;
    }

    const { ip, port } = u.server;
    
    if (sessions.has(uid) && !isReconnect) {
        activeCount--;
        return safeReply(interaction, { content: "⚠️ Already running", flags: [MessageFlags.Ephemeral] });
    }

    if (!isReconnect && interaction) {
        await safeReply(interaction, { content: `🟡 Connecting to ${ip}:${port}...`, flags: [MessageFlags.Ephemeral] });
    }

    const opts = {
        host: ip,
        port: parseInt(port),
        connectTimeout: 20000,
        keepAlive: false, // Disable to save memory
        viewDistance: CONFIG.VIEW_DISTANCE,
        profilesFolder: getAuthDir(uid),
        username: uid,
        offline: u.connectionType === "offline",
        skipPing: true,
        autoInitPlayer: false, // Lazy init
        useTimeout: true,
        // CRITICAL: Disable chunk caching
        chunkCaching: false,
        noPong: true, // Don't send pong packets if not needed
    };

    if (u.connectionType === "offline") {
        opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    }

    let mc;
    try {
        mc = bedrock.createClient(opts);
    } catch (err) {
        activeCount--;
        if (interaction) safeReply(interaction, { content: "❌ Failed to create", flags: [MessageFlags.Ephemeral] });
        processQueue();
        return;
    }

    const session = {
        client: mc,
        startedAt: Date.now(),
        manualStop: false,
        cleaning: false,
        connected: false,
        entityId: null,
        afkTimer: null,
        healthTimer: null,
    };
    
    sessions.set(uid, session);
    activeSessionsStore[uid] = { startedAt: Date.now(), server: u.server };
    saveJson(REJOIN_STORE, activeSessionsStore);

    // Minimal event handlers
    mc.on('connect', () => {
        // Connected at TCP level
    });

    mc.on("start_game", (packet) => {
        session.entityId = packet.runtime_entity_id;
        session.connected = true;
        if (activeSessionsStore[uid]) {
            activeSessionsStore[uid].lastConnected = Date.now();
            saveJson(REJOIN_STORE, activeSessionsStore);
        }
        
        if (!isReconnect && interaction) {
            safeReply(interaction, { content: `🟢 Online on ${ip}:${port}`, embeds: [] });
        } else {
            logToDiscord(`✅ Bot <@${uid}> online`);
        }

        // Minimal AFK - only swing arm (less packets)
        const doAfk = () => {
            if (!session.connected || session.cleaning) return;
            try {
                if (session.entityId) {
                    mc.write('animate', { action_id: 1, runtime_entity_id: session.entityId });
                }
            } catch (e) {}
            session.afkTimer = setTimeout(doAfk, 10000 + Math.random() * 5000);
        };
        doAfk();

        // Minimal health check - every 30s
        session.healthTimer = setInterval(() => {
            try {
                mc.queue('client_cache_status', { enabled: false });
            } catch (e) {
                mc.close();
            }
        }, 30000);
    });

    mc.on("error", (e) => {
        if (!e.message?.includes('fetch')) { // Ignore auth network errors
            console.log(`[${uid}] Err: ${e.message.slice(0, 50)}`);
        }
        if (!session.manualStop && !session.cleaning) {
            setTimeout(() => cleanupSession(uid).then(() => startSession(uid, null, true)), 10000);
        }
    });

    mc.on("close", () => {
        if (!session.manualStop && !session.cleaning) {
            setTimeout(() => cleanupSession(uid).then(() => startSession(uid, null, true)), 10000);
        } else {
            cleanupSession(uid);
        }
    });

    mc.on('disconnect', (packet) => {
        const reason = packet?.reason || "";
        if (reason.includes("wait") || reason.includes("before")) {
            session.manualStop = true;
            delete activeSessionsStore[uid];
            saveJson(REJOIN_STORE, activeSessionsStore);
        }
    });
};

// ==================== DISCORD EVENTS ====================
client.on("clientReady", async () => {
    console.log(`✅ Bot: ${client.user?.tag}`);
    
    try {
        await client.application?.commands?.set([
            new SlashCommandBuilder().setName("panel").setDescription("Bedrock panel"),
            new SlashCommandBuilder().setName("java").setDescription("Java panel"),
        ]);
    } catch (e) {}

    // Restore sessions with big delays (memory safe)
    const uids = Object.keys(activeSessionsStore);
    if (uids.length > 0) {
        console.log(`🔄 Restoring ${uids.length} sessions...`);
        let delay = 0;
        for (const uid of uids) {
            setTimeout(() => startSession(uid, null, true), delay);
            delay += CONFIG.SESSION_DELAY;
        }
    }
});

client.on(Events.InteractionCreate, async (i) => {
    if (!i?.user?.id || isShuttingDown) return;
    const uid = i.user.id;

    if (i.isChatInputCommand()) {
        if (i.commandName === "panel") return safeReply(i, panelRow(false));
        if (i.commandName === "java") return safeReply(i, panelRow(true));
    }

    if (i.isButton()) {
        if (i.customId === "start_bedrock" || i.customId === "start_java") {
            if (sessions.has(uid)) return safeReply(i, { content: "Already running", flags: [MessageFlags.Ephemeral] });
            await i.deferReply({ flags: [MessageFlags.Ephemeral] });
            return startSession(uid, i, false);
        }
        
        if (i.customId === "stop") {
            const ok = await stopSession(uid);
            return safeReply(i, { content: ok ? "Stopped" : "Not running", flags: [MessageFlags.Ephemeral] });
        }
        
        if (i.customId === "link") {
            await i.deferReply({ flags: [MessageFlags.Ephemeral] });
            return linkMicrosoft(uid, i);
        }
        
        if (i.customId === "unlink") {
            const dir = getAuthDir(uid);
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
            getUser(uid).linked = false;
            saveJson(STORE, users);
            return safeReply(i, { content: "Unlinked", flags: [MessageFlags.Ephemeral] });
        }
        
        if (i.customId === "settings") {
            const u = getUser(uid);
            const modal = new ModalBuilder()
                .setCustomId("set")
                .setTitle("Config")
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setRequired(true).setValue(u.server?.ip || "")
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(u.server?.port || "19132"))
                    )
                );
            return i.showModal(modal);
        }
    }

    if (i.isModalSubmit() && i.customId === "set") {
        const ip = i.fields?.getTextInputValue("ip")?.trim();
        const port = parseInt(i.fields?.getTextInputValue("port"));
        
        if (!isValidIP(ip) || !isValidPort(port)) {
            return safeReply(i, { content: "Invalid IP/port", flags: [MessageFlags.Ephemeral] });
        }
        
        getUser(uid).server = { ip, port };
        saveJson(STORE, users);
        return safeReply(i, { content: `Saved: ${ip}:${port}`, flags: [MessageFlags.Ephemeral] });
    }
});

// ==================== STARTUP ====================
console.log("🚀 Starting...");

client.login(DISCORD_TOKEN).catch((err) => {
    console.error("Login failed:", err.message);
    process.exit(1);
});

// Minimal heartbeat
setInterval(() => {
    const mem = process.memoryUsage();
    const mb = (mem.rss / 1024 / 1024).toFixed(1);
    console.log(`💓 Sessions: ${sessions.size} | Mem: ${mb}MB`);
    
    if (mb > CONFIG.MAX_MEMORY_MB && global.gc) {
        console.log("🧹 GC triggered");
        global.gc();
    }
}, 60000);
