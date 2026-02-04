/**
 * ULTIMATE MINECRAFT COMPANION - FIXED EDITION
 * v7.0 - Stable Auth & Social Matchmaking
 */

const {
    Client,
    GatewayIntentBits,
    Partials,
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
// 1. CONFIGURATION
// ==========================================

const CONFIG = {
    TOKEN: process.env.DISCORD_TOKEN,
    ADMIN_ID: "1144987924123881564", 
    SETUP_GUILD: "1462335230345089254",
    PATHS: {
        DATA: path.join(__dirname, "data"),
        AUTH: path.join(__dirname, "data", "auth"),
        DB: path.join(__dirname, "data", "database.json")
    }
};

if (!CONFIG.TOKEN) process.exit(1);

if (!fs.existsSync(CONFIG.PATHS.DATA)) fs.mkdirSync(CONFIG.PATHS.DATA);
if (!fs.existsSync(CONFIG.PATHS.AUTH)) fs.mkdirSync(CONFIG.PATHS.AUTH, { recursive: true });

// ==========================================
// 2. DATABASE SYSTEM
// ==========================================

class Database {
    constructor() {
        this.data = { users: {}, servers: [] };
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(CONFIG.PATHS.DB)) {
                this.data = JSON.parse(fs.readFileSync(CONFIG.PATHS.DB, "utf8"));
            }
            if (!this.data.servers) this.data.servers = [];
        } catch (e) { this.save(); }
    }

    save() {
        fs.writeFile(CONFIG.PATHS.DB, JSON.stringify(this.data, null, 2), () => {});
    }

    getUser(uid) {
        if (!this.data.users[uid]) {
            this.data.users[uid] = {
                bedrock: { ip: null, port: 19132, username: `Bot_${uid.slice(-4)}` },
                java: { ip: null, port: 19132, username: `Java_${uid.slice(-4)}` },
                settings: { version: 'auto', connectionType: 'offline' },
                linked: false
            };
            this.save();
        }
        return this.data.users[uid];
    }

    addServer(server) {
        this.data.servers.push(server);
        this.save();
    }

    getServers() {
        return this.data.servers;
    }
}

const DB = new Database();

// ==========================================
// 3. SOCIAL SYSTEM (FIXED)
// ==========================================

// Stores UID -> Timestamp
const matchmakingQueue = new Map(); 
// Stores UID -> UID
const activePairs = new Map(); 

