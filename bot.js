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
const mineflayer = require("mineflayer");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// ----------------- CRITICAL CONFIGURATION -----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ CRTICAL ERROR: DISCORD_TOKEN is missing!");
  process.exit(1);
}

// Allowed Guilds (Support for multiple servers)
const ALLOWED_GUILDS = [
    "1462335230345089254", 
    "1468289465783943354"
];
const ADMIN_ID = "1144987924123881564";

// ----------------- STORAGE SYSTEM -----------------
const DATA_DIR = path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const USER_FILE = path.join(DATA_DIR, "users.json");

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// Load Users
let users = {};
try {
  users = fs.existsSync(USER_FILE) ? JSON.parse(fs.readFileSync(USER_FILE, "utf8")) : {};
} catch (e) {
  console.error("⚠️ Failed to load users.json, creating new database.");
  users = {};
}

function saveDatabase() {
  fs.writeFile(USER_FILE, JSON.stringify(users, null, 2), (err) => {
    if (err) console.error("❌ Failed to save database:", err);
  });
}

function getUser(uid) {
  if (!users[uid]) users[uid] = {};
  
  // Ensure Bedrock structure
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  
  // Ensure Java structure
  if (!users[uid].java) {
    users[uid].java = {
      server: null,
      offlineUsername: `Java_${uid.slice(-4)}`,
      selectedVersion: "auto"
    };
  }
  return users[uid];
}

