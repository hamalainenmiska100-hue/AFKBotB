/**
 * Bedrock AFK Bot - "Professional Sponsor" Edition
 * - Physics Engine v4 (Inhimillinen liike & painovoima)
 * - Steve Skin (Näkymättömyys-fix)
 * - Automaattinen uudelleenyhdistys (2 min välein)
 * - Dynaaminen kumppanuus/sponsorijärjestelmä
 * - Admin-hallinta lukitulla kanavalla
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

// ----------------- Asetukset -----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED_GUILD_ID = "1462335230345089254";
const ADMIN_CHANNEL_ID = "1464615993320935447";
const PATREON_URL = "https://patreon.com/AFKBot396";

// ----------------- Kumppanit & Sponsorit -----------------
// Tähän voit helposti vaihtaa mainokset joista saat rahaa (Affiliate/Sponsorit)
const PARTNERS = [
  {
    text: "🚀 Need a high-end MC Server? Get 25% OFF with code 'AFKBot'!",
    label: "View Server Hosting",
    url: "https://patreon.com/AFKBot396" // Lisää tähän affiliate-linkki
  },
  {
    text: "💎 Help us keep AFKBot alive by supporting us on Patreon.",
    label: "Support on Patreon",
    url: PATREON_URL
  }
];

function getPartner() {
  return PARTNERS[Math.floor(Math.random() * PARTNERS.length)];
}

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

// ----------------- UI-Rakentajat -----------------
function panelRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("link").setLabel("🔑 Link Microsoft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("unlink").setLabel("🗑 Unlink").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start").setLabel("▶ Start Bot").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop Bot").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("settings").setLabel("⚙ Settings").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function partnerRow(p) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel(p.label).setStyle(ButtonStyle.Link).setURL(p.url)
  );
}

// ----------------- Microsoft Kirjautuminen -----------------
async function linkMicrosoft(uid, interaction) {
  if (pendingLink.has(uid)) return interaction.editReply("⏳ Login in progress. Check the previous code.");
  const authDir = getUserAuthDir(uid);
  
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
      getUser(uid).linked = true;
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

// ----------------- Botin Hallinta -----------------

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
  const partner = getPartner();
  
  // Välitön palaute käyttäjälle
  interaction.editReply({
    content: `⏳ Connecting to server... 🔌\n\n*${partner.text}*`,
    components: [partnerRow(partner)]
  }).catch(() => {});

  const mc = bedrock.createClient({
    host: u.server.ip,
    port: u.server.port || 19132,
    profilesFolder: getUserAuthDir(uid),
    username: uid,
    offline: u.connectionType === "offline",
    // --- SKINI-KORJAUS ---
    skinData: { DeviceOS: 11, DeviceId: crypto.randomUUID(), SkinId: "Standard_Steve", UIProfile: 0 }
  });

  const session = {
    client: mc, manualStop: false, packetCount: 0, serverInfo: u.server,
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, targetYaw: 0, targetPitch: 0,
    isMoving: false, onGround: true, tick: 0, nextThink: 0
  };
  sessions.set(uid, session);

  mc.on('packet', () => session.packetCount++);

  mc.on("spawn", () => {
    const p = getPartner();
    interaction.editReply({
      content: `🟢 Connected to **${u.server.ip}** 🎮\n\n*${p.text}*`,
      components: [partnerRow(p)]
    }).catch(() => {});
    
    if (mc.entity?.position) session.pos = { ...mc.entity.position };

    // --- DIVINE PHYSICS ENGINE v4 (20 TPS) ---
    session.physicsLoop = setInterval(() => {
      if (!mc.entityId) return;
      session.tick++;

      // Inhimillinen päätöksenteko
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
        if (session.isMoving && Math.random() < 0.06 && session.onGround) {
          session.vel.y = 0.42; session.onGround = false;
        }
      }

      // Kameran sulavuus
      session.yaw = lerp(session.yaw, session.targetYaw, 0.12);
      session.pitch = lerp(session.pitch, session.targetPitch, 0.08);

      // Fysiikkalaskenta
      const friction = session.onGround ? 0.91 : 0.98;
      if (session.isMoving) {
        const rad = (session.yaw + 90) * (Math.PI / 180);
        session.vel.x += Math.cos(rad) * 0.085;
        session.vel.z += Math.sin(rad) * 0.085;
      }

      session.vel.y -= 0.08; 
      session.vel.x *= friction; session.vel.z *= friction; session.vel.y *= 0.98;
      session.pos.x += session.vel.x; session.pos.y += session.vel.y; session.pos.z += session.vel.z;

      // Maatörmäys
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
      console.log(`[REJOIN] Bot for ${uid} disconnected. Rejoining in 120s...`);
      session.rejoinTimeout = setTimeout(() => actualConnect(uid, interaction), 120000);
    } else {
      sessions.delete(uid);
    }
  });

  mc.on("error", (e) => {
    const p = getPartner();
    interaction.editReply({
      content: `❌ Error: ${e.message}\n\n*${p.text}*`,
      components: [partnerRow(p)]
    }).catch(() => {});
    stopSession(uid);
  });
}

// ----------------- Interactionit -----------------
client.on(Events.InteractionCreate, async (i) => {
  const uid = i.user.id;
  if (i.guildId !== ALLOWED_GUILD_ID) return;

  if (i.isChatInputCommand()) {
    if (i.commandName === "panel") {
      const p = getPartner();
      const embed = new EmbedBuilder()
        .setTitle("🤖 AFK Bot Control Panel")
        .setColor(0x5865F2)
        .setDescription("Manage your AFK sessions here. ✨")
        .setFooter({ text: p.text });

      return i.reply({ embeds: [embed], components: panelRow() });
    }

    if (i.commandName === "admin" && i.channelId === ADMIN_CHANNEL_ID) {
      const sub = i.options.getSubcommand();
      if (sub === "info") {
        const mem = process.memoryUsage().rss / 1024 / 1024;
        let s = ""; sessions.forEach((v, k) => s += `👤 <@${k}> | IP: ${v.serverInfo.ip} | Pkts: ${v.packetCount}\n`);
        const emb = new EmbedBuilder().setTitle("🖥 Admin Panel").setColor(0x00FF00)
          .addFields({ name: "🧠 RAM", value: `${mem.toFixed(1)}MB`, inline: true }, { name: "🎮 Active", value: `${sessions.size}`, inline: true })
          .setDescription(s || "No active bots.");
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
      if (!u.server?.ip) return i.editReply("❌ Configure server in **Settings** first.");
      if (u.connectionType === "online" && !u.linked) return i.editReply("❌ **Link Microsoft** account first.");
      if (sessions.has(uid)) return i.editReply("❌ Bot is already running.");
      return actualConnect(uid, i);
    }

    if (i.customId === "stop") {
      const ok = stopSession(uid);
      const p = getPartner();
      return i.reply({ 
        ephemeral: true, 
        content: ok ? `⏹ Bot stopped.\n\n*${p.text}*` : "❌ No bot running.",
        components: ok ? [partnerRow(p)] : []
      });
    }

    if (i.customId === "unlink") { getUser(uid).linked = false; save(); return i.reply({ ephemeral: true, content: "🗑 Account unlinked." }); }

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

client.once("ready", () => {
  client.application.commands.set([
    new SlashCommandBuilder().setName("panel").setDescription("User Panel"),
    new SlashCommandBuilder().setName("admin").setDescription("Admin Panel")
      .addSubcommand(s => s.setName("info").setDescription("Stats"))
      .addSubcommand(s => s.setName("stop-all").setDescription("Kill all"))
  ]);
  console.log(`✅ AFKBot Online: ${client.user.tag}`);
});

process.on("unhandledRejection", e => console.error(e));

client.login(DISCORD_TOKEN);

