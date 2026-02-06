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
const mineflayer = require("mineflayer"); // Added for Java support
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ----------------- CONFIGURATION -----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ CRITICAL ERROR: DISCORD_TOKEN is missing in environment variables!");
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

  // Bedrock Defaults
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion || users[uid].bedrockVersion === "auto") users[uid].bedrockVersion = "1.21.60";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  if (!users[uid].profiles) {
      if (users[uid].linked) {
          users[uid].profiles = [{ id: 'default', name: 'Main Account', created: Date.now() }];
      } else {
          users[uid].profiles = [];
      }
      delete users[uid].linked;
  }
  
  // Java Defaults (NEW)
  if (!users[uid].java) {
    users[uid].java = {
      server: null,
      offlineUsername: `Java_${uid.slice(-4)}`,
      selectedVersion: "auto"
    };
  }
  
  return users[uid];
}

function getUserAuthDir(uid, profileId) {
  let dir = profileId ? path.join(AUTH_DIR, uid, profileId) : path.join(AUTH_DIR, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ----------------- GLOBAL STATE -----------------
const sessions = new Map();     // Bedrock Sessions
const javaSessions = new Map(); // Java Sessions
const pendingAuth = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

// ----------------- NOTIFICATIONS -----------------
async function notifyUser(uid, message) {
    try {
        const user = await client.users.fetch(uid);
        await user.send(message);
    } catch (e) {}
}

// ----------------- UNIFIED SESSION MANAGEMENT -----------------

function getSessionKey(uid, profileId) {
    return `${uid}_${profileId || 'default'}`;
}

function destroySession(uid, type, profileId = 'default') {
    const isJava = type === 'java';
    const map = isJava ? javaSessions : sessions;
    const key = isJava ? uid : getSessionKey(uid, profileId);
    const s = map.get(key);
    
    if (!s || s.isDestroying) return;
    s.isDestroying = true;

    // Clear All Timers
    if (s.afkLoop) clearInterval(s.afkLoop);
    if (s.actionLoop) clearInterval(s.actionLoop);
    if (s.moveTimer) clearTimeout(s.moveTimer);
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    if (s.uptimeInterval) clearInterval(s.uptimeInterval);

    try {
        if (isJava && s.bot) {
            s.bot.quit();
            s.bot.removeAllListeners();
        } else if (!isJava && s.client) {
            s.client.removeAllListeners();
            s.client.close();
        }
    } catch (e) {
        console.error(`Error closing session ${key}:`, e.message);
    }
    
    map.delete(key);
    console.log(`[${type.toUpperCase()}] Session destroyed: ${key}`);
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

async function prepareBedrockStart(uid, interaction, profileId, isUpdate = false) {
    const u = getUser(uid);
    const profile = u.profiles.find(p => p.id === profileId) || { id: 'default', name: 'Offline/Default' };
    
    if (!u.server) {
        const msg = "❌ No Bedrock server set! Go to Settings in the Bedrock panel.";
        return isUpdate ? interaction.update({ content: msg, components: [] }) : interaction.reply({ content: msg, ephemeral: true });
    }

    const key = getSessionKey(uid, profile.id);
    if (sessions.has(key)) {
        const msg = `❌ **Session Active:** This profile (${profile.name}) is already online. Stop it first.`;
        return isUpdate ? interaction.update({ content: msg, components: [] }) : interaction.reply({ content: msg, ephemeral: true });
    }

    if (uid !== ROOT_ID && Array.from(sessions.keys()).some(k => k.startsWith(uid))) {
        const msg = "❌ **Limit Reached:** You can only have one active Bedrock bot.";
        return isUpdate ? interaction.update({ content: msg, components: [] }) : interaction.reply({ content: msg, ephemeral: true });
    }

    const authDir = getUserAuthDir(uid, profile.id);
    const { ip, port } = u.server;

    if (isUpdate) await interaction.update({ content: `🔎 **Pinging ${ip}:${port}...**`, components: [], embeds: [] });
    else await interaction.reply({ content: `🔎 **Pinging ${ip}:${port}...**`, ephemeral: true });

    try {
        await bedrock.ping({ host: ip, port: port, timeout: 5000 });
        await interaction.editReply({ content: `✅ **Server Found! Joining as ${profile.name}...**\nUsing version: \`${u.bedrockVersion}\`` });
    } catch (e) {
        return interaction.editReply({ content: `❌ **Connection Failed:** Server offline.\nReason: ${e.message}` });
    }

    const options = {
        host: ip,
        port: port,
        connectTimeout: 30000,
        skipPing: true,
        version: u.bedrockVersion, 
        offline: u.connectionType === "offline",
        username: u.connectionType === "offline" ? (u.offlineUsername || `AFK_${uid.slice(-4)}`) : undefined,
        profilesFolder: u.connectionType === "online" ? authDir : undefined,
        authTitle: Titles.MinecraftNintendoSwitch,
        flow: 'live',
        skinData: { DeviceId: crypto.randomUUID(), SelfSignedId: crypto.randomUUID() } // Simplified but effective
    };

    if (u.connectionType === "online" && !u.profiles.find(p => p.id === profile.id)) {
        return interaction.followUp({ content: "❌ Account not linked!", ephemeral: true });
    }

    console.log(`[INIT] Starting Bedrock bot for ${uid} on ${ip}:${port} (v${u.bedrockVersion})`);
    createBedrockInstance(uid, profile.id, options, interaction);
}

function createBedrockInstance(uid, profileId, opts, interaction, attempt = 0) {
    const sessionKey = getSessionKey(uid, profileId);
    let botClient;

    try {
        botClient = bedrock.createClient(opts);
    } catch (e) {
        if (interaction) interaction.followUp({ content: `❌ Init Error: ${e.message}`, ephemeral: true });
        return;
    }

    const session = {
        client: botClient, startTime: Date.now(), manualStop: false, opts: opts,
        pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, tickCount: 0n,
        runtimeEntityId: null, congratsHours: 0, isDestroying: false, 
        profileId: profileId, rejoinAttempts: attempt, type: 'bedrock'
    };
    sessions.set(sessionKey, session);

    botClient.on('resource_packs_info', (packet) => {
        botClient.write('resource_pack_client_response', { response_status: 'completed', resourcepack_ids: [] });
        botClient.write('client_cache_status', { enabled: false });
    });

    botClient.on('spawn', () => {
        session.connected = true;
        session.rejoinAttempts = 0; 
        console.log(`[BEDROCK] ${sessionKey} spawned successfully.`);
        if (interaction) interaction.followUp({ content: `✅ **Connected to ${opts.host}!**`, ephemeral: true });
        notifyUser(uid, `🚀 **Bedrock Bot Connected!**\nProfile: ${profileId}\nTarget: ${opts.host}`);
        startAfkLogic(uid, session, 'bedrock');
    });

    botClient.on('error', (err) => console.log(`[ERR] ${sessionKey} Client Error:`, err.message));
    botClient.on('kick', (reason) => {
        notifyUser(uid, `⚠️ **Bot Kicked!**\nReason: \`${JSON.stringify(reason)}\``);
        destroySession(uid, 'bedrock', profileId);
    });
    botClient.on('close', () => handleDisconnect(uid, session));
}


// ----------------- JAVA ENGINE (NEW) -----------------

async function startJava(uid, interaction) {
    const u = getUser(uid);
    if (!u.java.server) return interaction.update({ content: "❌ No Java server set! Go to Settings in the Java panel.", components: [] });
    if (javaSessions.has(uid)) return interaction.update({ content: "❌ Java bot is already running.", components: [] });

    const { ip, port } = u.java.server;
    await interaction.update({ content: `☕ **Connecting to ${ip}:${port}...**`, components: [], embeds: [] });

    const options = {
        host: ip,
        port: port,
        username: u.java.offlineUsername || `Java_${uid.slice(-4)}`,
        auth: 'offline',
        version: u.java.selectedVersion === "auto" ? false : u.java.selectedVersion,
        checkTimeoutInterval: 60 * 1000,
        hideErrors: false
    };

    createJavaInstance(uid, options, interaction);
}

function createJavaInstance(uid, opts, interaction, attempt = 0) {
    let bot;
    try {
        bot = mineflayer.createBot(opts);
    } catch (e) {
        if (interaction) interaction.followUp({ content: `❌ Init Error: ${e.message}`, ephemeral: true });
        return;
    }

    const session = {
        bot: bot, startTime: Date.now(), manualStop: false, opts: opts,
        congratsHours: 0, isDestroying: false, rejoinAttempts: attempt, type: 'java'
    };
    javaSessions.set(uid, session);

    bot.once('spawn', () => {
        session.connected = true;
        session.rejoinAttempts = 0;
        console.log(`[JAVA] ${uid} spawned on ${opts.host}`);
        if (interaction) interaction.followUp({ content: `✅ **Connected to ${opts.host}!**`, ephemeral: true });
        notifyUser(uid, `🚀 **Java Bot Connected!**\nTarget: ${opts.host}`);
        startAfkLogic(uid, session, 'java');
    });

    bot.on('error', (err) => console.log(`[JAVA ERR] ${uid}:`, err.message));
    bot.on('kicked', (reason) => notifyUser(uid, `⚠️ **Java Bot Kicked:** ${reason}`));
    bot.on('end', () => handleDisconnect(uid, session));
}

// ----------------- UNIFIED ANTI-AFK & RECONNECT -----------------

function startAfkLogic(uid, session, type) {
    if (type === 'bedrock') {
        session.afkLoop = setInterval(() => {
            if (!session.client) return;
            try {
                session.client.write("player_auth_input", { pitch: session.pitch, yaw: session.yaw, position: session.pos, move_vector: { x: 0, z: 0 }, head_yaw: session.yaw, input_data: { _value: 0n }, input_mode: 'mouse', play_mode: 'normal', tick: session.tickCount++, delta: { x: 0, y: 0, z: 0 }});
            } catch (e) {}
        }, 100);
        session.actionLoop = setInterval(() => {
             if (session.client) session.client.write("animate", { action_id: 1, runtime_entity_id: session.runtimeEntityId });
        }, 5000);
    } else { // Java
        session.afkLoop = setInterval(() => {
            if (session.bot?.entity) {
                session.bot.swingArm();
                session.bot.setControlState('jump', Math.random() > 0.8);
            }
        }, 5000);
    }
    
    session.uptimeInterval = setInterval(() => {
        session.congratsHours++;
        notifyUser(uid, `🎉 **Status Update:** Your ${type} bot has been online for **${session.congratsHours} hours**!`);
    }, 3600 * 1000);
}

function handleDisconnect(uid, session) {
    const key = session.type === 'java' ? uid : getSessionKey(uid, session.profileId);
    const map = session.type === 'java' ? javaSessions : sessions;

    if (!map.has(key)) return;

    if (session.afkLoop) clearInterval(session.afkLoop);
    if (session.actionLoop) clearInterval(session.actionLoop);
    if (session.uptimeInterval) clearInterval(session.uptimeInterval);

    if (session.manualStop) {
        notifyUser(uid, `⏹ **${session.type.charAt(0).toUpperCase() + session.type.slice(1)} Bot Stopped.**`);
        destroySession(uid, session.type, session.profileId);
    } else {
        if (session.rejoinAttempts >= 5) {
            notifyUser(uid, `❌ **Reconnection Failed:** Gave up after 5 attempts on ${session.type} bot.`);
            destroySession(uid, session.type, session.profileId);
            return;
        }

        const waitTime = session.rejoinAttempts > 0 ? 30000 : 5000;
        notifyUser(uid, `⚠️ **${session.type} Bot Disconnected!** Reconnecting in ${waitTime / 1000}s... (Attempt ${session.rejoinAttempts + 1}/5)`);
        
        session.reconnectTimer = setTimeout(() => {
            if (map.has(key) && !map.get(key).manualStop) {
                if (session.type === 'java') createJavaInstance(uid, session.opts, null, session.rejoinAttempts + 1);
                else createBedrockInstance(uid, session.profileId, session.opts, null, session.rejoinAttempts + 1);
            } else {
                destroySession(uid, session.type, session.profileId);
            }
        }, waitTime);
    }
}

// ----------------- UI & INTERACTIONS -----------------

client.on(Events.InteractionCreate, async (i) => {
    if (i.guildId && !ALLOWED_GUILDS.includes(i.guildId)) return;
    const uid = i.user.id;

    try {
        if (i.isChatInputCommand()) {
            if (i.commandName === "panel") return i.reply({ content: "**Bedrock Bot Panel 🤖**", components: getPanel('bedrock') });
            if (i.commandName === "java") return i.reply({ content: "**Java Bot Panel ☕**", components: getPanel('java') });
        }

        if (i.isButton()) {
            const id = i.customId;

            // ---- Bedrock Buttons ----
            if (id === "pre_bedrock") {
                const u = getUser(uid);
                if (!u.server) return i.reply({ content: "❌ **Configuration Missing!** Go to Settings.", ephemeral: true });

                if (uid === ROOT_ID && u.profiles.length > 1) {
                    const select = new StringSelectMenuBuilder().setCustomId("start_select_bedrock").setPlaceholder("Select Account to Use").addOptions(u.profiles.map(p => ({ label: p.name, value: p.id })));
                    return i.reply({ content: "Choose a Bedrock account:", components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
                }
                const profileId = u.profiles.length > 0 ? u.profiles[0].id : 'default';
                return showPreFlight(i, 'bedrock', u, profileId, false);
            }
            if (id.startsWith("start_conf_")) return prepareBedrockStart(uid, i, id.replace("start_conf_", ""), true);
            if (id === "stop_bedrock") {
                const userSessions = Array.from(sessions.entries()).filter(([k, v]) => k.startsWith(uid + "_"));
                if (userSessions.length === 0) return i.reply({ content: "❌ No Bedrock bots running.", ephemeral: true });
                userSessions.forEach(([k, s]) => { s.manualStop = true; handleDisconnect(uid, s); });
                return i.reply({ content: "⏹ **Stopping all Bedrock bots...**", ephemeral: true });
            }
            if (id === "set_bedrock") return i.showModal(getSettingsModal('bedrock', getUser(uid)));
            if (id === "link") return handleLink(uid, i);
            if (id === "unlink") {
                 const u = getUser(uid);
                 if (u.profiles.length === 0) return i.reply({ content: "❌ No accounts to unlink.", ephemeral: true });
                 if (uid === ROOT_ID && u.profiles.length > 1) {
                    const select = new StringSelectMenuBuilder().setCustomId("unlink_select").setPlaceholder("Select Account to Remove").addOptions(u.profiles.map(p => ({ label: p.name, value: p.id })));
                    return i.reply({ content: "Select account to unlink:", components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
                 }
                 unlinkProfile(uid, u.profiles[0].id);
                 return i.reply({ content: "🗑 **Account Unlinked.**", ephemeral: true });
            }

            // ---- Java Buttons ----
            if (id === "pre_java") {
                const u = getUser(uid);
                if (!u.java.server) return i.reply({ content: "❌ **Configuration Missing!** Go to Java Settings.", ephemeral: true });
                return showPreFlight(i, 'java', u, null, false);
            }
            if (id === "start_java") return startJava(uid, i);
            if (id === "stop_java") {
                if (!javaSessions.has(uid)) return i.reply({ content: "❌ No Java bot running.", ephemeral: true });
                const s = javaSessions.get(uid);
                s.manualStop = true;
                handleDisconnect(uid, s);
                return i.reply({ content: "⏹ **Stopping Java bot...**", ephemeral: true });
            }
            if (id === "set_java") return i.showModal(getSettingsModal('java', getUser(uid)));

            if (id === "cancel") return i.update({ content: "❌ Cancelled.", components: [], embeds: [] });
        }

        if (i.isStringSelectMenu()) {
            const u = getUser(uid);
            if (i.customId === "sel_bed_ver" || i.customId === "sel_java_ver") {
                const isJava = i.customId === "sel_java_ver";
                const type = isJava ? 'java' : 'bedrock';
                
                if (isJava) u.java.selectedVersion = i.values[0];
                else u.bedrockVersion = i.values[0];
                saveDatabase();

                const profileId = isJava ? null : (u.profiles[0]?.id || 'default');
                return showPreFlight(i, type, u, profileId, true);
            }
            if (i.customId === "start_select_bedrock") return showPreFlight(i, 'bedrock', u, i.values[0], true);
            if (i.customId === "unlink_select") {
                unlinkProfile(uid, i.values[0]);
                return i.update({ content: `🗑 **Profile ${i.values[0]} removed.**`, components: [] });
            }
        }

        if (i.isModalSubmit()) {
            const u = getUser(uid);
            if (i.customId === "modal_bedrock") {
                u.server = { ip: i.fields.getTextInputValue("ip"), port: parseInt(i.fields.getTextInputValue("port")) };
                u.offlineUsername = i.fields.getTextInputValue("off");
                saveDatabase();
                return i.reply({ content: "✅ Bedrock settings saved.", ephemeral: true });
            }
            if (i.customId === "modal_java") {
                u.java.server = { ip: i.fields.getTextInputValue("ip"), port: parseInt(i.fields.getTextInputValue("port")) };
                u.java.offlineUsername = i.fields.getTextInputValue("user");
                saveDatabase();
                return i.reply({ content: "✅ Java settings saved.", ephemeral: true });
            }
        }
    } catch (err) { console.error("Interaction Error:", err); }
});


// ----------------- UI HELPERS -----------------

function showPreFlight(i, type, u, profileId, isUpdate) {
    const isJava = type === 'java';
    const currentVer = isJava ? u.java.selectedVersion : u.bedrockVersion;
    const server = isJava ? u.java.server : u.server;
    
    const verRow = getVersionSelector(type, currentVer);
    const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(isJava ? 'start_java' : `start_conf_${profileId}`).setLabel("✅ Connect Now").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );
    
    let content = `**Pre-Flight Check (${isJava ? 'Java' : 'Bedrock'})**\nTarget: \`${server.ip}:${server.port}\`\nVersion: \`${currentVer}\`\n`;
    if (!isJava) content += `Account: **${u.profiles.find(p => p.id === profileId)?.name || "Default"}**\n`;
    content += `\n*Ready to join?*`;

    const payload = { content: content, components: [verRow, confirmRow], ephemeral: true };
    return isUpdate ? i.update(payload) : i.reply(payload);
}

function getSettingsModal(type, u) {
    if (type === 'java') {
        const m = new ModalBuilder().setCustomId("modal_java").setTitle("Java Settings");
        const ip = new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.java.server?.ip || "").setRequired(true);
        const port = new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.java.server?.port || 25565));
        const user = new TextInputBuilder().setCustomId("user").setLabel("Username").setStyle(TextInputStyle.Short).setValue(u.java.offlineUsername || "");
        m.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port), new ActionRowBuilder().addComponents(user));
        return m;
    } else {
        const m = new ModalBuilder().setCustomId("modal_bedrock").setTitle("Bedrock Settings");
        const ip = new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "").setRequired(true);
        const port = new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132));
        const user = new TextInputBuilder().setCustomId("off").setLabel("Offline Username").setStyle(TextInputStyle.Short).setValue(u.offlineUsername || "");
        m.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port), new ActionRowBuilder().addComponents(user));
        return m;
    }
}

