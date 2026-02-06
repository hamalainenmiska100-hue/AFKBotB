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
const crypto = require("crypto");

// ----------------- CONFIGURATION -----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ CRITICAL ERROR: DISCORD_TOKEN is missing!");
  process.exit(1);
}

const ROOT_ID = "1144987924123881564"; // VIP User ID
const ALLOWED_GUILDS = [
    "1462335230345089254", 
    "1468289465783943354"
];

// ----------------- STORAGE SYSTEM -----------------
const DATA_DIR = path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const USER_FILE = path.join(DATA_DIR, "users.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let users = {};
try {
  users = fs.existsSync(USER_FILE) ? JSON.parse(fs.readFileSync(USER_FILE, "utf8")) : {};
} catch (e) {
  users = {};
}

function saveDatabase() {
  fs.writeFile(USER_FILE, JSON.stringify(users, null, 2), (err) => { if (err) console.error(err); });
}

function getUser(uid) {
  if (!users[uid]) users[uid] = {};
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  if (!users[uid].profiles) {
      if (users[uid].linked) {
          users[uid].profiles = [{ id: 'default', name: 'Main Account', created: Date.now() }];
      } else {
          users[uid].profiles = [];
      }
      delete users[uid].linked;
  }
  return users[uid];
}

function getUserAuthDir(uid, profileId) {
  let dir;
  if (!profileId || profileId === 'default') {
      dir = path.join(AUTH_DIR, uid);
  } else {
      dir = path.join(AUTH_DIR, uid, profileId);
  }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ----------------- GLOBAL STATE -----------------
const sessions = new Map();     
const pendingAuth = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

// ----------------- NOTIFICATIONS -----------------
async function notifyUser(uid, message) {
    try {
        const user = await client.users.fetch(uid);
        await user.send(message);
    } catch (e) {}
}

// ----------------- SESSION MANAGEMENT -----------------

function getSessionKey(uid, profileId) {
    return `${uid}_${profileId || 'default'}`;
}

function destroySession(uid, profileId = 'default') {
    const key = getSessionKey(uid, profileId);
    const s = sessions.get(key);
    
    if (!s) return;

    sessions.delete(key);

    // Clean up timers (Added actionLoop)
    if (s.afkLoop) clearInterval(s.afkLoop);
    if (s.actionLoop) clearInterval(s.actionLoop);
    if (s.moveTimer) clearTimeout(s.moveTimer);
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    if (s.uptimeInterval) clearInterval(s.uptimeInterval);

    try {
        if (s.client) {
            s.client.removeAllListeners();
            s.client.close();
        }
    } catch (e) {
        console.error(`Error closing session ${key}:`, e.message);
    }

    console.log(`[BEDROCK] Session destroyed: ${key}`);
}

function unlinkProfile(uid, profileId) {
    const u = getUser(uid);
    u.profiles = u.profiles.filter(p => p.id !== profileId);
    saveDatabase();
    const dir = getUserAuthDir(uid, profileId);
    try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) { console.error("Delete error:", e); }
}

// ----------------- BEDROCK ENGINE -----------------

async function prepareStart(uid, interaction, profileId, isUpdate = false) {
    const u = getUser(uid);
    const profile = u.profiles.find(p => p.id === profileId) || { id: 'default', name: 'Offline/Default' };
    
    // Config Check
    if (!u.server) {
        const msg = "❌ No server set! Go to Settings.";
        if (isUpdate) return interaction.update({ content: msg, components: [] });
        return interaction.reply({ content: msg, ephemeral: true });
    }

    // Session Check
    const key = getSessionKey(uid, profile.id);
    if (sessions.has(key)) {
        const msg = `❌ **Session Active:** This profile (${profile.name}) is already online. Stop it first.`;
        if (isUpdate) return interaction.update({ content: msg, components: [] });
        return interaction.reply({ content: msg, ephemeral: true });
    }

    // VIP Override / Limit Check
    if (uid !== ROOT_ID) {
        const active = Array.from(sessions.keys()).some(k => k.startsWith(uid));
        if (active) {
            const msg = "❌ **Limit Reached:** You can only have one active bot.";
            if (isUpdate) return interaction.update({ content: msg, components: [] });
            return interaction.reply({ content: msg, ephemeral: true });
        }
    }

    const authDir = getUserAuthDir(uid, profile.id);
    const { ip, port } = u.server;

    // Feedback
    if (isUpdate) await interaction.update({ content: `🔎 **Pinging ${ip}:${port}...**`, components: [], embeds: [] });
    else await interaction.reply({ content: `🔎 **Pinging ${ip}:${port}...**`, components: [], embeds: [], ephemeral: true });

    try {
        await bedrock.ping({ host: ip, port: port, timeout: 5000 });
        await interaction.editReply({ content: `✅ **Server Found! Joining as ${profile.name}...**` });
    } catch (e) {
        return interaction.editReply({ content: `❌ **Connection Failed:** Server offline.\nReason: ${e.message}` });
    }

    const options = {
        host: ip,
        port: port,
        connectTimeout: 30000,
        skipPing: false, 
        version: u.bedrockVersion === "auto" ? undefined : u.bedrockVersion,
        offline: u.connectionType === "offline",
        username: u.connectionType === "offline" ? (u.offlineUsername || `AFK_${uid.slice(-4)}`) : uid,
        profilesFolder: u.connectionType === "online" ? authDir : undefined
    };

    if (u.connectionType === "online") {
        const hasProfile = u.profiles.find(p => p.id === profile.id);
        if (!hasProfile) return interaction.followUp({ content: "❌ Account not linked!", ephemeral: true });
    }

    createBedrockInstance(uid, profile.id, options, interaction);
}

function createBedrockInstance(uid, profileId, opts, interaction, attempt = 0) {
    let botClient;
    try {
        botClient = bedrock.createClient(opts);
    } catch (e) {
        if (interaction) interaction.followUp({ content: `❌ Init Error: ${e.message}`, ephemeral: true });
        return;
    }

    const sessionKey = getSessionKey(uid, profileId);
    
    const session = {
        client: botClient,
        connected: false,
        startTime: Date.now(),
        manualStop: false,
        opts: opts,
        // Movement State
        pos: { x: 0, y: 0, z: 0 }, 
        yaw: 0,
        pitch: 0,
        tickCount: 0n,
        runtimeEntityId: null, // Critical for animations
        congratsHours: 0,
        
        profileId: profileId,
        rejoinAttempts: attempt
    };
    sessions.set(sessionKey, session);

    // Capture Entity ID for animations
    botClient.on('start_game', (packet) => {
        session.runtimeEntityId = packet.runtime_entity_id;
    });

    botClient.on('spawn', () => {
        session.connected = true;
        session.rejoinAttempts = 0; // Reset attempts on success!
        console.log(`[BEDROCK] ${sessionKey} spawned`);
        if (interaction) interaction.followUp({ content: `✅ **Connected to ${opts.host}!**`, ephemeral: true });
        
        notifyUser(uid, `🚀 **Bot Connected!**\nProfile: ${profileId === 'default' ? 'Main' : 'Alt'}\nTarget: ${opts.host}`);
        
        startAfkLogic(uid, session);
    });

    botClient.on('error', (err) => console.log(`[ERR] ${sessionKey}:`, err.message));

    botClient.on('kick', (reason) => {
        botClient.removeAllListeners();
        notifyUser(uid, `⚠️ **Bot Kicked!**\nReason: \`${reason}\``);
        destroySession(uid, profileId);
    });

    botClient.on('close', () => handleDisconnect(uid, session));

    botClient.on('move_player', (packet) => {
        if (packet.runtime_id === botClient.entityId) {
            session.pos = { x: packet.position.x, y: packet.position.y, z: packet.position.z };
        }
    });
}

// ----------------- IMPROVED ANTI-AFK LOGIC (FIXED TIMEOUTS) -----------------

function startAfkLogic(uid, session) {
    // 1. Packet Loop (Keep-Alive & Head Rotation)
    // Sends packets regularly to keep connection alive and simulate "looking around"
    session.afkLoop = setInterval(() => {
        if (!session.client) return;
        
        try {
            session.tickCount++;

            // Randomly look around slightly (Simulate human idle)
            if (Math.random() > 0.9) {
                session.yaw += (Math.random() - 0.5) * 5;
                session.pitch += (Math.random() - 0.5) * 2;
                // Clamp limits
                session.pitch = Math.max(-90, Math.min(90, session.pitch));
            }

            session.client.write("player_auth_input", {
                pitch: session.pitch,
                yaw: session.yaw,
                position: { x: session.pos.x, y: session.pos.y, z: session.pos.z },
                move_vector: { x: 0, z: 0 },
                head_yaw: session.yaw,
                input_data: { _value: 0n },
                input_mode: 'mouse',
                play_mode: 'normal',
                tick: session.tickCount,
                delta: { x: 0, y: 0, z: 0 }
            });

        } catch (e) {}
    }, 100); // 100ms = 10 ticks/sec

    // 2. ACTION LOOP (NEW: Prevents "Ghost" timeouts)
    // Punches the air every 5 seconds. This keeps the connection "hot".
    session.actionLoop = setInterval(() => {
        if (!session.client || !session.runtimeEntityId) return;
        try {
            session.client.write("animate", {
                action_id: 1, // Swing Arm
                runtime_entity_id: session.runtimeEntityId
            });
        } catch (e) {}
    }, 5000);

    // 3. Teleport Movement (0.5 blocks)
    // Moves slightly every random interval to prevent server AFK detection
    const scheduleTeleport = () => {
        if (!sessions.get(getSessionKey(uid, session.profileId))) return;

        // Random interval: 30s to 90s (More frequent to prevent 1h timeouts)
        const delay = Math.floor(Math.random() * (90000 - 30000 + 1) + 30000);
        
        session.moveTimer = setTimeout(() => {
            if (session.client) {
                // Teleport 0.5 blocks in a random X/Z direction
                const offset = 0.5;
                const angle = Math.random() * Math.PI * 2;
                
                session.pos.x += Math.cos(angle) * offset;
                session.pos.z += Math.sin(angle) * offset;
                
                // Note: The position updates in the next 'player_auth_input' packet in the loop above
            }
            scheduleTeleport();
        }, delay);
    };

    scheduleTeleport();

    // 4. Hourly Stats
    session.uptimeInterval = setInterval(async () => {
        session.congratsHours++;
        notifyUser(uid, `🎉 **Status Update:** Bot has been online for **${session.congratsHours} hours**!`);
    }, 3600 * 1000);
}

// ----------------- REJOIN LOGIC (UPDATED) -----------------

function handleDisconnect(uid, session) {
    const key = getSessionKey(uid, session.profileId);
    if (!sessions.has(key)) return;

    // Cleanup timers
    if (session.afkLoop) clearInterval(session.afkLoop);
    if (session.actionLoop) clearInterval(session.actionLoop);
    if (session.moveTimer) clearTimeout(session.moveTimer);
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    if (session.uptimeInterval) clearInterval(session.uptimeInterval);

    if (session.manualStop) {
        notifyUser(uid, `⏹ **Bot Stopped.**\nYou manually terminated the session.`);
        destroySession(uid, session.profileId);
    } else {
        // --- NEW REJOIN STRATEGY ---
        // Max 5 attempts
        if (session.rejoinAttempts >= 5) {
            notifyUser(uid, `❌ **Reconnection Failed:** Gave up after 5 attempts.`);
            destroySession(uid, session.profileId);
            return;
        }

        // 0 attempts (First kick) -> 0ms delay (Immediate)
        // 1+ attempts -> 30s delay
        let waitTime = (session.rejoinAttempts === 0) ? 0 : 30000;

        // Message logic
        if (waitTime === 0) {
            notifyUser(uid, `⚠️ **Disconnected!** Rejoining immediately... (Attempt ${session.rejoinAttempts + 1}/5)`);
        } else {
            notifyUser(uid, `⚠️ **Disconnected!** Waiting 30s before retry... (Attempt ${session.rejoinAttempts + 1}/5)`);
        }
        
        session.reconnectTimer = setTimeout(() => {
            if (sessions.has(key) && !sessions.get(key).manualStop) {
                try { session.client.removeAllListeners(); session.client.close(); } catch(e){}
                // Pass attempt count + 1
                createBedrockInstance(uid, session.profileId, session.opts, null, session.rejoinAttempts + 1);
            } else {
                destroySession(uid, session.profileId);
            }
        }, waitTime);
    }
}

// ----------------- UI & INTERACTIONS -----------------

client.on(Events.InteractionCreate, async (i) => {
    if (i.guildId && !ALLOWED_GUILDS.includes(i.guildId)) return;
    const uid = i.user.id;

    try {
        if (i.isChatInputCommand() && i.commandName === "panel") {
            // Public Panel (Not ephemeral)
            return i.reply({ content: "**Bedrock Bot Panel 🤖**", components: getPanel() });
        }

        if (i.isButton()) {
            const id = i.customId;

            // --- START FLOW ---
            if (id === "pre_bedrock") {
                const u = getUser(uid);
                if (!u.server) return i.reply({ content: "❌ **Configuration Missing!** Go to Settings.", ephemeral: true });

                // VIP Multi-Account Select
                if (uid === ROOT_ID && u.profiles.length > 1) {
                    const select = new StringSelectMenuBuilder()
                        .setCustomId("start_select")
                        .setPlaceholder("Select Account to Use")
                        .addOptions(u.profiles.map(p => ({ label: p.name, value: p.id, description: `ID: ${p.id}` })));
                    
                    return i.reply({ content: "Choose an account:", components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
                }

                // Default Flow
                const profileId = u.profiles.length > 0 ? u.profiles[0].id : 'default';
                return showPreFlight(i, u, profileId, false); // false = reply new message
            }

            if (id.startsWith("start_conf_")) {
                const profileId = id.replace("start_conf_", "");
                // This happens inside ephemeral message, so we update it
                return prepareStart(uid, i, profileId, true);
            }
            
            if (id === "cancel") return i.update({ content: "❌ Cancelled.", components: [], embeds: [] });

            // --- STOP FLOW ---
            if (id === "stop_bedrock") {
                const userSessions = Array.from(sessions.entries()).filter(([k, v]) => k.startsWith(uid + "_"));
                
                if (userSessions.length === 0) return i.reply({ content: "❌ No bots running.", ephemeral: true });

                if (userSessions.length === 1) {
                    const s = userSessions[0][1];
                    s.manualStop = true;
                    destroySession(uid, s.profileId);
                    return i.reply({ content: "⏹ **Stopping Bot...**", ephemeral: true });
                } else {
                    const select = new StringSelectMenuBuilder()
                        .setCustomId("stop_select")
                        .setPlaceholder("Select Bot to Stop")
                        .addOptions(userSessions.map(([k, s]) => ({ 
                            label: `Bot on ${s.opts.host}`, 
                            value: s.profileId, 
                            description: `Profile: ${s.profileId}` 
                        })));
                    return i.reply({ content: "Select which bot to stop:", components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
                }
            }

            // --- SETTINGS ---
            if (id === "set_bedrock") {
                const u = getUser(uid);
                const m = new ModalBuilder().setCustomId("modal_bedrock").setTitle("Bedrock Settings");
                const ip = new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "").setRequired(true);
                const port = new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132));
                const user = new TextInputBuilder().setCustomId("off").setLabel("Offline Username").setStyle(TextInputStyle.Short).setValue(u.offlineUsername || "");
                m.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port), new ActionRowBuilder().addComponents(user));
                return i.showModal(m);
            }

            // --- LINKING ---
            if (id === "link") return handleLink(uid, i);
            
            if (id === "unlink") {
                const u = getUser(uid);
                if (u.profiles.length === 0) return i.reply({ content: "❌ Nothing to unlink.", ephemeral: true });

                if (uid === ROOT_ID && u.profiles.length > 1) {
                    const select = new StringSelectMenuBuilder()
                        .setCustomId("unlink_select")
                        .setPlaceholder("Select Account to Remove")
                        .addOptions(u.profiles.map(p => ({ label: p.name, value: p.id })));
                    return i.reply({ content: "Select account to unlink:", components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
                }

                unlinkProfile(uid, u.profiles[0].id);
                return i.reply({ content: "🗑 **Account Unlinked.**", ephemeral: true });
            }
        }

        // --- MENUS ---
        if (i.isStringSelectMenu()) {
            if (i.customId === "sel_bed_ver") {
                const u = getUser(uid);
                u.bedrockVersion = i.values[0];
                saveDatabase();
                
                let profileId = 'default';
                try {
                    const oldId = i.message.components[1].components[0].customId;
                    if (oldId && oldId.startsWith("start_conf_")) profileId = oldId.replace("start_conf_", "");
                } catch(e) {}

                const verRow = getVersionSelector(i.values[0]);
                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`start_conf_${profileId}`).setLabel("✅ Connect Now").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                );
                return i.update({ components: [verRow, confirmRow] });
            }

            if (i.customId === "start_select") {
                const u = getUser(uid);
                return showPreFlight(i, u, i.values[0], true);
            }

            if (i.customId === "stop_select") {
                const profileId = i.values[0];
                const key = getSessionKey(uid, profileId);
                const s = sessions.get(key);
                if (s) {
                    s.manualStop = true;
                    destroySession(uid, profileId);
                    return i.update({ content: `⏹ **Stopped bot on profile ${profileId}.**`, components: [] });
                }
                return i.update({ content: "❌ Session not found.", components: [] });
            }

            if (i.customId === "unlink_select") {
                unlinkProfile(uid, i.values[0]);
                return i.update({ content: `🗑 **Profile ${i.values[0]} removed.**`, components: [] });
            }
        }

        if (i.isModalSubmit() && i.customId === "modal_bedrock") {
            const u = getUser(uid);
            u.server = { ip: i.fields.getTextInputValue("ip"), port: parseInt(i.fields.getTextInputValue("port")) };
            u.offlineUsername = i.fields.getTextInputValue("off");
            saveDatabase();
            return i.reply({ content: "✅ Settings saved.", ephemeral: true });
        }

    } catch (err) { console.error("Ix Err:", err); }
});

