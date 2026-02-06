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
  if (!users[uid].profiles) users[uid].profiles = [];
  
  // Java Defaults (with new authentication fields)
  if (!users[uid].java) {
    users[uid].java = {
      server: null,
      offlineUsername: `Java_${uid.slice(-4)}`,
      selectedVersion: "auto",
      auth: "offline", // 'offline' or 'online'
      selectedProfile: null // ID of the profile for online auth
    };
  }
  // Backwards compatibility for existing users
  if (users[uid].java && !users[uid].java.auth) {
      users[uid].java.auth = 'offline';
  }
  
  return users[uid];
}

function getUserAuthDir(uid, profileId) {
  let dir = profileId ? path.join(AUTH_DIR, uid, profileId) : path.join(AUTH_DIR, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ----------------- GLOBAL STATE -----------------
const sessions = new Map();
const javaSessions = new Map();
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
function destroySession(uid, type, profileId = 'default') {
    const isJava = type === 'java';
    const map = isJava ? javaSessions : sessions;
    const key = isJava ? uid : getSessionKey(uid, profileId);
    const s = map.get(key);
    
    if (!s || s.isDestroying) return;
    s.isDestroying = true;

    if (s.afkLoop) clearInterval(s.afkLoop);
    if (s.actionLoop) clearInterval(s.actionLoop);
    if (s.moveTimer) clearTimeout(s.moveTimer);
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    if (s.uptimeInterval) clearInterval(s.uptimeInterval);

    try {
        if (isJava && s.bot) {
            s.bot.end();
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
        host: ip, port: port, connectTimeout: 30000, skipPing: true,
        version: u.bedrockVersion, offline: u.connectionType === "offline",
        username: u.connectionType === "offline" ? (u.offlineUsername || `AFK_${uid.slice(-4)}`) : undefined,
        profilesFolder: u.connectionType === "online" ? authDir : undefined,
        authTitle: Titles.MinecraftNintendoSwitch, flow: 'live'
    };

    console.log(`[INIT] Starting Bedrock bot for ${uid} on ${ip}:${port}`);
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

    botClient.on('resource_packs_info', () => {
        botClient.write('resource_pack_client_response', { response_status: 'completed', resourcepack_ids: [] });
        botClient.write('client_cache_status', { enabled: false });
    });
    botClient.on('spawn', () => {
        session.connected = true;
        session.rejoinAttempts = 0; 
        console.log(`[BEDROCK] ${sessionKey} spawned successfully.`);
        if (interaction) interaction.followUp({ content: `✅ **Connected to ${opts.host}!**`, ephemeral: true });
        notifyUser(uid, `🚀 **Bedrock Bot Connected!**`);
        startAfkLogic(uid, session);
    });
    botClient.on('error', (err) => {
        console.error(`[BEDROCK ERR] ${sessionKey} Client Error:`, err); // Enhanced logging
        if (err.message && err.message.toUpperCase().includes('ECONNRESET')) {
             notifyUser(uid, `⚠️ **Connection Reset!** The Bedrock server may be offline or the selected version is incompatible.`);
        }
    });
    botClient.on('kick', (reason) => {
        notifyUser(uid, `⚠️ **Bot Kicked!** Reason: \`${JSON.stringify(reason)}\``);
        destroySession(uid, 'bedrock', profileId);
    });
    botClient.on('close', () => handleDisconnect(uid, session));
}

// ----------------- JAVA ENGINE (REFACTORED) -----------------
async function startJava(uid, interaction) {
    const u = getUser(uid);
    if (!u.java.server) return interaction.update({ content: "❌ No Java server set! Go to Server Settings.", components: [] });
    if (javaSessions.has(uid)) return interaction.update({ content: "❌ Java bot is already running.", components: [] });

    const { ip, port } = u.java.server;
    const isOnline = u.java.auth === 'online';

    // --- Authentication Check for Online Mode ---
    if (isOnline && !u.java.selectedProfile) {
        return interaction.update({ content: "❌ **Auth Error:** Please select a linked Xbox account for online mode in 'Auth Settings'.", components: [] });
    }
    const profile = isOnline ? u.profiles.find(p => p.id === u.java.selectedProfile) : null;
    if (isOnline && !profile) {
        return interaction.update({ content: "❌ **Auth Error:** The selected account profile could not be found. Please re-select it in 'Auth Settings'.", components: [] });
    }
    // --- End Auth Check ---

    const authDir = isOnline ? getUserAuthDir(uid, profile.id) : undefined;
    const connectMsg = `☕ **Connecting to ${ip}:${port}**...\nMode: \`${isOnline ? `Online (${profile.name})` : 'Offline'}\``;
    await interaction.update({ content: connectMsg, components: [], embeds: [] });

    const options = {
        host: ip, port: port,
        auth: isOnline ? 'microsoft' : 'offline',
        version: u.java.selectedVersion === "auto" ? false : u.java.selectedVersion,
        username: isOnline ? undefined : (u.java.offlineUsername || `Java_${uid.slice(-4)}`),
        profilesFolder: authDir,
        authTitle: isOnline ? Titles.MinecraftJava : undefined,
        checkTimeoutInterval: 60 * 1000,
        hideErrors: false
    };

    createJavaInstance(uid, options, interaction);
}

function createJavaInstance(uid, opts, interaction, attempt = 0) {
    let bot;
    try {
        console.log(`[INIT] Creating Java bot for ${uid} with options:`, opts);
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

    bot.once('login', () => console.log(`[JAVA] ${uid} has logged in.`));
    bot.once('spawn', () => {
        session.connected = true;
        session.rejoinAttempts = 0;
        console.log(`[JAVA] ${uid} spawned on ${opts.host}`);
        if (interaction) interaction.followUp({ content: `✅ **Connected to ${opts.host}!**`, ephemeral: true });
        notifyUser(uid, `🚀 **Java Bot Connected!**`);
        startAfkLogic(uid, session);
    });
    bot.on('error', (err) => {
        console.error(`[JAVA ERR] ${uid}:`, err); // Enhanced logging
        if (err.code === 'ECONNRESET') {
            notifyUser(uid, "⚠️ **Connection Reset!** The server may be offline, in online-mode, or your selected version is incompatible.");
        }
    });
    bot.on('kicked', (reason) => {
        console.log(`[JAVA KICK] ${uid}:`, reason);
        notifyUser(uid, `⚠️ **Java Bot Kicked:** ${reason}`);
    });
    bot.on('end', (reason) => {
        console.log(`[JAVA END] ${uid} disconnected. Reason: ${reason}`);
        handleDisconnect(uid, session);
    });
}

// ----------------- UNIFIED ANTI-AFK & RECONNECT -----------------
function startAfkLogic(uid, session) {
    const type = session.type;
    if (type === 'bedrock') {
        session.afkLoop = setInterval(() => {
            if (session.client) session.client.write("player_auth_input", { pitch: session.pitch, yaw: session.yaw, position: session.pos, move_vector: { x: 0, z: 0 }, head_yaw: session.yaw, input_data: { _value: 0n }, input_mode: 'mouse', play_mode: 'normal', tick: session.tickCount++, delta: { x: 0, y: 0, z: 0 }});
        }, 100);
        session.actionLoop = setInterval(() => {
             if (session.client) session.client.write("animate", { action_id: 1, runtime_entity_id: session.runtimeEntityId });
        }, 5000);
    } else { // Java
        session.afkLoop = setInterval(() => {
            if (session.bot?.entity) {
                session.bot.swingArm();
                if (Math.random() > 0.8) session.bot.setControlState('jump', true);
                else session.bot.setControlState('jump', false);
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

    if (!map.has(key) || session.isDestroying) return;

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
        
        // Before reconnecting, clean up the old session instance completely
        destroySession(uid, session.type, session.profileId);

        session.reconnectTimer = setTimeout(() => {
            if (session.type === 'java') createJavaInstance(uid, session.opts, null, session.rejoinAttempts + 1);
            else createBedrockInstance(uid, session.profileId, session.opts, null, session.rejoinAttempts + 1);
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
            const u = getUser(uid);

            // Bedrock Buttons
            if (id === "pre_bedrock") {
                if (!u.server) return i.reply({ content: "❌ **Configuration Missing!** Go to Settings.", ephemeral: true });
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
            if (id === "set_bedrock") return i.showModal(getSettingsModal('bedrock', u));
            if (id === "link") return handleLink(uid, i);
            if (id === "unlink") {
                 if (u.profiles.length === 0) return i.reply({ content: "❌ No accounts to unlink.", ephemeral: true });
                 unlinkProfile(uid, u.profiles[0].id); // Note: This assumes unlinking the first profile. Needs more logic for multiple.
                 return i.reply({ content: "🗑 **Account Unlinked.**", ephemeral: true });
            }

            // Java Buttons
            if (id === "pre_java") {
                if (!u.java.server) return i.reply({ content: "❌ **Configuration Missing!** Go to Java Settings.", ephemeral: true });
                return showPreFlight(i, 'java', u, null, false);
            }
            if (id === "start_java") return startJava(uid, i);
            if (id === "stop_java") {
                if (!javaSessions.has(uid)) return i.reply({ content: "❌ No Java bot running.", ephemeral: true });
                javaSessions.get(uid).manualStop = true;
                handleDisconnect(uid, javaSessions.get(uid));
                return i.reply({ content: "⏹ **Stopping Java bot...**", ephemeral: true });
            }
            if (id === "set_java") return i.showModal(getSettingsModal('java', u));
            if (id === "set_java_auth") {
                if (u.profiles.length === 0) return i.reply({ content: "❌ You have no linked Xbox accounts. Link one from the Bedrock panel first.", ephemeral: true });
                const authMenu = new StringSelectMenuBuilder()
                    .setCustomId('select_java_profile')
                    .setPlaceholder('Select an account for Java online mode')
                    .addOptions(
                        { label: 'Use Offline Mode', value: 'offline', description: 'For offline-mode servers.' },
                        ...u.profiles.map(p => ({ label: p.name, value: p.id }))
                    );
                const row = new ActionRowBuilder().addComponents(authMenu);
                return i.reply({ content: 'Choose your authentication method for the Java bot.', components: [row], ephemeral: true });
            }
            
            // General Buttons
            if (id === "cancel") return i.update({ content: "❌ Cancelled.", components: [], embeds: [] });
        }

        if (i.isStringSelectMenu()) {
            const u = getUser(uid);
            const type = i.customId === "sel_java_ver" ? 'java' : 'bedrock';
            
            if (i.customId === 'select_java_profile') {
                const selectedValue = i.values[0];
                if (selectedValue === 'offline') {
                    u.java.auth = 'offline';
                    u.java.selectedProfile = null;
                    await i.update({ content: '✅ Java bot set to **Offline Mode**.', components: [] });
                } else {
                    u.java.auth = 'online';
                    u.java.selectedProfile = selectedValue;
                    const profileName = u.profiles.find(p => p.id === selectedValue)?.name || 'Unknown Profile';
                    await i.update({ content: `✅ Java bot will now use **${profileName}** for online mode.`, components: [] });
                }
                saveDatabase();
                return;
            }

            if (type === 'java') u.java.selectedVersion = i.values[0];
            else u.bedrockVersion = i.values[0];
            saveDatabase();

            const profileId = type === 'java' ? null : (u.profiles[0]?.id || 'default');
            return showPreFlight(i, type, u, profileId, true);
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
    
    let content = `**Pre-Flight Check (${isJava ? 'Java' : 'Bedrock'})**\nTarget: \`${server.ip}:${server.port}\`\nVersion: \`${currentVer}\`\nReady to join?`;
    if (isJava) {
        const authProfile = u.profiles.find(p => p.id === u.java.selectedProfile);
        const authMode = u.java.auth === 'online' && authProfile ? `Online (${authProfile.name})` : 'Offline';
        content += `\nAuth Mode: \`${authMode}\``;
    }

    const payload = { content: content, components: [verRow, confirmRow], ephemeral: true };
    return isUpdate ? i.update(payload) : i.reply(payload);
}

function getSettingsModal(type, u) {
    if (type === 'java') {
        const m = new ModalBuilder().setCustomId("modal_java").setTitle("Java Server Settings");
        m.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.java.server?.ip || "").setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.java.server?.port || 25565))),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user").setLabel("Offline Username").setStyle(TextInputStyle.Short).setValue(u.java.offlineUsername || ""))
        );
        return m;
    } else {
        const m = new ModalBuilder().setCustomId("modal_bedrock").setTitle("Bedrock Settings");
         m.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "").setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132))),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("off").setLabel("Offline Username").setStyle(TextInputStyle.Short).setValue(u.offlineUsername || ""))
        );
        return m;
    }
}

