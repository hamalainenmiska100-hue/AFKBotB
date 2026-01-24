/**
 * Bedrock AFK Bot - "Divine Physics" v4
 * Integroitu LootLabs.gg Creator API:n kanssa.
 * Sisältää 48h mainosmuistin, inhimillisen liikkeen ja Steve-skinin.
 */

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
  EmbedBuilder
} = require("discord.js");

const bedrock = require("bedrock-protocol");
const { Authflow, Titles } = require("prismarine-auth");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");

// ----------------- Konfiguraatio -----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_CHANNEL_ID = "1464615993320935447";

// ----------------- LootLabs Integrointi -----------------
// Käytetään kuvassa näkyvää API-tokenia
const LOOTLABS_API_KEY = "33e661bfba65b1587c3c41d39dbdee9f2fe0a3f8ad624240c9289bed0c22c2bd";
const AD_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000; // 48 Tuntia

// ----------------- Tallennus -----------------
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
  if (!users[uid].connectionType) users[uid].connectionType = "online";
  if (!users[uid].lastAdTime) users[uid].lastAdTime = 0;
  return users[uid];
}

function getUserAuthDir(uid) {
  const dir = path.join(AUTH_ROOT, uid);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ----------------- Runtime Tila -----------------
const sessions = new Map();
const pendingLink = new Map();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const lerp = (start, end, amt) => (1 - amt) * start + amt * end;

// ----------------- UI Rakentajat -----------------
function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink Account").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start Bot").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop Bot").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    )
  ];
}

// ----------------- Microsoft Kirjautuminen -----------------
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) return interaction.editReply("⏳ Login already in progress. Check the last code.").catch(() => {});
  const authDir = getUserAuthDir(uid);
  const u = getUser(uid);
  
  const flow = new Authflow(uid, authDir, {
    flow: "live",
    authTitle: Titles.MinecraftNintendoSwitch,
    deviceType: "Nintendo"
  }, async (data) => {
    const uri = data.verification_uri_complete || data.verification_uri;
    const code = data.user_code;
    await interaction.editReply({
      content: `🔐 **Microsoft Login Required**\nURL: ${uri}\nCode: \`${code}\``,
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Open Link").setStyle(ButtonStyle.Link).setURL(uri))]
    }).catch(() => {});
  });

  const promise = (async () => {
    try {
      await flow.getMsaToken();
      u.linked = true;
      save();
      await interaction.followUp({ ephemeral: true, content: "✅ Linked successfully! 🥳" });
    } catch (e) {
      await interaction.editReply(`❌ Login failed: ${e.message}`);
    } finally {
      pendingLink.delete(uid);
    }
  })();
  pendingLink.set(uid, promise);
}

// ----------------- LootLabs API Kutsut -----------------

/**
 * Luodaan dynaaminen linkki käyttäjälle Creators API:n kautta
 */
