/**
 * TITAN AFK BOT - HIGH PERFORMANCE EDITION
 * * Optimized for:
 * 1. Flash Fast Joins (No chunk processing)
 * 2. Minimal RAM Usage (Aggressive garbage collection)
 * 3. Robust Error Handling (Immediate stops on failure)
 * 4. English UI
 */

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

// ==========================================
// 1. CONFIGURATION & CONSTANTS
// ==========================================

const CONFIG = {
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    ADMIN_ID: "1144987924123881564",
    ALLOWED_GUILDS: [
        "1462335230345089254", 
        "1468289465783943354"
    ],
    PATHS: {
        DATA: path.join(__dirname, "data"),
        AUTH: path.join(__dirname, "data", "auth"),
        USERS: path.join(__dirname, "data", "users.json")
    },
    // Packet throttle interval (ms) to keep connection alive without spamming
    AFK_PACKET_INTERVAL: 15000, 
    // Connection timeout in milliseconds
    CONNECT_TIMEOUT: 25000 
};

// Critical Pre-flight check
if (!CONFIG.DISCORD_TOKEN) {
    console.error("❌FATAL: DISCORD_TOKEN env var missing. Exiting.");
    process.exit(1);
}

// Ensure Directories
if (!fs.existsSync(CONFIG.PATHS.DATA)) fs.mkdirSync(CONFIG.PATHS.DATA);
if (!fs.existsSync(CONFIG.PATHS.AUTH)) fs.mkdirSync(CONFIG.PATHS.AUTH, { recursive: true });

// ==========================================
// 2. DATABASE MANAGER (Cached & Optimized)
// ==========================================

class DatabaseManager {
    constructor() {
        this.cache = {};
        this.loaded = false;
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(CONFIG.PATHS.USERS)) {
                this.cache = JSON.parse(fs.readFileSync(CONFIG.PATHS.USERS, "utf8"));
            }
            this.loaded = true;
            console.log("📂 Database loaded into memory.");
        } catch (e) {
            console.error("⚠️ Database load failed, resetting:", e);
            this.cache = {};
        }
    }

    async save() {
        // Non-blocking save
        try {
            await fs.promises.writeFile(CONFIG.PATHS.USERS, JSON.stringify(this.cache, null, 2));
        } catch (e) {
            console.error("❌ Async Save Error:", e);
        }
    }

    getUser(uid) {
        if (!this.cache[uid]) this.cache[uid] = {};
        const u = this.cache[uid];

        // Ensure Schema
        if (!u.server) u.server = { ip: null, port: 19132 };
        if (!u.java) u.java = { server: { ip: null, port: 19132 }, offlineUsername: `G_${uid.slice(-4)}` };
        if (!u.offlineUsername) u.offlineUsername = `B_${uid.slice(-4)}`;
        if (!u.connectionType) u.connectionType = "online";
        
        return u;
    }

    updateUser(uid, data) {
        this.cache[uid] = { ...this.getUser(uid), ...data };
        this.save();
    }
}

const DB = new DatabaseManager();

// ==========================================
// 3. SESSION CONTROLLER (The Brain)
// ==========================================

/**
 * Manages a single Minecraft connection.
 * Optimized to drop unnecessary packets to save RAM.
 */
class BotSession {
    constructor(uid, type, interaction) {
        this.uid = uid;
        this.type = type; // 'bedrock' or 'java'
        this.interaction = interaction;
        this.client = null;
        this.afkInterval = null;
        this.uptimeInterval = null;
        this.connected = false;
        this.startTime = 0;
        this.hoursOnline = 0;
        this.userConfig = DB.getUser(uid);
    }

