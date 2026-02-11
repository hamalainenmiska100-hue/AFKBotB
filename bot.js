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
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_ID = "1144987924123881564";
const LOG_CHANNEL_ID = "1464615030111731753";
const ADMIN_CHANNEL_ID = "1469013237625393163";

// ----------------- Storage -----------------
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");
const REJOIN_STORE = path.join(DATA, "ReJoin.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

// Safe Load Helper
function loadJson(path, defaultVal) {
    if (!fs.existsSync(path)) return defaultVal;
    try {
        return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch (e) {
        console.error(`⚠️ Corrupt JSON at ${path}. Resetting.`);
        return defaultVal;
    }
}

let users = loadJson(STORE, {});
let activeSessionsStore = loadJson(REJOIN_STORE, {});

function save() {
    try { fs.writeFileSync(STORE, JSON.stringify(users, null, 2)); } catch (e) { console.error("Save failed:", e); }
}

function saveActiveSessions() {
    try { fs.writeFileSync(REJOIN_STORE, JSON.stringify(activeSessionsStore, null, 2)); } catch (e) { console.error("Save Active failed:", e); }
}

function getUser(uid) {
    if (!users[uid]) users[uid] = {};
    users[uid].connectionType = "online";
    if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
    return users[uid];
}

function getUserAuthDir(uid) {
    const dir = path.join(AUTH_ROOT, uid);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function unlinkMicrosoft(uid) {
    const dir = getUserAuthDir(uid);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
    const u = getUser(uid);
    u.linked = false;
    save();
}

// ----------------- Runtime -----------------
const sessions = new Map();
const pendingLink = new Map();
const lastMsa = new Map();
let lastAdminMessage = null;

// ----------------- Discord client -----------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessages
    ]
});

// ==========================================================
// 🛡️ CRASH PREVENTION SYSTEM
// ==========================================================
client.on("error", (error) => console.error("⚠️ Discord Client Error (Ignored):", error.message));
client.on("shardError", (error) => console.error("⚠️ WebSocket Error (Ignored):", error.message));
process.on("uncaughtException", (err) => console.error("🔥 Uncaught Exception:", err));

async function logToDiscord(message) {
    try {
        const channel = await client.channels.fetch(LOG_CHANNEL_ID);
        if (channel) {
            const embed = new EmbedBuilder().setColor("#5865F2").setDescription(message).setTimestamp();
            await channel.send({ embeds: [embed] });
        }
    } catch (e) { }
}

function denyIfWrongGuild(i) {
    if (!i.inGuild() || i.guildId !== ALLOWED_GUILD_ID) {
        const msg = "This bot cannot be used in this server ⛔️";
        if (i.replied || i.deferred) return;
        return i.reply({ ephemeral: true, content: msg }).catch(() => { });
    }
    return null;
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
            options.push({ label: `User: ${uid}`, description: `Started: ${new Date(session.startedAt).toLocaleTimeString()}`, value: uid });
            count++;
        }
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId("admin_force_stop_select").setPlaceholder("Select bot to Force Stop").addOptions(options)
        ));
    }
    return rows;
}

function getAdminStatsEmbed() {
    const memory = process.memoryUsage();
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
            { name: "💾 Persisted Sessions", value: `**Saved for Restart:** ${Object.keys(activeSessionsStore).length}`, inline: true }
        )
        .setFooter({ text: "Auto-refreshing every 30s • Administrative Access Only" })
        .setTimestamp();

    if (sessions.size > 0) {
        let botList = "";
        for (const [uid, s] of sessions) {
            const status = s.connected ? "🟢 Online" : (s.isReconnecting ? "⏳ Reconnecting" : "🔴 Offline");
            botList += `<@${uid}>: ${status}\n`;
        }
        embed.addFields({ name: "📋 Active Bot Registry", value: botList.slice(0, 1024) || "None" });
    }
    return embed;
}