async function handleLink(uid, interaction) {
    if (pendingAuth.has(uid)) return interaction.reply({ content: "⏳ Auth pending.", ephemeral: true });
    const u = getUser(uid);
    if (uid !== ROOT_ID && u.profiles.length >= 1) return interaction.reply({ content: "❌ You can only link one Xbox account.", ephemeral: true });
    
    const newProfileId = crypto.randomUUID().split('-')[0];
    const newAuthDir = getUserAuthDir(uid, newProfileId);

    const flow = new Authflow(uid, newAuthDir, { flow: "live", authTitle: Titles.MinecraftNintendoSwitch });

    await interaction.deferReply({ ephemeral: true });
    pendingAuth.set(uid, true);

    try {
        const msa = await flow.getMsaToken();
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Login to Microsoft").setStyle(ButtonStyle.Link).setURL(msa.verification_uri));
        await interaction.editReply({ content: `🔐 **Code:** \`${msa.user_code}\``, components: [row] });

        await flow.getMinecraftToken(); // Finishes the auth flow
        const u = getUser(uid);
        const newProfileName = `Xbox Account #${u.profiles.length + 1}`;
        u.profiles.push({ id: newProfileId, name: newProfileName, created: Date.now() });
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
        { label: "Auto-Detect (Recommended)", value: "auto" }, { label: "1.21", value: "1.21" },
        { label: "1.20.4", value: "1.20.4" }, { label: "1.19.4", value: "1.19.4" },
        { label: "1.18.2", value: "1.18.2" }, { label: "1.16.5", value: "1.16.5" },
        { label: "1.8.9", value: "1.8.9" }
    ] : [
        { label: "1.21.60 (Latest)", value: "1.21.60" }, { label: "1.21.50", value: "1.21.50" },
        { label: "1.21.40", value: "1.21.40" }
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
                new ButtonBuilder().setCustomId("set_java").setLabel("⚙ Server Settings").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("set_java_auth").setLabel("🔑 Auth Settings").setStyle(ButtonStyle.Secondary)
        )];
    } else {
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
