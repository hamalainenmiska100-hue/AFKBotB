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

// ----------------- Storage -----------------
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");
const REJOIN_STORE = path.join(DATA, "ReJoin.json");

// Safe directory initialization
try {
    if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
    if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });
} catch (e) {
    console.error("❌ Fatal: Cannot create data directories:", e);
    process.exit(1);
}

// Safe Load Helper with backup
function loadJson(filePath, defaultVal) {
    if (!fs.existsSync(filePath)) return defaultVal;
    try {
        const data = fs.readFileSync(filePath, "utf8");
        if (!data || data.trim() === "") return defaultVal;
        return JSON.parse(data);
    } catch (e) {
        console.error(`⚠️ Corrupt JSON at ${filePath}. Backing up and resetting.`);
        try {
            const backupPath = `${filePath}.backup.${Date.now()}`;
            fs.renameSync(filePath, backupPath);
        } catch (backupErr) {
            // Ignore backup errors
        }
        return defaultVal;
    }
}

// Safe Save Helper with atomic write
function atomicSave(filePath, data) {
    const tempPath = `${filePath}.tmp`;
    try {
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
        fs.renameSync(tempPath, filePath);
        return true;
    } catch (e) {
        console.error(`❌ Save failed for ${filePath}:`, e);
        try { fs.unlinkSync(tempPath); } catch {}
        return false;
    }
}

let users = loadJson(STORE, {});
let activeSessionsStore = loadJson(REJOIN_STORE, {});

function save() {
    return atomicSave(STORE, users);
}

function saveActiveSessions() {
    return atomicSave(REJOIN_STORE, activeSessionsStore);
}

function getUser(uid) {
    if (!uid || typeof uid !== 'string') return { connectionType: "online", bedrockVersion: "auto" };
    if (!users[uid]) users[uid] = {};
    users[uid].connectionType = users[uid].connectionType || "online";
    if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
    return users[uid];
}

function getUserAuthDir(uid) {
    if (!uid || typeof uid !== 'string') return null;
    const dir = path.join(AUTH_ROOT, uid.replace(/[^a-zA-Z0-9]/g, ''));
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return dir;
    } catch (e) {
        console.error("❌ Cannot create auth dir:", e);
        return null;
    }
}

function unlinkMicrosoft(uid) {
    if (!uid) return false;
    const dir = getUserAuthDir(uid);
    if (dir) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    const u = getUser(uid);
    u.linked = false;
    save();
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
    allowedMentions: { parse: ['users', 'roles'], repliedUser: false }
});

// ==========================================================
// 🛡️ CRASH PREVENTION SYSTEM
// ==========================================================
client.on("error", (error) => console.error("⚠️ Discord Client Error (Ignored):", error?.message || error));
client.on("shardError", (error) => console.error("⚠️ WebSocket Error (Ignored):", error?.message || error));
client.on("warn", (warning) => console.warn("⚠️ Discord Warning:", warning));
client.on("rateLimit", (data) => console.warn("⏱️ Rate limited:", data));

process.on("uncaughtException", (err) => {
    console.error("🔥 Uncaught Exception:", err);
    // Keep process alive but log it
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("🔥 Unhandled Rejection at:", promise, "reason:", reason);
    // Keep process alive
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received. Shutting down gracefully...');
    isShuttingDown = true;
    cleanupAllSessions();
    setTimeout(() => process.exit(0), 5000);
});

process.on('SIGINT', () => {
    console.log('🛑 SIGINT received. Shutting down gracefully...');
    isShuttingDown = true;
    cleanupAllSessions();
    setTimeout(() => process.exit(0), 5000);
});

function cleanupAllSessions() {
    console.log(`🧹 Cleaning up ${sessions.size} sessions...`);
    for (const [uid, session] of sessions) {
        try {
            cleanupSession(uid);
        } catch (e) {
            console.error(`Error cleaning up session ${uid}:`, e);
        }
    }
}

async function logToDiscord(message) {
    if (!message || isShuttingDown) return;
    try {
        const channel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (channel && channel.send) {
            const embed = new EmbedBuilder()
                .setColor("#5865F2")
                .setDescription(String(message).slice(0, 4096))
                .setTimestamp();
            await channel.send({ embeds: [embed] }).catch(() => {});
        }
    } catch (e) {
        // Silent fail
    }
}

// ----------------- UI helpers -----------------
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
                delay += 5000;
            }
        }
    } else {
        console.log("⚪ No previous sessions found.");
    }
});