    /**
     * The Logic:
     * 1. Check Config
     * 2. Initialize Bedrock Client
     * 3. Hook vital events ONLY (ignore chunks)
     * 4. Handle Disconnects
     */
    async start() {
        const configTarget = this.type === 'java' ? this.userConfig.java : this.userConfig;
        const targetServer = configTarget.server;

        if (!targetServer || !targetServer.ip) {
            this.logUI("❌ **Configuration Error:** IP address is missing. Please set it in Settings.");
            SessionManager.destroy(this.uid, this.type);
            return;
        }

        // --- UPDATE UI ---
        await this.interaction.update({ 
            content: `🚀 **Initiating Flash Connection...**\nTarget: \`${targetServer.ip}:${targetServer.port}\`\nMode: **${this.type.toUpperCase()}**`, 
            components: [], 
            embeds: [] 
        }).catch(() => {});

        const authDir = path.join(CONFIG.PATHS.AUTH, this.uid);

        // --- OPTIMIZED OPTIONS ---
        const options = {
            host: targetServer.ip,
            port: targetServer.port,
            connectTimeout: CONFIG.CONNECT_TIMEOUT,
            skipPing: false, // We keep ping for validation, it's fast enough
            
            // Offline/Online logic
            offline: this.userConfig.connectionType === "offline",
            username: this.userConfig.connectionType === "offline" 
                ? (configTarget.offlineUsername || "Bot") 
                : undefined,
            
            // Auth caching
            profilesFolder: this.userConfig.connectionType === "online" ? authDir : undefined,
            
            // Reduce internal logging overhead
            conLog: (msg) => { /* Suppress internal logs to save I/O */ },
            
            // Protocol version settings
            version: this.userConfig.bedrockVersion === 'auto' ? undefined : this.userConfig.bedrockVersion,
            
            // NETWORK OPTIMIZATIONS
            followPort: false, // Don't follow redirects, prevents hangs
            useRaknetWorker: true // Use worker threads for networking if available
        };

        try {
            console.log(`[${this.type.toUpperCase()}] Creating client for ${this.uid}...`);
            this.client = bedrock.createClient(options);
            this.attachListeners(targetServer.ip);
        } catch (e) {
            this.handleError(e);
        }
    }

    attachListeners(hostIp) {
        // 1. SPAWN EVENT (Successful Join)
        this.client.on('spawn', () => {
            this.connected = true;
            this.startTime = Date.now();
            console.log(`[${this.type}] Connected: ${this.uid}`);
            
            let msg = `✅ **FLASH JOIN SUCCESSFUL!**\nConnected to: \`${hostIp}\``;
            if (this.type === 'java') msg += "\n*(Via GeyserMC/Floodgate)*";

            this.interaction.followUp({ content: msg, ephemeral: true }).catch(()=>{});
            
            // Start AFK Routine
            this.startAFK();
            SessionManager.updateAdminDashboard();
        });

        // 2. ERROR HANDLING (Fail Fast)
        this.client.on('error', (err) => {
            if (!this.connected) {
                // Connection phase error
                this.logUI(`❌ **Connection Failed:** ${err.message}\n*Stopping immediately.*`);
                SessionManager.destroy(this.uid, this.type);
            } else {
                console.log(`[${this.type} ERR] ${err.message}`);
            }
        });

        // 3. DISCONNECT handling
        this.client.on('close', () => {
            this.connected = false;
            console.log(`[${this.type}] Socket closed for ${this.uid}`);
            // Strict rule: If disconnected, STOP. No reconnect loops.
            this.logUI(`⚠️ **Disconnected from server.** Session ended.`);
            SessionManager.destroy(this.uid, this.type);
        });

        // 4. KICK handling
        this.client.on('kick', (packet) => {
            const reason = packet.message || "Unknown reason";
            this.logUI(`⚠️ **Kicked by server:** \`${reason}\``);
            SessionManager.destroy(this.uid, this.type);
        });
    }

