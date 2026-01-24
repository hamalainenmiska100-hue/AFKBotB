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
  StringSelectMenuBuilder
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

const ALLOWED_GUILD_ID = "1462335230345089254";

// ----------------- Säilytys -----------------
const DATA = path.join(__dirname, "data");
const AUTH_ROOT = path.join(DATA, "auth");
const STORE = path.join(DATA, "users.json");

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);
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
  intents: [GatewayIntentBits.Guilds]
});

function denyIfWrongGuild(i) {
  if (!i.inGuild() || i.guildId !== ALLOWED_GUILD_ID) {
    const msg = "Tätä bottia ei voi käyttää tällä palvelimella ⛔️";
    if (i.deferred) return i.editReply(msg).catch(() => {});
    if (i.replied) return i.followUp({ ephemeral: true, content: msg }).catch(() => {});
    return i.reply({ ephemeral: true, content: msg }).catch(() => {});
  }
  return null;
}

// ----------------- UI-apulaiset -----------------
function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Linkitä Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Poista linkitys").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Käynnistä").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Pysäytä").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Asetukset").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("more").setLabel("➕ Lisää").setStyle(ButtonStyle.Secondary)
    )
  ];
}

// ----------------- Slash-komennot -----------------
client.once("ready", async () => {
  console.log("🟢 Botti online:", client.user.tag);
  const cmds = [new SlashCommandBuilder().setName("panel").setDescription("Avaa Bedrock AFK-paneeli")];
  await client.application.commands.set(cmds);
});

// ----------------- Microsoft linkitys -----------------
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) {
    await interaction.editReply("⏳ Kirjautuminen on jo käynnissä.");
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
      const code = data.user_code || "(ei koodia)";
      lastMsa.set(uid, { uri, code, at: Date.now() });
      codeShown = true;

      const msg = `🔐 **Microsoft-kirjautuminen vaaditaan**\n\n👉 ${uri}\n\nKoodisi: \`${code}\`\n\nPalaa tänne kun olet kirjautunut.`;
      await interaction.editReply({ 
        content: msg, 
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("🌐 Avaa linkki").setStyle(ButtonStyle.Link).setURL(uri))]
      }).catch(() => {});
    }
  );

  const p = (async () => {
    try {
      if (!codeShown) await interaction.editReply("⏳ Pyydetään koodia…");
      await flow.getMsaToken();
      u.linked = true;
      save();
      await interaction.followUp({ ephemeral: true, content: "✅ Microsoft-tili linkitetty!" }).catch(() => {});
    } catch (e) {
      await interaction.editReply(`❌ Virhe kirjautumisessa: ${String(e.message)}`).catch(() => {});
    } finally {
      pendingLink.delete(uid);
    }
  })();
  pendingLink.set(uid, p);
}

// ----------------- Bedrock-sessio & Fysiikka -----------------

function cleanupSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  if (s.timeout) clearTimeout(s.timeout);
  if (s.physicsLoop) clearInterval(s.physicsLoop);
  if (s.rejoinTimeout) clearTimeout(s.rejoinTimeout);
  try { s.client.close(); } catch {}
  sessions.delete(uid);
}

function stopSession(uid) {
  if (!sessions.has(uid)) return false;
  const s = sessions.get(uid);
  s.manualStop = true;
  cleanupSession(uid);
  return true;
}

