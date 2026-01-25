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
  EmbedBuilder,
  PermissionFlagsBits
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// --- KONFIGURAATIO & API AVAIMET ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_KEYS = [
  "AIzaSyAZbj5F2X-FLM6NSqz_3K1sciQMepX6JMA",
  "AIzaSyD51YhFcYCTp5HNOUZOZe14ymIhamILoOg"
];
const GEMINI_MODEL = "gemini-2.5-flash-lite";

// --- ADMIN ASETUKSET ---
const ADMIN_IDS = ["1144987924123881564"];
const ALLOWED_GUILD_ID = "1462335230345089254";

if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing from environment!");
  process.exit(1);
}

// ----------------- Tallennusjärjestelmä (Fly.io Volume) -----------------
const DATA = fs.existsSync("/data") ? "/data" : path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};

/**
 * Tallentaa käyttäjätiedot levylle
 */
function save() {
  try {
    fs.writeFileSync(STORE, JSON.stringify(users, null, 2));
  } catch (error) {
    console.error("Critical storage error:", error);
  }
}

/**
 * Hakee käyttäjän tiedot tai luo oletusasetukset
 */
function getUser(uid) {
  if (!users[uid]) {
    users[uid] = {};
  }
  if (!users[uid].delayMs) users[uid].delayMs = 5000;
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  return users[uid];
}

/**
 * Hakee käyttäjäkohtaisen auth-kansion polun
 */
function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Poistaa Microsoft-linkityksen tiedostot
 */
function unlinkMicrosoft(uid) {
  const dir = getUserAuthDir(uid);
  try { 
    fs.rmSync(dir, { recursive: true, force: true }); 
  } catch (e) {}
  const u = getUser(uid);
  u.linked = false;
  save();
}

// ----------------- Runtime Hallinta -----------------
const sessions = new Map(); // Sisältää botit, intervallit ja tilan
const pendingLink = new Map();
const lastMsa = new Map();
let currentKeyIndex = 0;

/**
 * Tasapainottaa Gemini-kutsuja kahden avaimen välillä
 */
function getGeminiKey() {
  const key = GEMINI_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS.length;
  return key;
}

// ----------------- Gemini AI "Intelligence Engine" -----------------

/**
 * Gemini-apulainen, joka analysoi virheet, RAM-käytön ja palvelimen tilan.
 */
async function askGeminiAssistant(prompt, type = "error") {
  const apiKey = getGeminiKey();
  
  const systemInstruction = `You are AFKBot Intelligence, a professional Minecraft Bedrock assistant.
  Current Context: The bot maintains player presence on servers. It moves the player to avoid kicks.
  Role: ${type === 'error' ? 'Analyze the error and suggest fixes.' : 'Monitor server health and RAM usage.'}
  Instructions:
  - Explain the situation in clear English.
  - Suggest one of these actions in brackets if needed: [RECONNECT], [RAM_PURGE], [RESTART], [WAIT].
  - Tell the user EXACTLY what they can do (e.g., check server IP, re-link Microsoft).
  - Be concise, technical, and professional. Do not act like a chat bot.
  - If RAM usage is mentioned as high, explain that a RAM_PURGE will quickly reconnect to save resources.`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: systemInstruction }] }
      })
    });

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "System anomaly detected. Please check your settings manually.";
  } catch (e) {
    return `AI Engine is under maintenance. Error: ${prompt}`;
  }
}

// ----------------- Discord Client -----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
  ]
});

// ----------------- UI Rakentajat -----------------

function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink Microsoft").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("more").setLabel("➕ More Options").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function msaComponents(uri) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("🌐 Open link").setStyle(ButtonStyle.Link).setURL(uri)
    )
  ];
}

function patreonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Donate 💸")
      .setStyle(ButtonStyle.Link)
      .setURL("https://patreon.com/AFKBot396")
  );
}

function aiActionConfirmRow(action, uid) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ai_confirm_${action}_${uid}`).setLabel("Confirm AI Action").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ai_ignore_${uid}`).setLabel("Ignore").setStyle(ButtonStyle.Secondary)
  );
}

function versionRow(current = "auto") {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("set_version")
    .setPlaceholder("🌐 Bedrock Version")
    .addOptions(
      { label: "Auto", value: "auto", default: current === "auto" },
      { label: "1.21.x", value: "1.21.x", default: current === "1.21.x" },
      { label: "1.20.x", value: "1.20.x", default: current === "1.20.x" }
    );
  return new ActionRowBuilder().addComponents(menu);
}

