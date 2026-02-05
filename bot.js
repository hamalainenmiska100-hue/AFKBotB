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
const pendingAuth = new Map();  // Auth flows

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

// ----------------- NOTIFICATION SYSTEM -----------------
async function notifyUser(uid, message) {
    try {
        const user = await client.users.fetch(uid);
        await user.send(message);
    } catch (e) {
        console.log(`Failed to send DM to ${uid} (DMs likely closed).`);
    }
}

// ----------------- SESSION MANAGEMENT (OPTIMIZED) -----------------

/**
 * Completely destroys a session to prevent memory leaks.
 * Clears timers, closes connections, and removes from map.
 */
function destroySession(uid) {
    const s = sessions.get(uid);
    
    if (!s) return;

    // 1. Clear Timers
    if (s.afkInterval) clearInterval(s.afkInterval);
    if (s.uptimeInterval) clearInterval(s.uptimeInterval);
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);

    // 2. Close Connections
    try {
        if (s.client) {
            s.client.close();
            s.client.removeAllListeners();
        }
    } catch (e) {
        console.error(`Error closing session for ${uid}:`, e.message);
    }

    // 3. Delete from Memory
    sessions.delete(uid);
    console.log(`[BEDROCK] Session destroyed for ${uid}`);
}

// ----------------- BEDROCK ENGINE -----------------

async function startBedrock(uid, interaction, versionOverride) {
    const u = getUser(uid);
    if (!u.server) return interaction.reply({ content: "❌ No server set! Go to Settings.", ephemeral: true });
    
    // 1. SESSION LOCK: Check if already running
    if (sessions.has(uid)) {
        return interaction.reply({ 
            content: "❌ **Session Active:** Please terminate your old session before starting a new bot.", 
            ephemeral: true 
        });
    }

    const authDir = getUserAuthDir(uid);
    const { ip, port } = u.server;

    // 2. MOTD CHECK: Ping server before joining
    await interaction.update({ content: `🔎 **Pinging ${ip}:${port}...**`, components: [], embeds: [] });

    try {
        // Attempt to ping with a 5-second timeout
        await bedrock.ping({ host: ip, port: port, timeout: 5000 });
        await interaction.editReply({ content: `✅ **Server Found! Joining...**` });
    } catch (e) {
        return interaction.editReply({ content: `❌ **Connection Failed:** Server is offline or unreachable.\nReason: ${e.message || "Timeout"}` });
    }

    const options = {
        host: ip,
        port: port,
        connectTimeout: 30000, // Explicit 30s timeout
        skipPing: true,        // We already pinged above
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
    let botClient;
    try {
        botClient = bedrock.createClient(opts);
    } catch (e) {
        if (interaction) interaction.followUp({ content: `❌ Init Error: ${e.message}`, ephemeral: true });
        return;
    }

    const session = {
        client: botClient,
        connected: false,
        startTime: Date.now(),
        manualStop: false,
        opts: opts, // Save options for auto-rejoin
        pos: { x: 0, y: 0, z: 0 },
        congratsHours: 0
    };
    sessions.set(uid, session);

    botClient.on('spawn', () => {
        session.connected = true;
        console.log(`[BEDROCK] ${uid} spawned on ${opts.host}`);
        if (interaction) interaction.followUp({ content: `✅ **Connected to ${opts.host}!**`, ephemeral: true });
        
        // Critical Notification
        notifyUser(uid, `🚀 **Bot Connected!**\nYour bot has successfully joined **${opts.host}**.`);
        
        startAfkLogic(uid, session);
    });

    botClient.on('error', (err) => {
        console.log(`[BEDROCK ERR] ${uid}:`, err.message);
    });

    botClient.on('kick', (reason) => {
        notifyUser(uid, `⚠️ **Bot Kicked!**\nServer kicked the bot. Reason: \`${reason}\``);
    });

    botClient.on('close', () => {
        handleDisconnect(uid, session);
    });

    // Handle Auth Input (Movement updates)
    botClient.on('move_player', (packet) => {
        if (packet.runtime_id === botClient.entityId) session.pos = packet.position;
    });
}

// ----------------- SHARED LOGIC -----------------

function startAfkLogic(uid, session) {
    // 1. Movement Interval (Anti-AFK)
    session.afkInterval = setInterval(() => {
        try {
            if (session.client) {
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
        notifyUser(uid, `🎉 **Status Update:** Your bot has been online for **${session.congratsHours} hours**! Keep it up! 🚀`);
    }, 3600 * 1000);
}

function handleDisconnect(uid, session) {
    // Clear intervals immediately
    if (session.afkInterval) clearInterval(session.afkInterval);
    if (session.uptimeInterval) clearInterval(session.uptimeInterval);

    if (session.manualStop) {
        // User asked to stop -> Destroy everything
        notifyUser(uid, `⏹ **Bot Stopped.**\nYou manually terminated the session.`);
        destroySession(uid);
    } else {
        // Crash/Kick -> Reconnect
        console.log(`[BEDROCK] Disconnected ${uid}. Reconnecting in 30s...`);
        notifyUser(uid, `⚠️ **Disconnected!**\nConnection lost. Attempting to auto-reconnect in 30 seconds...`);
        
        // Store reconnect timer in session so we can cancel it if user clicks stop during wait
        session.reconnectTimer = setTimeout(() => {
            // Double check if user stopped it during the wait
            if (sessions.has(uid) && !sessions.get(uid).manualStop) {
                console.log(`[BEDROCK] Reconnecting ${uid} now...`);
                // Recursive restart
                createBedrockInstance(uid, session.opts, null);
            } else {
                destroySession(uid);
            }
        }, 30000);
    }
}

// ----------------- UI BUILDERS -----------------

function getVersionSelector(current) {
    // Bedrock Versions
    const bv = [
        { label: "Auto-Detect (Best)", value: "auto" },
        { label: "1.21.60", value: "1.21.60" }, { label: "1.21.50", value: "1.21.50" },
        { label: "1.21.40", value: "1.21.40" }, { label: "1.21.20", value: "1.21.20" },
        { label: "1.21.0", value: "1.21.0" }, { label: "1.20.80", value: "1.20.80" }
    ];

    const list = bv;
    // Validate selection
    const safeCurrent = list.find(x => x.value === current) ? current : "auto";

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId("sel_bed_ver")
            .setPlaceholder(`Selected: ${safeCurrent}`)
            .addOptions(list.map(v => ({ label: v.label, value: v.value, default: v.value === safeCurrent })))
    );
}

function getPanel() {
    // Clean, minimalistic buttons - TECHNICAL REMOVED
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("pre_bedrock").setLabel("▶ Start").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("stop_bedrock").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Xbox").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("unlink").setLabel("⛓ Unlink").setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("set_bedrock").setLabel("⚙ Settings").setStyle(ButtonStyle.Primary)
        )
    ];
}

