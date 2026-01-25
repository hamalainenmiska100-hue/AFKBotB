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

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN missing");
  process.exit(1);
}

// --- GEMINI CONFIGURATION ---
const GEMINI_API_KEY = "AIzaSyAZbj5F2X-FLM6NSqz_3K1sciQMepX6JMA";
const GEMINI_MODEL = "gemini-2.5-flash-lite";

// --- ADMIN CONFIGURATION ---
const ADMIN_IDS = ["1144987924123881564"];
const ALLOWED_GUILD_ID = "1462335230345089254";

// ----------------- Storage (Fly.io Volume & Persistence) -----------------
const DATA = fs.existsSync("/data") ? "/data" : path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};
function save() {
  fs.writeFileSync(STORE, JSON.stringify(users, null, 2));
}

function getUser(uid) {
  if (!users[uid]) users[uid] = {};
  if (!users[uid].delayMs) users[uid].delayMs = 5000;
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  return users[uid];
}

function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function unlinkMicrosoft(uid) {
  const dir = getUserAuthDir(uid);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  const u = getUser(uid);
  u.linked = false;
  save();
}

// ----------------- Runtime -----------------
const sessions = new Map();
const pendingLink = new Map();
const lastMsa = new Map();

// ----------------- Discord client -----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
  ]
});

// ----------------- Gemini AI Smart Error Handler -----------------
async function explainUnknownError(error, context) {
  const systemInstruction = `You are a technical support assistant for a Minecraft Bedrock AFK bot. 
  The bot connects to servers to prevent AFK kicks by moving the player periodically.
  Explain the following error in clear English. 
  Describe what the bot was trying to do when this happened.
  Advise the user on what THEY can do to fix it (e.g., check server settings, white-list the bot, or check firewall).
  Keep it professional and concise. Only provide the explanation and advice.`;

  const userQuery = `Error: ${error}\nContext: ${context}`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemInstruction }] }
      })
    });

    if (!response.ok) return "The bot encountered an unusual error. Please check your server IP and version settings.";
    const result = await response.json();
    return result.candidates?.[0]?.content?.parts?.[0]?.text || "Unexpected connection issue. Please ensure the server is online and accessible.";
  } catch (e) {
    return `Technical error occurred: ${error}. Please verify your configuration.`;
  }
}

function denyIfWrongGuild(i) {
  if (!i.inGuild() || i.guildId !== ALLOWED_GUILD_ID) {
    const msg = "This bot cannot be used in this server ⛔️";
    if (i.deferred) return i.editReply(msg).catch(() => {});
    if (i.replied) return i.followUp({ ephemeral: true, content: msg }).catch(() => {});
    return i.reply({ ephemeral: true, content: msg }).catch(() => {});
  }
  return null;
}

// ----------------- UI helpers -----------------
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
      new ButtonBuilder().setCustomId("more").setLabel("➕ More").setStyle(ButtonStyle.Secondary)
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
      .setURL("https://patreon.com/AFKBot396?utm_medium=unknown&utm_source=join_link&utm_campaign=creatorshare_creator&utm_content=copyLink")
  );
}

function shouldShowPatreon() {
  return Math.random() < 0.7; // ~70% mahdollisuus
}