function connRow(current = "online") {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("set_conn")
    .setPlaceholder("🔌 Connection Type")
    .addOptions(
      { label: "Online (Microsoft)", value: "online", default: current === "online" },
      { label: "Offline (Cracked)", value: "offline", default: current === "offline" }
    );
  return new ActionRowBuilder().addComponents(menu);
}

// ----------------- Microsoft Link (Aito Alkuperäinen Logiikka) -----------------

async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) {
    await interaction.editReply("⏳ Login already in progress. Use the last code.");
    return;
  }

  const authDir = getUserAuthDir(uid);
  const u = getUser(uid);
  let codeShown = false;

  const flow = new Authflow(
    uid,
    authDir,
    {
      flow: "live",
      authTitle: Titles?.MinecraftNintendoSwitch || "Bedrock AFK Bot",
      deviceType: "Nintendo"
    },
    async (data) => {
      // TÄMÄ ON TÄSMÄLLEEN ALKUPERÄINEN CALLBACK
      const uri = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
      const code = data.user_code || "(no code)";
      lastMsa.set(uid, { uri, code, at: Date.now() });
      codeShown = true;

      const msg =
        `🔐 **Microsoft login required**\n\n` +
        `👉 ${uri}\n\n` +
        `Your code: \`${code}\`\n\n` +
        `⚠ **IMPORTANT:** Use a *second* Microsoft account.\n` +
        `Do **NOT** use the account you normally play with.\n\n` +
        `Come back here after login.`;

      await interaction.editReply({ 
        content: msg, 
        components: msaComponents(uri) 
      }).catch(() => {});
    }
  );

  const p = (async () => {
    try {
      if (!codeShown) await interaction.editReply("⏳ Requesting Microsoft login code…");
      await flow.getMsaToken();
      u.linked = true;
      save();
      await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account linked!" }).catch(() => {});
    } catch (e) {
      // Gemini selittää jos kirjautuminen epäonnistuu oudosti
      const explanation = await askGeminiAssistant(`Microsoft Login Error: ${e.message}`);
      await interaction.editReply(`❌ **Login Failed**\n\n${explanation}`).catch(() => {});
    } finally {
      pendingLink.delete(uid);
    }
  })();

  pendingLink.set(uid, p);
}

// ----------------- Bedrock Session Hallinta (Tehdas-taso) -----------------

/**
 * Puhdistaa session kaikki resurssit (muisti, intervallit, ajastimet)
 */
function cleanupSessionResources(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  
  if (s.afkInterval) clearInterval(s.afkInterval);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.timeout) clearTimeout(s.timeout);
  if (s.healthCheckInterval) clearInterval(s.healthCheckInterval);
  
  try { 
    s.client.close(); 
  } catch (e) {}
  
  sessions.delete(uid);
}

/**
 * Pysäyttää botin manuaalisesti
 */
function stopSession(uid) {
  const s = sessions.get(uid);
  if (!s) return false;
  s.manualStop = true;
  cleanupSessionResources(uid);
  return true;
}

/**
 * Käynnistää Minecraft-session ja asettaa monitoroinnit
 */