function getUserAuthDir(uid) {
  const dir = path.join(AUTH_DIR, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ----------------- GLOBAL STATE -----------------
// We use a Map to store active sessions. 
// Key: UserID, Value: Session Object
const sessions = new Map();     // Bedrock
const javaSessions = new Map(); // Java
const pendingAuth = new Map();  // Auth flows

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

// ----------------- SESSION MANAGEMENT (OPTIMIZED) -----------------

/**
 * Completely destroys a session to prevent memory leaks.
 * Clears timers, closes connections, and removes from map.
 */
function destroySession(uid, type) {
    const map = type === 'java' ? javaSessions : sessions;
    const s = map.get(uid);
    
    if (!s) return;

    // 1. Clear Timers
    if (s.afkInterval) clearInterval(s.afkInterval);
    if (s.uptimeInterval) clearInterval(s.uptimeInterval);
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);

    // 2. Close Connections
    try {
        if (type === 'java' && s.bot) {
            s.bot.end(); // Aggressive close
            s.bot.removeAllListeners(); // Prevent zombie listeners
        }
        if (type === 'bedrock' && s.client) {
            s.client.close();
            s.client.removeAllListeners();
        }
    } catch (e) {
        console.error(`Error closing ${type} session for ${uid}:`, e.message);
    }

    // 3. Delete from Memory
    map.delete(uid);
    console.log(`[${type.toUpperCase()}] Session destroyed for ${uid}`);
    updateAdminDashboard(); // Refresh UI
}

// ----------------- BEDROCK ENGINE -----------------

async function startBedrock(uid, interaction, versionOverride) {
    const u = getUser(uid);
    if (!u.server) return interaction.reply({ content: "❌ No server set! Go to Settings.", ephemeral: true });
    
    // Prevent duplicates
    if (sessions.has(uid)) return interaction.reply({ content: "❌ Bot already running.", ephemeral: true });

    const authDir = getUserAuthDir(uid);
    const { ip, port } = u.server;

    // Initial Feedback
    await interaction.update({ content: `🧱 **Connecting to ${ip}:${port}...**`, components: [], embeds: [] });

    const options = {
        host: ip,
        port: port,
        connectTimeout: 30000, // Explicit 30s timeout
        skipPing: false,       // Ping is usually good for validation
        version: versionOverride === "auto" ? undefined : versionOverride,
        offline: u.connectionType === "offline",
        username: u.connectionType === "offline" ? (u.offlineUsername || `AFK_${uid.slice(-4)}`) : uid,
        profilesFolder: u.connectionType === "online" ? authDir : undefined
    };

    if (u.connectionType === "online" && !u.linked) {
        return interaction.followUp({ content: "❌ Microsoft Account not linked! Use 'Link Xbox' first.", ephemeral: true });
    }

    createBedrockInstance(uid, options, interaction);
}

function createBedrockInstance(uid, opts, interaction) {
    let client;
    try {
        client = bedrock.createClient(opts);
    } catch (e) {
        if (interaction) interaction.followUp({ content: `❌ Init Error: ${e.message}`, ephemeral: true });
        return;
    }

    const session = {
        client: client,
        connected: false,
        startTime: Date.now(),
        manualStop: false,
        opts: opts, // Save options for auto-rejoin
        pos: { x: 0, y: 0, z: 0 },
        congratsHours: 0
    };
    sessions.set(uid, session);

    client.on('spawn', () => {
        session.connected = true;
        console.log(`[BEDROCK] ${uid} spawned on ${opts.host}`);
        if (interaction) interaction.followUp({ content: `✅ **Connected to ${opts.host}!**`, ephemeral: true });
        updateAdminDashboard();
        startAfkLogic(uid, session, 'bedrock');
    });

    client.on('error', (err) => console.log(`[BEDROCK ERR] ${uid}:`, err.message));

    client.on('close', () => {
        handleDisconnect(uid, session, 'bedrock');
    });

    // Handle Auth Input (Movement updates)
    client.on('move_player', (packet) => {
        if (packet.runtime_id === client.entityId) session.pos = packet.position;
    });
}

// ----------------- JAVA ENGINE -----------------

async function startJava(uid, interaction, versionOverride) {
    const u = getUser(uid);
    if (!u.java.server) return interaction.reply({ content: "❌ No server set! Go to Settings.", ephemeral: true });
    
    if (javaSessions.has(uid)) return interaction.reply({ content: "❌ Bot already running.", ephemeral: true });

    const { ip, port } = u.java.server;
    
    await interaction.update({ content: `☕ **Connecting to ${ip}:${port}...**`, components: [], embeds: [] });

    const options = {
        host: ip,
        port: port,
        username: u.java.offlineUsername || `Java_${uid.slice(-4)}`,
        auth: 'offline', // Forced offline for stability requested
        version: versionOverride === "auto" ? false : versionOverride,
        
        // OPTIMIZATION: Critical for keeping connections alive
        checkTimeoutInterval: 60 * 1000, // 60 seconds tolerance
        keepAlive: true,
        hideErrors: false
    };

    createJavaInstance(uid, options, interaction);
}

function createJavaInstance(uid, opts, interaction) {
    let bot;
    try {
        bot = mineflayer.createBot(opts);
    } catch (e) {
        if (interaction) interaction.followUp({ content: `❌ Init Error: ${e.message}`, ephemeral: true });
        return;
    }

    const session = {
        bot: bot,
        connected: false,
        startTime: Date.now(),
        manualStop: false,
        opts: opts,
        congratsHours: 0
    };
    javaSessions.set(uid, session);

    bot.once('spawn', () => {
        session.connected = true;
        console.log(`[JAVA] ${uid} spawned on ${opts.host}`);
        if (interaction) interaction.followUp({ content: `✅ **Connected to ${opts.host}!**`, ephemeral: true });
        updateAdminDashboard();
        startAfkLogic(uid, session, 'java');
    });

    bot.on('error', (err) => console.log(`[JAVA ERR] ${uid}:`, err.message));
    
    bot.on('kicked', (reason) => {
        console.log(`[JAVA KICK] ${uid}:`, reason);
        // Mineflayer automatically emits 'end' after 'kicked', so logic is handled there
    });

    bot.on('end', () => {
        handleDisconnect(uid, session, 'java');
    });
}

// ----------------- SHARED LOGIC -----------------

function startAfkLogic(uid, session, type) {
    // 1. Movement Interval (Anti-AFK)
    session.afkInterval = setInterval(() => {
        try {
            if (type === 'java' && session.bot?.entity) {
                session.bot.setControlState('jump', true);
                session.bot.look(Math.random() * Math.PI, Math.random() * Math.PI); // Look random
                setTimeout(() => { if (session.bot) session.bot.setControlState('jump', false); }, 500);
            } 
            else if (type === 'bedrock' && session.client) {
                // Send Bedrock movement packet
                const yaw = Math.random() * 360;
                session.client.write("player_auth_input", {
                    pitch: 0, yaw: yaw, head_yaw: yaw,
                    position: session.pos,
                    move_vector: { x: 0, z: 0 },
                    input_data: { _value: 0n },
                    input_mode: 'mouse', play_mode: 'normal', tick: 0n, delta: { x: 0, y: 0, z: 0 }
                });
            }
        } catch (e) {
            // Siltent catch - if this fails, connection is probably dropping anyway
        }
    }, 10000); // Every 10 seconds

    // 2. Hourly Congrats DM
    session.uptimeInterval = setInterval(async () => {
        session.congratsHours++;
        try {
            const user = await client.users.fetch(uid);
            user.send(`🎉 **Congrats!** Your ${type === 'java' ? "Java" : "Bedrock"} bot has been online for **${session.congratsHours} hours**! Keep it up! 🚀`).catch(() => {});
        } catch (e) {}
    }, 3600 * 1000);
}

function handleDisconnect(uid, session, type) {
    // Clear intervals immediately
    if (session.afkInterval) clearInterval(session.afkInterval);
    if (session.uptimeInterval) clearInterval(session.uptimeInterval);

    if (session.manualStop) {
        // User asked to stop -> Destroy everything
        destroySession(uid, type);
    } else {
        // Crash/Kick -> Reconnect
        console.log(`[${type.toUpperCase()}] Disconnected ${uid}. Reconnecting in 30s...`);
        updateAdminDashboard();
        
        // Store reconnect timer in session so we can cancel it if user clicks stop during wait
        session.reconnectTimer = setTimeout(() => {
            const map = type === 'java' ? javaSessions : sessions;
            // Double check if user stopped it during the wait
            if (map.has(uid) && !map.get(uid).manualStop) {
                console.log(`[${type.toUpperCase()}] Reconnecting ${uid} now...`);
                // Recursive restart
                if (type === 'java') createJavaInstance(uid, session.opts, null);
                else createBedrockInstance(uid, session.opts, null);
            } else {
                destroySession(uid, type);
            }
        }, 30000);
    }
}

// ----------------- UI BUILDERS -----------------

function getVersionSelector(type, current) {
    // Java Versions
    const jv = [
        { label: "Auto-Detect (Best)", value: "auto" },
        { label: "1.21.4", value: "1.21.4" }, { label: "1.21.1", value: "1.21.1" },
        { label: "1.20.6", value: "1.20.6" }, { label: "1.20.4", value: "1.20.4" },
        { label: "1.20.1", value: "1.20.1" }, { label: "1.19.4", value: "1.19.4" },
        { label: "1.18.2", value: "1.18.2" }, { label: "1.16.5", value: "1.16.5" },
        { label: "1.12.2", value: "1.12.2" }, { label: "1.8.9", value: "1.8.9" }
    ];
    // Bedrock Versions
    const bv = [
        { label: "Auto-Detect (Best)", value: "auto" },
        { label: "1.21.60", value: "1.21.60" }, { label: "1.21.50", value: "1.21.50" },
        { label: "1.21.40", value: "1.21.40" }, { label: "1.21.20", value: "1.21.20" },
        { label: "1.21.0", value: "1.21.0" }, { label: "1.20.80", value: "1.20.80" }
    ];

    const list = type === 'java' ? jv : bv;
    // Validate selection
    const safeCurrent = list.find(x => x.value === current) ? current : "auto";

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(type === 'java' ? "sel_java_ver" : "sel_bed_ver")
            .setPlaceholder(`Selected: ${safeCurrent}`)
            .addOptions(list.map(v => ({ label: v.label, value: v.value, default: v.value === safeCurrent })))
    );
}

