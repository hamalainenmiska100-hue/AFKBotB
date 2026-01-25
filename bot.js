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
  Partials
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");

// --- JÄRJESTELMÄN ASETUKSET ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// Gemini API Avaimet - Käytetään molempia tasapainottamaan kuormaa
const GEMINI_KEYS = [
  "AIzaSyAZbj5F2X-FLM6NSqz_3K1sciQMepX6JMA",
  "AIzaSyD51YhFcYCTp5HNOUZOZe14ymIhamILoOg"
];
const GEMINI_MODEL = "gemini-2.5-flash-lite";

// Käyttäjä-ID:t
const OWNER_ID = "1144987924123881564"; 
const ADMIN_IDS = [OWNER_ID]; 
const ALLOWED_GUILD_ID = "1462335230345089254";

// Uptime-virstanpylväät (minuutteina)
const MILESTONES = [30, 60, 120, 240, 360, 480, 720, 1440];

// ----------------- Pysyvä Tallennus (Fly.io Volume) -----------------
const DATA = fs.existsSync("/data") ? "/data" : path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

// Luodaan tarvittavat kansiot jos niitä ei ole
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

// Ladataan käyttäjädata
let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};

/**
 * Tallentaa käyttäjätiedot tiedostoon (users.json)
 */
function save() {
  try {
    fs.writeFileSync(STORE, JSON.stringify(users, null, 2));
  } catch (e) {
    console.error("Tallennusvirhe:", e);
  }
}

/**
 * Hakee käyttäjän datan tai luo uuden oletusarvoilla
 */
function getUser(uid) {
  if (!users[uid]) users[uid] = {};
  if (!users[uid].delayMs) users[uid].delayMs = 5000;
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  return users[uid];
}

/**
 * Palauttaa käyttäjän Microsoft-autentikaatiokansion polun
 */
function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Poistaa Microsoft-linkityksen tiedostot ja päivittää datan
 */
function unlinkMicrosoft(uid) {
  const dir = getUserAuthDir(uid);
  try { 
    fs.rmSync(dir, { recursive: true, force: true }); 
  } catch (e) {
    console.error(`Virhe poistaessa auth-kansiota käyttäjältä ${uid}:`, e);
  }
  const u = getUser(uid);
  u.linked = false;
  save();
}

// ----------------- Runtime Tila & Moottorit -----------------
const sessions = new Map(); // Aktiiviset botit
const pendingLink = new Map(); // Käynnissä olevat kirjautumiset
let currentKeyIndex = 0;

/**
 * Valitsee seuraavan vapaan Gemini API-avaimen
 */
function getGeminiKey() {
  const key = GEMINI_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS.length;
  return key;
}

// ----------------- Omistajan Lokitus (Owner Notify) -----------------
/**
 * Lähettää järjestelmäilmoituksen suoraan omistajalle DM:nä
 */
async function notifyOwner(content) {
  try {
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (owner) {
      const timestamp = new Date().toLocaleTimeString('fi-FI');
      await owner.send(`\`[${timestamp}]\` 📡 **Järjestelmäloki:** ${content}`).catch(() => {});
    }
  } catch (e) {
    console.error("Omistajalle ilmoittaminen epäonnistui:", e);
  }
}

// ----------------- Gemini AI Intelligence Hub -----------------
/**
 * Käyttää Geminiä analysoimaan tilanteita, virheitä tai RAM-käyttöä.
 */
async function askGemini(prompt, type = "general") {
  const apiKey = getGeminiKey();
  
  const systemInstruction = `You are AFKBot Intelligence, the core processor of a Minecraft Mega Factory.
  Role: System administrator and user assistant.
  Current Task: ${type === 'error' ? 'Analyze the connection error and provide a fix.' : 'Monitor backend health and RAM usage.'}
  Capabilities: You can trigger actions via brackets like [RAM_PURGE], [RECONNECT], [RESTART], or [WAIT].
  Rules:
  1. Be professional, technical, and modern. No "cringe" or over-dramatic text.
  2. If RAM is mentioned as high, explain that you will optimize resources.
  3. Tell the user exactly what steps to take in simple English.
  4. Never mention you are an AI. You are the AFKBot System.`;

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
    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || "System busy. Manual check required.";
    
    // Lokitetaan AI:n päätökset omistajalle
    notifyOwner(`AI Engine (${type}) teki analyysin: "${prompt.substring(0, 50)}..." -> Vastaus: ${result.substring(0, 100)}`);
    
    return result;
  } catch (e) {
    return "AI Module is currently reloading. Standard protocols active.";
  }
}