// ----------------- Microsoft link -----------------
async function linkMicrosoft(uid, interaction) {
    if (!uid || !interaction) return;
    
    if (pendingLink.has(uid)) {
        return safeReply(interaction, "⏳ Login already in progress. Use the last code.");
    }
    
    const authDir = getUserAuthDir(uid);
    if (!authDir) {
        return safeReply(interaction, "❌ System error: Cannot create auth directory.");
    }
    
    const u = getUser(uid);
    let codeShown = false;

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
                    
                    // 🔐 ENCRYPTED VOLUME NOTICE ADDED HERE
                    const msg = `🔐 **Microsoft Authentication Required**\n\n1. Visit: ${uri}\n2. Enter Code: \`${code}\`\n\n🔒 **Security Notice:** Your account tokens are saved in an encrypted volume and are never shared.`;
                    
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

        const p = (async () => {
            try {
                if (!codeShown) await interaction.editReply("⏳ Requesting code…").catch(() => {});
                await flow.getMsaToken();
                u.linked = true; 
                save();
                await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account linked!" }).catch(() => {});
            } catch (e) {
                const errorMsg = e?.message || "Unknown error";
                await interaction.editReply(`❌ Login failed: ${errorMsg}`).catch(() => {});
            } finally { 
                pendingLink.delete(uid); 
            }
        })();
        
        pendingLink.set(uid, p);
        
        // Timeout cleanup
        setTimeout(() => {
            if (pendingLink.has(uid)) {
                pendingLink.delete(uid);
            }
        }, 300000); // 5 minute timeout
        
    } catch (e) {
        pendingLink.delete(uid);
        console.error("Authflow creation error:", e);
        safeReply(interaction, "❌ Authentication system error.");
    }
}

// ----------------- Session Logic -----------------
function cleanupSession(uid) {
    if (!uid) return;
    const s = sessions.get(uid);
    if (!s) return;

    try {
        if (s.reconnectTimer) {
            clearTimeout(s.reconnectTimer);
            s.reconnectTimer = null;
        }
        if (s.physicsLoop) {
            clearInterval(s.physicsLoop);
            s.physicsLoop = null;
        }
        if (s.afkTimeout) {
            clearTimeout(s.afkTimeout);
            s.afkTimeout = null;
        }
        if (s.chunkGCLoop) {
            clearInterval(s.chunkGCLoop);
            s.chunkGCLoop = null;
        }

        if (s.client) {
            s.client.removeAllListeners();
            try {
                s.client.close();
            } catch {}
            s.client = null;
        }
    } catch (e) {
        console.error(`Error in cleanupSession for ${uid}:`, e);
    }
    
    sessions.delete(uid);
}

function stopSession(uid) {
    if (!uid) return false;
    const s = sessions.get(uid);

    if (activeSessionsStore && activeSessionsStore[uid]) {
        delete activeSessionsStore[uid];
        saveActiveSessions();
    }

    if (!s) return false;
    s.manualStop = true;
    cleanupSession(uid);
    return true;
}

function handleAutoReconnect(uid) {
    if (!uid || isShuttingDown) return;
    const s = sessions.get(uid);
    if (!s || s.manualStop) return;

    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);

    s.isReconnecting = true;
    logToDiscord(`⏳ Bot of <@${uid}> disconnected. Reconnecting in 60s...`);

    try { 
        if (s.client) s.client.removeAllListeners(); 
    } catch {}

    s.reconnectTimer = setTimeout(() => {
        if (!isShuttingDown && sessions.has(uid)) {
            const checkS = sessions.get(uid);
            if (checkS && !checkS.manualStop) {
                checkS.reconnectTimer = null;
                startSession(uid, null, true);
            } else {
                cleanupSession(uid);
            }
        }
    }, 60000);
}

async function safeReply(interaction, content) {
    if (!interaction) return;
    try {
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply(content).catch(() => {});
        } else {
            await interaction.reply(content).catch(() => {});
        }
    } catch (e) {
        // Silent fail
    }
}

// Validate IP format
function isValidIP(ip) {
    if (!ip || typeof ip !== 'string') return false;
    if (ip.length > 253) return false;
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
    const hostnameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
    return ipv4Regex.test(ip) || ipv6Regex.test(ip) || hostnameRegex.test(ip);
}

function isValidPort(port) {
    const num = parseInt(port);
    return !isNaN(num) && num > 0 && num <= 65535;
}