// ----------------- INTERACTION HANDLER -----------------

client.on(Events.InteractionCreate, async (i) => {
    // 1. Guild Security Check
    if (i.guildId && !ALLOWED_GUILDS.includes(i.guildId)) return;
    
    const uid = i.user.id;

    try {
        // --- COMMANDS ---
        if (i.isChatInputCommand()) {
            if (i.commandName === "panel") return i.reply({ content: "**Bedrock Bot Panel 🤖**", components: getPanel() });
        }

        // --- BUTTONS ---
        if (i.isButton()) {
            const id = i.customId;

            // PRE-FLIGHT (Start Checks)
            if (id === "pre_bedrock") {
                // Pre-check: Session Lock (Visual check only, real check in startBedrock)
                if (sessions.has(uid)) {
                    return i.reply({ content: "❌ **Session Active:** Please terminate your old session before starting a new bot.", ephemeral: true });
                }

                const u = getUser(uid);
                
                // Config Check
                const serverData = u.server;
                if (!serverData) return i.reply({ content: "❌ **Configuration Missing!** Please click 'Settings' first.", ephemeral: true });

                const ver = u.bedrockVersion;
                const verRow = getVersionSelector(ver);
                
                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`start_bedrock`).setLabel("✅ Connect Now").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );

                return i.reply({ 
                    content: `**Pre-Flight Check (Bedrock)**\nTarget: \`${serverData.ip}:${serverData.port}\`\n\n*Does this look correct? Select version if auto-detect fails.*`,
                    components: [verRow, confirmRow], 
                    ephemeral: true 
                });
            }

            // START SIGNALS
            if (id === "start_bedrock") return startBedrock(uid, i, getUser(uid).bedrockVersion || "auto");
            
            if (id === "cancel") return i.update({ content: "❌ Cancelled.", components: [], embeds: [] });

            // STOPS
            if (id === "stop_bedrock") {
                const s = sessions.get(uid);
                if (!s) return i.reply({ content: "❌ No Bedrock bot running.", ephemeral: true });
                s.manualStop = true;
                destroySession(uid);
                return i.reply({ content: "⏹ **Stopping Bedrock Bot...**", ephemeral: true });
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

            // AUTH
            if (id === "link") return handleLink(uid, i);
            if (id === "unlink") { unlinkMicrosoft(uid); return i.reply({ content: "🗑 Unlinked.", ephemeral: true }); }
            
        }

        // --- MENUS ---
        if (i.isStringSelectMenu()) {
            // Version Selectors
            if (i.customId === "sel_bed_ver") {
                const u = getUser(uid);
                u.bedrockVersion = i.values[0];
                saveDatabase();
                const verRow = getVersionSelector(i.values[0]);
                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`start_bedrock`).setLabel("✅ Connect Now").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );
                return i.update({ components: [verRow, confirmRow] });
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
        }

    } catch (err) {
        console.error("Interaction Error:", err);
    }
});

// ----------------- HELPERS -----------------

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

// ----------------- STARTUP -----------------
client.once("ready", async () => {
    console.log(`🟢 Bot Online: ${client.user.tag}`);
    client.application.commands.set([
        new SlashCommandBuilder().setName("panel").setDescription("Bedrock Panel")
    ]);
});

process.on("uncaughtException", (e) => console.error("Uncaught:", e));
process.on("unhandledRejection", (e) => console.error("Unhandled:", e));

client.login(DISCORD_TOKEN);