function getPanel(type) {
    // Clean, minimalistic buttons
    if (type === 'bedrock') {
        return [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("pre_bedrock").setLabel("▶ Start").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId("stop_bedrock").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Xbox").setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId("unlink").setLabel("⛓ Unlink").setStyle(ButtonStyle.Secondary)
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("set_bedrock").setLabel("⚙ Settings").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("tech_bedrock").setLabel("🛠 Technical").setStyle(ButtonStyle.Secondary)
            )
        ];
    } else {
        return [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("pre_java").setLabel("▶ Start Java").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId("stop_java").setLabel("⏹ Stop Java").setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId("set_java").setLabel("⚙ Settings").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("tech_java").setLabel("🛠 Technical").setStyle(ButtonStyle.Secondary)
            )
        ];
    }
}

// ----------------- INTERACTION HANDLER -----------------

client.on(Events.InteractionCreate, async (i) => {
    // 1. Guild Security Check
    if (i.guildId && !ALLOWED_GUILDS.includes(i.guildId)) return;
    
    const uid = i.user.id;

    try {
        // --- COMMANDS ---
        if (i.isChatInputCommand()) {
            if (i.commandName === "panel") return i.reply({ content: "**Bedrock Bot Panel 🤖**", components: getPanel('bedrock') });
            if (i.commandName === "java") return i.reply({ content: "**Java Bot Panel 🤖**", components: getPanel('java') });
            if (i.commandName === "admin" && uid === ADMIN_ID) {
                const data = await generateAdminData();
                adminDashboardMessage = await i.reply({ ...data, fetchReply: true });
            }
        }

        // --- BUTTONS ---
        if (i.isButton()) {
            const id = i.customId;

            // PRE-FLIGHT (Start Checks)
            if (id === "pre_bedrock" || id === "pre_java") {
                const type = id === "pre_java" ? "java" : "bedrock";
                const u = getUser(uid);
                
                // Config Check
                const serverData = type === "java" ? u.java.server : u.server;
                if (!serverData) return i.reply({ content: "❌ **Configuration Missing!** Please click 'Settings' first.", ephemeral: true });

                const ver = type === "java" ? u.java.selectedVersion : u.bedrockVersion;
                const verRow = getVersionSelector(type, ver);
                
                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`start_${type}`).setLabel("✅ Connect Now").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );

                return i.reply({ 
                    content: `**Pre-Flight Check (${type === 'java' ? 'Java' : 'Bedrock'})**\nTarget: \`${serverData.ip}:${serverData.port}\`\n\n*Does this look correct? Select version if auto-detect fails.*`,
                    components: [verRow, confirmRow], 
                    ephemeral: true 
                });
            }

            // START SIGNALS
            if (id === "start_bedrock") return startBedrock(uid, i, getUser(uid).bedrockVersion || "auto");
            if (id === "start_java") return startJava(uid, i, getUser(uid).java.selectedVersion || "auto");
            
            if (id === "cancel") return i.update({ content: "❌ Cancelled.", components: [], embeds: [] });

            // STOPS
            if (id === "stop_bedrock") {
                const s = sessions.get(uid);
                if (!s) return i.reply({ content: "❌ No Bedrock bot running.", ephemeral: true });
                s.manualStop = true;
                destroySession(uid, 'bedrock');
                return i.reply({ content: "⏹ **Stopping Bedrock Bot...**", ephemeral: true });
            }
            if (id === "stop_java") {
                const s = javaSessions.get(uid);
                if (!s) return i.reply({ content: "❌ No Java bot running.", ephemeral: true });
                s.manualStop = true;
                destroySession(uid, 'java');
                return i.reply({ content: "⏹ **Stopping Java Bot...**", ephemeral: true });
            }

            // SETTINGS MODALS
            if (id === "set_bedrock") {
                const u = getUser(uid);
                const m = new ModalBuilder().setCustomId("modal_bedrock").setTitle("Bedrock Settings");
                const ip = new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "").setRequired(true);
                const port = new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132));
                const user = new TextInputBuilder().setCustomId("off").setLabel("Offline Username").setStyle(TextInputStyle.Short).setValue(u.offlineUsername || "");
                m.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port), new ActionRowBuilder().addComponents(user));
                return i.showModal(m);
            }
            if (id === "set_java") {
                const u = getUser(uid);
                const m = new ModalBuilder().setCustomId("modal_java").setTitle("Java Settings");
                const ip = new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.java.server?.ip || "").setRequired(true);
                const port = new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.java.server?.port || 25565));
                const user = new TextInputBuilder().setCustomId("user").setLabel("Username").setStyle(TextInputStyle.Short).setValue(u.java.offlineUsername || "");
                m.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port), new ActionRowBuilder().addComponents(user));
                return i.showModal(m);
            }

            // AUTH
            if (id === "link") return handleLink(uid, i);
            if (id === "unlink") { unlinkMicrosoft(uid); return i.reply({ content: "🗑 Unlinked.", ephemeral: true }); }
            
            // TECH MENUS
            if (id === "tech_bedrock") return i.reply({ content: "🛠 **Bedrock Technical**", components: [getTechMenu('bedrock')], ephemeral: true });
            if (id === "tech_java") return i.reply({ content: "🛠 **Java Technical**", components: [getTechMenu('java')], ephemeral: true });
            
            if (id === "admin_refresh" && uid === ADMIN_ID) {
                i.deferUpdate();
                updateAdminDashboard();
            }
        }

        // --- MENUS ---
        if (i.isStringSelectMenu()) {
            // Version Selectors
            if (i.customId === "sel_java_ver") {
                const u = getUser(uid);
                u.java.selectedVersion = i.values[0];
                saveDatabase();
                // Update the pre-flight UI
                const verRow = getVersionSelector('java', i.values[0]);
                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`start_java`).setLabel("✅ Connect Now").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );
                return i.update({ components: [verRow, confirmRow] });
            }
            if (i.customId === "sel_bed_ver") {
                const u = getUser(uid);
                u.bedrockVersion = i.values[0];
                saveDatabase();
                const verRow = getVersionSelector('bedrock', i.values[0]);
                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`start_bedrock`).setLabel("✅ Connect Now").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );
                return i.update({ components: [verRow, confirmRow] });
            }
            
            // Technical Actions
            if (i.customId === "act_bedrock" || i.customId === "act_java") {
                const isJava = i.customId === "act_java";
                const s = isJava ? javaSessions.get(uid) : sessions.get(uid);
                
                if (!s || !s.connected) return i.reply({ content: "❌ Bot not connected.", ephemeral: true });
                
                const val = i.values[0];
                if (val === "coords") {
                    let pos = isJava ? s.bot?.entity?.position : s.pos;
                    if (!pos) pos = { x: 0, y: 0, z: 0 };
                    return i.reply({ content: `📍 **Position:** ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}`, ephemeral: true });
                }
                if (val === "reconnect") {
                    // Force restart via disconnect logic
                    if (isJava) s.bot.end(); else s.client.close();
                    return i.reply({ content: "🔄 **Restarting session...**", ephemeral: true });
                }
                if (val === "cmd") {
                    const m = new ModalBuilder().setCustomId(`cmd_${isJava ? 'java' : 'bed'}`).setTitle("Send Command");
                    const inp = new TextInputBuilder().setCustomId("txt").setLabel("Command (no /)").setStyle(TextInputStyle.Short).setRequired(true);
                    m.addComponents(new ActionRowBuilder().addComponents(inp));
                    return i.showModal(m);
                }
            }
        }

        // --- MODAL SUBMITS ---
        if (i.isModalSubmit()) {
            if (i.customId === "modal_bedrock") {
                const u = getUser(uid);
                u.server = { ip: i.fields.getTextInputValue("ip"), port: parseInt(i.fields.getTextInputValue("port")) };
                u.offlineUsername = i.fields.getTextInputValue("off");
                saveDatabase();
                return i.reply({ content: "✅ Bedrock settings saved.", ephemeral: true });
            }
            if (i.customId === "modal_java") {
                const u = getUser(uid);
                u.java.server = { ip: i.fields.getTextInputValue("ip"), port: parseInt(i.fields.getTextInputValue("port")) };
                u.java.offlineUsername = i.fields.getTextInputValue("user");
                saveDatabase();
                return i.reply({ content: "✅ Java settings saved.", ephemeral: true });
            }
            if (i.customId.startsWith("cmd_")) {
                const isJava = i.customId === "cmd_java";
                const s = isJava ? javaSessions.get(uid) : sessions.get(uid);
                const cmd = i.fields.getTextInputValue("txt");
                
                if (s) {
                    if (isJava && s.bot) s.bot.chat(`/${cmd}`);
                    if (!isJava && s.client) s.client.write("command_request", { command: `/${cmd}`, origin: { type: 0, uuid: "", request_id: "", player_entity_id: undefined }, internal: false, version: 52 });
                    return i.reply({ content: `📤 Sent: /${cmd}`, ephemeral: true });
                }
                return i.reply({ content: "❌ Session lost.", ephemeral: true });
            }
        }

    } catch (err) {
        console.error("Interaction Error:", err);
    }
});