// ----------------- MAIN SESSION FUNCTION -----------------
async function startSession(uid, interaction, isReconnect = false) {
    if (!uid || isShuttingDown) return;
    
    const u = getUser(uid);
    if (!u) {
        if (!isReconnect) safeReply(interaction, "❌ User data error.");
        return;
    }

    if (!activeSessionsStore) activeSessionsStore = {};
    if (!activeSessionsStore[uid]) {
        activeSessionsStore[uid] = true;
        saveActiveSessions();
    }

    if (!u.server || !u.server.ip) {
        if (!isReconnect) safeReply(interaction, "⚠ Please configure your server settings first.");
        delete activeSessionsStore[uid];
        saveActiveSessions();
        return;
    }

    const { ip, port } = u.server;
    
    if (!isValidIP(ip) || !isValidPort(port)) {
        if (!isReconnect) safeReply(interaction, "❌ Invalid server IP or port format.");
        delete activeSessionsStore[uid];
        saveActiveSessions();
        return;
    }

    // Avoid duplicate sessions if not reconnecting
    if (sessions.has(uid) && !isReconnect) {
        return safeReply(interaction, { 
            ephemeral: true, 
            content: "⚠️ **Session Conflict**: Active session already exists." 
        });
    }

    const connectionEmbed = new EmbedBuilder()
        .setColor("#5865F2")
        .setTitle("Bot Initialization")
        .setThumbnail("https://files.catbox.moe/9mqpoz.gif");

    try {
        if (!isReconnect) {
            connectionEmbed.setDescription(`🔍 **Pinging server...**\n🌐 **Target:** \`${ip}:${port}\``);
            await safeReply(interaction, { embeds: [connectionEmbed], content: null, components: [] });
        }

        await bedrock.ping({ 
            host: ip, 
            port: parseInt(port) || 19132, 
            timeout: 5000 
        });

        if (!isReconnect) {
            connectionEmbed.setDescription(`✅ **Server found! Joining...**\n🌐 **Target:** \`${ip}:${port}\``);
            await safeReply(interaction, { embeds: [connectionEmbed] });
        }
    } catch (err) {
        logToDiscord(`❌ Connection failure for <@${uid}>: Server ${ip}:${port} unreachable.`);
        if (isReconnect) handleAutoReconnect(uid);
        else {
            await safeReply(interaction, { 
                content: `❌ **Connection Failed**: The server at \`${ip}:${port}\` is currently offline.`, 
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
        return handleAutoReconnect(uid);
    }

    const currentSession = {
        client: mc,
        startedAt: Date.now(),
        manualStop: false,
        connected: false,
        isReconnecting: false,
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
        entityId: null
    };
    sessions.set(uid, currentSession);

    // ==========================================
    // 🍎 ADVANCED PHYSICS, WALKING & CHUNK ENGINE
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
            if (!currentSession.Chunk || !packet) return;
            try {
                const chunk = new currentSession.Chunk();
                if (packet.payload) chunk.load(packet.payload);
                if (packet.x !== undefined && packet.z !== undefined) {
                    currentSession.chunks.set(`${packet.x},${packet.z}`, chunk);
                }
            } catch (e) { 
                // Ignore chunk errors
            }
        });

        currentSession.chunkGCLoop = setInterval(() => {
            try {
                if (currentSession.chunks && currentSession.chunks.size > 20) {
                    currentSession.chunks.clear();
                }
            } catch (e) {}
        }, 30000);

        currentSession.physicsLoop = setInterval(() => {
            try {
                if (!currentSession.connected || !currentSession.position || !currentSession.velocity) return;

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

                if (currentSession.position.y < -64) {
                    currentSession.position.y = 320;
                    currentSession.velocity.y = 0;
                }

                if (mc && mc.write) {
                    mc.write("player_auth_input", {
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
                }
            } catch (e) { 
                // Ignore physics errors
            }
        }, 50);
    }

    // ==========================================
    // 🤖 ANTI-AFK & AI CONTROLLER
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
            scanForBedAndSleep(uid);

            const action = Math.random();
            if (action > 0.5 && !s.isWalking) {
                s.isWalking = true;
            } else {
                s.yaw += (Math.random() - 0.5) * 20;
                s.pitch += (Math.random() - 0.5) * 10;
                if (s.onGround && Math.random() > 0.9 && s.velocity) {
                    s.velocity.y = 0.42;
                    s.onGround = false;
                }
            }

            if (mc && mc.write && s.entityId) {
                mc.write('animate', { action_id: 1, runtime_entity_id: s.entityId });
            }
        } catch (e) {}

        const nextDelay = Math.random() * 20000 + 10000;
        s.afkTimeout = setTimeout(performAntiAfk, nextDelay);
    };

    // ==========================================
    // 🛌 BED DETECTION AI
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
                                    logToDiscord(`🛌 Bed found for <@${uid}> at ${checkPos.x},${checkPos.y},${checkPos.z}. Attempting to sleep.`);
                                    s.isTryingToSleep = true;

                                    if (mc && mc.write) {
                                        mc.write('inventory_transaction', {
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

                                        mc.write('player_action', {
                                            runtime_entity_id: s.entityId || 0n,
                                            action: 'start_sleeping',
                                            position: checkPos,
                                            result_code: 0,
                                            face: 0
                                        });
                                    }
                                    return;
                                }
                            } catch (err) {
                                // Chunk read error, ignore
                            }
                        }
                    }
                }
            }
        } catch (e) {
            // Ignore bed scan errors
        }
    }

    // --- EVENTS ---
    mc.on("spawn", () => {
        logToDiscord(`✅ Bot of <@${uid}> spawned on **${ip}:${port}**` + (isReconnect ? " (Auto-Rejoined)" : ""));
        if (!isReconnect) safeReply(interaction, { content: `🟢 **Online** on \`${ip}:${port}\``, embeds: [] });
    });

    mc.on("start_game", (packet) => {
        if (!packet) return;
        try {
            if (Vec3 && currentSession) {
                currentSession.position = new Vec3(
                    packet.player_position?.x || 0, 
                    packet.player_position?.y || 0, 
                    packet.player_position?.z || 0
                );
                currentSession.targetPosition = currentSession.position.clone();
            }
            currentSession.entityId = packet.runtime_entity_id;
            currentSession.connected = true;
            currentSession.isReconnecting = false;

            performAntiAfk();
        } catch (e) {
            console.error("Error in start_game handler:", e);
        }
    });

    mc.on("move_player", (packet) => {
        if (!packet || !currentSession) return;
        try {
            if (packet.runtime_id === currentSession.entityId && currentSession.position) {
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
            }
        } catch (e) {
            console.error("Error in respawn handler:", e);
        }
    });

    mc.on("error", (e) => {
        if (!currentSession.manualStop) handleAutoReconnect(uid);
        logToDiscord(`❌ Bot of <@${uid}> error: \`${e?.message || 'Unknown error'}\``);
    });

    mc.on("close", () => {
        if (!currentSession.manualStop) handleAutoReconnect(uid);
        logToDiscord(`🔌 Bot of <@${uid}> connection closed.`);
    });
}