// ----------------- Events: Ready & Startup Rejoin -----------------
client.once("ready", async () => {
    console.log("🟢 Online as", client.user.tag);

    const cmds = [
        new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
        new SlashCommandBuilder().setName("java").setDescription("Open Java AFKBot Panel"),
        new SlashCommandBuilder().setName("admin").setDescription("Open Admin Control Panel")
    ];
    await client.application.commands.set(cmds);

    setInterval(async () => {
        if (lastAdminMessage) {
            try {
                await lastAdminMessage.edit({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() });
            } catch (e) { lastAdminMessage = null; }
        }
    }, 30000);

    console.log("📂 Checking ReJoin.json for previous sessions...");
    const previousSessions = Object.keys(activeSessionsStore);

    if (previousSessions.length > 0) {
        console.log(`♻️ Found ${previousSessions.length} bots to restore. Starting them now...`);
        let delay = 0;
        for (const uid of previousSessions) {
            setTimeout(() => startSession(uid, null, true), delay);
            delay += 5000;
        }
    } else {
        console.log("⚪ No previous sessions found.");
    }
});

// ----------------- Microsoft link -----------------
async function linkMicrosoft(uid, interaction) {
    if (pendingLink.has(uid)) return interaction.editReply("⏳ Login already in progress. Use the last code.");
    const authDir = getUserAuthDir(uid);
    const u = getUser(uid);
    let codeShown = false;

    const flow = new Authflow(uid, authDir, { flow: "live", authTitle: Titles?.MinecraftNintendoSwitch || "Bedrock AFK Bot", deviceType: "Nintendo" }, async (data) => {
        const uri = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
        const code = data.user_code || "(no code)";
        lastMsa.set(uid, { uri, code, at: Date.now() });
        codeShown = true;
        const msg = `🔐 **Microsoft Authentication Required**\n\n1. Visit: ${uri}\n2. Enter Code: \`${code}\``;
        await interaction.editReply({ content: msg, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("🌐 Open link").setStyle(ButtonStyle.Link).setURL(uri))] }).catch(() => { });
    });

    const p = (async () => {
        try {
            if (!codeShown) await interaction.editReply("⏳ Requesting code…");
            await flow.getMsaToken();
            u.linked = true; save();
            await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account linked!" });
        } catch (e) {
            await interaction.editReply(`❌ Login failed: ${e.message}`).catch(() => { });
        } finally { pendingLink.delete(uid); }
    })();
    pendingLink.set(uid, p);
}

// ----------------- Session Logic -----------------
function cleanupSession(uid) {
    const s = sessions.get(uid);
    if (!s) return;

    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    if (s.physicsLoop) clearInterval(s.physicsLoop);
    if (s.afkTimeout) clearTimeout(s.afkTimeout);
    if (s.chunkGCLoop) clearInterval(s.chunkGCLoop);

    try {
        if (s.client) {
            s.client.removeAllListeners();
            s.client.close();
        }
    } catch { }
    sessions.delete(uid);
}

function stopSession(uid) {
    const s = sessions.get(uid);

    if (activeSessionsStore[uid]) {
        delete activeSessionsStore[uid];
        saveActiveSessions();
    }

    if (!s) return false;
    s.manualStop = true;

    cleanupSession(uid);
    return true;
}