function startSession(uid, interaction) {
  const u = getUser(uid);
  if (!u.server) {
    if (interaction && !interaction.replied) interaction.editReply("⚠ Määritä asetukset ensin.");
    return;
  }

  if (sessions.has(uid) && !sessions.get(uid).isDisconnected) return;

  const { ip, port } = u.server;
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
    opts.profilesFolder = authDir;
  }

  const mc = bedrock.createClient(opts);
  
  const session = { 
    client: mc, 
    timeout: null, 
    physicsLoop: null, 
    rejoinTimeout: null, 
    manualStop: false,
    isDisconnected: false,
    // Fysiikkamuuttujat
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    isMoving: false
  };
  sessions.set(uid, session);

  session.timeout = setTimeout(() => {
    if (sessions.has(uid) && !session.isDisconnected) {
      cleanupSession(uid);
      if (interaction) interaction.editReply("❌ Yhteyden aikakatkaisu.").catch(() => {});
    }
  }, 47000);

  mc.on("spawn", () => {
    clearTimeout(session.timeout);
    if (interaction) interaction.editReply(`🟢 Bot online: **${ip}:${port}**. Realistinen fysiikka käytössä.`).catch(() => {});

    // Alustetaan sijainti spawniin
    if (mc.entity?.position) {
      session.pos = { ...mc.entity.position };
    }

    // --- REALISTINEN FYSIIKKAMOOTTORI ---
    // Minecraft tick on 50ms (20 TPS)
    session.physicsLoop = setInterval(() => {
      if (!mc.entityId) return;

      const friction = 0.91; // Normaali maan kitka
      const acceleration = 0.08; // Kävelyn kiihtyvyys per tick
      
      // Päätetään satunnaisesti liikkumisesta (simuloidaan näppäinpainalluksia)
      const now = Date.now();
      if (!session.nextActionTime || now > session.nextActionTime) {
        session.isMoving = !session.isMoving;
        // Liikutaan 2-5 sekuntia, sitten huilataan 15-30 sekuntia
        session.nextActionTime = now + (session.isMoving ? 3000 : 20000 + Math.random() * 10000);
        
        if (session.isMoving) {
          // Valitaan satunnainen suunta (eteen tai taakse suhteessa yawiin)
          session.moveDir = Math.random() > 0.5 ? 1 : -1;
          session.yaw = Math.random() * 360; // Käänny satunnaiseen suuntaan
        }
      }

      // Jos liikkeessä, lisää kiihtyvyyttä nopeuteen
      if (session.isMoving) {
        const rad = (session.yaw + 90) * (Math.PI / 180);
        session.vel.x += Math.cos(rad) * acceleration * session.moveDir;
        session.vel.z += Math.sin(rad) * acceleration * session.moveDir;
      }

      // Käytä kitkaa nopeuteen
      session.vel.x *= friction;
      session.vel.z *= friction;

      // Jos nopeus on hyvin pieni, nollaa se
      if (Math.abs(session.vel.x) < 0.001) session.vel.x = 0;
      if (Math.abs(session.vel.z) < 0.001) session.vel.z = 0;

      // Päivitä sijainti nopeuden perusteella
      session.pos.x += session.vel.x;
      session.pos.z += session.vel.z;

      // Lähetä liike-paketti vain jos on liikettä tai kääntymistä
      if (session.vel.x !== 0 || session.vel.z !== 0 || session.isMoving) {
        try {
          mc.write("move_player", {
            runtime_id: mc.entityId,
            position: session.pos,
            pitch: session.pitch,
            yaw: session.yaw,
            head_yaw: session.yaw,
            mode: 0,
            on_ground: true,
            ridden_runtime_id: 0,
            teleport: false
          });
        } catch {}
      }
    }, 50); 
  });

  mc.on("close", () => {
    session.isDisconnected = true;
    if (session.physicsLoop) clearInterval(session.physicsLoop);
    
    // --- AUTOMAATTINEN REJOIN (2 min) ---
    if (!session.manualStop) {
      console.log(`Botti potkittiin (${uid}). Yritetään uudelleen 2min päästä...`);
      session.rejoinTimeout = setTimeout(() => {
        if (!session.manualStop) startSession(uid, interaction);
      }, 120000);
    } else {
      cleanupSession(uid);
    }
  });

  mc.on("error", (e) => {
    session.isDisconnected = true;
    console.error("MC Error:", e);
  });
}

// ----------------- Vuorovaikutus -----------------
client.on(Events.InteractionCreate, async (i) => {
  try {
    const blocked = denyIfWrongGuild(i);
    if (blocked) return;

    const uid = i.user.id;

    if (i.isChatInputCommand() && i.commandName === "panel") {
      return i.reply({ content: "🎛 **Bedrock AFK-ohjauspaneeli**", components: panelRow() });
    }

    if (i.isButton()) {
      if (i.customId === "link") {
        await i.deferReply({ ephemeral: true });
        return linkMicrosoft(uid, i);
      }
      if (i.customId === "start") {
        await i.deferReply({ ephemeral: true });
        await i.editReply("⏳ Muodostetaan yhteyttä fysiikkamoottorilla…");
        return startSession(uid, i);
      }
      if (i.customId === "stop") {
        stopSession(uid);
        return i.reply({ ephemeral: true, content: "⏹ Botti pysäytetty ja automaattinen uudelleenyhdistys peruttu." });
      }
      if (i.customId === "settings") {
        const u = getUser(uid);
        const modal = new ModalBuilder().setCustomId("settings_modal").setTitle("⚙ Bedrock-asetukset");
        const ip = new TextInputBuilder().setCustomId("ip").setLabel("Palvelimen IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "");
        const port = new TextInputBuilder().setCustomId("port").setLabel("Portti").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132));
        modal.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port));
        return i.showModal(modal);
      }
    }

    if (i.isModalSubmit() && i.customId === "settings_modal") {
      const ip = i.fields.getTextInputValue("ip").trim();
      const port = parseInt(i.fields.getTextInputValue("port").trim(), 10);
      const u = getUser(uid);
      u.server = { ip, port };
      save();
      return i.reply({ ephemeral: true, content: `Asetukset tallennettu: ${ip}:${port}` });
    }

  } catch (e) {
    console.error("Interaction error:", e);
  }
});

client.login(DISCORD_TOKEN);