    startAFK() {
        // --- RAM SAVING TRICK ---
        // We do NOT listen to 'level_chunk' or 'start_game' packet details.
        // We only send 'player_auth_input' to keep connection alive.
        
        console.log(`[${this.type}] Starting AFK loop for ${this.uid}`);
        
        this.afkInterval = setInterval(() => {
            if (this.client && this.connected) {
                try {
                    // Send minimal movement packet to prevent timeout
                    // Rotating head is safest.
                    const yaw = (Date.now() % 360);
                    this.client.write('player_auth_input', {
                        pitch: 0,
                        yaw: yaw,
                        head_yaw: yaw,
                        position: { x: 0, y: 0, z: 0 }, // We don't care about real pos
                        move_vector: { x: 0, z: 0 },
                        input_data: { _value: 0n },
                        input_mode: 'mouse',
                        play_mode: 'normal',
                        tick: 0n,
                        delta: { x: 0, y: 0, z: 0 }
                    });
                } catch (e) {
                    // Packet failed, likely disconnected already
                }
            }
        }, CONFIG.AFK_PACKET_INTERVAL);

        // Uptime Notifications (Hourly)
        this.uptimeInterval = setInterval(async () => {
            this.hoursOnline++;
            try {
                const u = await client.users.fetch(this.uid);
                u.send(`⏱️ **Status Update:** Your ${this.type} bot has been online for **${this.hoursOnline} hours**.`).catch(()=>{});
            } catch (e) {}
        }, 3600 * 1000);
    }

    handleError(err) {
        console.error(`[${this.type} CRITICAL] ${err.message}`);
        this.logUI(`❌ **Critical Initialization Error:** ${err.message}`);
        SessionManager.destroy(this.uid, this.type);
    }

    stop() {
        // CLEANUP PHASE - CRITICAL FOR RAM
        if (this.afkInterval) clearInterval(this.afkInterval);
        if (this.uptimeInterval) clearInterval(this.uptimeInterval);

        if (this.client) {
            try {
                this.client.close();
                this.client.removeAllListeners();
            } catch (e) { }
            this.client = null; // Help GC
        }
        this.connected = false;
    }

    logUI(msg) {
        if (this.interaction) {
            this.interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
        }
    }
}

// ==========================================
// 4. SESSION MANAGER (Global State)
// ==========================================

class SessionManager {
    static sessions = new Map(); // Stores { bedrock: Map, java: Map }
    static adminMessage = null;

    static getMap(type) {
        if (!this.sessions.has(type)) this.sessions.set(type, new Map());
        return this.sessions.get(type);
    }

    static create(uid, type, interaction) {
        const map = this.getMap(type);
        if (map.has(uid)) {
            interaction.reply({ content: "⚠️ **Session already active.** Stop the existing one first.", ephemeral: true });
            return;
        }

        const session = new BotSession(uid, type, interaction);
        map.set(uid, session);
        session.start(); // Async start
        this.updateAdminDashboard();
    }

    static destroy(uid, type) {
        const map = this.getMap(type);
        if (map.has(uid)) {
            const session = map.get(uid);
            session.stop();
            map.delete(uid);
            console.log(`[MANAGER] Destroyed ${type} session for ${uid}`);
            this.updateAdminDashboard();
        }
    }

    static countTotal() {
        let total = 0;
        this.sessions.forEach(map => total += map.size);
        return total;
    }

    static async updateAdminDashboard() {
        if (!this.adminMessage) return;
        
        const memUsage = process.memoryUsage();
        const ram = (memUsage.heapUsed / 1024 / 1024).toFixed(1);
        
        const bCount = this.getMap('bedrock').size;
        const jCount = this.getMap('java').size;

        const embed = new EmbedBuilder()
            .setTitle("🛡️ TITAN ADMIN DASHBOARD")
            .setColor(0x5865F2)
            .addFields(
                { name: "Total Sessions", value: `${bCount + jCount}`, inline: true },
                { name: "RAM Usage", value: `${ram} MB`, inline: true },
                { name: "Breakdown", value: `Bedrock: ${bCount} | Java: ${jCount}`, inline: false }
            )
            .setTimestamp();
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("admin_refresh").setLabel("Force Refresh").setStyle(ButtonStyle.Secondary)
        );

        try {
            await this.adminMessage.edit({ embeds: [embed], components: [row] });
        } catch (e) {
            this.adminMessage = null; // Message likely deleted
        }
    }
}

// ==========================================
// 5. DISCORD INTERFACE (UI & Events)
// ==========================================

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- UI GENERATORS ---