// ----------------- HELPERS -----------------

function getTechMenu(type) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(type === 'java' ? "act_java" : "act_bedrock")
            .setPlaceholder("Select Action")
            .addOptions(
                { label: "View Coordinates", value: "coords" },
                { label: "Send Command", value: "cmd" },
                { label: "Force Reconnect", value: "reconnect" }
            )
    );
}

async function handleLink(uid, interaction) {
    if (pendingAuth.has(uid)) return interaction.reply({ content: "⏳ Auth already pending.", ephemeral: true });
    
    const flow = new Authflow(uid, getUserAuthDir(uid), { flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo" }, async (res) => {
        const link = res.verification_uri_complete || res.verification_uri;
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Login to Microsoft").setStyle(ButtonStyle.Link).setURL(link));
        interaction.editReply({ content: `🔐 **Code:** \`${res.user_code}\``, components: [row] }).catch(()=>{});
    });

    await interaction.deferReply({ ephemeral: true });
    pendingAuth.set(uid, true);

    try {
        await flow.getMsaToken();
        const u = getUser(uid);
        u.linked = true;
        saveDatabase();
        interaction.followUp({ content: "✅ **Linked Successfully!**", ephemeral: true });
    } catch (e) {
        interaction.followUp({ content: `❌ Auth Failed: ${e.message}`, ephemeral: true });
    } finally {
        pendingAuth.delete(uid);
    }
}

// Admin Dashboard Generator
async function generateAdminData() {
    const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const embed = new EmbedBuilder().setTitle("🛡️ Admin Panel").setColor(0xFF0000)
        .setDescription(`**RAM:** ${mem}MB | **Bedrock:** ${sessions.size} | **Java:** ${javaSessions.size}`);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("admin_refresh").setLabel("Refresh").setStyle(ButtonStyle.Primary));
    return { embeds: [embed], components: [row] };
}
async function updateAdminDashboard() {
    if (adminDashboardMessage) adminDashboardMessage.edit(await generateAdminData()).catch(() => adminDashboardMessage = null);
}

// ----------------- STARTUP -----------------
client.once("ready", async () => {
    console.log(`🟢 Bot Online: ${client.user.tag}`);
    client.application.commands.set([
        new SlashCommandBuilder().setName("panel").setDescription("Bedrock Panel"),
        new SlashCommandBuilder().setName("java").setDescription("Java Panel"),
        new SlashCommandBuilder().setName("admin").setDescription("Admin Panel")
    ]);
});

process.on("uncaughtException", (e) => console.error("Uncaught:", e));
process.on("unhandledRejection", (e) => console.error("Unhandled:", e));

client.login(DISCORD_TOKEN);

