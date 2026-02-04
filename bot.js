/**
 * AFKBot Panel 🎛️
 * Static Launcher Edition.
 * UI is static, all actions are ephemeral per user.
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
    EmbedBuilder
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// --- CONFIGURATION ---
const CONFIG = {
    TOKEN: process.env.DISCORD_TOKEN,
    ADMIN_ID: "1144987924123881564",
    PATHS: {
        DATA: path.join(__dirname, "data"),
        AUTH: path.join(__dirname, "data", "auth"),
        USERS: path.join(__dirname, "data", "users.json")
    }
};

if (!CONFIG.TOKEN) {
    console.error("❌ Error: DISCORD_TOKEN is missing.");
    process.exit(1);
}

// Ensure Storage
if (!fs.existsSync(CONFIG.PATHS.DATA)) fs.mkdirSync(CONFIG.PATHS.DATA);
if (!fs.existsSync(CONFIG.PATHS.AUTH)) fs.mkdirSync(CONFIG.PATHS.AUTH, { recursive: true });

// --- DATA MANAGER ---
let users = {};
try {
    users = fs.existsSync(CONFIG.PATHS.USERS) ? JSON.parse(fs.readFileSync(CONFIG.PATHS.USERS, "utf8")) : {};
} catch (e) { users = {}; }

function saveUsers() {
    fs.writeFile(CONFIG.PATHS.USERS, JSON.stringify(users, null, 2), () => {});
}

function getUser(uid) {
    if (!users[uid]) {
        users[uid] = {
            ip: null,
            port: 19132,
            username: `Bot_${uid.slice(-4)}`,
            onlineMode: false,
            linked: false
        };
        saveUsers();
    }
    return users[uid];
}

// --- BOT SESSIONS ---
const sessions = new Map();
const pendingAuth = new Set();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- UI GENERATOR (STATIC) ---
function getStaticPanel() {
    const embed = new EmbedBuilder()
        .setTitle("AFKBot Launcher 🚀")
        .setDescription("Click buttons below to control your personal AFK client.\nAll interactions are private.")
        .setColor(0x2B2D31)
        .setFooter({ text: "Bedrock Edition • Supports Geyser Servers" });

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("start").setLabel("Start Client").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("stop").setLabel("Stop Client").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("settings").setLabel("Configure").setStyle(ButtonStyle.Secondary).setEmoji("⚙️")
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("link").setLabel("Link Account").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("unlink").setLabel("Unlink").setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row1, row2] };
}

// --- MINECRAFT LOGIC ---

async function startBot(uid, interaction = null, isReconnect = false) {
    const user = getUser(uid);

    // Prevent double start via UI
    if (!isReconnect && interaction) {
        if (sessions.has(uid)) {
            return interaction.reply({ content: "⚠️ **Bot is already running!** Stop it first.", ephemeral: true });
        }
        if (!user.ip) {
            return interaction.reply({ content: "❌ IP address is missing. Click **Configure**.", ephemeral: true });
        }
        // Initial feedback
        await interaction.reply({ content: `🚀 **Connecting to** \`${user.ip}:${user.port}\`...`, ephemeral: true });
    }

    // --- MOTD CHECK (Server Status) ---
    try {
        if (isReconnect) console.log(`[${uid}] Auto-reconnecting...`);
        // Ping with short timeout
        await bedrock.ping({ host: user.ip, port: parseInt(user.port), skipPing: false, connectTimeout: 5000 });
    } catch (e) {
        const errorMsg = `❌ **Connection Failed!**\nTarget: \`${user.ip}:${user.port}\`\nReason: Server offline or unreachable.`;
        
        if (!isReconnect && interaction) {
            interaction.editReply({ content: errorMsg });
        } else {
            notifyUser(uid, errorMsg);
        }
        
        // Don't retry if server is dead during initial connect
        if (sessions.has(uid)) sessions.delete(uid);
        return;
    }

    // --- CONNECTION ---
    const options = {
        host: user.ip,
        port: parseInt(user.port),
        connectTimeout: 30000,
        skipPing: true, // We already pinged
        offline: !user.onlineMode,
        username: !user.onlineMode ? user.username : undefined,
        profilesFolder: user.onlineMode ? path.join(CONFIG.PATHS.AUTH, uid) : undefined,
        conLog: () => {} 
    };

    try {
        const bedrockClient = bedrock.createClient(options);
        
        const session = {
            client: bedrockClient,
            afkInt: null,
            manualStop: false
        };
        sessions.set(uid, session);

        // --- EVENTS ---

        bedrockClient.on('spawn', () => {
            console.log(`[${uid}] Spawned`);
            
            if (!isReconnect && interaction) {
                interaction.editReply({ content: `✅ **Connected!**\nUser: \`${options.username || 'Online'}\`\nServer: \`${user.ip}\`` });
            } else if (isReconnect) {
                notifyUser(uid, `♻️ **Reconnected** successfully to \`${user.ip}\`!`);
            }
            
            // AFK Loop
            session.afkInt = setInterval(() => {
                if(bedrockClient) {
                    try {
                        const yaw = (Date.now() % 360);
                        bedrockClient.write('player_auth_input', { pitch:0, yaw:yaw, position:{x:0,y:0,z:0}, input_mode:'mouse' });
                    } catch(e){}
                }
            }, 10000);
        });

        bedrockClient.on('error', (e) => {
            console.log(`[${uid}] Error: ${e.message}`);
        });

        bedrockClient.on('close', () => {
            console.log(`[${uid}] Closed`);
            handleDisconnect(uid);
        });

        bedrockClient.on('kick', (packet) => {
             console.log(`[${uid}] Kicked: ${packet.message}`);
        });

    } catch (e) {
        if (!isReconnect && interaction) interaction.editReply({ content: `❌ **Init Error:** ${e.message}` });
    }
}

function handleDisconnect(uid) {
    const session = sessions.get(uid);
    if (!session) return;

    if (session.afkInt) clearInterval(session.afkInt);

    if (session.manualStop) {
        sessions.delete(uid);
    } else {
        // Auto-Rejoin Logic
        notifyUser(uid, `⚠️ **Connection Lost.** Rejoining in 20s...`);
        
        setTimeout(() => {
            // Ensure user didn't stop it during the wait
            if (sessions.has(uid) && !sessions.get(uid).manualStop) {
                startBot(uid, null, true);
            }
        }, 20000);
    }
}

function stopBot(uid) {
    const session = sessions.get(uid);
    if (session) {
        session.manualStop = true;
        if (session.afkInt) clearInterval(session.afkInt);
        try { session.client.close(); } catch(e){}
        sessions.delete(uid);
        return true;
    }
    return false;
}

function notifyUser(uid, msg) {
    client.users.fetch(uid).then(u => u.send(msg)).catch(()=>{});
}

// --- DISCORD EVENTS ---

client.once(Events.ClientReady, () => {
    console.log(`Bot Online: ${client.user.tag}`);
    client.application.commands.set([
        new SlashCommandBuilder().setName("panel").setDescription("Show Launcher")
    ]);
});

client.on(Events.InteractionCreate, async (i) => {
    const uid = i.user.id;

    try {
        // Command
        if (i.isChatInputCommand() && i.commandName === "panel") {
            return i.reply(getStaticPanel());
        }

        // Buttons
        if (i.isButton()) {
            if (i.customId === "start") return startBot(uid, i, false);
            
            if (i.customId === "stop") {
                const stopped = stopBot(uid);
                if (stopped) {
                    return i.reply({ content: "⏹ **Bot Stopped.** Auto-rejoin disabled.", ephemeral: true });
                } else {
                    return i.reply({ content: "⚠️ **No bot running.**", ephemeral: true });
                }
            }

            if (i.customId === "settings") {
                const u = getUser(uid);
                const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Bot Configuration");
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.ip || "").setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.port)).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user").setLabel("Offline Username").setStyle(TextInputStyle.Short).setValue(u.username).setRequired(true))
                );
                return i.showModal(modal);
            }

            if (i.customId === "link") return handleLink(uid, i);
            
            if (i.customId === "unlink") {
                const u = getUser(uid);
                u.linked = false;
                u.onlineMode = false;
                saveUsers();
                return i.reply({ content: "✅ **Unlinked.** Bot is now in Offline Mode.", ephemeral: true });
            }
        }

        // Modals
        if (i.isModalSubmit() && i.customId === "settings_modal") {
            const u = getUser(uid);
            u.ip = i.fields.getTextInputValue("ip");
            u.port = i.fields.getTextInputValue("port");
            u.username = i.fields.getTextInputValue("user");
            saveUsers();
            return i.reply({ content: `✅ **Settings Saved!**\nTarget: \`${u.ip}:${u.port}\``, ephemeral: true });
        }

    } catch (e) {
        console.error(e);
    }
});

// Auth Logic
async function handleLink(uid, i) {
    if (pendingAuth.has(uid)) return i.reply({ content: "Auth already in progress.", ephemeral: true });
    
    await i.deferReply({ ephemeral: true });
    pendingAuth.add(uid);

    const flow = new Authflow(uid, path.join(CONFIG.PATHS.AUTH, uid), { 
        flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo" 
    }, async (res) => {
        i.editReply({ 
            content: `**To Link:**\n1. Click [Here](${res.verification_uri_complete})\n2. Code: \`${res.user_code}\`\n3. Wait here...` 
        });
    });

    try {
        await flow.getMsaToken();
        const u = getUser(uid);
        u.linked = true;
        u.onlineMode = true;
        saveUsers();
        i.followUp({ content: "✅ **Success!** Account linked.", ephemeral: true });
    } catch(e) {
        i.followUp({ content: "❌ **Auth Failed:** " + e.message, ephemeral: true });
    } finally {
        pendingAuth.delete(uid);
    }
}

client.login(CONFIG.TOKEN);