const UI = {
    mainPanel(type) {
        const isJava = type === 'java';
        const title = isJava ? "☕ JAVA (GEYSER) CONTROLLER" : "🧱 BEDROCK CONTROLLER";
        const color = isJava ? ButtonStyle.Success : ButtonStyle.Primary; // Green for Java, Blue for Bedrock

        return [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`pre_${type}`).setLabel("▶ START BOT").setStyle(color),
                new ButtonBuilder().setCustomId(`stop_${type}`).setLabel("⏹ EMERGENCY STOP").setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`settings_${type}`).setLabel("⚙ SETTINGS").setStyle(ButtonStyle.Secondary)
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("link_xbox").setLabel("🔑 Link Microsoft Account").setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`status_${type}`).setLabel("📊 Status Check").setStyle(ButtonStyle.Secondary)
            )
        ];
    },

    preFlightEmbed(server) {
        return new EmbedBuilder()
            .setTitle("⚠️ PRE-FLIGHT CHECK: JAVA SERVER")
            .setColor(0xFFA500)
            .setDescription(`**Target:** \`${server.ip}:${server.port}\`\n\nSince this bot uses the **Bedrock Protocol** to join a Java server, the server **MUST** have the following plugins installed:\n\n1. **GeyserMC** (Required for connection)\n2. **ViaVersion** (To support newer clients)\n3. **ViaBackwards** (If server is older version)\n\n*If these are missing, the bot will fail to join immediately.*`)
            .setFooter({ text: "Are you sure you want to proceed?" });
    },

    preFlightButtons() {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("confirm_java").setLabel("✅ Yes, Server is Compatible").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("cancel_action").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary)
        );
    }
};

// --- EVENT HANDLERS ---

client.once(Events.ClientReady, () => {
    console.log(`🤖 TITAN BOT ONLINE: ${client.user.tag}`);
    client.application.commands.set([
        new SlashCommandBuilder().setName("bedrock").setDescription("Open Bedrock Control Panel"),
        new SlashCommandBuilder().setName("java").setDescription("Open Java (Geyser) Control Panel"),
        new SlashCommandBuilder().setName("admin").setDescription("System Dashboard")
    ]);
});