async function handleLink(uid, interaction) {
    if (pendingAuth.has(uid)) return interaction.reply({ content: "⏳ Auth pending.", ephemeral: true });
    const u = getUser(uid);
    if (uid !== ROOT_ID && u.profiles.length >= 1) return interaction.reply({ content: "❌ You can only link one Xbox account.", ephemeral: true });
    
    const newProfileId = (u.profiles.length === 0) ? 'default' : crypto.randomUUID().split('-')[0];
    const newAuthDir = getUserAuthDir(uid, newProfileId);

    const flow = new Authflow(uid, newAuthDir, { flow: "live", authTitle: Titles.MinecraftNintendoSwitch }, (res) => {
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

function getVersionSelector(type, current) {
    const versions = type === 'java' ? [
        { label: "Auto-Detect", value: "auto" }, { label: "1.21", value: "1.21" },
        { label: "1.20.4", value: "1.20.4" }, { label: "1.19.4", value: "1.19.4" },
        { label: "1.18.2", value: "1.18.2" }, { label: "1.16.5", value: "1.16.5" },
        { label: "1.8.9", value: "1.8.9" }
    ] : [
        { label: "1.21.60 (Latest)", value: "1.21.60" }, { label: "1.21.50", value: "1.21.50" },
        { label: "1.21.40", value: "1.21.40" }, { label: "1.21.0", value: "1.21.0" },
        { label: "1.20.80", value: "1.20.80" }
    ];

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(type === 'java' ? "sel_java_ver" : "sel_bed_ver")
            .setPlaceholder(`Selected: ${current}`)
            .addOptions(versions.map(v => ({ label: v.label, value: v.value, default: v.value === current })))
    );
}

function getPanel(type) {
    if (type === 'java') {
        return [ new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("pre_java").setLabel("▶ Start").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId("stop_java").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId("set_java").setLabel("⚙ Settings").setStyle(ButtonStyle.Primary)
        )];
    } else { // bedrock
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
}

// ----------------- STARTUP -----------------
client.once("ready", () => {
    console.log(`🟢 Online: ${client.user.tag}`);
    client.application.commands.set([
        new SlashCommandBuilder().setName("panel").setDescription("Open the Bedrock Edition panel."),
        new SlashCommandBuilder().setName("java").setDescription("Open the Java Edition panel.")
    ]);
});

process.on("uncaughtException", (e) => console.error("Uncaught:", e));
process.on("unhandledRejection", (e) => console.error("Unhandled:", e));

client.login(DISCORD_TOKEN);