// ----------------- Discord Client -----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User]
});

// ----------------- UI Rakentajat (Moderni & Simppeli) -----------------
function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink Microsoft").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start Bot").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop Bot").setStyle(ButtonStyle.Danger),
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
      new ButtonBuilder().setLabel("🌐 Open Login Link").setStyle(ButtonStyle.Link).setURL(uri)
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

function aiConfirmationRow(action, uid) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ai_confirm_${action}_${uid}`).setLabel("Confirm Optimization").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ai_ignore_${uid}`).setLabel("Ignore Assistant").setStyle(ButtonStyle.Secondary)
  );
}

function versionRow(current = "auto") {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId("set_version").setPlaceholder("Select Bedrock Version").addOptions(
      { label: "Auto-detect", value: "auto", default: current === "auto" },
      { label: "1.21.x", value: "1.21.x", default: current === "1.21.x" },
      { label: "1.20.x", value: "1.20.x", default: current === "1.20.x" }
    )
  );
}

// ----------------- Microsoft Link (Aito Alkuperäinen Logiikka) -----------------
/**
 * Hoitaa Microsoft-kirjautumisprosessin täsmälleen alkuperäisellä tavalla
 */
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) {
    await interaction.editReply("⏳ Login process is already active. Please use the previous code.");
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
      const uri = data.verification_uri_complete || data.verification_uri || "https://www.microsoft.com/link";
      const code = data.user_code || "(no code)";
      codeShown = true;
      
      const msg = `🔐 **Microsoft login required**\n\n👉 ${uri}\n\nYour code: \`${code}\`\n\n⚠ **IMPORTANT:** Please use a secondary account. Come back here after logging in.`;
      
      await interaction.editReply({ content: msg, components: msaComponents(uri) }).catch(() => {});
      notifyOwner(`Käyttäjä <@${uid}> pyysi kirjautumiskoodia.`);
    }
  );

  const p = (async () => {
    try {
      if (!codeShown) await interaction.editReply("⏳ Requesting Microsoft authentication code…");
      await flow.getMsaToken();
      u.linked = true;
      save();
      await interaction.followUp({ ephemeral: true, content: "✅ Microsoft account successfully linked!" }).catch(() => {});
      notifyOwner(`Käyttäjä <@${uid}> linkitti Microsoft-tilin onnistuneesti.`);
    } catch (e) {
      const aiResponse = await askGemini(`Microsoft Linking Failed: ${e.message}`, "auth");
      await interaction.editReply({ content: `❌ **Authentication Failed**\n\n${aiResponse}` });
    } finally {
      pendingLink.delete(uid);
    }
  })();
  pendingLink.set(uid, p);
}

// ----------------- Bedrock Session Moottori (Tehdas) -----------------

/**
 * Puhdistaa session kaikki resurssit muistista ja sulkee yhteydet
 */
function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  
  if (s.afkInterval) clearInterval(s.afkInterval);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.uptimeTimer) clearInterval(s.uptimeTimer);
  if (s.healthMonitor) clearInterval(s.healthMonitor);
  if (s.timeout) clearTimeout(s.timeout);
  
  try { s.client.close(); } catch (e) {}
  sessions.delete(uid);
}

/**
 * Pysäyttää botin ja ilmoittaa siitä
 */
function stopBot(uid) {
  if (!sessions.has(uid)) return false;
  const s = sessions.get(uid);
  s.manualStop = true;
  cleanupSession(uid);
  notifyOwner(`Käyttäjä <@${uid}> pysäytti botin manuaalisesti.`);
  return true;
}

/**
 * Käynnistää Minecraft-session ja kaikki siihen liittyvät monitorit
 */