client.on(Events.InteractionCreate, async (i) => {
    if (!CONFIG.ALLOWED_GUILDS.includes(i.guildId)) return;
    const uid = i.user.id;

    try {
        // 1. SLASH COMMANDS
        if (i.isChatInputCommand()) {
            const cmd = i.commandName;
            if (cmd === "bedrock") return i.reply({ content: "**TITAN BEDROCK ENGINE**", components: UI.mainPanel('bedrock') });
            if (cmd === "java") return i.reply({ content: "**TITAN JAVA ENGINE (GEYSER)**", components: UI.mainPanel('java') });
            if (cmd === "admin" && uid === CONFIG.ADMIN_ID) {
                const msg = await i.reply({ content: "Loading Dashboard...", fetchReply: true });
                SessionManager.adminMessage = msg;
                SessionManager.updateAdminDashboard();
            }
        }

        // 2. BUTTONS
        if (i.isButton()) {
            const id = i.customId;

            // > START BEDROCK
            if (id === "pre_bedrock") {
                SessionManager.create(uid, 'bedrock', i);
                return;
            }

            // > START JAVA (Pre-flight)
            if (id === "pre_java") {
                const u = DB.getUser(uid);
                if (!u.java.server.ip) return i.reply({ content: "❌ **Error:** No server IP set. Go to Settings.", ephemeral: true });
                
                return i.reply({ 
                    embeds: [UI.preFlightEmbed(u.java.server)], 
                    components: [UI.preFlightButtons()], 
                    ephemeral: true 
                });
            }

            // > CONFIRM JAVA
            if (id === "confirm_java") {
                SessionManager.create(uid, 'java', i);
                return;
            }

            // > STOPS
            if (id.startsWith("stop_")) {
                const type = id.split("_")[1];
                SessionManager.destroy(uid, type);
                return i.reply({ content: `🛑 **Stopping ${type.toUpperCase()} session...**`, ephemeral: true });
            }

            // > SETTINGS
            if (id.startsWith("settings_")) {
                const type = id.split("_")[1];
                const u = DB.getUser(uid);
                const conf = type === 'java' ? u.java.server : u.server;
                const offlineName = type === 'java' ? u.java.offlineUsername : u.offlineUsername;

                const modal = new ModalBuilder().setCustomId(`save_${type}`).setTitle(`${type.toUpperCase()} CONFIG`);
                
                const ipInput = new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(conf.ip || "").setRequired(true);
                const portInput = new TextInputBuilder().setCustomId("port").setLabel("Port (Default 19132)").setStyle(TextInputStyle.Short).setValue(String(conf.port || 19132));
                const userInput = new TextInputBuilder().setCustomId("username").setLabel("Offline Username").setStyle(TextInputStyle.Short).setValue(offlineName || "");

                modal.addComponents(
                    new ActionRowBuilder().addComponents(ipInput),
                    new ActionRowBuilder().addComponents(portInput),
                    new ActionRowBuilder().addComponents(userInput)
                );

                await i.showModal(modal);
                return;
            }

            // > LINK XBOX
            if (id === "link_xbox") {
                handleAuthFlow(uid, i);
                return;
            }

            // > CANCEL
            if (id === "cancel_action") {
                return i.update({ content: "❌ Operation cancelled.", embeds: [], components: [] });
            }

            // > ADMIN REFRESH
            if (id === "admin_refresh") {
                i.deferUpdate();
                SessionManager.updateAdminDashboard();
            }
        }

        // 3. MODALS
        if (i.isModalSubmit()) {
            const type = i.customId.split("_")[1]; // bedrock or java
            const ip = i.fields.getTextInputValue("ip");
            const port = parseInt(i.fields.getTextInputValue("port"));
            const username = i.fields.getTextInputValue("username");

            const u = DB.getUser(uid);
            
            if (type === 'java') {
                u.java.server = { ip, port };
                u.java.offlineUsername = username;
            } else {
                u.server = { ip, port };
                u.offlineUsername = username;
            }

            DB.save();
            return i.reply({ content: `✅ **${type.toUpperCase()} Settings Saved!**\nTarget: \`${ip}:${port}\`\nUser: \`${username}\``, ephemeral: true });
        }

    } catch (err) {
        console.error("Interaction Error:", err);
        if (!i.replied && !i.deferred) i.reply({ content: "❌ System Error.", ephemeral: true }).catch(()=>{});
    }
});

// ==========================================
// 6. MICROSOFT AUTH FLOW (Prismarine)
// ==========================================

const authCache = new Map(); // Prevent double auth attempts

function handleAuthFlow(uid, interaction) {
    if (authCache.has(uid)) return interaction.reply({ content: "⏳ Auth flow already active. Check your DMs or wait.", ephemeral: true });

    const authDir = path.join(CONFIG.PATHS.AUTH, uid);
    
    // Create flow
    const flow = new Authflow(uid, authDir, { 
        flow: "live", 
        authTitle: Titles.MinecraftNintendoSwitch, 
        deviceType: "Nintendo" 
    }, async (res) => {
        // On Code Logic
        const link = res.verification_uri_complete || res.verification_uri;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel("👉 Login to Microsoft").setStyle(ButtonStyle.Link).setURL(link)
        );
        interaction.editReply({ 
            content: `🔐 **AUTHORIZATION REQUIRED**\n\nCode: \`${res.user_code}\`\n\nClick the button to link your account.`, 
            components: [row] 
        }).catch(()=>{});
    });

    interaction.deferReply({ ephemeral: true });
    authCache.set(uid, true);

    flow.getMsaToken().then(() => {
        const u = DB.getUser(uid);
        u.linked = true;
        DB.save();
        interaction.followUp({ content: "✅ **Account Linked Successfully!** You can now use Online Mode.", ephemeral: true });
    }).catch(e => {
        interaction.followUp({ content: `❌ **Auth Failed:** ${e.message}`, ephemeral: true });
    }).finally(() => {
        authCache.delete(uid);
    });
}

// ==========================================
// 7. SYSTEM START
// ==========================================

client.login(CONFIG.DISCORD_TOKEN);


