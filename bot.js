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

// --- KONFIGURAATIO ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_KEYS = [
  "AIzaSyAZbj5F2X-FLM6NSqz_3K1sciQMepX6JMA",
  "AIzaSyD51YhFcYCTp5HNOUZOZe14ymIhamILoOg"
];
const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";

const OWNER_ID = "1144987924123881564";
const ADMIN_IDS = [OWNER_ID];
const ALLOWED_GUILD_ID = "1462335230345089254";
const SUPPORT_CHANNEL_ID = "1462398161074000143";
const MILESTONES = [30, 60, 120, 240, 360, 480, 720, 1440];

// --- TALLENNUS ---
const DATA = fs.existsSync("/data") ? "/data" : path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

let users = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : {};
let systemLogs = [];
let totalRamOptimized = 0;

function addLog(msg) {
  const ts = new Date().toLocaleTimeString('fi-FI');
  systemLogs.unshift(`\`[${ts}]\` ${msg}`);
  if (systemLogs.length > 50) systemLogs.pop();
}

function save() {
  try {
    fs.writeFileSync(STORE, JSON.stringify(users, null, 2));
  } catch (e) {
    process.stderr.write(`Tallennusvirhe: ${e.message}\n`);
  }
}

function getUser(uid) {
  if (!users[uid]) users[uid] = {};
  if (!users[uid].delayMs) users[uid].delayMs = 5000;
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].bedrockVersion) users[uid].bedrockVersion = "auto";
  if (!users[uid].offlineUsername) users[uid].offlineUsername = `AFK_${uid.slice(-4)}`;
  if (users[uid].banned === undefined) users[uid].banned = false;
  if (users[uid].linked === undefined) users[uid].linked = false;
  return users[uid];
}

// --- RUNTIME TILA ---
const sessions = new Map();
const pendingLink = new Map();
let currentKeyIndex = 0;

function getGeminiKey() {
  const key = GEMINI_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS.length;
  return key;
}

async function notifyOwner(content) {
  try {
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (owner) {
      const ts = new Date().toLocaleTimeString('fi-FI');
      await owner.send(`\`[${ts}]\` 📡 **Ilmoitus:** ${content}`).catch(() => {});
    }
  } catch (e) {}
}

async function askGemini(prompt, type = "general") {
  const apiKey = getGeminiKey();
  const systemInstruction = `Olet AFKBot AI.
Backend: Node.js, bedrock-protocol, prismarine-auth.
UI: Discord Dashboard (Link, Unlink, Start, Stop, Settings, Get Help, More).
Toiminnot:
- Link: Microsoft-kirjautuminen Authflowlla. Callback näyttää koodin heti.
- Start: Pingaa servun (Aternos-tarkistus), yhdistää, liikuttaa pelaajaa spawnissa.
- Stop: Sulkee yhteyden ja siivoaa muistin.
- Get Help: Automaattinen diagnostiikka (ping + status) tai manuaalinen tuki.
- Admin Hub: System stats, BC Discord, BC MC, User Browser, Blacklist.

Säännöt tuki-kanavalle (${SUPPORT_CHANNEL_ID}):
Jos viesti EI ole avunpyyntö tai ongelma, vastaa VAIN: [NoCont]
Jos se ON avunpyyntö, auta käyttäjää backend-tietosi perusteella. Käytä emojeita. Suomi/Englanti.`;

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
    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || "[NoCont]";
    return result;
  } catch (e) {
    return "[NoCont]";
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User]
});

// --- UI RAKENTAJAT ---
function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("get_help").setLabel("🆘 Get Help").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("more").setLabel("➕ More").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function adminHubRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_sys").setLabel("📊 System").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_bc_discord").setLabel("💬 Discord BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_bc_mc").setLabel("⛏️ Game BC").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_logs").setLabel("📜 Logs").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_users").setLabel("👥 User Browser").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_blacklist").setLabel("🚫 Blacklist").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_stop_all").setLabel("☢️ Kill All").setStyle(ButtonStyle.Danger)
    )
  ];
}

function helpMenuRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("help_choice")
      .setPlaceholder("🆘 Miten voimme auttaa?")
      .addOptions(
        { label: "Tunnista ongelma automaattisesti", value: "auto_detect", emoji: "🔍" },
        { label: "Kirjoita oma ongelma", value: "custom_input", emoji: "✍️" }
      )
  );
}

function patreonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Support & Donate 💸").setStyle(ButtonStyle.Link).setURL("https://patreon.com/AFKBot396")
  );
}

function aiActionRow(action, uid) {
  const label = action === 'purge' ? '🚀 RAM Optimointi' : '🔄 Pikayhdistys';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ai_confirm_${action}_${uid}`).setLabel(label).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ai_ignore_${uid}`).setLabel("Ohita").setStyle(ButtonStyle.Secondary)
  );
}

// --- SESSION ENGINE ---
function cleanup(uid) {
  const s = sessions.get(uid); if (!s) return;
  if (s.afkInterval) clearInterval(s.afkInterval);
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.uptimeTimer) clearInterval(s.uptimeTimer);
  if (s.healthMonitor) clearInterval(s.healthMonitor);
  if (s.timeout) clearTimeout(s.timeout);
  try { s.client.close(); } catch (e) {}
  sessions.delete(uid);
}

function unlinkMicrosoft(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  const u = getUser(uid);
  u.linked = false;
  save();
}

async function startSession(uid, interaction = null) {
  const u = getUser(uid);
  if (u.banned) return interaction?.editReply("🚫 Olet estetty.");
  if (sessions.has(uid) && !sessions.get(uid).isReconnecting) {
    if (interaction) await interaction.editReply("⚠️ Botti on jo online-tilassa.");
    return;
  }
  const { ip, port } = u.server || {};
  if (!ip) return interaction?.editReply("⚠️ Määritä IP ja Portti asetuksista!");
  
  try {
    const ping = await bedrock.ping({ host: ip, port: port });
    if ((ping.motd || "").toLowerCase().match(/offline|starting|queue/)) {
      if (interaction) await interaction.editReply(`❌ Palvelin on Offline tai jonossa. Botti ei liity.`); return;
    }
  } catch (e) { if (interaction) await interaction.editReply(`❌ Ei yhteyttä palvelimeen.`); return; }

  const mc = bedrock.createClient({ 
    host: ip, port, connectTimeout: 45000, keepAlive: true, 
    version: u.bedrockVersion === "auto" ? undefined : u.bedrockVersion, 
    username: u.connectionType === "offline" ? u.offlineUsername : uid, 
    offline: u.connectionType === "offline", 
    profilesFolder: u.connectionType === "offline" ? undefined : path.join(AUTH_ROOT, uid) 
  });
  
  const session = { client: mc, connected: false, manualStop: false, isReconnecting: false, startTime: Date.now(), milestones: [], retryCount: sessions.get(uid)?.retryCount || 0 };
  sessions.set(uid, session);

  session.timeout = setTimeout(() => {
    if (!session.connected) { if (interaction) interaction.editReply(`❌ Aikakatkaisu yhdistettäessä.`); cleanup(uid); }
  }, 47000);

  mc.on("spawn", () => {
    session.connected = true; session.retryCount = 0; clearTimeout(session.timeout);
    addLog(`Käyttäjä ${uid} spawnasi servulle ${ip}`);
    if (interaction) interaction.editReply({ content: `🟢 **Yhdistetty** kohteeseen **${ip}:${port}**\nAnti-AFK liike aktivoitu! 🏃‍♂️`, components: [patreonRow()] }).catch(() => {});

    session.uptimeTimer = setInterval(async () => {
      const mins = Math.floor((Date.now() - session.startTime) / 60000);
      const m = MILESTONES.find(v => mins >= v && !session.milestones.includes(v));
      if (m) {
        session.milestones.push(m);
        const user = await client.users.fetch(uid).catch(() => null);
        if (user) await user.send(`Onnittelut! Bottisi on ollut päällä **${m >= 60 ? (m/60)+'h' : m+' min'}**! 🥳`).catch(() => {});
      }
    }, 60000);

    let toggle = false;
    session.afkInterval = setInterval(() => {
      try { 
        if (!mc.entity?.position) return; 
        const pos = { ...mc.entity.position }; 
        toggle ? pos.x += 0.5 : pos.x -= 0.5; toggle = !toggle; 
        mc.write("move_player", { runtime_id: mc.entityId, position: pos, pitch: 0, yaw: Math.random() * 360, head_yaw: Math.random() * 360, mode: 0, on_ground: true, ridden_runtime_id: 0, teleport: false }); 
      } catch (e) {}
    }, 60000);

    session.healthMonitor = setInterval(async () => {
      const ram = process.memoryUsage().heapUsed / 1024 / 1024;
      if (ram > 490) {
        const res = await askGemini(`RAM High (${ram.toFixed(1)}MB). Recommend [RAM_PURGE] for user ${uid}?`);
        const user = await client.users.fetch(uid).catch(() => null);
        if (user && res.includes("[RAM_PURGE]")) {
           const clean = res.replace("[RAM_PURGE]", "").trim();
           await user.send({ content: `🛡️ **AI Assistentti:** Järjestelmä vaatii optimointia.\n\n${clean}`, components: [aiActionRow('purge', uid)] }).catch(() => {});
           totalRamOptimized += 50;
        }
      }
    }, 300000);
  });

  mc.on("error", (err) => { if (!session.manualStop) handleAutoReconnect(uid, interaction); });
  mc.on("close", () => { if (!session.manualStop) handleAutoReconnect(uid, interaction); });
}