async function startSession(uid, interaction = null) {
  const u = getUser(uid);
  if (!u.server) {
    if (interaction) await interaction.editReply("⚠ Please configure your server settings first.");
    return;
  }
  
  // TÄRKEÄ KORJAUS: Estetään päällekkäiset botit
  if (sessions.has(uid) && !sessions.get(uid).isReconnecting) {
    if (interaction) {
        const msg = "⚠️ **Active Session Detected**\nYour AFK bot is already operational. To restart or change settings, please terminate the current session by tapping the **Stop** button first.";
        await interaction.editReply(msg);
    }
    return;
  }

  const { ip, port } = u.server;

  // Aternos Proxy Protection (Ping before connecting)
  try {
    const pingData = await bedrock.ping({ host: ip, port: port });
    const motd = (pingData.motd || "").toLowerCase();
    if (motd.includes("offline") || motd.includes("starting") || motd.includes("queue")) {
        if (interaction) await interaction.editReply(`❌ Server is **Offline/Starting**. Bot will not join a proxy lobby.`);
        return;
    }
  } catch (e) {
    if (interaction) await interaction.editReply(`❌ Network Error: Server **${ip}** is unreachable.`);
    return;
  }

  const authDir = getUserAuthDir(uid);
  const opts = {
    host: ip,
    port,
    connectTimeout: 47000,
    keepAlive: true
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername;
    opts.offline = true;
  } else {
    opts.username = uid;
    opts.offline = false;
    opts.profilesFolder = authDir;
  }

  const mc = bedrock.createClient(opts);
  
  // Luodaan uusi session-objekti
  const session = {
    client: mc,
    connected: false,
    manualStop: false,
    isReconnecting: false,
    retryCount: sessions.get(uid)?.retryCount || 0,
    startTime: Date.now(),
    afkInterval: null,
    healthCheckInterval: null,
    timeout: null
  };
  sessions.set(uid, session);

  // Yhteyden aikakatkaisu (Spawn Timeout)
  session.timeout = setTimeout(async () => {
    if (!session.connected) {
      const advice = await askGeminiAssistant(`Failed to receive spawn packet from ${ip} within 47s.`);
      if (interaction) await interaction.editReply(`❌ **Connection Timeout**\n\n${advice}`);
      cleanupSessionResources(uid);
    }
  }, 48000);

  mc.on("spawn", () => {
    session.connected = true;
    session.retryCount = 0;
    clearTimeout(session.timeout);

    if (interaction) {
        let msg = `🟢 Connected to **${ip}:${port}** (Auto-move active)`;
        const comps = [];
        if (Math.random() < 0.7) {
          msg += "\n\nHelp us keep AFKBot up by donating through Patreon!";
          comps.push(patreonRow());
        }
        interaction.editReply({ content: msg, components: comps }).catch(() => {});
    }

    // --- Anti-AFK Liike ---
    let moveToggle = false;
    session.afkInterval = setInterval(() => {
      try {
        if (!mc.entity?.position) return;
        const pos = { ...mc.entity.position };
        moveToggle ? pos.x += 0.5 : pos.x -= 0.5;
        moveToggle = !moveToggle;

        mc.write("move_player", {
          runtime_id: mc.entityId,
          position: pos,
          pitch: 0,
          yaw: Math.random() * 360,
          head_yaw: Math.random() * 360,
          mode: 0,
          on_ground: true,
          ridden_runtime_id: 0,
          teleport: false
        });
      } catch (err) {}
    }, 60000);

    // --- RAM & Terveys-monitori (Gemini Assistant) ---
    session.healthCheckInterval = setInterval(async () => {
       const mem = process.memoryUsage().heapUsed / 1024 / 1024;
       if (mem > 450) { // Jos muistinkäyttö on korkea
          const report = await askGeminiAssistant(`High RAM usage detected: ${mem.toFixed(1)}MB. Recommend RAM_PURGE?`, "health");
          const user = await client.users.fetch(uid).catch(() => null);
          if (user) {
             await user.send({
                content: `🛡️ **Assistant:** I've detected high resource load. Would you like me to optimize your session?\n\n${report}`,
                components: [aiActionConfirmRow('purge', uid)]
             }).catch(() => {});
          }
       }
    }, 180000); // 3 min välein
  });

  mc.on("error", async (e) => {
    clearTimeout(session.timeout);
    if (session.manualStop) return;

    const errorMsg = String(e?.message || e);
    const isAuth = errorMsg.toLowerCase().includes("auth") || errorMsg.toLowerCase().includes("session");
    const isTimeout = errorMsg.toLowerCase().includes("timeout") || errorMsg.toLowerCase().includes("etimedout");

    if (isAuth) {
      const user = await client.users.fetch(uid).catch(() => null);
      if (user) await user.send("❌ **Authentication Expired!** Please re-link your Microsoft account in the panel.").catch(() => {});
      return cleanupSessionResources(uid);
    }

    if (!isTimeout) {
       // Kysytään Geminiltä tuntemattomasta virheestä
       const aiHelp = await askGeminiAssistant(`Client Error: ${errorMsg} at ${ip}`);
       if (interaction) await interaction.editReply(`⚠️ **Session Error**\n\n${aiHelp}`).catch(() => {});
    }

    handleAutoReconnect(uid, interaction);
  });

  mc.on("close", () => {
    if (!session.manualStop) {
        handleAutoReconnect(uid, interaction);
    }
  });
}