function handleAutoReconnect(uid) {
    const s = sessions.get(uid);
    if (!s || s.manualStop) return;

    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);

    s.isReconnecting = true;
    logToDiscord(`⏳ Bot of <@${uid}> disconnected. Reconnecting in 60s...`);

    // Clean up old client listeners to prevent memory leak
    try { s.client.removeAllListeners(); } catch { }

    s.reconnectTimer = setTimeout(() => {
        if (sessions.has(uid)) {
            const checkS = sessions.get(uid);
            if (!checkS.manualStop) {
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
        if (interaction.replied || interaction.deferred) await interaction.editReply(content);
        else await interaction.reply(content);
    } catch (e) { }
}

// ----------------- MAIN SESSION FUNCTION -----------------
async function startSession(uid, interaction, isReconnect = false) {
    const u = getUser(uid);

    if (!activeSessionsStore[uid]) {
        activeSessionsStore[uid] = true;
        saveActiveSessions();
    }

    if (!u.server) {
        if (!isReconnect) await safeReply(interaction, "⚠ Please configure your server settings first.");
        delete activeSessionsStore[uid];
        saveActiveSessions();
        return;
    }

    const { ip, port } = u.server;

    // Avoid duplicate sessions if not reconnecting
    if (sessions.has(uid) && !isReconnect) {
        return safeReply(interaction, "⚠️ **Session Conflict**: Active session already exists.").catch(() => { });
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

        await bedrock.ping({ host: ip, port: parseInt(port) || 19132, timeout: 5000 });

        if (!isReconnect) {
            connectionEmbed.setDescription(`✅ **Server found! Joining...**\n🌐 **Target:** \`${ip}:${port}\``);
            await safeReply(interaction, { embeds: [connectionEmbed] });
        }
    } catch (err) {
        logToDiscord(`❌ Connection failure for <@${uid}>: Server ${ip}:${port} unreachable.`);
        if (isReconnect) handleAutoReconnect(uid);
        else await safeReply(interaction, { content: `❌ **Connection Failed**: The server at \`${ip}:${port}\` is currently offline.`, embeds: [] });
        return;
    }

    const authDir = getUserAuthDir(uid);

    const opts = {
        host: ip,
        port: parseInt(port),
        connectTimeout: 60000,
        keepAlive: true,
        viewDistance: 4,
        profilesFolder: authDir,
        username: uid,
        offline: false,
        skipPing: true // Optimization: We already pinged above
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
        return handleAutoReconnect(uid);
    }

    const currentSession = {
        client: mc,
        startedAt: Date.now(),
        manualStop: false,
        connected: false,
        isReconnecting: false,
        position: null,
        velocity: (Vec3) ? new Vec3(0, 0, 0) : null,
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
    if (Vec3 && PrismarineChunk) {
        try {
            currentSession.registry = PrismarineRegistry('bedrock_1.20.0');
            currentSession.Chunk = PrismarineChunk(currentSession.registry);
        } catch (e) {
            logToDiscord(`Could not initialize chunk manager for <@${uid}>. Bed detection disabled.`);
            currentSession.Chunk = null;
        }

        mc.on('level_chunk', (packet) => {
            if (!currentSession.Chunk) return;
            try {
                const chunk = new currentSession.Chunk();
                chunk.load(packet.payload);
                currentSession.chunks.set(`${packet.x},${packet.z}`, chunk);
            } catch (e) { }
        });

        // Clear memory more aggressively
        currentSession.chunkGCLoop = setInterval(() => {
            if (currentSession.chunks.size > 20) {
                currentSession.chunks.clear();
            }
        }, 30000);

        currentSession.physicsLoop = setInterval(() => {
            // FIX: Check if velocity exists (Vec3 loaded)
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

            try {
                mc.write("player_auth_input", {
                    pitch: currentSession.pitch, yaw: currentSession.yaw,
                    position: { x: currentSession.position.x, y: currentSession.position.y, z: currentSession.position.z },
                    move_vector: moveVector, head_yaw: currentSession.yaw, input_data: 0n,
                    input_mode: "mouse", play_mode: "screen", interaction_model: "touch", tick: 0n
                });
            } catch (e) { }
        }, 50);
    }

    // ==========================================
    // 🤖 ANTI-AFK & AI CONTROLLER
    // ==========================================
    const performAntiAfk = () => {
        if (!sessions.has(uid)) return;
        const s = sessions.get(uid);

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

            mc.write('animate', { action_id: 1, runtime_entity_id: s.entityId || 0n });
        } catch (e) { }

        const nextDelay = Math.random() * 20000 + 10000;
        s.afkTimeout = setTimeout(performAntiAfk, nextDelay);
    };

    // ==========================================
    // 🛌 BED DETECTION AI
    // ==========================================
    function scanForBedAndSleep(uid) {
        const s = sessions.get(uid);
        if (!s || !s.Chunk || !s.position || s.isTryingToSleep) return;

        const searchRadius = 3;
        const playerPos = s.position.floored();

        for (let x = -searchRadius; x <= searchRadius; x++) {
            for (let y = -searchRadius; y <= searchRadius; y++) {
                for (let z = -searchRadius; z <= searchRadius; z++) {
                    const checkPos = playerPos.offset(x, y, z);

                    const chunkX = Math.floor(checkPos.x / 16);
                    const chunkZ = Math.floor(checkPos.z / 16);
                    const chunk = s.chunks.get(`${chunkX},${chunkZ}`);

                    if (chunk) {
                        // FIX: Try/Catch required for getBlock if coords are edge-case
                        try {
                            const block = chunk.getBlock(checkPos);
                            if (block && block.name.includes('bed')) {
                                logToDiscord(`🛌 Bed found for <@${uid}> at ${checkPos}. Attempting to sleep.`);
                                s.isTryingToSleep = true;

                                mc.write('inventory_transaction', {
                                    transaction: {
                                        transaction_type: 'item_use_on_block', action_type: 0,
                                        block_position: checkPos, block_face: 1, hotbar_slot: 0,
                                        item_in_hand: { network_id: 0 }, player_position: s.position,
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
                                return;
                            }
                        } catch (err) {
                            // Chunk read error, ignore
                        }
                    }
                }
            }
        }
    }

    // --- EVENTS ---
    mc.on("spawn", () => {
        logToDiscord(`✅ Bot of <@${uid}> spawned on **${ip}:${port}**` + (isReconnect ? " (Auto-Rejoined)" : ""));
        if (!isReconnect) safeReply(interaction, { content: `🟢 **Online** on \`${ip}:${port}\``, embeds: [] });
    });

    mc.on("start_game", (packet) => {
        if (Vec3) {
            currentSession.position = new Vec3(packet.player_position.x, packet.player_position.y, packet.player_position.z);
            currentSession.targetPosition = currentSession.position.clone();
        }
        currentSession.entityId = packet.runtime_entity_id;
        currentSession.connected = true;
        currentSession.isReconnecting = false;

        performAntiAfk();
    });

    mc.on("move_player", (packet) => {
        if (packet.runtime_id === currentSession.entityId && currentSession.position) {
            if (packet.position.y > currentSession.position.y && currentSession.velocity) {
                currentSession.onGround = true;
                currentSession.velocity.y = 0;
            } else {
                currentSession.onGround = false;
            }
            currentSession.isTryingToSleep = false;
            currentSession.position.set(packet.position.x, packet.position.y, packet.position.z);
        }
    });

    mc.on("respawn", (packet) => {
        logToDiscord(`💀 Bot of <@${uid}> died and respawned.`);
        if (currentSession.position) {
            currentSession.position.set(packet.position.x, packet.position.y, packet.position.z);
            currentSession.targetPosition = currentSession.position.clone();
            if (currentSession.velocity) currentSession.velocity.set(0, 0, 0);
            currentSession.isTryingToSleep = false;
        }
    });

    mc.on("error", (e) => {
        if (!currentSession.manualStop) handleAutoReconnect(uid);
        logToDiscord(`❌ Bot of <@${uid}> error: \`${e.message}\``);
    });

    mc.on("close", () => {
        if (!currentSession.manualStop) handleAutoReconnect(uid);
        logToDiscord(`🔌 Bot of <@${uid}> connection closed.`);
    });
}

// ----------------- Interactions -----------------
client.on(Events.InteractionCreate, async (i) => {
    try {
        const blocked = denyIfWrongGuild(i);
        if (blocked) return;
        const uid = i.user.id;

        if (i.isChatInputCommand()) {
            if (i.commandName === "panel") return safeReply(i, panelRow(false));
            if (i.commandName === "java") return safeReply(i, panelRow(true));
            if (i.commandName === "admin") {
                if (uid !== ADMIN_ID || i.channelId !== ADMIN_CHANNEL_ID) return safeReply(i, { content: "⛔ Access restricted.", ephemeral: true });
                const msg = await i.reply({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents(), fetchReply: true });
                lastAdminMessage = msg;
                return;
            }
        }

        // --- Select Menu Handling (FIXED) ---
        if (i.isStringSelectMenu()) {
            if (i.customId === "admin_force_stop_select") {
                const targetUid = i.values[0];
                stopSession(targetUid);
                return i.update({ content: `🛑 Forced stop for <@${targetUid}>`, embeds: [getAdminStatsEmbed()], components: adminPanelComponents() });
            }
        }

        if (i.isButton()) {
            if (i.customId === "admin_refresh") {
                return i.update({ embeds: [getAdminStatsEmbed()], components: adminPanelComponents() }).catch(() => { });
            }

            if (i.customId === "admin_stop_all") {
                if (uid !== ADMIN_ID) return;
                sessions.forEach((_, sUid) => stopSession(sUid));
                return i.update({ content: "🛑 All sessions stopped.", embeds: [getAdminStatsEmbed()], components: adminPanelComponents() });
            }

            if (i.customId === "start_bedrock") {
                if (sessions.has(uid)) return safeReply(i, { ephemeral: true, content: "⚠️ **Session Conflict**: Active session exists." });
                const embed = new EmbedBuilder().setTitle("Bedrock Connection").setDescription("Start bot?").setColor("#2ECC71");
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("confirm_start").setLabel("Start").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );
                return i.reply({ embeds: [embed], components: [row], ephemeral: true }).catch(() => { });
            }

            if (i.customId === "start_java") {
                if (sessions.has(uid)) return safeReply(i, { ephemeral: true, content: "⚠️ **Session Conflict**: Active session exists." });
                const embed = new EmbedBuilder()
                    .setTitle("⚙️ Java Compatibility Check")
                    .setDescription("For a successful connection to a Java server, ensure the following plugins are installed.")
                    .addFields({ name: "Required Plugins", value: "• GeyserMC\n• Floodgate" })
                    .setColor("#E67E22");
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("confirm_start").setLabel("Confirm & Start").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );
                return i.reply({ embeds: [embed], components: [row], ephemeral: true }).catch(() => { });
            }

            if (i.customId === "confirm_start") {
                await i.deferUpdate().catch(() => { });
                return startSession(uid, i, false);
            }

            if (i.customId === "cancel") return i.update({ content: "❌ Cancelled.", embeds: [], components: [] }).catch(() => { });

            if (i.customId === "stop") {
                const ok = stopSession(uid);
                return safeReply(i, { ephemeral: true, content: ok ? "⏹ **Session Terminated.**" : "No active sessions." });
            }

            if (i.customId === "link") {
                await i.deferReply({ ephemeral: true }).catch(() => { });
                return linkMicrosoft(uid, i);
            }

            if (i.customId === "unlink") {
                unlinkMicrosoft(uid);
                return safeReply(i, { ephemeral: true, content: "🗑 Unlinked." });
            }

            if (i.customId === "settings") {
                const u = getUser(uid);
                const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Configuration");
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setRequired(true).setValue(u.server?.ip || "")),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(u.server?.port || 19132)))
                );
                return i.showModal(modal);
            }
        }

        if (i.isModalSubmit() && i.customId === "settings_modal") {
            const ip = i.fields.getTextInputValue("ip").trim();
            const port = parseInt(i.fields.getTextInputValue("port").trim(), 10);
            const u = getUser(uid);
            u.server = { ip, port };
            save();
            return safeReply(i, { ephemeral: true, content: `✅ Saved: **${ip}:${port}**` });
        }

    } catch (e) { console.error(e); }
});

process.on("unhandledRejection", (e) => console.error("Unhandled Rejection:", e));
client.login(DISCORD_TOKEN);