function handleAutoReconnect(uid, interaction) {
  const s = sessions.get(uid); if (!s || s.manualStop || s.reconnectTimer) return;
  s.isReconnecting = true; s.connected = false; s.retryCount++;
  notifyOwner(`Uudelleenyhdistys (<@${uid}>): Yritys ${s.retryCount}`);
  s.reconnectTimer = setTimeout(async () => {
    if (sessions.has(uid) && !s.manualStop) {
      const u = getUser(uid);
      try { await bedrock.ping({ host: u.server.ip, port: u.server.port }); startSession(uid, interaction); }
      catch (e) { s.reconnectTimer = null; handleAutoReconnect(uid, interaction); }
    }
  }, 30000);
}

// --- EVENTIT ---
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  if (msg.channelId !== SUPPORT_CHANNEL_ID) return;
  const aiRes = await askGemini(`Käyttäjä <@${msg.author.id}> kanavalla: ${msg.content}`, "support");
  if (aiRes.includes("[NoCont]")) return;
  await msg.reply({ content: aiRes });
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    const uid = i.user.id;
    if (i.guildId !== ALLOWED_GUILD_ID && i.inGuild()) return;

    if (i.isButton()) {
      if (i.customId === "get_help") return i.reply({ content: "🆘 **Tuki & Diagnostiikka**\nValitse menetelmä alta:", components: [helpMenuRow()], ephemeral: true });
      if (i.customId === "start") { await i.deferReply({ ephemeral: true }); return startSession(uid, i); }
      if (i.customId === "stop") { cleanup(uid); return i.reply({ ephemeral: true, content: "⏹ Botti sammutettu.", components: [patreonRow()] }); }
      if (i.customId === "unlink") { unlinkMicrosoft(uid); return i.reply({ ephemeral: true, content: "🗑 Microsoft-linkitys poistettu." }); }
      
      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true });
        const authDir = path.join(AUTH_ROOT, uid);
        const flow = new Authflow(uid, authDir, { flow: "live", authTitle: "Bedrock AFK Bot", deviceType: "Nintendo" }, async (data) => {
          const msg = `🔐 **Microsoft Login**\n\n👉 ${data.verification_uri}\n\nKoodi: \`${data.user_code}\`\n\nPalaa tänne kun olet kirjautunut selaimessa.`;
          await i.editReply({ content: msg, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Avaa Linkki").setStyle(ButtonStyle.Link).setURL(data.verification_uri)), patreonRow()] }).catch(() => {});
        });
        await flow.getMsaToken();
        getUser(uid).linked = true; save();
        return i.followUp({ ephemeral: true, content: "✅ Microsoft-tili linkitetty onnistuneesti!" });
      }

      if (i.customId === "admin_sys") {
        if (!ADMIN_IDS.includes(uid)) return;
        const mem = process.memoryUsage();
        const embed = new EmbedBuilder().setTitle("📊 Järjestelmän tila").setColor("#00ff00").addFields(
          { name: "Heap", value: `\`${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB\``, inline: true },
          { name: "Sessiot", value: `\`${sessions.size}\``, inline: true },
          { name: "Optimointi", value: `\`${totalRamOptimized} MB\``, inline: true }
        );
        return i.reply({ embeds: [embed], ephemeral: true });
      }

      if (i.customId === "admin_bc_discord") {
        if (!ADMIN_IDS.includes(uid)) return;
        const modal = new ModalBuilder().setCustomId("bc_discord_modal").setTitle("📢 Discord Broadcast");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bc_chan").setLabel("Kanava ID").setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bc_msg").setLabel("Viesti").setStyle(TextInputStyle.Paragraph).setRequired(true)));
        return i.showModal(modal);
      }

      if (i.customId === "admin_bc_mc") {
        if (!ADMIN_IDS.includes(uid)) return;
        const modal = new ModalBuilder().setCustomId("bc_mc_modal").setTitle("⛏️ Game Broadcast");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bc_msg").setLabel("Viesti kaikille boteille").setStyle(TextInputStyle.Short).setRequired(true)));
        return i.showModal(modal);
      }

      if (i.customId === "admin_users") {
        if (!ADMIN_IDS.includes(uid)) return;
        const uList = Object.keys(users).map(id => ({ label: `UID: ${id}`, value: id })).slice(0, 25);
        if (uList.length === 0) return i.reply({ content: "DB on tyhjä.", ephemeral: true });
        const menu = new StringSelectMenuBuilder().setCustomId("admin_user_view").setPlaceholder("Valitse käyttäjä").addOptions(uList);
        return i.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      }

      if (i.customId === "admin_logs") {
        if (!ADMIN_IDS.includes(uid)) return;
        return i.reply({ content: `📜 **Viimeisimmät lokit:**\n${systemLogs.join("\n") || "Tyhjä."}`, ephemeral: true });
      }

      if (i.customId === "admin_stop_all") {
        if (!ADMIN_IDS.includes(uid)) return;
        for (const [id] of sessions) cleanup(id);
        return i.reply({ content: "☢️ Kaikki botit tapettu.", ephemeral: true });
      }

      if (i.customId === "admin_blacklist") {
        if (!ADMIN_IDS.includes(uid)) return;
        const modal = new ModalBuilder().setCustomId("bl_modal").setTitle("🚫 Blacklist Control");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bl_id").setLabel("Käyttäjä ID").setStyle(TextInputStyle.Short).setRequired(true)));
        return i.showModal(modal);
      }

      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("Asetukset");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("offline").setLabel("Offline-nimi").setStyle(TextInputStyle.Short).setValue(u.offlineUsername || ""))
        );
        return i.showModal(modal);
      }

      if (i.customId === "more") {
        const u = getUser(uid);
        const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId("set_version").setPlaceholder("Bedrock Versio").addOptions({ label: "Auto-detect", value: "auto", default: u.bedrockVersion === "auto" }, { label: "1.21.x", value: "1.21.x", default: u.bedrockVersion === "1.21.x" }));
        return i.reply({ ephemeral: true, content: "➕ **Lisäasetukset**", components: [row, patreonRow()] });
      }

      if (i.customId?.startsWith("ai_confirm_")) {
        cleanup(uid); setTimeout(() => startSession(uid), 1500);
        return i.update({ content: "⚡ Optimoidaan järjestelmää...", components: [] });
      }
      if (i.customId?.startsWith("ai_ignore_")) return i.update({ content: "Optimointi hylätty.", components: [] });
    }

    if (i.isStringSelectMenu()) {
      if (i.customId === "admin_user_view") {
        const target = i.values[0];
        const u = users[target];
        const embed = new EmbedBuilder().setTitle(`👤 Käyttäjän tiedot: ${target}`).setColor("#00ffff").addFields(
          { name: "Palvelin", value: `\`${u.server?.ip || "N/A"}:${u.server?.port || "19132"}\`` },
          { name: "Tyyppi", value: `\`${u.connectionType}\`` },
          { name: "Linkitetty", value: `\`${u.linked}\`` },
          { name: "Banned", value: `\`${u.banned}\`` },
          { name: "Nimi", value: `\`${u.offlineUsername}\`` }
        );
        return i.reply({ embeds: [embed], ephemeral: true });
      }
      if (i.customId === "help_choice") {
        const choice = i.values[0];
        if (choice === "auto_detect") {
          await i.update({ content: "⏳ **AI Thinking…** Analysoidaan tilaa...", components: [] });
          const u = getUser(uid); const s = sessions.get(uid); let pingRes = "Offline";
          try { const p = await bedrock.ping({ host: u.server?.ip, port: u.server?.port }); pingRes = `Online (${p.motd})`; } catch (e) {}
          const res = await askGemini(`Diagnostic: Server ${u.server?.ip}, Status ${s?.connected ? 'OK' : 'FAIL'}, Ping ${pingRes}`, "help");
          let comps = [patreonRow()]; let clean = res;
          ['RECONNECT', 'RAM_PURGE', 'RESTART'].forEach(a => { if (res.includes(`[${a}]`)) { clean = clean.replace(`[${a}]`, "").trim(); comps.push(aiActionRow(a.toLowerCase().replace("ram_", ""), uid)); } });
          return i.editReply({ content: `🆘 **AI Diagnostiikka**\n\n${clean}`, components: comps });
        }
        if (choice === "custom_input") {
          const modal = new ModalBuilder().setCustomId("custom_help_modal").setTitle("Kuvaile ongelmasi");
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("p_text").setLabel("Mikä mättää?").setStyle(TextInputStyle.Paragraph).setRequired(true)));
          return i.showModal(modal);
        }
      }
      if (i.customId === "set_version") {
        const u = getUser(uid); u.bedrockVersion = i.values[0]; save();
        return i.reply({ ephemeral: true, content: "✅ Versio päivitetty." });
      }
    }

    if (i.isModalSubmit()) {
      if (i.customId === "bc_discord_modal") {
        const chan = await client.channels.fetch(i.fields.getTextInputValue("bc_chan")).catch(() => null);
        if (chan) {
          await chan.send({ embeds: [new EmbedBuilder().setTitle("📢 Tiedote").setDescription(i.fields.getTextInputValue("bc_msg")).setColor("#ffcc00").setTimestamp()] });
          return i.reply({ content: "✅ Lähetetty Discordiin.", ephemeral: true });
        }
        return i.reply({ content: "❌ Kanavaa ei löytynyt.", ephemeral: true });
      }
      if (i.customId === "bc_mc_modal") {
        let count = 0; const msg = i.fields.getTextInputValue("bc_msg");
        for (const [id, s] of sessions) {
          if (s.connected) {
            s.client.write("text", { type: "chat", needs_translation: false, source_name: "", xuid: "", platform_chat_id: "", message: `§e[ADMIN] §f${msg}` });
            count++;
          }
        }
        return i.reply({ content: `✅ Lähetetty ${count} botille peliin.`, ephemeral: true });
      }
      if (i.customId === "settings_modal") {
        const u = getUser(uid);
        u.server = { ip: i.fields.getTextInputValue("ip").trim(), port: parseInt(i.fields.getTextInputValue("port").trim()) || 19132 };
        u.offlineUsername = i.fields.getTextInputValue("offline").trim() || `AFK_${uid.slice(-4)}`;
        save();
        return i.reply({ ephemeral: true, content: "✅ Asetukset tallennettu." });
      }
      if (i.customId === "bl_modal") {
        const target = i.fields.getTextInputValue("bl_id");
        const u = getUser(target); u.banned = !u.banned; save();
        if (u.banned) cleanup(target);
        return i.reply({ content: `✅ Päivitetty (Banned: ${u.banned}).`, ephemeral: true });
      }
      if (i.customId === "custom_help_modal") {
        await i.reply({ content: "⏳ **AI Thinking…**", ephemeral: true });
        const res = await askGemini(`User manual report: "${i.fields.getTextInputValue("p_text")}" on ${getUser(uid).server?.ip}`, "help");
        return i.editReply({ content: `🆘 **AI Vastaus**\n\n${res}`, components: [patreonRow()] });
      }
    }

    if (i.commandName === "panel") return i.reply({ content: "🎛 **AFKBot Hallinta**", components: panelRow() });
    if (i.commandName === "admin") {
      if (!ADMIN_IDS.includes(uid)) return i.reply({ content: "⛔ Pääsy evätty.", ephemeral: true });
      return i.reply({ content: "🛡️ **Admin Hub**", components: adminHubRows(), ephemeral: true });
    }

  } catch (err) { process.stderr.write(`Error: ${err.message}\n`); }
});

process.on("unhandledRejection", (e) => addLog(`REJECTION: ${e.message}`));
process.on("uncaughtException", (e) => addLog(`CRASH: ${e.message}`));

client.once("ready", async () => {
  addLog("Järjestelmä käynnistetty. ✨");
  await client.application.commands.set([
    new SlashCommandBuilder().setName("panel").setDescription("Avaa hallintapaneeli"),
    new SlashCommandBuilder().setName("admin").setDescription("Admin Hub")
  ]);
});

client.login(DISCORD_TOKEN);