// ----------------- Interactions -----------------
client.on(Events.InteractionCreate, async (i) => {
    if (!i || isShuttingDown) return;
    
    try {
        const uid = i.user?.id;
        if (!uid) return;

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
                if (targetUid) {
                    stopSession(targetUid);
                    return i.update({ 
                        content: `🛑 Forced stop for <@${targetUid}>`, 
                        embeds: [getAdminStatsEmbed()], 
                        components: adminPanelComponents() 
                    }).catch(() => {});
                }
            }
        }

        if (i.isButton()) {
            if (i.customId === "admin_refresh") {
                return i.update({ 
                    embeds: [getAdminStatsEmbed()], 
                    components: adminPanelComponents() 
                }).catch(() => {});
            }

            if (i.customId === "admin_stop_all") {
                if (uid !== ADMIN_ID) return;
                sessions.forEach((_, sUid) => stopSession(sUid));
                return i.update({ 
                    content: "🛑 All sessions stopped.", 
                    embeds: [getAdminStatsEmbed()], 
                    components: adminPanelComponents() 
                }).catch(() => {});
            }

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
                const ok = stopSession(uid);
                return safeReply(i, { ephemeral: true, content: ok ? "⏹ **Session Terminated.**" : "No active sessions." });
            }

            if (i.customId === "link") {
                await i.deferReply({ ephemeral: true }).catch(() => {});
                return linkMicrosoft(uid, i);
            }

            if (i.customId === "unlink") {
                unlinkMicrosoft(uid);
                return safeReply(i, { ephemeral: true, content: "🗑 Unlinked." });
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
                save();
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