function versionRow(current = "auto") {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("set_version")
    .setPlaceholder("🌐 Bedrock Version")
    .addOptions(
      { label: "Auto", value: "auto", default: current === "auto" },
      { label: "1.21.x", value: "1.21.x", default: current === "1.21.x" },
      { label: "1.20.x", value: "1.20.x", default: current === "1.20.x" },
      { label: "1.19.x", value: "1.19.x", default: current === "1.19.x" }
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

// ----------------- Admin Panel Logic (Finnish) -----------------
function buildAdminEmbed() {
    const activeSessions = sessions.size;
    const totalUsersInDb = Object.keys(users).length;
    
    let activeBotsText = "";
    const activeUids = Array.from(sessions.keys());
    
    if (activeUids.length === 0) {
        activeBotsText = "Ei aktiivisia botteja.";
    } else {
        activeUids.forEach(uid => {
            const u = users[uid];
            const s = sessions.get(uid);
            const status = s.connected ? "🟢 Online" : "🟡 Yhdistää...";
            activeBotsText += `👤 <@${uid}>\n📍 \`${u.server?.ip || "N/A"}:${u.server?.port || "19132"}\` | ${status}\n\n`;
        });
    }

    return new EmbedBuilder()
        .setTitle("🛡️ AFKBot Hallintapaneeli")
        .setDescription("Reaaliaikainen palvelimen seuranta.")
        .setColor("#ff0000")
        .addFields(
            { name: "📊 Globaalit Tilastot", value: `Käyttäjiä tietokannassa: \`${totalUsersInDb}\`\nAktiivisia sessioita: \`${activeSessions}\``, inline: false },
            { name: "🤖 Aktiiviset Botit", value: activeBotsText || "Ei tietoja", inline: false }
        )
        .setTimestamp()
        .setFooter({ text: "Päivittyy automaattisesti 30 sekunnin välein" });
}

function buildAdminComponents() {
    const rows = [];
    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("admin_refresh").setLabel("🔄 Päivitä nyt").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("admin_stop_all").setLabel("☢️ Pysäytä kaikki").setStyle(ButtonStyle.Danger)
    );
    rows.push(buttonRow);

    if (sessions.size > 0) {
        const options = Array.from(sessions.keys()).map(uid => ({
            label: `Pysäytä käyttäjä ${uid}`,
            value: uid,
            description: `IP: ${sessions.get(uid).client?.options?.host || "tuntematon"}`
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId("admin_stop_user")
            .setPlaceholder("Valitse botti sammutettavaksi")
            .addOptions(options.slice(0, 25));

        rows.push(new ActionRowBuilder().addComponents(selectMenu));
    }

    return rows;
}

async function stopAndNotifyAdminAction(uid) {
    stopSession(uid);
    try {
        const user = await client.users.fetch(uid);
        if (user) {
            await user.send("Your bot has been stopped by the owner ⚠️").catch(() => {});
        }
    } catch (e) {
        console.error(`DM notification failed for user ${uid}`);
    }
}

// ----------------- Microsoft link (Original Logic) -----------------
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

      await interaction.editReply({ content: msg, components: msaComponents(uri) }).catch(() => {});
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
      const explanation = await explainUnknownError(e.message, "Microsoft Linking Process");
      await interaction.editReply({ content: `❌ **Linking Failed**\n\n${explanation}` }).catch(() => {});
    } finally {
      pendingLink.delete(uid);
    }
  })();

  pendingLink.set(uid, p);
}

// ----------------- Bedrock session -----------------
function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.afkInterval) clearInterval(s.afkInterval);
  try { s.client.close(); } catch {}
  sessions.delete(uid);
}

function stopSession(uid) {
  if (!sessions.get(uid)) return false;
  const s = sessions.get(uid);
  s.manualStop = true; 
  cleanupSession(uid);
  return true;
}