/**
 * Luotettava uudelleenkytkentä-logiikka eksponentiaalisella odotuksella
 */
function handleAutoReconnect(uid, interaction) {
    const s = sessions.get(uid);
    if (!s || s.manualStop || s.reconnectTimer) return;

    s.isReconnecting = true;
    s.connected = false;
    s.retryCount++;
    
    // Odotusaika pitenee yritysten myötä: 30s -> 45s -> 67s... (Max 5 min)
    const delay = Math.min(30000 * Math.pow(1.5, s.retryCount - 1), 300000);
    
    s.reconnectTimer = setTimeout(() => {
        if (sessions.has(uid) && !s.manualStop) {
            console.log(`[FACTORY] Rejoining user ${uid} (Attempt #${s.retryCount})`);
            startSession(uid, interaction);
        }
    }, delay);
}

// ----------------- Interaction Router (Kaikki yhdessä) -----------------

client.on(Events.InteractionCreate, async (i) => {
  try {
    const uid = i.user.id;
    if (i.guildId !== ALLOWED_GUILD_ID && i.inGuild()) {
       return i.reply({ content: "This bot cannot be used in this server ⛔️", ephemeral: true });
    }

    // --- Admin Hallinta ---
    if (i.commandName === "admin") {
        if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "Pääsy evätty. ⛔", ephemeral: true });
        await i.deferReply({ ephemeral: false });
        await i.editReply({ embeds: [buildAdminEmbed()], components: buildAdminComponents() });
        
        const adminInterval = setInterval(async () => {
           try { await i.editReply({ embeds: [buildAdminEmbed()], components: buildAdminComponents() }); }
           catch (e) { clearInterval(adminInterval); }
        }, 30000);
        return;
    }

    // --- Admin Painikkeet ---
    if (i.customId?.startsWith("admin_")) {
        if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "Pääsy evätty.", ephemeral: true });
        if (i.customId === "admin_refresh") return i.update({ embeds: [buildAdminEmbed()], components: buildAdminComponents() });
        if (i.customId === "admin_stop_all") {
           for (const [id] of sessions) {
              stopSession(id);
              const user = await client.users.fetch(id).catch(() => null);
              if (user) await user.send("Your bot has been stopped by the owner for maintenance ⚠️").catch(() => {});
           }
           return i.update({ embeds: [buildAdminEmbed()], components: buildAdminComponents() });
        }
    }

    // --- Gemini AI Vahvistukset ---
    if (i.customId?.startsWith("ai_confirm_purge_")) {
       const target = i.customId.split("_")[3];
       if (uid !== target) return i.reply({ content: "Not your session.", ephemeral: true });
       await i.update({ content: "⚡ **Optimizing resources...** (Purging RAM and reconnecting)", components: [] });
       cleanupSessionResources(uid);
       setTimeout(() => startSession(uid), 1500);
       return;
    }
    if (i.customId?.startsWith("ai_ignore_")) {
       await i.update({ content: "Assistant recommendation ignored.", components: [] });
       return;
    }

    // --- Käyttäjän Slash Komennot ---
    if (i.isChatInputCommand()) {
      if (i.commandName === "panel") {
        return i.reply({ content: "🎛 **Bedrock AFK Panel**", components: panelRow() });
      }
    }

    // --- Painikkeet ---
    if (i.isButton()) {
      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true });
        return linkMicrosoft(uid, i);
      }

      if (i.customId === "unlink") {
        unlinkMicrosoft(uid);
        let msg = "🗑 Microsoft account unlinked for your user.";
        if (shouldShowPatreon()) {
           msg += "\n\nHelp us keep AFKBot up by donating through Patreon!";
           return i.reply({ ephemeral: true, content: msg, components: [patreonRow()] });
        }
        return i.reply({ ephemeral: true, content: msg });
      }

      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("⚙ Bedrock Settings");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setRequired(true).setValue(u.server?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port (19132)").setStyle(TextInputStyle.Short).setRequired(true).setValue(String(u.server?.port || 19132))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("offline").setLabel("Offline username").setStyle(TextInputStyle.Short).setRequired(false).setValue(u.offlineUsername || ""))
        );
        return i.showModal(modal);
      }

      if (i.customId === "start") {
        await i.deferReply({ ephemeral: true });
        return startSession(uid, i);
      }

      if (i.customId === "stop") {
        const ok = stopSession(uid);
        if (!ok) return i.reply({ ephemeral: true, content: "No active bots running." });
        let msg = "⏹ **Bot Stopped.** Connection closed.";
        if (shouldShowPatreon()) {
          msg += "\n\nHelp us keep AFKBot up by donating through Patreon!";
          return i.reply({ ephemeral: true, content: msg, components: [patreonRow()] });
        }
        return i.reply({ ephemeral: true, content: msg });
      }

      if (i.customId === "more") {
        const u = getUser(uid);
        let msg = "➕ **Extended Options**";
        const comps = [
          new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("invisible").setLabel("👻 Hide Bot").setStyle(ButtonStyle.Secondary)),
          versionRow(u.bedrockVersion),
          connRow(u.connectionType)
        ];
        if (shouldShowPatreon()) {
          msg += "\n\nHelp us keep AFKBot up by donating through Patreon!";
          comps.push(patreonRow());
        }
        return i.reply({ ephemeral: true, content: msg, components: comps });
      }

      if (i.customId === "invisible") {
        const s = sessions.get(uid);
        if (!s) return i.reply({ ephemeral: true, content: "Bot is not online." });
        try {
          s.client.write("command_request", { command: "/gamemode survival @s", internal: false, version: 2 });
          return i.reply({ ephemeral: true, content: "Ghost protocol attempted." });
        } catch (e) {
          return i.reply({ ephemeral: true, content: "Command execution failed." });
        }
      }
    }

    // --- Select Menut & Modalit ---
    if (i.isStringSelectMenu()) {
      const u = getUser(uid);
      if (i.customId === "set_version" || i.customId === "set_conn") {
        if (i.customId === "set_version") u.bedrockVersion = i.values[0];
        else u.connectionType = i.values[0];
        save();
        return i.reply({ ephemeral: true, content: "✅ Setting updated." });
      }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
      const u = getUser(uid);
      u.server = { ip: i.fields.getTextInputValue("ip").trim(), port: parseInt(i.fields.getTextInputValue("port").trim(), 10) };
      const off = i.fields.getTextInputValue("offline").trim();
      if (off) u.offlineUsername = off;
      save();
      return i.reply({ ephemeral: true, content: `✅ Configuration Saved: \`${u.server.ip}:${u.server.port}\`` });
    }

  } catch (err) {
    console.error("Critical Interaction Error:", err);
  }
});

