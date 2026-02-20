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

// ==================== CONFIG ====================
const ALLOWED_IDS = ["1310851800751931463", "1144987924123881564"];
const DATA_DIR = path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const USERS_FILE = path.join(DATA_DIR, "users.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// ==================== STORAGE ====================
const loadUsers = () => {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } 
    catch { return {}; }
};
const saveUsers = (data) => fs.writeFileSync(USERS_FILE, JSON.stringify(data));

let users = loadUsers();
const sessions = new Map(); // uid -> {client, entityId, afkTimer, reconnectTimer, manualStop}

// ==================== CLIENT ====================
const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    presence: { status: 'online', activities: [{ name: 'AFK', type: ActivityType.Watching }] },
    makeCache: Options.cacheWithLimits({
        MessageManager: 0,
        PresenceManager: 0,
        GuildMemberManager: 10,
        UserManager: 10,
    }),
});

// ==================== HELPERS ====================
const isAllowed = (id) => ALLOWED_IDS.includes(id);
const getUser = (uid) => {
    if (!users[uid]) users[uid] = { server: null };
    return users[uid];
};
const getAuthDir = (uid) => {
    const dir = path.join(AUTH_DIR, uid);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
};
const reply = async (i, content) => {
    try {
        const payload = typeof content === 'string' ? { content } : content;
        if (i.replied || i.deferred) await i.editReply(payload).catch(() => {});
        else await i.reply({ ...payload, flags: [MessageFlags.Ephemeral] }).catch(() => {});
    } catch {}
};

// ==================== PANEL ====================
const panelButtons = () => [
    new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("link").setLabel("🔑 Link").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("start").setLabel("▶ Start").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("settings").setLabel("⚙ Set").setStyle(ButtonStyle.Secondary)
    )
];

// ==================== AUTH ====================
const pendingAuth = new Map();

const linkAccount = async (uid, interaction) => {
    if (pendingAuth.has(uid)) return reply(interaction, "Already linking...");
    
    const authDir = getAuthDir(uid);
    pendingAuth.set(uid, true);
    
    const flow = new Authflow(uid, authDir, { 
        flow: "live", 
        authTitle: Titles?.MinecraftNintendoSwitch || "Minecraft",
        deviceType: "Nintendo" 
    }, async (data) => {
        const code = data?.user_code;
        const url = data?.verification_uri_complete || "https://www.microsoft.com/link";
        await interaction.editReply({ 
            content: `Code: \`${code}\`\n${url}`,
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel("Open").setStyle(ButtonStyle.Link).setURL(url)
            )]
        }).catch(() => {});
    });

    flow.getMsaToken()
        .then(() => {
            getUser(uid).linked = true;
            saveUsers(users);
            pendingAuth.delete(uid);
            interaction.followUp({ content: "✅ Linked", flags: [MessageFlags.Ephemeral] }).catch(() => {});
        })
        .catch((e) => {
            pendingAuth.delete(uid);
            interaction.editReply({ content: `❌ ${e.message}` }).catch(() => {});
        });
    
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
};

const unlinkAccount = (uid) => {
    const dir = getAuthDir(uid);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    getUser(uid).linked = false;
    saveUsers(users);
    return "🗑 Unlinked";
};

// ==================== SESSION WITH AUTO-RECONNECT ====================
const cleanup = (uid, keepEntry = false) => {
    const s = sessions.get(uid);
    if (!s) return;
    if (s.afkTimer) clearInterval(s.afkTimer);
    if (!keepEntry) {
        if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
        sessions.delete(uid);
    }
    try { s.client?.close(); } catch {}
    if (keepEntry) {
        s.client = null;
        s.entityId = null;
    }
};