class SocialManager {
    static async joinQueue(uid, interaction) {
        // Prevent double join
        if (activePairs.has(uid)) return;
        if (matchmakingQueue.has(uid)) {
            matchmakingQueue.delete(uid);
            return interaction.editReply({ 
                embeds: [new EmbedBuilder().setDescription("🛑 Left matchmaking queue.").setColor(0xED4245)],
                components: [UI.navRow("nav_social")]
            });
        }

        // Check if anyone else is waiting
        // We filter out the user themselves just in case
        const availableUsers = Array.from(matchmakingQueue.keys()).filter(id => id !== uid);

        if (availableUsers.length > 0) {
            // MATCH FOUND!
            const partnerId = availableUsers[0];
            matchmakingQueue.delete(partnerId); // Remove partner from queue
            
            // Register pair
            this.createPair(uid, partnerId);

            // Notify Partner (Send a NEW message because their interaction might be stale)
            this.notifyMatch(interaction.client, partnerId, uid);

            // Notify Current User (Edit their interaction)
            return interaction.editReply({ 
                embeds: [this.getMatchEmbed(partnerId)],
                components: [this.getChatControls()]
            });

        } else {
            // NO MATCH, ADD TO QUEUE
            matchmakingQueue.set(uid, Date.now());
            
            return interaction.editReply({ 
                embeds: [new EmbedBuilder()
                    .setTitle("🔍 Searching for Partner...")
                    .setDescription("Please wait while we look for another user.\n\n*You will be notified when a match is found.*")
                    .setColor(0xFEE75C)
                    .setThumbnail("https://media.tenor.com/On7kvXhzml4AAAAj/loading-gif.gif")
                ],
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("social_cancel").setLabel("Cancel Search").setStyle(ButtonStyle.Danger)
                )]
            });
        }
    }

    static createPair(userA, userB) {
        activePairs.set(userA, userB);
        activePairs.set(userB, userA);
    }

    static async notifyMatch(client, targetId, partnerId) {
        try {
            const user = await client.users.fetch(targetId);
            await user.send({ 
                embeds: [this.getMatchEmbed(partnerId)],
                components: [this.getChatControls()]
            });
        } catch (e) {
            console.error(`Failed to notify ${targetId}:`, e);
        }
    }

    static getMatchEmbed(partnerId) {
        return new EmbedBuilder()
            .setTitle("🎉 Partner Found!")
            .setDescription(`You are now connected with <@${partnerId}>!\n\n💬 **Type to Chat:** Anything you send here goes to them.\n🎮 **Play:** Use the buttons below.`)
            .setColor(0x57F287);
    }

    static getChatControls() {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("game_rps").setLabel("Rock Paper Scissors").setStyle(ButtonStyle.Primary).setEmoji("✂️"),
            new ButtonBuilder().setCustomId("game_dice").setLabel("Roll Dice").setStyle(ButtonStyle.Secondary).setEmoji("🎲"),
            new ButtonBuilder().setCustomId("social_leave").setLabel("Disconnect Chat").setStyle(ButtonStyle.Danger).setEmoji("🛑")
        );
    }

    static disconnect(uid, client) {
        const partner = activePairs.get(uid);
        if (partner) {
            activePairs.delete(uid);
            activePairs.delete(partner);
            
            const endEmbed = new EmbedBuilder().setDescription("🛑 **Chat session ended.**").setColor(0xED4245);
            const controls = [UI.navRow("nav_social")];

            // Notify both
            [uid, partner].forEach(async id => {
                try {
                    const u = await client.users.fetch(id);
                    await u.send({ embeds: [endEmbed], components: controls });
                } catch(e){}
            });
        }
    }

    static handleMessage(msg) {
        if (activePairs.has(msg.author.id)) {
            const partnerId = activePairs.get(msg.author.id);
            msg.client.users.fetch(partnerId).then(u => {
                u.send(`💬 **${msg.author.username}:** ${msg.content}`);
            }).catch(()=>{});
        }
    }
}

// ==========================================
// 4. AUTH SYSTEM (FIXED)
// ==========================================

const pendingAuth = new Set();

async function handleAuth(uid, interaction) {
    if (pendingAuth.has(uid)) {
        return interaction.editReply({ content: "⏳ Auth flow already active. Check previous messages." });
    }

    const authDir = path.join(CONFIG.PATHS.AUTH, uid);
    
    // Clear old tokens to force re-link if needed
    try { 
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    } catch(e) {}

    pendingAuth.add(uid);

    const flow = new Authflow(uid, authDir, { 
        flow: "live", 
        authTitle: Titles.MinecraftNintendoSwitch, 
        deviceType: "Nintendo" 
    }, async (res) => {
        // Show code directly in interaction
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel("Login to Microsoft").setStyle(ButtonStyle.Link).setURL(res.verification_uri_complete || res.verification_uri)
        );
        
        await interaction.editReply({ 
            content: null,
            embeds: [new EmbedBuilder()
                .setTitle("🔐 Microsoft Authentication")
                .setDescription(`**Step 1:** Click the button below.\n**Step 2:** Use code: \`${res.user_code}\`\n**Step 3:** Wait here for confirmation.`)
                .setColor(0x5865F2)
            ], 
            components: [row] 
        });
    });

    try {
        // Wait for token (This blocks until user actually logs in)
        await flow.getMsaToken();
        
        const u = DB.getUser(uid);
        u.linked = true;
        u.settings.connectionType = 'online';
        DB.save();

        await interaction.followUp({ 
            content: "✅ **Successfully Linked!** You can now join online servers.",
            ephemeral: false 
        });
        
        // Refresh UI
        interaction.user.send(UI.config(uid));

    } catch (e) {
        await interaction.followUp({ content: `❌ **Authentication Failed:** ${e.message}` });
    } finally {
        pendingAuth.delete(uid);
    }
}

// ==========================================
// 5. MINECRAFT ENGINE
// ==========================================

const activeSessions = new Map();

class MinecraftSession {
    constructor(uid, type, interaction) {
        this.uid = uid;
        this.type = type;
        this.interaction = interaction; // Initial interaction
        this.client = null;
        this.afkInt = null;
    }