// ----------------- HELPERS -----------------

function showPreFlight(i, u, profileId, isUpdate) {
    const verRow = getVersionSelector(u.bedrockVersion);
    const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`start_conf_${profileId}`).setLabel("✅ Connect Now").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );
    const pName = u.profiles.find(p => p.id === profileId)?.name || "Default";
    const content = `**Pre-Flight Check**\nAccount: **${pName}**\nTarget: \`${u.server.ip}:${u.server.port}\`\n\n*Ready to join?*`;
    
    if (isUpdate) return i.update({ content: content, components: [verRow, confirmRow] });
    return i.reply({ content: content, components: [verRow, confirmRow], ephemeral: true });
}

async function handleLink(uid, interaction) {
    if (pendingAuth.has(uid)) return interaction.reply({ content: "⏳ Auth pending.", ephemeral: true });
    const u = getUser(uid);
    
    if (uid !== ROOT_ID && u.profiles.length >= 1) {
        return interaction.reply({ content: "❌ **You cant link more than one Xbox account!**\nUnlink your current one first.", ephemeral: true });
    }
    
    const newProfileId = (u.profiles.length === 0) ? 'default' : crypto.randomUUID().split('-')[0];
    const newAuthDir = getUserAuthDir(uid, newProfileId);

    const flow = new Authflow(uid, newAuthDir, { flow: "live", authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo" }, async (res) => {
        const link = res.verification_uri_complete || res.verification_uri;
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Login to Microsoft").setStyle(ButtonStyle.Link).setURL(link));
        interaction.editReply({ content: `🔐 **Code:** \`${res.user_code}\`\n*Link new account...*`, components: [row] }).catch(()=>{});
    });

    await interaction.deferReply({ ephemeral: true });
    pendingAuth.set(uid, true);

    try {
        await flow.getMsaToken();
        const u = getUser(uid);
        const name = `Xbox Account ${u.profiles.length + 1}`;
        u.profiles.push({ id: newProfileId, name: name, created: Date.now() });
        saveDatabase();
        interaction.followUp({ content: "✅ **Linked Successfully!**", ephemeral: true });
    } catch (e) {
        interaction.followUp({ content: `❌ Auth Failed: ${e.message}`, ephemeral: true });
        try { fs.rmSync(newAuthDir, { recursive: true, force: true }); } catch(e){}
    } finally {
        pendingAuth.delete(uid);
    }
}

function getVersionSelector(current) {
    const bv = [
        { label: "Auto-Detect (Best)", value: "auto" },
        { label: "1.21.60", value: "1.21.60" }, { label: "1.21.50", value: "1.21.50" },
        { label: "1.21.40", value: "1.21.40" }, { label: "1.21.20", value: "1.21.20" },
        { label: "1.21.0", value: "1.21.0" }, { label: "1.20.80", value: "1.20.80" }
    ];
    const safeCurrent = bv.find(x => x.value === current) ? current : "auto";
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId("sel_bed_ver").setPlaceholder(`Version: ${safeCurrent}`)
            .addOptions(bv.map(v => ({ label: v.label, value: v.value, default: v.value === safeCurrent })))
    );
}

function getPanel() {
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

client.once("ready", () => {
    console.log(`🟢 Online: ${client.user.tag}`);
    client.application.commands.set([ new SlashCommandBuilder().setName("panel").setDescription("Bedrock Panel") ]);
});

process.on("uncaughtException", (e) => console.error("Uncaught:", e));
process.on("unhandledRejection", (e) => console.error("Unhandled:", e));

client.login(DISCORD_TOKEN);


