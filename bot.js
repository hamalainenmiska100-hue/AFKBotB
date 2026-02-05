/**
 * AFKBot Panel 🎛️
 * Removed 'My Status'. Fixed Settings Modal.
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
        .setDescription("Control your personal AFK client.\n\n**Note:** If you link your account, the bot joins as YOU.\nIf you unlink, it joins as a random offline bot.")
        .setColor(0x2B2D31)
        .setFooter({ text: "Bedrock Edition • Supports Geyser Servers" });

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("start").setLabel("Start Client").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("stop").setLabel("Stop Client").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("settings").setLabel("Configure").setStyle(ButtonStyle.Secondary).setEmoji("⚙️")
    );

    // Removed "My Status" button as requested
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("link").setLabel("Link Account").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("unlink").setLabel("Unlink / Reset").setStyle(ButtonStyle.Danger)
    );

    return { embeds: [embed], components: [row1, row2] };
}

// --- MINECRAFT LOGIC ---

async function startBot(uid, interaction = null, isReconnect = false) {
    const user = getUser(uid);

    if (!isReconnect && interaction) {
        if (sessions.has(uid)) return interaction.reply({ content: "⚠️ **Bot is already running!**", ephemeral: true });
        if (!user.ip) return interaction.reply({ content: "❌ IP missing. Click **Configure**.", ephemeral: true });
        await interaction.reply({ content: `🚀 **Connecting to** \`${user.ip}:${user.port}\`...`, ephemeral: true });
    }

    // Ping Check
    try {
        if (isReconnect) console.log(`[${uid}] Reconnecting...`);
        await bedrock.ping({ host: user.ip, port: parseInt(user.port), skipPing: false, connectTimeout: 5000 });
    } catch (e) {
        const msg = `❌ **Connection Failed!** Server \`${user.ip}\` is offline or unreachable.`;
        if (!isReconnect && interaction) interaction.editReply({ content: msg });
        else notifyUser(uid, msg);
        
        if (sessions.has(uid)) sessions.delete(uid);
        return;
    }

    // Connect
    const options = {
        host: user.ip,
        port: parseInt(user.port),
        connectTimeout: 30000,
        skipPing: true,
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

        bedrockClient.on('spawn', () => {
            const status = user.onlineMode ? "Online Account" : `Offline: ${user.username}`;
            if (!isReconnect && interaction) {
                interaction.editReply({ content: `✅ **Connected!**\n👤 User: \`${status}\`\n🌍 Server: \`${user.ip}\`` });
            } else if (isReconnect) {
                notifyUser(uid, `♻️ **Reconnected** to \`${user.ip}\`!`);
            }
            
            session.afkInt = setInterval(() => {
                if(bedrockClient) {
                    try {
                        const yaw = (Date.now() % 360);
                        bedrockClient.write('player_auth_input', { pitch:0, yaw:yaw, position:{x:0,y:0,z:0}, input_mode:'mouse' });
                    } catch(e){}
                }
            }, 10000);
        });

        bedrockClient.on('error', (e) => { console.log(e.message); });
        bedrockClient.on('close', () => handleDisconnect(uid));
        bedrockClient.on('kick', (p) => { 
            if (!isReconnect && interaction) interaction.followUp({ content: `🛑 **Kicked:** ${p.message}`, ephemeral: true });
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
        notifyUser(uid, `⚠️ **Lost Connection.** Rejoining in 20s...`);
        setTimeout(() => {
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
        if (i.isChatInputCommand() && i.commandName === "panel") {
            return i.reply(getStaticPanel());
        }

        if (i.isButton()) {
            if (i.customId === "start") return startBot(uid, i, false);
            
            if (i.customId === "stop") {
                const stopped = stopBot(uid);
                return i.reply({ content: stopped ? "⏹ **Bot Stopped.**" : "⚠️ **No bot running.**", ephemeral: true });
            }

            // --- CONFIG BUTTON ---
            if (i.customId === "settings") {
                const u = getUser(uid);
                const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Bot Configuration");
                
                const ipInput = new TextInputBuilder()
                    .setCustomId("ip")
                    .setLabel("Server IP")
                    .setStyle(TextInputStyle.Short)
                    .setValue(u.ip || "")
                    .setRequired(true);

                const portInput = new TextInputBuilder()
                    .setCustomId("port")
                    .setLabel("Port")
                    .setStyle(TextInputStyle.Short)
                    .setValue(String(u.port || "19132"))
                    .setRequired(true);

                const userInput = new TextInputBuilder()
                    .setCustomId("user")
                    .setLabel("Offline Username")
                    .setStyle(TextInputStyle.Short)
                    .setValue(u.username || "Bot_User")
                    .setRequired(true);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(ipInput),
                    new ActionRowBuilder().addComponents(portInput),
                    new ActionRowBuilder().addComponents(userInput)
                );
                
                return i.showModal(modal);
            }

            if (i.customId === "link") return handleLink(uid, i);
            
            if (i.customId === "unlink") {
                const u = getUser(uid);
                u.linked = false;
                u.onlineMode = false;
                saveUsers();

                const authPath = path.join(CONFIG.PATHS.AUTH, uid);
                try {
                    if (fs.existsSync(authPath)) {
                        fs.rmSync(authPath, { recursive: true, force: true });
                    }
                } catch(e) { console.error("Failed to delete tokens:", e); }

                return i.reply({ content: "🗑️ **Unlinked!** Tokens deleted. Bot will now join as Offline User.", ephemeral: true });
            }
        }

        if (i.isModalSubmit() && i.customId === "settings_modal") {
            const u = getUser(uid);
            u.ip = i.fields.getTextInputValue("ip");
            u.port = i.fields.getTextInputValue("port");
            u.username = i.fields.getTextInputValue("user");
            saveUsers();
            return i.reply({ content: `✅ **Settings Saved!**\nTarget: \`${u.ip}:${u.port}\``, ephemeral: true });
        }

    } catch (e) { console.error(e); }
});

// --- AUTH LOGIC FIX ---
async function handleLink(uid, i) {
    if (pendingAuth.has(uid)) return i.reply({ content: "Auth already in progress.", ephemeral: true });
    
    await i.deferReply({ ephemeral: true });
    pendingAuth.add(uid);

    // Clear old tokens
    try {
        const authPath = path.join(CONFIG.PATHS.AUTH, uid);
        if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
    } catch(e) {}

    const flow = new Authflow(uid, path.join(CONFIG.PATHS.AUTH, uid), { 
        flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo" 
    }, async (res) => {
        const link = res.verification_uri_complete || res.verification_uri || "https://microsoft.com/link";
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel("Login to Microsoft").setStyle(ButtonStyle.Link).setURL(link)
        );

        i.editReply({ 
            content: `**Action Required:**\n1. Click the button below.\n2. Enter code: \`${res.user_code}\`\n3. Wait here...`,
            components: [row]
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