const startSession = async (uid, interaction = null) => {
    // Check if already connected
    const existing = sessions.get(uid);
    if (existing?.client) {
        if (interaction) reply(interaction, "Already connected!");
        return;
    }
    
    const u = getUser(uid);
    if (!u.server?.ip) {
        if (interaction) reply(interaction, "Set server first!");
        return;
    }
    
    if (interaction) await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    
    const { ip, port = 19132 } = u.server;
    console.log(`[${uid}] Starting session on ${ip}:${port}`);
    
    try {
        const mc = bedrock.createClient({
            host: ip,
            port: parseInt(port),
            username: uid,
            profilesFolder: getAuthDir(uid),
            offline: false,
            skipPing: true,
            viewDistance: 1,
        });
        
        // Get or create session entry
        let session = sessions.get(uid);
        if (!session) {
            session = { manualStop: false };
            sessions.set(uid, session);
        }
        
        // Clear any pending reconnect
        if (session.reconnectTimer) {
            clearTimeout(session.reconnectTimer);
            session.reconnectTimer = null;
        }
        
        session.client = mc;
        session.manualStop = false; // Reset flag on successful start
        
        mc.on("start_game", (packet) => {
            session.entityId = packet.runtime_entity_id;
            console.log(`[${uid}] Connected`);
            if (interaction) reply(interaction, `🟢 Online on ${ip}`);
            
            // AFK loop
            session.afkTimer = setInterval(() => {
                try {
                    mc.write('animate', { action_id: 1, runtime_entity_id: session.entityId });
                } catch {}
            }, 10000);
        });
        
        mc.on("close", () => {
            console.log(`[${uid}] Disconnected`);
            // Only reconnect if not manually stopped
            if (!session.manualStop) {
                console.log(`[${uid}] Reconnecting in 30s...`);
                cleanup(uid, true); // Keep entry, clear timers
                session.reconnectTimer = setTimeout(() => {
                    if (!session.manualStop) startSession(uid);
                }, 30000);
            } else {
                cleanup(uid);
            }
        });
        
        mc.on("error", (e) => {
            console.log(`[${uid}] Error: ${e.message}`);
            // Let 'close' event handle reconnect
        });
        
    } catch (e) {
        console.error(`[${uid}] Failed to create: ${e.message}`);
        // Retry in 30s even on creation fail (unless stopped)
        const session = sessions.get(uid);
        if (session && !session.manualStop) {
            session.reconnectTimer = setTimeout(() => startSession(uid), 30000);
        }
        if (interaction) reply(interaction, "Failed, retrying in 30s...");
    }
};

const stopSession = (uid) => {
    const s = sessions.get(uid);
    if (!s) return "Not running";
    
    s.manualStop = true; // Prevent reconnect
    if (s.reconnectTimer) {
        clearTimeout(s.reconnectTimer);
        s.reconnectTimer = null;
    }
    cleanup(uid);
    return "⏹ Stopped (no auto-reconnect)";
};

// ==================== EVENTS ====================
client.on("clientReady", async () => {
    console.log(`✅ ${client.user.tag}`);
    await client.application?.commands?.set([
        new SlashCommandBuilder().setName("panel").setDescription("Panel"),
    ]);
});

client.on(Events.InteractionCreate, async (i) => {
    if (!i?.user) return;
    const uid = i.user.id;
    
    if (!isAllowed(uid)) {
        return i.reply({ content: "⛔ Denied", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    
    if (i.isChatInputCommand()) {
        if (i.commandName === "panel") {
            return i.reply({ components: panelButtons(), flags: [MessageFlags.Ephemeral] });
        }
    }
    
    if (i.isButton()) {
        const id = i.customId;
        
        if (id === "start") {
            return startSession(uid, i);
        }
        
        if (id === "stop") {
            return reply(i, stopSession(uid));
        }
        
        if (id === "link") {
            return linkAccount(uid, i);
        }
        
        if (id === "unlink") {
            return reply(i, unlinkAccount(uid));
        }
        
        if (id === "settings") {
            const u = getUser(uid);
            const modal = new ModalBuilder()
                .setCustomId("set")
                .setTitle("Server")
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
        const ip = i.fields.getTextInputValue("ip").trim();
        const port = parseInt(i.fields.getTextInputValue("port"));
        getUser(uid).server = { ip, port };
        saveUsers(users);
        return reply(i, `Saved: ${ip}:${port}`);
    }
});

client.login(DISCORD_TOKEN);