    async start() {
        const user = DB.getUser(this.uid);
        const conf = this.type === 'java' ? user.java : user.bedrock;
        
        if(!conf.ip) {
            return this.interaction.editReply({ content: "❌ IP not set. Go to Config.", embeds: [], components: [UI.navRow("nav_home")] });
        }

        await this.interaction.editReply({ 
            content: null,
            embeds: [new EmbedBuilder().setDescription(`🚀 **Connecting to** \`${conf.ip}:${conf.port}\`...`).setColor(0xFEE75C)],
            components: []
        });

        const opts = {
            host: conf.ip,
            port: parseInt(conf.port),
            offline: user.settings.connectionType === 'offline',
            username: user.settings.connectionType === 'offline' ? conf.username : undefined,
            profilesFolder: user.settings.connectionType === 'online' ? path.join(CONFIG.PATHS.AUTH, this.uid) : undefined,
            skipPing: false,
            connectTimeout: 25000,
            conLog: ()=>{}
        };

        if(user.settings.connectionType === 'online' && !user.linked) {
            return this.interaction.editReply({ content: "❌ **Error:** Set to Online Mode but account not linked.", components: [UI.navRow("nav_home")] });
        }

        try {
            this.client = bedrock.createClient(opts);
            
            this.client.on('spawn', () => {
                this.interaction.editReply({ 
                    embeds: [new EmbedBuilder()
                        .setTitle("✅ Bot Online")
                        .setDescription(`**Server:** ${conf.ip}\n**Mode:** ${this.type.toUpperCase()}\n**Status:** Anti-AFK Active`)
                        .setColor(0x57F287)
                        .setThumbnail("https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcT2N_1t_l7p_1t_l7p_1t_l7p&s")
                    ],
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId("mc_disconnect").setLabel("Stop Bot").setStyle(ButtonStyle.Danger).setEmoji("🛑")
                    ), UI.navRow("nav_home")]
                });

                // Anti-AFK
                this.afkInt = setInterval(() => {
                    if(this.client) {
                        try {
                            const yaw = (Date.now() % 360);
                            this.client.write('player_auth_input', { pitch:0, yaw:yaw, position:{x:0,y:0,z:0}, input_mode:'mouse' });
                        } catch(e){}
                    }
                }, 10000);
            });

            this.client.on('error', (e) => {
                this.interaction.followUp({ content: `❌ Connection Error: ${e.message}` });
                this.stop();
            });

            this.client.on('close', () => {
                this.interaction.followUp({ content: "⚠️ Disconnected from server." });
                this.stop();
            });

        } catch(e) { 
            this.interaction.editReply(`❌ Init Error: ${e.message}`); 
        }
    }

    stop() {
        if(this.afkInt) clearInterval(this.afkInt);
        if(this.client) { try{this.client.close();}catch(e){} }
        activeSessions.delete(this.uid);
    }
}

// ==========================================
// 6. UI COMPONENTS
// ==========================================