async function createLootLabsLink(userId) {
  try {
    const response = await axios.post('https://creators.lootlabs.gg/api/public/content_locker', {
      title: "AFKBot-Auth",
      url: `https://discord.com/users/${userId}`, // Kohdeosoite, ei merkitystä konversion kannalta
      tier_id: 1, // Trending & Recommended
      number_of_tasks: 3,
      theme: 3 // Minecraft-teema
    }, {
      headers: { 
        'Authorization': `Bearer ${LOOTLABS_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data && response.data.message && response.data.message.loot_url) {
      return response.data.message.loot_url;
    }
    return null;
  } catch (err) {
    // Lokitetaan tarkka virhe palvelimen hallintapaneeliin
    console.error("LootLabs POST Error:", err.response?.data || err.message);
    return null;
  }
}

/**
 * Tarkistetaan onko käyttäjä suorittanut linkin
 */
async function verifyAdCompletion(userId) {
  try {
    const response = await axios.get(`https://creators.lootlabs.gg/api/v1/conversions`, {
      params: { 
        api_key: LOOTLABS_API_KEY,
        user_id: userId 
      }
    });
    // Jos konversiolista ei ole tyhjä, käyttäjä on suorittanut tehtävän
    return response.data && response.data.length > 0;
  } catch (err) {
    console.error("Verification Error:", err.message);
    return false;
  }
}

// ----------------- Pelisession Hallinta -----------------
function stopSession(uid) {
  const s = sessions.get(uid);
  if (!s) return false;
  s.manualStop = true;
  if (s.physicsLoop) clearInterval(s.physicsLoop);
  if (s.rejoinTimeout) clearTimeout(s.rejoinTimeout);
  try { s.client.close(); } catch {}
  sessions.delete(uid);
  return true;
}

function actualConnect(uid, interaction) {
  const u = getUser(uid);
  // Annetaan välitön palaute
  interaction.editReply("⏳ Connecting... 🔌").catch(() => {});

  const mc = bedrock.createClient({
    host: u.server.ip,
    port: u.server.port || 19132,
    profilesFolder: getUserAuthDir(uid),
    username: uid,
    offline: u.connectionType === "offline",
    // --- NÄKYVYYSKORJAUS (Steve-skini) ---
    skinData: { DeviceOS: 11, DeviceId: crypto.randomUUID(), SkinId: "Standard_Steve", UIProfile: 0 }
  });

  const session = {
    client: mc,
    manualStop: false,
    packetCount: 0,
    serverInfo: u.server,
    // --- Fysiikkamoottori v4 Tila ---
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, targetYaw: 0, targetPitch: 0,
    isMoving: false, onGround: true, tick: 0, nextThink: 0
  };
  sessions.set(uid, session);

  mc.on('packet', () => session.packetCount++);

  mc.on("spawn", () => {
    // Päivitetään viesti kun botti on sisällä
    interaction.editReply(`🟢 Connected to **${u.server.ip}:${u.server.port || 19132}** 🎮`).catch(() => {});
    if (mc.entity?.position) session.pos = { ...mc.entity.position };

    // --- DIVINE PHYSICS ENGINE v4 (50ms välein) ---
    session.physicsLoop = setInterval(() => {
      if (!mc.entityId) return;
      session.tick++;

      // Inhimillinen päätöksenteko (Pään kääntäminen ja liike)
      if (session.tick >= session.nextThink) {
        const r = Math.random();
        if (r < 0.4) {
          session.isMoving = true;
          session.targetYaw = (session.targetYaw + (Math.random() * 120 - 60)) % 360;
          session.nextThink = session.tick + 70 + Math.random() * 100;
        } else if (r < 0.6) {
          session.isMoving = false;
          session.targetPitch = Math.random() * 30 - 15;
          session.nextThink = session.tick + 100 + Math.random() * 180;
        } else {
          session.targetYaw += Math.random() * 20 - 10;
          session.nextThink = session.tick + 30 + Math.random() * 60;
        }
        
        // Satunnainen hyppiminen
        if (session.isMoving && Math.random() < 0.06 && session.onGround) {
          session.vel.y = 0.42; 
          session.onGround = false;
        }
      }

      // Kameran pehmeys (Interpolointi)
      session.yaw = lerp(session.yaw, session.targetYaw, 0.12);
      session.pitch = lerp(session.pitch, session.targetPitch, 0.08);

      // Fysiikan laskenta (Painovoima & Kitka)
      const friction = session.onGround ? 0.91 : 0.98;
      if (session.isMoving) {
        const rad = (session.yaw + 90) * (Math.PI / 180);
        session.vel.x += Math.cos(rad) * 0.085;
        session.vel.z += Math.sin(rad) * 0.085;
      }

      session.vel.y -= 0.08; 
      session.vel.x *= friction; session.vel.z *= friction; session.vel.y *= 0.98;
      session.pos.x += session.vel.x; session.pos.y += session.vel.y; session.pos.z += session.vel.z;

      // Maatörmäys (estää putoamisen)
      const ground = mc.entity?.position?.y || session.pos.y;
      if (session.pos.y < ground - 0.1) {
        session.pos.y = ground; session.vel.y = 0; session.onGround = true;
      }

      try {
        mc.write("move_player", {
          runtime_id: mc.entityId, position: session.pos, pitch: session.pitch,
          yaw: session.yaw, head_yaw: session.yaw, mode: 0, on_ground: session.onGround,
          ridden_runtime_id: 0, teleport: false
        });
      } catch {}
    }, 50);
  });

  mc.on("close", () => {
    if (session.physicsLoop) clearInterval(session.physicsLoop);
    // Automaattinen uudelleenyhdistys (2 min)
    if (!session.manualStop) {
      session.rejoinTimeout = setTimeout(() => actualConnect(uid, interaction), 120000);
    } else {
      sessions.delete(uid);
    }
  });

  mc.on("error", (e) => {
    interaction.editReply(`❌ Error: ${e.message}`).catch(() => {});
    stopSession(uid);
  });
}

// ----------------- Discord Vuorovaikutus -----------------
client.on(Events.InteractionCreate, async (i) => {
  const uid = i.user.id;
  if (i.guildId !== ALLOWED_GUILD_ID) return;

  if (i.isChatInputCommand()) {
    if (i.commandName === "panel") {
      const embed = new EmbedBuilder()
        .setTitle("🤖 AFK Bot Control Panel")
        .setColor(0x5865F2)
        .setDescription("Manage your Bedrock AFK bot session easily. ✨")
        .setFooter({ text: "💰 Support AFKBot by completing the LootLabs wall!" });

      return i.reply({ embeds: [embed], components: panelRow() });
    }

    if (i.commandName === "admin" && i.channelId === ADMIN_CHANNEL_ID) {
      const sub = i.options.getSubcommand();
      if (sub === "info") {
        const mem = process.memoryUsage().rss / 1024 / 1024;
        let s = ""; sessions.forEach((v, k) => s += `👤 <@${k}> | IP: ${v.serverInfo.ip} | Pkts: ${v.packetCount}\n`);
        const emb = new EmbedBuilder().setTitle("🖥 Admin Panel").setColor(0x00FF00)
          .addFields({ name: "🧠 RAM", value: `${mem.toFixed(1)}MB`, inline: true }, { name: "🎮 Active", value: `${sessions.size}`, inline: true })
          .setDescription(s || "No bots online.");
        return i.reply({ embeds: [emb] });
      }
      if (sub === "stop-all") { sessions.forEach((_, id) => stopSession(id)); return i.reply("🛑 All bots terminated."); }
    }
  }

  if (i.isButton()) {
    if (i.customId === "link") { await i.deferReply({ ephemeral: true }); return linkMicrosoft(uid, i); }
    
    if (i.customId === "start") {
      await i.deferReply({ ephemeral: true });
      const u = getUser(uid);

      if (!u.server?.ip) return i.editReply("❌ Set server IP in **Settings** first. ⚙");
      if (u.connectionType === "online" && !u.linked) return i.editReply("❌ **Link Microsoft** account first. 🔑");
      if (sessions.has(uid)) return i.editReply("❌ Bot is already running. 🏃");

      // --- LOOTLABS 48H TARKISTUS ---
      const now = Date.now();
      if (now - u.lastAdTime > AD_COOLDOWN_MS) {
        const lootUrl = await createLootLabsLink(uid);
        if (!lootUrl) {
          return i.editReply("❌ **Failed to generate Reward Link.** Make sure Creator Details are filled in LootLabs.gg! 🥺");
        }

        const adEmbed = new EmbedBuilder()
          .setTitle("📢 Support Required")
          .setColor(0xFFA500)
          .setDescription(
            "**We are sorry but this is to keep AFKBot up!** 🥺\n\n" +
            "Please complete the link wall to continue. This supports our hosting costs.\n\n" +
            "**This will be prompted only once a 2 days.** 📅"
          )
          .setFooter({ text: "Thank you for supporting us!" });

        const adRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel("🔗 Open Reward Link").setStyle(ButtonStyle.Link).setURL(lootUrl),
          new ButtonBuilder().setCustomId("verify_ad").setLabel("✅ I've Completed It").setStyle(ButtonStyle.Success)
        );

        return i.editReply({ embeds: [adEmbed], components: [adRow] });
      }

      return actualConnect(uid, i);
    }

    if (i.customId === "verify_ad") {
      await i.deferReply({ ephemeral: true });
      const success = await verifyAdCompletion(uid);
      
      if (success) {
        const u = getUser(uid);
        u.lastAdTime = Date.now();
        save();
        await i.editReply("✅ Verification detected! Starting bot now... 🚀");
        return actualConnect(uid, i);
      } else {
        return i.editReply("❌ **No conversion found.** Please reach the end of the LootLabs task. 🥺");
      }
    }

    if (i.customId === "stop") {
      stopSession(uid);
      return i.reply({ ephemeral: true, content: "⏹ Bot stopped." });
    }

    if (i.customId === "unlink") {
      const u = getUser(uid); u.linked = false; save();
      return i.reply({ ephemeral: true, content: "🗑 Account unlinked." });
    }

    if (i.customId === "settings") {
      const u = getUser(uid);
      const mod = new ModalBuilder().setCustomId("sets").setTitle("Server Config");
      const ip = new TextInputBuilder().setCustomId("ip").setLabel("IP").setStyle(TextInputStyle.Short).setValue(u.server?.ip || "");
      const port = new TextInputBuilder().setCustomId("port").setLabel("Port").setStyle(TextInputStyle.Short).setValue(String(u.server?.port || 19132));
      mod.addComponents(new ActionRowBuilder().addComponents(ip), new ActionRowBuilder().addComponents(port));
      return i.showModal(mod);
    }
  }

  if (i.isModalSubmit() && i.customId === "sets") {
    const u = getUser(uid);
    u.server = { ip: i.fields.getTextInputValue("ip"), port: parseInt(i.fields.getTextInputValue("port")) || 19132 };
    save();
    return i.reply({ ephemeral: true, content: "✅ Settings saved! 💾" });
  }
});

// ----------------- Alustus -----------------
client.once("ready", () => {
  client.application.commands.set([
    new SlashCommandBuilder().setName("panel").setDescription("User panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Admin panel")
      .addSubcommand(s => s.setName("info").setDescription("Stats"))
      .addSubcommand(s => s.setName("stop-all").setDescription("Kill all bots"))
  ]);
  console.log(`✅ AFKBot Online: ${client.user.tag}`);
});

process.on("unhandledRejection", e => console.error("Unhandled:", e));

client.login(DISCORD_TOKEN);