// ----------------- Admin Helpers (Suomeksi) -----------------

function buildAdminEmbed() {
  const activeBots = Array.from(sessions.entries()).map(([id, s]) => {
    const duration = Math.floor((Date.now() - s.startTime) / 60000);
    return `👤 <@${id}> (\`${id}\`)\nKesto: \`${duration} min\` | Yritykset: \`${s.retryCount}\` | Tila: \`${s.connected ? "🟢 Online" : "🟡 Yhdistää"}\``;
  }).join("\n\n") || "Ei aktiivisia botteja.";

  return new EmbedBuilder()
    .setTitle("🛡️ AFKBot Hallintapaneeli")
    .setColor("#ff0000")
    .addFields(
      { name: "Globaalit Tilastot", value: `Käyttäjiä DB:ssä: \`${Object.keys(users).length}\`\nAktiivisia sessioita: \`${sessions.size}\`` },
      { name: "Aktiiviset Botit", value: activeBots }
    )
    .setTimestamp()
    .setFooter({ text: "Päivittyy automaattisesti 30s välein" });
}

function buildAdminComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_refresh").setLabel("🔄 Päivitä").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_stop_all").setLabel("☢️ Pysäytä Kaikki").setStyle(ButtonStyle.Danger)
    )
  ];
}

function shouldShowPatreon() {
  return Math.random() < 0.7;
}

// ----------------- Virhesuojaus & Lifecycle -----------------

process.on("unhandledRejection", (error) => {
  console.error("Unhandled Promise Rejection (Guarded):", error);
});

process.on("uncaughtException", (error) => {
  console.error("CRITICAL EXCEPTION (Guarded):", error);
});

client.once("ready", async () => {
  console.log(`🟢 AFKBot MEGA FACTORY ONLINE: ${client.user.tag}`);
  
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Open Admin Control Panel")
  ];

  await client.application.commands.set(cmds);
});

client.login(DISCORD_TOKEN);