async function startSession(uid, interaction) {
  const u = getUser(uid);
  if (!u.server) {
    if (interaction && !interaction.replied) interaction.editReply("⚠ Set your settings first.");
    return;
  }
  
  // --- TÄRKEÄ KORJAUS: Estetään päällekkäiset botit ---
  if (sessions.has(uid)) {
    if (interaction && !interaction.replied) {
        const msg = "⚠️ **Bot Already Running**\nYour AFK bot is currently active. If you wish to restart or change servers, please tap the **Stop** button before starting again.";
        interaction.editReply(msg);
    }
    return;
  }

  const { ip, port } = u.server;

  // --- Aternos/Proxy Protection ---
  try {
    const pingData = await bedrock.ping({ host: ip, port: port });
    const motd = (pingData.motd || "").toLowerCase();
    if (motd.includes("offline") || motd.includes("starting") || motd.includes("queue")) {
        if (interaction) interaction.editReply(`❌ Server Status: **Offline/Starting**. Bot will not join a proxy lobby.`).catch(() => {});
        return;
    }
  } catch (e) {
    const explanation = await explainUnknownError(e.message, `Pinging server at ${ip}:${port}`);
    if (interaction) interaction.editReply(`❌ **Connection Error**\n\n${explanation}`).catch(() => {});
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
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  } else {
    opts.username = uid;
    opts.offline = false;
    opts.profilesFolder = authDir;
  }

  const mc = bedrock.createClient(opts);
  
  let currentSession = { client: mc, timeout: null, startedAt: Date.now(), manualStop: false, connected: false, afkInterval: null };
  sessions.set(uid, currentSession);

  const waitForEntity = setInterval(() => {
    if (!mc.entity || !mc.entityId) return;

    clearInterval(waitForEntity);

    let moveToggle = false;
    currentSession.afkInterval = setInterval(() => {
      try {
        const pos = { ...mc.entity.position };
        moveToggle ? pos.x += 0.5 : pos.x -= 0.5;
        moveToggle = !moveToggle;

        mc.write("move_player", {
          runtime_id: mc.entityId, position: pos, pitch: 0, yaw: Math.random() * 360,
          head_yaw: Math.random() * 360, mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false
        });
      } catch {}
    }, 60 * 1000);

    mc.once("close", () => { if(currentSession.afkInterval) clearInterval(currentSession.afkInterval); });
    mc.once("error", () => { if(currentSession.afkInterval) clearInterval(currentSession.afkInterval); });
  }, 1000);

  currentSession.timeout = setTimeout(async () => {
    if (sessions.get(uid) && !currentSession.connected) {
      if (interaction && !interaction.replied) {
          const explanation = await explainUnknownError("Timeout", "Waiting for server spawn");
          interaction.editReply(`❌ **Spawn Timeout**\n\n${explanation}`).catch(() => {});
      }
      mc.close();
    }
  }, 47000);

  mc.on("spawn", () => {
    currentSession.connected = true;
    clearTimeout(currentSession.timeout);
    if (interaction) {
        let msg = `🟢 Connected to **${ip}:${port}** (Auto-move active)`;
        const comps = [];
        if (shouldShowPatreon()) {
          msg += "\n\nHelp us keep AFKBot up by donating through Patreon!";
          comps.push(patreonRow());
        }
        interaction.editReply({ content: msg, components: comps }).catch(() => {});
    }
  });

  mc.on("error", async (e) => {
    clearTimeout(currentSession.timeout);
    let errorMsg = e.message || String(e);
    
    const isTimeout = errorMsg.toLowerCase().includes("timeout") || errorMsg.toLowerCase().includes("etimedout");
    const isAuth = errorMsg.toLowerCase().includes("auth") || errorMsg.toLowerCase().includes("session");
    
    if (isTimeout) {
      if (interaction) interaction.editReply("⚠️ **Network Latency** — Connection lost. Retrying in 30s...").catch(() => {});
    } else if (isAuth) {
      if (interaction) interaction.editReply("❌ **Auth Expired** — Please re-link your Microsoft account.").catch(() => {});
      stopSession(uid);
      return;
    } else if (!currentSession.manualStop) {
      const explanation = await explainUnknownError(errorMsg, `Session at ${ip}:${port}`);
      if (interaction) interaction.editReply(`⚠️ **Session Error**\n\n${explanation}`).catch(() => {});
    }

    if (!currentSession.manualStop) {
        handleAutoReconnect(uid, interaction);
    }
  });

  mc.on("close", () => {
    clearTimeout(currentSession.timeout);
    if (!currentSession.manualStop) {
        handleAutoReconnect(uid, interaction);
    }
  });
}

function handleAutoReconnect(uid, interaction) {
    const s = sessions.get(uid);
    if (!s || s.manualStop || s.reconnectTimer) return;

    s.isReconnecting = true;
    s.connected = false;
    
    s.reconnectTimer = setTimeout(() => {
        if (sessions.has(uid) && !s.manualStop) {
            s.reconnectTimer = null;
            startSession(uid, interaction);
        }
    }, 30000);
}