async function startSession(uid, interaction = null) {
  const u = getUser(uid);
  if (!u.server) {
    if (interaction) await interaction.editReply("⚠ Please configure your IP and Port in Settings first.");
    return;
  }

  // AMMATTIMAINEN START-ESTO: Estetään tuplajoinaukset
  if (sessions.has(uid) && !sessions.get(uid).isReconnecting) {
    if (interaction && !interaction.replied) {
      const msg = "⚠️ **Active Session Detected**\nYour AFK bot is already operational. To restart or change servers, please terminate the current session by tapping the **Stop Bot** button first.";
      await interaction.editReply(msg);
    }
    return;
  }

  const { ip, port } = u.server;

  // ATERNOS PROXY PROTECTION: Ping ennen liittymistä
  try {
    const ping = await bedrock.ping({ host: ip, port: port });
    const motd = (ping.motd || "").toLowerCase();
    if (motd.includes("offline") || motd.includes("starting") || motd.includes("queue")) {
      if (interaction) await interaction.editReply(`❌ Server Status: **Offline/Starting**. The bot will not connect to a proxy lobby. Please start your Aternos server first.`);
      return;
    }
  } catch (e) {
    if (interaction) await interaction.editReply(`❌ **Network Error**: The server at **${ip}** is unreachable.`);
    return;
  }

  const authDir = getUserAuthDir(uid);
  const opts = { 
    host: ip, 
    port, 
    connectTimeout: 45000, 
    keepAlive: true,
    version: u.bedrockVersion === "auto" ? undefined : u.bedrockVersion
  };

  if (u.connectionType === "offline") {
    opts.username = u.offlineUsername;
    opts.offline = true;
  } else {
    opts.username = uid;
    opts.profilesFolder = authDir;
  }

  const mc = bedrock.createClient(opts);
  const session = {
    client: mc,
    connected: false,
    manualStop: false,
    isReconnecting: false,
    startTime: Date.now(),
    milestones: [],
    retryCount: sessions.get(uid)?.retryCount || 0
  };
  sessions.set(uid, session);

  // Join Timeout
  session.timeout = setTimeout(async () => {
    if (!session.connected) {
      const aiAdvice = await askGemini(`Bot failed to spawn at ${ip}:${port} after 45s wait.`, "network");
      if (interaction) await interaction.editReply(`❌ **Connection Timeout**\n\n${aiAdvice}`);
      cleanupSession(uid);
    }
  }, 47000);

  mc.on("spawn", () => {
    session.connected = true;
    session.retryCount = 0;
    clearTimeout(session.timeout);
    notifyOwner(`Käyttäjän <@${uid}> botti yhdisti kohteeseen **${ip}:${port}**.`);

    if (interaction) {
      let msg = `🟢 Connected to **${ip}:${port}** (Auto-move active)`;
      const comps = [];
      if (Math.random() < 0.7) {
        msg += "\n\nHelp us keep AFKBot up by donating through Patreon!";
        comps.push(patreonRow());
      }
      interaction.editReply({ content: msg, components: comps }).catch(() => {});
    }

    // --- UPTIME MILESTONES (30min, 1h, 2h...) ---
    session.uptimeTimer = setInterval(async () => {
      const elapsedMins = Math.floor((Date.now() - session.startTime) / 60000);
      const milestone = MILESTONES.find(m => elapsedMins >= m && !session.milestones.includes(m));
      
      if (milestone) {
        session.milestones.push(milestone);
        const user = await client.users.fetch(uid).catch(() => null);
        if (user) {
          const timeLabel = milestone >= 60 ? `${milestone / 60}h` : `${milestone} minutes`;
          await user.send(`Congrats! Your bot has been up for **${timeLabel}**! 🥳`).catch(() => {});
          notifyOwner(`Käyttäjä <@${uid}> saavutti ${timeLabel} uptime-virstanpylvään.`);
        }
      }
    }, 60000);

    // --- ANTI-AFK MOVEMENT ---
    let moveToggle = false;
    session.afkInterval = setInterval(() => {
      try {
        if (!mc.entity?.position) return;
        const pos = { ...mc.entity.position };
        moveToggle ? pos.x += 0.5 : pos.x -= 0.5;
        moveToggle = !moveToggle;
        mc.write("move_player", {
          runtime_id: mc.entityId, position: pos, pitch: 0, yaw: Math.random() * 360,
          head_yaw: Math.random() * 360, mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false
        });
      } catch (err) {}
    }, 60000);

    // --- GEMINI HEALTH & RAM ASSISTANT ---
    session.healthMonitor = setInterval(async () => {
      const ramUsage = process.memoryUsage().heapUsed / 1024 / 1024;
      if (ramUsage > 480) { // Jos Node käyttää yli 480MB
        const analysis = await askGemini(`Backend RAM usage is high (${ramUsage.toFixed(1)}MB). Recommend [RAM_PURGE] for session ${uid}?`, "health");
        const user = await client.users.fetch(uid).catch(() => null);
        if (user) {
          await user.send({ 
            content: `🛡️ **System Assistant:** I've detected high resource usage. To keep your session stable, I recommend a quick resource optimization.\n\n${analysis}`,
            components: [aiConfirmationRow('purge', uid)]
          }).catch(() => {});
        }
        notifyOwner(`VAROITUS: Korkea RAM-käyttö (${ramUsage.toFixed(1)}MB). Gemini analysoi käyttäjän ${uid} session.`);
      }
    }, 300000); // 5 min välein
  });

  mc.on("error", async (err) => {
    if (session.manualStop) return;
    const errorMsg = String(err.message || err);
    notifyOwner(`VIRHE (Käyttäjä <@${uid}>): ${errorMsg}`);

    if (errorMsg.includes("auth") || errorMsg.includes("session")) {
      const user = await client.users.fetch(uid).catch(() => null);
      if (user) await user.send("❌ **Auth Failed**: Your Microsoft session has expired. Please use **Link Microsoft** again.").catch(() => {});
      return cleanupSession(uid);
    }

    // Jos virhe on outo, Gemini selittää sen käyttäjälle
    if (!errorMsg.toLowerCase().includes("timeout")) {
        const explanation = await askGemini(`Minecraft Client Error: ${errorMsg} at ${ip}`, "error");
        const user = await client.users.fetch(uid).catch(() => null);
        if (user) await user.send(`⚠️ **Bot Encountered an Error**\n\n${explanation}`).catch(() => {});
    }

    handleAutoReconnect(uid, interaction);
  });

  mc.on("close", () => {
    if (!session.manualStop) handleAutoReconnect(uid, interaction);
  });
}