const UI = {
    navRow(current) {
        const btns = [
            { id: "nav_home", label: "Home", emoji: "🏠" },
            { id: "nav_servers", label: "Servers", emoji: "🌐" },
            { id: "nav_social", label: "Social", emoji: "👥" },
            { id: "nav_config", label: "Config", emoji: "⚙️" }
        ];
        
        return new ActionRowBuilder().addComponents(
            btns.map(b => new ButtonBuilder()
                .setCustomId(b.id)
                .setLabel(b.label)
                .setEmoji(b.emoji)
                .setStyle(current === b.id ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setDisabled(current === b.id)
            )
        );
    },

    home(uid) {
        const user = DB.getUser(uid);
        const session = activeSessions.get(uid);
        
        const embed = new EmbedBuilder()
            .setTitle("🎮 Minecraft Companion")
            .setDescription("Control your AFK bot or explore community features.")
            .setColor(0x5865F2)
            .addFields(
                { name: "🤖 Bot Status", value: session ? "🟢 **Online**" : "🔴 **Offline**", inline: true },
                { name: "🔑 Account", value: user.linked ? "✅ Linked" : "⚠️ Offline Mode", inline: true }
            );

        const controls = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("start_bedrock").setLabel("Bedrock").setStyle(ButtonStyle.Success).setEmoji("🧱").setDisabled(!!session),
            new ButtonBuilder().setCustomId("start_java").setLabel("Java (Geyser)").setStyle(ButtonStyle.Success).setEmoji("☕").setDisabled(!!session),
            new ButtonBuilder().setCustomId("mc_disconnect").setLabel("Stop").setStyle(ButtonStyle.Danger).setEmoji("🛑").setDisabled(!session)
        );

        return { embeds: [embed], components: [controls, this.navRow("nav_home")] };
    },

    servers() {
        const list = DB.getServers();
        const display = list.slice(-5).map(s => `🌐 **${s.ip}:${s.port}**\n📝 ${s.desc}`).join("\n\n") || "No servers shared yet.";

        const embed = new EmbedBuilder()
            .setTitle("🌐 Server List")
            .setDescription(display)
            .setColor(0x2B2D31);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("share_server").setLabel("Share Yours").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("refresh_servers").setLabel("Refresh").setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [row, this.navRow("nav_servers")] };
    },

    social(uid) {
        const inQueue = matchmakingQueue.has(uid);
        const chatting = activePairs.has(uid);

        const embed = new EmbedBuilder()
            .setTitle("👥 Social Hub")
            .setDescription("Find chat partners or play mini-games.")
            .addFields(
                { name: "Your Status", value: chatting ? "💬 **Chatting**" : (inQueue ? "🔍 **Searching...**" : "💤 **Idle**"), inline: true },
                { name: "Queue Size", value: `${matchmakingQueue.size} users`, inline: true }
            )
            .setColor(0xEB459E);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("social_find").setLabel(inQueue ? "Searching..." : "Find Partner").setStyle(inQueue ? ButtonStyle.Secondary : ButtonStyle.Success).setEmoji("🔍").setDisabled(inQueue || chatting),
            new ButtonBuilder().setCustomId("social_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger).setDisabled(!inQueue)
        );

        return { embeds: [embed], components: [row, this.navRow("nav_social")] };
    },

    config(uid) {
        const user = DB.getUser(uid);
        const embed = new EmbedBuilder()
            .setTitle("⚙️ Settings")
            .setDescription(`**Bedrock:** \`${user.bedrock.ip || 'Not Set'}\`\n**Java:** \`${user.java.ip || 'Not Set'}\``)
            .setColor(0x2B2D31);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("edit_config").setLabel("Edit IPs").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("link_ms").setLabel("Link Account").setStyle(ButtonStyle.Secondary).setDisabled(user.linked),
            new ButtonBuilder().setCustomId("unlink_ms").setLabel("Unlink").setStyle(ButtonStyle.Danger).setDisabled(!user.linked)
        );

        return { embeds: [embed], components: [row, this.navRow("nav_config")] };
    }
};

// ==========================================
// 7. DISCORD LOGIC
// ==========================================

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages], partials: [Partials.Channel] });

// --- Message Handler (Chat Relay) ---
client.on(Events.MessageCreate, async (msg) => {
    if(msg.author.bot) return;
    
    if(!msg.guild) {
        // Chat Relay logic
        if (activePairs.has(msg.author.id)) {
            SocialManager.handleMessage(msg);
            return; // Don't show panel if chatting
        }

        // Show panel for any message if not chatting
        if(msg.content) {
            await msg.reply(UI.home(msg.author.id));
        }
    }
});