// ----------------- Interaction Router -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    const blocked = denyIfWrongGuild(i);
    if (blocked) return;
    const uid = i.user.id;

    if (i.isChatInputCommand() && i.commandName === "admin") {
        if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "Pääsy evätty. ⛔", ephemeral: true });
        await i.deferReply({ ephemeral: false });
        await i.editReply({ embeds: [buildAdminEmbed()], components: buildAdminComponents() });
        const interval = setInterval(async () => {
            try { await i.editReply({ embeds: [buildAdminEmbed()], components: buildAdminComponents() }); } 
            catch (e) { clearInterval(interval); }
        }, 30000);
        return;
    }

    if (i.customId?.startsWith("admin_")) {
        if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "Pääsy evätty. ⛔", ephemeral: true });
        if (i.customId === "admin_refresh") return i.update({ embeds: [buildAdminEmbed()], components: buildAdminComponents() });
        if (i.customId === "admin_stop_all") {
            const uids = Array.from(sessions.keys());
            for (const id of uids) await stopAndNotifyAdminAction(id);
            return i.update({ embeds: [buildAdminEmbed()], components: buildAdminComponents() });
        }
        if (i.customId === "admin_stop_user") {
            const target = i.values[0];
            await stopAndNotifyAdminAction(target);
            return i.update({ embeds: [buildAdminEmbed()], components: buildAdminComponents() });
        }
    }

    if (i.isChatInputCommand() && i.commandName === "panel") {
      return i.reply({ content: "🎛 **Bedrock AFK Panel**", components: panelRow() });
    }

    if (i.isButton()) {
      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true });
        return linkMicrosoft(uid, i);
      }
      if (i.customId === "unlink") {
        unlinkMicrosoft(uid);
        let msg = "🗑 Microsoft account unlinked.";
        const comps = [];
        if (shouldShowPatreon()) { msg += "\n\nHelp us keep AFKBot up by donating through Patreon!"; comps.push(patreonRow()); }
        return i.reply({ ephemeral: true, content: msg, components: comps });
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
        if (!ok) return i.reply({ ephemeral: true, content: "No active sessions found." });
        let msg = "⏹ **Bot Stopped.** Connection closed.";
        const comps = [];
        if (shouldShowPatreon()) { msg += "\n\nHelp us keep AFKBot up by donating through Patreon!"; comps.push(patreonRow()); }
        return i.reply({ ephemeral: true, content: msg, components: comps });
      }
      if (i.customId === "more") {
        const u = getUser(uid);
        let msg = "➕ **More options**";
        const comps = [
          new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("invisible").setLabel("👻 Hide Bot").setStyle(ButtonStyle.Secondary)),
          versionRow(u.bedrockVersion), connRow(u.connectionType)
        ];
        if (shouldShowPatreon()) { msg += "\n\nHelp us keep AFKBot up by donating through Patreon!"; comps.push(patreonRow()); }
        return i.reply({ ephemeral: true, content: msg, components: comps });
      }
    }

    if (i.isStringSelectMenu()) {
      const u = getUser(uid);
      if (i.customId === "set_version" || i.customId === "set_conn") {
        if (i.customId === "set_version") u.bedrockVersion = i.values[0];
        else u.connectionType = i.values[0];
        save();
        return i.reply({ ephemeral: true, content: "✅ Settings updated." });
      }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
      const u = getUser(uid);
      u.server = { ip: i.fields.getTextInputValue("ip").trim(), port: parseInt(i.fields.getTextInputValue("port").trim(), 10) };
      const off = i.fields.getTextInputValue("offline").trim();
      if (off) u.offlineUsername = off;
      save();
      return i.reply({ ephemeral: true, content: `✅ Saved: \`${u.server.ip}:${u.server.port}\`` });
    }

  } catch (e) { console.error("Interaction error:", e); }
});

client.once("ready", async () => {
  console.log("🟢 Online as", client.user.tag);
  const cmds = [
    new SlashCommandBuilder().setName("panel").setDescription("Open Bedrock AFK panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Open Admin Control Panel")
  ];
  await client.application.commands.set(cmds);
});

process.on("unhandledRejection", (e) => console.error("Unhandled Rejection:", e));
process.on("uncaughtException", (e) => console.error("Uncaught Exception:", e));

client.login(DISCORD_TOKEN);