/**
 * AGGRESSIIVINEN 30S REJOIN MOOTTORI
 */
function handleAutoReconnect(uid, interaction) {
  const s = sessions.get(uid);
  if (!s || s.manualStop || s.reconnectTimer) return;

  s.isReconnecting = true;
  s.connected = false;
  s.retryCount++;

  notifyOwner(`Sessio <@${uid}> katkesi. Yritetään uudelleen 30 sekunnin päästä. (Yritys #${s.retryCount})`);

  s.reconnectTimer = setTimeout(async () => {
    if (sessions.has(uid) && !s.manualStop) {
      const u = getUser(uid);
      // TARKISTETAAN JOKA 30S ONKO SERVU PÄÄLLÄ
      try {
        await bedrock.ping({ host: u.server.ip, port: u.server.port });
        console.log(`[TEHDAS] Kohdepalvelin ${u.server.ip} on ONLINE. Liitytään takaisin...`);
        startSession(uid, interaction);
      } catch (e) {
        // Jos servu on vielä alhaalla, nollataan ajastin ja yritetään uudelleen 30s päästä
        s.reconnectTimer = null;
        handleAutoReconnect(uid, interaction);
      }
    }
  }, 30000);
}

// ----------------- Interaction Router (Kaikki Komennot) -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    const uid = i.user.id;
    if (i.guildId !== ALLOWED_GUILD_ID && i.inGuild()) return;

    // --- ADMIN HALLINTA (Suomeksi) ---
    if (i.commandName === "admin") {
      if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "Pääsy evätty.", ephemeral: true });
      await i.deferReply();
      return i.editReply({ embeds: [buildAdminEmbed()], components: buildAdminComponents() });
    }

    if (i.customId?.startsWith("admin_")) {
      if (!ADMIN_IDS.includes(uid)) return;
      if (i.customId === "admin_refresh") return i.update({ embeds: [buildAdminEmbed()], components: buildAdminComponents() });
      if (i.customId === "admin_stop_all") {
        const count = sessions.size;
        for (const [id] of sessions) {
          cleanupSession(id);
          const user = await client.users.fetch(id).catch(() => null);
          if (user) await user.send("Your bot has been stopped by the owner for system maintenance ⚠️").catch(() => {});
        }
        notifyOwner(`Kaikki botit (${count} kpl) pysäytetty adminin toimesta.`);
        return i.update({ embeds: [buildAdminEmbed()], components: buildAdminComponents() });
      }
    }

    // --- AI ACTION VAHVISTUKSET ---
    if (i.customId?.startsWith("ai_confirm_purge_")) {
      const target = i.customId.split("_")[3];
      if (uid !== target) return i.reply({ content: "Access denied.", ephemeral: true });
      await i.update({ content: "⚡ **AI Optimization Active:** Cleaning resources and reconnecting...", components: [] });
      cleanupSession(target);
      setTimeout(() => startSession(target), 1500);
      return;
    }

    if (i.customId?.startsWith("ai_ignore_")) {
      await i.update({ content: "AI suggestion ignored. Stability not guaranteed.", components: [] });
      return;
    }

    // --- KÄYTTÄJÄ PANEELI ---
    if (i.commandName === "panel") {
      return i.reply({ content: "🎛 **AFKBot System Control**", components: panelRow() });
    }

    if (i.isButton()) {
      if (i.customId === "start") {
        await i.deferReply({ ephemeral: true });
        return startSession(uid, i);
      }
      if (i.customId === "stop") {
        const ok = stopBot(uid);
        let msg = ok ? "⏹ **Bot Terminated.** Your session has ended." : "❌ No active session found.";
        if (ok && Math.random() < 0.7) {
          msg += "\n\nHelp us keep AFKBot up by donating through Patreon!";
          return i.reply({ ephemeral: true, content: msg, components: [patreonRow()] });
        }
        return i.reply({ ephemeral: true, content: msg });
      }
      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true });
        return linkMicrosoft(uid, i);
      }
      if (i.customId === "unlink") {
        unlinkMicrosoft(uid);
        notifyOwner(`Käyttäjä <@${uid}> poisti Microsoft-linkityksen.`);
        return i.reply({ ephemeral: true, content: "🗑 Microsoft account unlinked." });
      }
      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Bot Configuration");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("Server IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("offline").setLabel("Offline Username").setStyle(TextInputStyle.Short).setValue(u.offlineUsername || ""))
        );
        return i.showModal(modal);
      }
      if (i.customId === "more") {
        const u = getUser(uid);
        return i.reply({ ephemeral: true, content: "➕ **Advanced Configuration**", components: [versionRow(u.bedrockVersion)] });
      }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
      const u = getUser(uid);
      u.server = { ip: i.fields.getTextInputValue("ip").trim(), port: parseInt(i.fields.getTextInputValue("port").trim()) || 19132 };
      u.offlineUsername = i.fields.getTextInputValue("offline").trim() || `AFK_${uid.slice(-4)}`;
      save();
      notifyOwner(`Käyttäjä <@${uid}> päivitti asetukset: ${u.server.ip}:${u.server.port}`);
      return i.reply({ ephemeral: true, content: "✅ Settings saved successfully." });
    }

    if (i.isStringSelectMenu() && i.customId === "set_version") {
      const u = getUser(uid);
      u.bedrockVersion = i.values[0];
      save();
      return i.reply({ ephemeral: true, content: `✅ Version set to: **${u.bedrockVersion}**` });
    }

  } catch (err) {
    console.error("Interaktio-virhe:", err);
    notifyOwner(`KRIITTINEN INTERAKTIOVIRHE: ${err.message}`);
  }
});