// --- Interaction Handler ---
client.on(Events.InteractionCreate, async (i) => {
    const uid = i.user.id;

    // Guild Setup Logic
    if(i.guildId) {
        if(i.guildId === CONFIG.SETUP_GUILD && i.commandName === "setup") {
            return i.reply({
                content: "🚀 **We've moved to DMs!**",
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("dm_launch").setLabel("Open App").setStyle(ButtonStyle.Primary).setEmoji("📩"))]
            });
        }
        if(i.customId === "dm_launch") {
            try { 
                await i.user.send(UI.home(uid)); 
                i.reply({content: "✅ **Check your DMs!**", ephemeral:true}); 
            } catch { 
                i.reply({content: "❌ **Enable DMs** in your privacy settings.", ephemeral:true}); 
            }
            return;
        }
        return i.reply({content:"⛔ This bot works in DMs only.", ephemeral:true});
    }

    try {
        // Slash Command
        if(i.isChatInputCommand()) {
            if(i.commandName === "panel") i.reply(UI.home(uid));
        }

        // Buttons
        if(i.isButton()) {
            // AUTH
            if(i.customId === "link_ms") {
                await i.deferReply();
                handleAuth(uid, i);
                return;
            }
            if(i.customId === "unlink_ms") {
                const u = DB.getUser(uid); u.linked = false; u.settings.connectionType='offline'; DB.save();
                try { fs.rmSync(path.join(CONFIG.PATHS.AUTH, uid), {recursive:true, force:true}); } catch(e){}
                i.update(UI.config(uid));
                return;
            }

            // NAVIGATION
            if(i.customId === "nav_home") i.update(UI.home(uid));
            if(i.customId === "nav_servers") i.update(UI.servers());
            if(i.customId === "nav_social") i.update(UI.social(uid));
            if(i.customId === "nav_config") i.update(UI.config(uid));

            // BOT CONTROL
            if(i.customId.startsWith("start_")) {
                const type = i.customId.split("_")[1];
                await i.deferReply();
                const session = new MinecraftSession(uid, type, i);
                activeSessions.set(uid, session);
                session.start();
                return;
            }
            if(i.customId === "mc_disconnect") {
                const s = activeSessions.get(uid);
                if(s) s.stop();
                i.update(UI.home(uid));
                return;
            }

            // CONFIG MODAL
            if(i.customId === "edit_config") {
                const m = new ModalBuilder().setCustomId("conf_modal").setTitle("Config");
                const u = DB.getUser(uid);
                m.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("IP Address").setStyle(TextInputStyle.Short).setValue(u.bedrock.ip || "").setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.bedrock.port || 19132)).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user").setLabel("Offline Username").setStyle(TextInputStyle.Short).setValue(u.bedrock.username).setRequired(true))
                );
                i.showModal(m);
                return;
            }

            // SERVER SHARE MODAL
            if(i.customId === "share_server") {
                const m = new ModalBuilder().setCustomId("share_modal").setTitle("Share Server");
                m.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("s_ip").setLabel("IP:Port").setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("s_desc").setLabel("Description").setStyle(TextInputStyle.Paragraph).setRequired(true))
                );
                i.showModal(m);
                return;
            }
            if(i.customId === "refresh_servers") i.update(UI.servers());

            // SOCIAL LOGIC
            if(i.customId === "social_find") {
                await i.deferUpdate(); // Prevents "interaction failed"
                SocialManager.joinQueue(uid, i);
                return;
            }
            if(i.customId === "social_cancel") {
                matchmakingQueue.delete(uid);
                i.update(UI.social(uid));
                return;
            }
            if(i.customId === "social_leave") {
                SocialManager.disconnect(uid, i.client);
                i.update(UI.social(uid));
                return;
            }
            
            // GAMES
            if(i.customId === "game_rps") {
                const moves = ["Rock 🪨", "Paper 📄", "Scissors ✂️"];
                const move = moves[Math.floor(Math.random()*moves.length)];
                const partner = activePairs.get(uid);
                i.reply(`You played **${move}**!`);
                if(partner) i.client.users.cache.get(partner)?.send(`🎮 Partner played **${move}**!`);
                return;
            }
            if(i.customId === "game_dice") {
                const roll = Math.floor(Math.random()*6)+1;
                const partner = activePairs.get(uid);
                i.reply(`🎲 You rolled a **${roll}**!`);
                if(partner) i.client.users.cache.get(partner)?.send(`🎲 Partner rolled a **${roll}**!`);
                return;
            }
        }

        // MODAL SUBMITS
        if(i.isModalSubmit()) {
            if(i.customId === "conf_modal") {
                const u = DB.getUser(uid);
                const ip = i.fields.getTextInputValue("ip");
                const port = i.fields.getTextInputValue("port");
                const usr = i.fields.getTextInputValue("user");
                u.bedrock = {ip,port,username:usr};
                u.java = {ip,port,username:usr};
                DB.save();
                i.update(UI.config(uid));
            }
            if(i.customId === "share_modal") {
                const raw = i.fields.getTextInputValue("s_ip").split(":");
                DB.addServer({ ip: raw[0], port: raw[1]||19132, desc: i.fields.getTextInputValue("s_desc") });
                i.update(UI.servers());
            }
        }
    } catch(e) { console.error(e); }
});

client.once('ready', () => {
    console.log("Online");
    client.application.commands.set([
        new SlashCommandBuilder().setName("panel").setDescription("App"),
        new SlashCommandBuilder().setName("setup").setDescription("Setup")
    ]);
});

client.login(CONFIG.TOKEN);