// ----------------- Admin Helpers (Suomeksi) -----------------
function buildAdminEmbed() {
  const activeBots = Array.from(sessions.entries()).map(([id, s]) => {
    const uptimeMins = Math.floor((Date.now() - s.startTime) / 60000);
    return `👤 <@${id}> (\`${id}\`)\nUptime: \`${uptimeMins} min\` | Yritykset: \`${s.retryCount}\` | Tila: \`${s.connected ? "🟢" : "🟡"}\``;
  }).join("\n\n") || "Ei aktiivisia botteja.";

  return new EmbedBuilder()
    .setTitle("🛡️ AFKBot Hallintapaneeli")
    .setColor("#ff0000")
    .addFields(
      { name: "Yleiset Tilastot", value: `Käyttäjiä tietokannassa: \`${Object.keys(users).length}\`\nAktiivisia sessioita: \`${sessions.size}\`` },
      { name: "Aktiiviset Botit", value: activeBots }
    )
    .setTimestamp()
    .setFooter({ text: "Tehdas-moottori online" });
}

function buildAdminComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin_refresh").setLabel("🔄 Päivitä").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin_stop_all").setLabel("☢️ Pysäytä Kaikki").setStyle(ButtonStyle.Danger)
  )];
}

// ----------------- Crash Guard & Lifecycle -----------------
process.on("unhandledRejection", (error) => {
  console.error("Guarded Unhandled Rejection:", error);
  notifyOwner(`Unhandled Rejection: \`${error.message}\``);
});

process.on("uncaughtException", (error) => {
  console.error("Guarded Uncaught Exception:", error);
  notifyOwner(`KRIITTINEN PROSESSIVIRHE (Estetty kaatuminen): \`${error.message}\``);
});

client.once("ready", async () => {
  console.log(`🟢 AFKBot MEGA FACTORY V3 ONLINE: ${client.user.tag}`);
  notifyOwner("Botti on käynnistynyt ja taustajärjestelmät ovat online-tilassa.");
  
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Open system control panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Open administrator control panel")
  ];
  await client.application.commands.set(cmds);
});

client.login(DISCORD_TOKEN);

