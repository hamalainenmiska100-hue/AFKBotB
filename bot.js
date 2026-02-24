#!/usr/bin/env node
/**
 * AFK Bot Orchestrator for Minecraft Bedrock Edition (Discord-controlled)
 * ----------------------------------------------------------------------
 * Goal: run 24/7 with high stability under tight RAM by:
 *   1) Running each Bedrock client in its own child process (crash isolation)
 *   2) Avoiding bedrock-protocol .close() on not-yet-connected clients (known crash trigger)
 *   3) Defaulting to the pure-JS RakNet backend ("jsp-raknet") to avoid native heap aborts
 *   4) Enforcing restart backoff + worker memory watchdog
 *
 * Single-file design: parent mode (Discord + storage + supervisor) and worker mode
 * (one Bedrock connection) live in this same bot.js.
 *
 * Run:
 *   npm i discord.js bedrock-protocol prismarine-auth
 *   DISCORD_TOKEN=... node bot.js
 *
 * Recommended Node flags for low RAM on the parent:
 *   node --optimize-for-size --max-old-space-size=160 bot.js
 *
 * Workers are spawned with their own heap limit via execArgv (see CONFIG).
 */

'use strict';

const path = require('path');
const fsSync = require('fs');
const fsp = require('fs/promises');
const { fork } = require('child_process');

// -------------------- Mode Switch --------------------

const IS_WORKER = process.argv.includes('--worker');

if (IS_WORKER) {
  runWorker().catch((e) => {
    // Last-resort: never throw beyond here (worker must exit cleanly)
    try { console.error('[worker] fatal:', e?.stack || e); } catch {}
    process.exit(1);
  });
} else {
  runParent().catch((e) => {
    try { console.error('[parent] fatal:', e?.stack || e); } catch {}
    process.exit(1);
  });
}

// =====================================================================
// Parent: Discord + persistence + supervisor
// =====================================================================

async function runParent() {
  const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
  if (!DISCORD_TOKEN) {
    console.error('DISCORD_TOKEN missing');
    process.exit(1);
  }

  const CONFIG = {
    ADMIN_ID: process.env.ADMIN_ID || '1144987924123881564',
    LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || '1464615030111731753',

    // Persistence
    SAVE_DEBOUNCE_MS: 150,

    // Session orchestration
    MAX_ACTIVE_SESSIONS: parseInt(process.env.MAX_ACTIVE_SESSIONS || '10', 10),
    RESTORE_STAGGER_MS: 7000,          // stagger restores to avoid spikes
    START_STAGGER_MS: 2000,            // stagger manual starts a bit too
    MAX_RESTART_ATTEMPTS: 30,
    RESTART_BASE_DELAY_MS: 4000,
    RESTART_MAX_DELAY_MS: 5 * 60_000,

    // Worker safety
    WORKER_HEAP_MB: parseInt(process.env.WORKER_HEAP_MB || '72', 10),
    WORKER_RSS_SOFT_MB: parseInt(process.env.WORKER_RSS_SOFT_MB || '140', 10),
    WORKER_RSS_HARD_MB: parseInt(process.env.WORKER_RSS_HARD_MB || '220', 10),
    WORKER_STATS_INTERVAL_MS: 30_000,

    // Bedrock defaults
    DEFAULT_RAKNET_BACKEND: process.env.RAKNET_BACKEND || 'jsp-raknet', // safest
    DEFAULT_VIEW_DISTANCE: 1,

    // UX / discord
    INTERACTION_COOLDOWN_MS: 1000,
    EPHEMERAL_DEFAULT: true,
  };

  // Fly.io uses FLY_VOLUME_PATH; local fallback.
  const DATA = process.env.FLY_VOLUME_PATH || '/data';
  const AUTH_ROOT = path.join(DATA, 'auth');
  const STORE_USERS = path.join(DATA, 'users.json');
  const STORE_AUTOSTART = path.join(DATA, 'autostart.json');
  const CRASH_LOG = path.join(DATA, 'crash.log');

  await ensureDir(DATA);
  await ensureDir(AUTH_ROOT);

  // -------------------- tiny crash log --------------------
  const crashLogger = {
    async log(type, err) {
      try {
        const ts = new Date().toISOString();
        const msg = `[${ts}] ${type}\n${err?.stack || err?.message || String(err)}\n\n`;
        await fsp.appendFile(CRASH_LOG, msg).catch(() => {});
      } catch {}
    }
  };

  process.on('uncaughtException', (err) => crashLogger.log('UNCAUGHT_EXCEPTION', err));
  process.on('unhandledRejection', (err) => crashLogger.log('UNHANDLED_REJECTION', err));

  // -------------------- persistence --------------------

  const userStore = new PersistentStore(STORE_USERS, CONFIG.SAVE_DEBOUNCE_MS);
  const autostartStore = new PersistentStore(STORE_AUTOSTART, CONFIG.SAVE_DEBOUNCE_MS);

  /** @type {Record<string, any>} */
  const users = await userStore.load({});
  /** @type {Record<string, any>} */
  const autostart = await autostartStore.load({}); // uid -> { desired:true, lastStartAt, ... }

  // -------------------- Discord client (lazy require) --------------------

  const {
    Client,
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Events,
    Partials,
    SlashCommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    EmbedBuilder,
    ActivityType,
    MessageFlags
  } = require('discord.js');

  // discord.js v15 uses flags for ephemeral
  const EPHEMERAL_FLAGS = MessageFlags?.Ephemeral ?? (1 << 6);

  function withEphemeral(payload, ephemeral) {
    if (!payload || typeof payload !== 'object') return payload;
    if (!ephemeral) {
      if ('ephemeral' in payload) delete payload.ephemeral;
      return payload;
    }
    if (payload.flags === undefined) payload.flags = EPHEMERAL_FLAGS;
    if ('ephemeral' in payload) delete payload.ephemeral;
    return payload;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User],
    allowedMentions: { parse: ['users'], repliedUser: false },
    presence: {
      status: 'online',
      activities: [{ name: 'AFK Bots', type: ActivityType.Watching }]
    },
    rest: { timeout: 15_000, retries: 2 }
  });

  let discordReady = false;
  let isShuttingDown = false;

  // -------------------- Supervisor state --------------------

  /**
   * sessions: uid -> session runtime
   * runtime = { desired, child, startedAt, attempt, backoffMs, lastExitAt, lastMsgAt, lastStats, starting, stopping }
   */
  const sessions = new Map();
  const pendingLink = new Map();
  const lastMsa = new Map();
  const lastInteractionAt = new Map();
  const startQueue = [];
  let startQueueTimer = null;

  // -------------------- helpers --------------------

  function now() { return Date.now(); }

  function getUser(uid) {
    if (!uid || typeof uid !== 'string' || !/^\d+$/.test(uid)) {
      return { connectionType: 'online', bedrockVersion: 'auto', _temp: true };
    }
    if (!users[uid]) {
      users[uid] = {
        connectionType: 'online',
        bedrockVersion: 'auto',
        createdAt: now(),
        lastActive: now(),
        linked: false,
        server: null,
        raknetBackend: CONFIG.DEFAULT_RAKNET_BACKEND,
      };
      userStore.save();
    }
    const u = users[uid];
    u.connectionType = u.connectionType || 'online';
    u.bedrockVersion = u.bedrockVersion || 'auto';
    u.raknetBackend = u.raknetBackend || CONFIG.DEFAULT_RAKNET_BACKEND;
    u.lastActive = now();
    return u;
  }

  function isValidIP(host) {
    if (!host || typeof host !== 'string') return false;
    if (host.length > 253) return false;
    if (host.includes('..') || host.startsWith('.') || host.endsWith('.')) return false;
    if (host.includes('://')) return false;
    const ipv4 = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;
    const ipv6 = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
    const hostname = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
    return ipv4.test(host) || ipv6.test(host) || hostname.test(host);
  }

  function isValidPort(port) {
    const n = parseInt(String(port), 10);
    return Number.isFinite(n) && n > 0 && n <= 65535;
  }

  async function ensureAuthDir(uid) {
    const safe = String(uid).replace(/[^0-9]/g, '');
    if (!safe) return null;
    const dir = path.join(AUTH_ROOT, safe);
    await ensureDir(dir);
    return dir;
  }

  async function logToDiscord(message) {
    if (!message || isShuttingDown || !discordReady) return;
    try {
      const channel = await client.channels.fetch(CONFIG.LOG_CHANNEL_ID).catch(() => null);
      if (!channel) return;
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setDescription(String(message).slice(0, 4096))
        .setTimestamp();
      await channel.send({ embeds: [embed] }).catch(() => {});
    } catch {}
  }

  async function dmUser(uid, content) {
    try {
      const user = await client.users.fetch(uid).catch(() => null);
      if (!user) return false;
      await user.send({ content: String(content).slice(0, 1900) }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  async function safeReply(interaction, content, ephemeral = CONFIG.EPHEMERAL_DEFAULT) {
    try {
      if (!interaction) return;
      const payload = typeof content === 'string' ? { content } : { ...content };
      withEphemeral(payload, ephemeral);

      if (!interaction.replied && !interaction.deferred) {
        try {
          await interaction.deferReply(withEphemeral({}, ephemeral));
        } catch (e) {
          // Unknown interaction (expired)
          if (e?.code === 10062) return;
        }
      }

      if (interaction.deferred && !interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
        return;
      }
      if (interaction.replied) {
        await interaction.followUp(payload).catch(() => {});
        return;
      }
      await interaction.reply(payload).catch(() => {});
    } catch {}
  }

  // -------------------- Discord UI --------------------

  function panelRow(isJava = false) {
    const title = isJava ? 'Java AFKBot Panel' : 'Bedrock AFKBot Panel';
    const startId = isJava ? 'start_java' : 'start_bedrock';
    return {
      content: `**${title}**`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('link').setLabel('Link Microsoft').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('unlink').setLabel('Unlink Microsoft').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(startId).setLabel('Start').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('settings').setLabel('Settings').setStyle(ButtonStyle.Secondary)
        )
      ]
    };
  }

  // -------------------- Auth (device code) --------------------
  // Lazy-require prismarine-auth only when needed (saves baseline RAM).
  async function linkMicrosoft(uid, interaction) {
    if (!uid || !interaction) return;
    await interaction.deferReply(withEphemeral({}, true)).catch(() => {});

    if (pendingLink.has(uid)) {
      return safeReply(interaction, 'Login already in progress. Check your DMs (or the last code).', true);
    }

    const authDir = await ensureAuthDir(uid);
    if (!authDir) return safeReply(interaction, 'System error: cannot create auth directory.', true);

    const u = getUser(uid);

    const { Authflow, Titles } = require('prismarine-auth');

    const timeout = setTimeout(() => {
      pendingLink.delete(uid);
      safeReply(interaction, 'Login timed out after 5 minutes.', true);
    }, 5 * 60_000);

    try {
      const flow = new Authflow(
        uid,
        authDir,
        {
          flow: 'live',
          authTitle: Titles?.MinecraftNintendoSwitch || 'Bedrock AFK Bot',
          deviceType: 'Nintendo'
        },
        async (data) => {
          const uri = data?.verification_uri_complete || data?.verification_uri || 'https://www.microsoft.com/link';
          const code = data?.user_code || '(no code)';
          lastMsa.set(uid, { uri, code, at: now() });

          const msg =
            `**Microsoft Authentication Required**\n\n` +
            `1) Open: ${uri}\n` +
            `2) Enter code: \`${code}\`\n\n` +
            `Tip: keep this DM for later token refreshes.`;

          // DM first (more reliable than ephemeral followups)
          await dmUser(uid, msg);
          await safeReply(interaction, 'I sent you a DM with the Microsoft login link + code.', true);
        }
      );

      pendingLink.set(uid, true);

      // Triggers device-code flow if needed, otherwise returns quickly from cached refresh tokens.
      await flow.getMsaToken();

      clearTimeout(timeout);
      pendingLink.delete(uid);

      u.linked = true;
      u.tokenAcquiredAt = now();
      await userStore.save(true);

      await safeReply(interaction, 'Microsoft account linked ✅', true);
    } catch (e) {
      clearTimeout(timeout);
      pendingLink.delete(uid);
      await safeReply(interaction, `Login failed: ${e?.message || 'Unknown error'}`, true);
    }
  }

  async function unlinkMicrosoft(uid, interaction) {
    const authDir = await ensureAuthDir(uid);
    if (authDir) {
      try { await fsp.rm(authDir, { recursive: true, force: true }); } catch {}
    }
    const u = getUser(uid);
    u.linked = false;
    u.tokenAcquiredAt = null;
    await userStore.save(true);

    // stop if running
    await stopSession(uid, true);

    if (interaction) await safeReply(interaction, 'Unlinked Microsoft account.', true);
  }

  // -------------------- Worker spawn / supervision --------------------

  function countDesiredSessions() {
    let n = 0;
    for (const s of sessions.values()) if (s.desired) n++;
    return n;
  }

  function enqueueStart(uid, reason = 'manual') {
    startQueue.push({ uid, reason, at: now() });
    if (!startQueueTimer) {
      startQueueTimer = setInterval(processStartQueue, CONFIG.START_STAGGER_MS);
    }
  }

  async function processStartQueue() {
    if (isShuttingDown) return;
    if (!startQueue.length) {
      clearInterval(startQueueTimer);
      startQueueTimer = null;
      return;
    }
    // Respect max
    const desired = countDesiredSessions();
    if (desired >= CONFIG.MAX_ACTIVE_SESSIONS) return;

    const job = startQueue.shift();
    if (!job) return;
    await startSession(job.uid, null, true, job.reason);
  }

  async function startSession(uid, interaction, fromQueue = false, reason = 'manual') {
    if (!uid || isShuttingDown) return;

    const u = getUser(uid);
    if (!u.linked) {
      if (interaction) await safeReply(interaction, 'Please link your Microsoft account first.', true);
      return;
    }
    if (!u.server?.ip || !u.server?.port) {
      if (interaction) await safeReply(interaction, 'Please configure server settings first.', true);
      return;
    }
    if (!isValidIP(u.server.ip) || !isValidPort(u.server.port)) {
      if (interaction) await safeReply(interaction, 'Invalid server IP or port.', true);
      return;
    }

    // Enforce max sessions: if manual start, queue it instead of hard failing.
    if (countDesiredSessions() >= CONFIG.MAX_ACTIVE_SESSIONS && !fromQueue) {
      enqueueStart(uid, reason);
      if (interaction) await safeReply(interaction, `At capacity (${CONFIG.MAX_ACTIVE_SESSIONS}). Queued your start.`, true);
      return;
    }

    // Mark desired autostart
    autostart[uid] = { desired: true, lastStartAt: now() };
    await autostartStore.save();

    // If already running, do nothing
    const existing = sessions.get(uid);
    if (existing?.child && !existing.stopping) {
      if (interaction) await safeReply(interaction, 'Already running.', true);
      return;
    }

    // Spawn
    const authDir = await ensureAuthDir(uid);
    if (!authDir) {
      if (interaction) await safeReply(interaction, 'Auth directory error.', true);
      return;
    }

    const runtime = existing || {
      desired: true,
      child: null,
      startedAt: 0,
      attempt: 0,
      backoffMs: CONFIG.RESTART_BASE_DELAY_MS,
      lastExitAt: 0,
      lastMsgAt: 0,
      lastStats: null,
      starting: false,
      stopping: false
    };

    runtime.desired = true;
    runtime.starting = true;
    runtime.stopping = false;

    sessions.set(uid, runtime);

    // restart backoff reset on explicit manual start
    if (reason === 'manual') {
      runtime.attempt = 0;
      runtime.backoffMs = CONFIG.RESTART_BASE_DELAY_MS;
    }

    const env = {
      ...process.env,

      // Worker inputs
      BOT_UID: uid,
      BOT_HOST: String(u.server.ip),
      BOT_PORT: String(u.server.port),
      BOT_CONNECTION_TYPE: u.connectionType || 'online',
      BOT_OFFLINE_USERNAME: u.offlineUsername || '',
      BOT_AUTH_DIR: authDir,
      BOT_RAKNET_BACKEND: u.raknetBackend || CONFIG.DEFAULT_RAKNET_BACKEND,
      BOT_VIEW_DISTANCE: String(CONFIG.DEFAULT_VIEW_DISTANCE),

      // Worker tunables
      BOT_STALE_TIMEOUT_MS: process.env.BOT_STALE_TIMEOUT_MS || '60000',
      BOT_KEEPALIVE_MS: process.env.BOT_KEEPALIVE_MS || '15000',
    };

    const execArgv = [
      '--optimize-for-size',
      `--max-old-space-size=${CONFIG.WORKER_HEAP_MB}`
    ];

    const child = fork(__filename, ['--worker'], {
      env,
      execArgv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });

    runtime.child = child;
    runtime.startedAt = now();
    runtime.lastMsgAt = now();
    runtime.starting = false;

    // Pipe worker output to parent logs (not Discord by default)
    child.stdout?.on('data', (d) => {
      const s = String(d).trim();
      if (s) console.log(`[w:${uid}] ${s}`);
    });
    child.stderr?.on('data', (d) => {
      const s = String(d).trim();
      if (s) console.error(`[w:${uid}] ${s}`);
    });

    child.on('message', async (msg) => {
      runtime.lastMsgAt = now();
      if (!msg || typeof msg !== 'object') return;

      if (msg.t === 'ready') {
        await logToDiscord(`Bot of <@${uid}> online on **${u.server.ip}:${u.server.port}** (${msg.backend || 'backend'})`);
        if (interaction) await safeReply(interaction, `Online on \`${u.server.ip}:${u.server.port}\``, true);
      }

      if (msg.t === 'spawn') {
        // optional: keep quieter
      }

      if (msg.t === 'msa') {
        const uri = msg.uri || 'https://www.microsoft.com/link';
        const code = msg.code || '(no code)';
        lastMsa.set(uid, { uri, code, at: now() });

        await dmUser(uid,
          `**Microsoft Authentication Needed Again**\n\n` +
          `Open: ${uri}\n` +
          `Code: \`${code}\`\n`
        );

        await logToDiscord(`Bot of <@${uid}> needs Microsoft re-auth (DM sent).`);
      }

      if (msg.t === 'stats') {
        runtime.lastStats = msg;
        const rss = (msg.rssMb || 0);

        // Soft restart if the worker gets too large (leaks / fragmentation)
        if (rss > CONFIG.WORKER_RSS_SOFT_MB && runtime.desired && !runtime.stopping) {
          console.warn(`[w:${uid}] RSS ${rss}MB > soft ${CONFIG.WORKER_RSS_SOFT_MB}MB: restarting worker`);
          await restartSession(uid, 'memory-soft');
        }

        // Hard kill if truly out of control
        if (rss > CONFIG.WORKER_RSS_HARD_MB && runtime.desired && runtime.child) {
          console.warn(`[w:${uid}] RSS ${rss}MB > hard ${CONFIG.WORKER_RSS_HARD_MB}MB: killing worker`);
          try { runtime.child.kill('SIGKILL'); } catch {}
        }
      }

      if (msg.t === 'kick') {
        await logToDiscord(`Bot of <@${uid}> kicked: ${msg.reason || 'Unknown'}`);
      }

      if (msg.t === 'warn') {
        console.warn(`[w:${uid}]`, msg.message || msg);
      }

      if (msg.t === 'error') {
        await logToDiscord(`Bot of <@${uid}> error: \`${String(msg.message || 'unknown').slice(0, 300)}\``);
      }
    });

    child.on('exit', async (code, signal) => {
      runtime.child = null;
      runtime.lastExitAt = now();

      const exitInfo = signal ? `signal ${signal}` : `code ${code}`;
      console.warn(`[w:${uid}] exited (${exitInfo})`);

      // If we are stopping, do nothing.
      if (runtime.stopping || !runtime.desired || isShuttingDown) return;

      // Restart with backoff
      runtime.attempt = (runtime.attempt || 0) + 1;
      if (runtime.attempt > CONFIG.MAX_RESTART_ATTEMPTS) {
        runtime.desired = false;
        delete autostart[uid];
        await autostartStore.save();
        await logToDiscord(`Bot of <@${uid}> stopped after too many restarts (${CONFIG.MAX_RESTART_ATTEMPTS}).`);
        return;
      }

      const base = Math.min(CONFIG.RESTART_BASE_DELAY_MS * Math.pow(1.4, runtime.attempt - 1), CONFIG.RESTART_MAX_DELAY_MS);
      const jitter = Math.floor(Math.random() * 1500);
      const delay = base + jitter;
      runtime.backoffMs = delay;

      await logToDiscord(`Bot of <@${uid}> disconnected. Restarting in ${Math.round(delay / 1000)}s (Attempt ${runtime.attempt}).`);

      setTimeout(() => {
        if (!isShuttingDown && runtime.desired) {
          enqueueStart(uid, 'restart');
        }
      }, delay);
    });

    // Proactive stats ping from parent
    setTimeout(() => {
      if (runtime.child && runtime.desired) {
        try { runtime.child.send({ cmd: 'stats' }); } catch {}
      }
    }, 5000);

    if (interaction) await safeReply(interaction, '**Starting...**', true);
  }

  async function restartSession(uid, reason = 'restart') {
    const rt = sessions.get(uid);
    if (!rt || rt.stopping) return;

    // set desired true and stop -> exit triggers restart logic anyway
    rt.desired = true;
    await stopSession(uid, false);
    enqueueStart(uid, reason);
  }

  async function stopSession(uid, clearAutostart = true) {
    const rt = sessions.get(uid);
    if (!rt) {
      if (clearAutostart) {
        delete autostart[uid];
        await autostartStore.save();
      }
      return false;
    }

    rt.desired = false;
    rt.stopping = true;

    if (clearAutostart) {
      delete autostart[uid];
      await autostartStore.save();
    }

    if (rt.child) {
      try {
        rt.child.send({ cmd: 'stop' });
      } catch {}

      // Hard kill after grace period
      const pid = rt.child.pid;
      setTimeout(() => {
        const cur = sessions.get(uid);
        if (cur?.child && cur.child.pid === pid) {
          try { cur.child.kill('SIGKILL'); } catch {}
        }
      }, 2500);
    }

    return true;
  }

  // -------------------- Restore sessions on boot --------------------

  async function restoreSessions() {
    const uids = Object.keys(autostart || {}).filter((k) => autostart[k]?.desired);
    console.log(`Found ${uids.length} desired sessions to restore`);

    let delay = 0;
    for (const uid of uids) {
      const u = getUser(uid);
      const ok = !!(u.linked && u.server?.ip && u.server?.port);
      if (!ok) {
        delete autostart[uid];
        continue;
      }
      setTimeout(() => {
        if (!isShuttingDown) enqueueStart(uid, 'restore');
      }, delay);
      delay += CONFIG.RESTORE_STAGGER_MS;
    }
    await autostartStore.save();
  }

  // -------------------- Discord events --------------------

  client.once(Events.ClientReady, async () => {
    discordReady = true;
    console.log('Discord client ready');

    // Register commands (global)
    try {
      const cmds = [
        new SlashCommandBuilder().setName('panel').setDescription('Open Bedrock AFK panel'),
        new SlashCommandBuilder().setName('java').setDescription('Open Java AFK panel'),
        new SlashCommandBuilder().setName('status').setDescription('Show bot status'),
      ];
      await client.application?.commands?.set(cmds);
    } catch (e) {
      console.error('Failed to register commands:', e?.message || e);
    }

    // Periodic: ask workers for stats
    setInterval(() => {
      for (const [uid, rt] of sessions) {
        if (rt?.child && rt.desired) {
          try { rt.child.send({ cmd: 'stats' }); } catch {}
        }
      }
    }, CONFIG.WORKER_STATS_INTERVAL_MS);

    // Restore after a short grace period
    setTimeout(() => restoreSessions(), 8000);
  });

  client.on('error', (e) => {
    discordReady = false;
    console.error('DISCORD ERROR:', e?.message || e);
  });

  client.on(Events.ShardResume, () => { discordReady = true; });
  client.on(Events.ShardDisconnect, () => { discordReady = false; });

  client.on(Events.InteractionCreate, async (i) => {
    try {
      if (!i || isShuttingDown) return;
      const uid = i.user?.id;
      if (!uid) return;

      // Basic spam guard
      const last = lastInteractionAt.get(uid) || 0;
      if (now() - last < CONFIG.INTERACTION_COOLDOWN_MS) {
        return safeReply(i, 'Please wait a moment before clicking again.', true);
      }
      lastInteractionAt.set(uid, now());

      if (i.isChatInputCommand()) {
        if (i.commandName === 'panel') return i.reply(panelRow(false)).catch(() => {});
        if (i.commandName === 'java') return i.reply(panelRow(true)).catch(() => {});
        if (i.commandName === 'status') {
          const rt = sessions.get(uid);
          const u = getUser(uid);
          const running = !!(rt?.child && rt.desired);
          const msg =
            `Linked: **${u.linked ? 'yes' : 'no'}**\n` +
            `Server: **${u.server?.ip || '-'}:${u.server?.port || '-'}**\n` +
            `Running: **${running ? 'yes' : 'no'}**\n` +
            `Backend: **${u.raknetBackend || CONFIG.DEFAULT_RAKNET_BACKEND}**\n` +
            (rt?.lastStats ? `Worker RSS: **${rt.lastStats.rssMb}MB**` : '');
          return safeReply(i, msg, true);
        }
      }

      if (i.isButton()) {
        if (i.customId === 'link') return linkMicrosoft(uid, i);
        if (i.customId === 'unlink') return unlinkMicrosoft(uid, i);

        if (i.customId === 'stop') {
          await i.deferReply(withEphemeral({}, true)).catch(() => {});
          const ok = await stopSession(uid, true);
          return safeReply(i, ok ? 'Stopped.' : 'No active session.', true);
        }

        if (i.customId === 'start_bedrock' || i.customId === 'start_java') {
          if (sessions.get(uid)?.child) return safeReply(i, 'Already running.', true);

          await i.deferReply(withEphemeral({}, true)).catch(() => {});

          const embed = i.customId === 'start_java'
            ? new EmbedBuilder()
              .setTitle('Java Compatibility Check')
              .setDescription('To connect to a Java server, you typically need **GeyserMC** + **Floodgate** installed server-side.')
              .setColor(0xE67E22)
            : new EmbedBuilder()
              .setTitle('Bedrock Connection')
              .setDescription('Start bot?')
              .setColor(0x2ECC71);

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('confirm_start').setLabel('Start').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
          );

          return i.followUp(withEphemeral({ embeds: [embed], components: [row] }, true)).catch(() => {});
        }

        if (i.customId === 'confirm_start') {
          await i.deferReply(withEphemeral({}, true)).catch(() => {});
          await safeReply(i, 'Starting...', true);
          await startSession(uid, i, false, 'manual');
          return;
        }

        if (i.customId === 'cancel') return safeReply(i, 'Cancelled.', true);

        if (i.customId === 'settings') {
          const u = getUser(uid);
          const modal = new ModalBuilder().setCustomId('settings_modal').setTitle('Configuration');

          const ipInput = new TextInputBuilder()
            .setCustomId('ip')
            .setLabel('Server IP / Hostname')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(u.server?.ip || '')
            .setMaxLength(253);

          const portInput = new TextInputBuilder()
            .setCustomId('port')
            .setLabel('Port')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(String(u.server?.port || 19132))
            .setMaxLength(5);

          const backendInput = new TextInputBuilder()
            .setCustomId('backend')
            .setLabel('RakNet backend: jsp-raknet / raknet-native / raknet-node')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(String(u.raknetBackend || CONFIG.DEFAULT_RAKNET_BACKEND))
            .setMaxLength(20);

          modal.addComponents(
            new ActionRowBuilder().addComponents(ipInput),
            new ActionRowBuilder().addComponents(portInput),
            new ActionRowBuilder().addComponents(backendInput),
          );

          return i.showModal(modal).catch(() => {});
        }
      }

      if (i.isModalSubmit() && i.customId === 'settings_modal') {
        const ip = i.fields?.getTextInputValue('ip')?.trim();
        const portStr = i.fields?.getTextInputValue('port')?.trim();
        const backend = i.fields?.getTextInputValue('backend')?.trim();

        if (!ip || !portStr) return safeReply(i, 'IP and Port are required.', true);
        if (!isValidIP(ip)) return safeReply(i, 'Invalid IP/hostname format.', true);
        if (!isValidPort(portStr)) return safeReply(i, 'Invalid port (1-65535).', true);

        const u = getUser(uid);
        u.server = { ip, port: parseInt(portStr, 10) };
        if (backend) {
          const allowed = new Set(['jsp-raknet', 'raknet-native', 'raknet-node']);
          if (!allowed.has(backend)) {
            return safeReply(i, 'Invalid backend. Use: jsp-raknet / raknet-native / raknet-node', true);
          }
          u.raknetBackend = backend;
        } else {
          u.raknetBackend = u.raknetBackend || CONFIG.DEFAULT_RAKNET_BACKEND;
        }

        await userStore.save(true);

        // If currently running, restart to apply settings
        const rt = sessions.get(uid);
        if (rt?.child && rt.desired) {
          await safeReply(i, `Saved. Restarting to apply settings...`, true);
          await restartSession(uid, 'settings-change');
        } else {
          await safeReply(i, `Saved: **${u.server.ip}:${u.server.port}** (backend: **${u.raknetBackend}**)`, true);
        }
        return;
      }
    } catch (e) {
      console.error('Interaction handler error:', e?.stack || e);
    }
  });

  // -------------------- Graceful shutdown --------------------

  async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`Shutting down (${signal})...`);

    const hard = setTimeout(() => process.exit(1), 15_000);

    // stop all workers
    for (const [uid] of sessions) {
      try { await stopSession(uid, false); } catch {}
    }

    try { await userStore.save(true); } catch {}
    try { await autostartStore.save(true); } catch {}

    try { await client.destroy(); } catch {}

    clearTimeout(hard);
    process.exit(0);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // -------------------- Boot --------------------

  await client.login(DISCORD_TOKEN);
  setInterval(() => {
    const desired = countDesiredSessions();
    console.log(`Heartbeat | Desired: ${desired} | Running: ${[...sessions.values()].filter(s => s.child && s.desired).length} | Discord: ${discordReady ? 'Connected' : 'Disconnected'} | Uptime: ${Math.floor(process.uptime() / 60)}m`);
  }, 60_000);
}

// =====================================================================
// Worker: ONE Bedrock connection (isolate crashes / native aborts)
// =====================================================================

async function runWorker() {
  const uid = process.env.BOT_UID;
  const host = process.env.BOT_HOST;
  const port = parseInt(process.env.BOT_PORT || '19132', 10);

  const connectionType = process.env.BOT_CONNECTION_TYPE || 'online';
  const offlineUsername = process.env.BOT_OFFLINE_USERNAME || '';
  const authDir = process.env.BOT_AUTH_DIR;

  const raknetBackend = process.env.BOT_RAKNET_BACKEND || 'jsp-raknet';
  const viewDistance = parseInt(process.env.BOT_VIEW_DISTANCE || '1', 10);

  const STALE_TIMEOUT_MS = parseInt(process.env.BOT_STALE_TIMEOUT_MS || '60000', 10);
  const KEEPALIVE_MS = parseInt(process.env.BOT_KEEPALIVE_MS || '15000', 10);

  if (!uid || !host || !authDir || !Number.isFinite(port)) {
    console.error('Missing worker env. Refusing to start.');
    process.exit(2);
  }

  // Lazy require only in worker
  const bedrock = require('bedrock-protocol');
  const { Authflow, Titles } = require('prismarine-auth');

  const send = (obj) => {
    try {
      if (process.send) process.send(obj);
    } catch {}
  };

  // Crash guards: if a native module aborts, we may not get here, but for JS errors we do.
  process.on('uncaughtException', (e) => {
    send({ t: 'error', message: e?.message || String(e), stack: e?.stack || '' });
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    send({ t: 'error', message: e?.message || String(e), stack: e?.stack || '' });
    process.exit(1);
  });

  let client = null;
  let connected = false;     // becomes true after start_game
  let stopping = false;
  let entityId = null;

  // State for anti-AFK
  const pos = { x: 0, y: 0, z: 0 };
  let yaw = 0;
  let pitch = 0;
  let tick = 0;

  let lastPacketAt = Date.now();
  let afkTimer = null;
  let keepaliveTimer = null;
  let staleTimer = null;

  // Authflow: uses cached tokens in authDir; if it needs reauth, we forward the device code to the parent.
  const authflow = new Authflow(
    uid,
    authDir,
    {
      flow: 'live',
      authTitle: Titles?.MinecraftNintendoSwitch || 'Bedrock AFK Bot',
      deviceType: 'Nintendo'
    },
    (data) => {
      const uri = data?.verification_uri_complete || data?.verification_uri;
      const code = data?.user_code;
      send({ t: 'msa', uri, code });
    }
  );

  const opts = {
    host,
    port,
    connectTimeout: 30_000,
    keepAlive: true,
    viewDistance,
    raknetBackend, // 'jsp-raknet' recommended for stability
    profilesFolder: authDir,
    username: uid,
    offline: false,
    skipPing: true,
    autoInitPlayer: true,
    useTimeout: true,
    authflow
  };

  if (connectionType === 'offline') {
    opts.username = offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
    delete opts.authflow;
  }

  // --- Create client ---
  try {
    client = bedrock.createClient(opts);
  } catch (e) {
    send({ t: 'error', message: e?.message || String(e), stack: e?.stack || '' });
    process.exit(1);
  }

  // --- messaging ---
  process.on('message', async (m) => {
    if (!m || typeof m !== 'object') return;

    if (m.cmd === 'stop') {
      stopping = true;
      // IMPORTANT: bedrock-protocol has a known crash when calling close() before fully connected.
      // So: only close if we're in a connected state. Otherwise we just exit.
      if (connected && client) {
        try { client.close(); } catch {}
        setTimeout(() => process.exit(0), 700);
      } else {
        process.exit(0);
      }
      return;
    }

    if (m.cmd === 'stats') {
      const mem = process.memoryUsage();
      send({
        t: 'stats',
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        backend: raknetBackend,
        connected
      });
    }
  });

  // --- events ---
  client.on('spawn', () => {
    // 'spawn' can fire before start_game in some cases; do not mark connected here
    send({ t: 'spawn' });
  });

  client.on('start_game', (pk) => {
    connected = true;
    entityId = pk?.runtime_entity_id || null;

    pos.x = pk?.player_position?.x || 0;
    pos.y = pk?.player_position?.y || 0;
    pos.z = pk?.player_position?.z || 0;

    yaw = (pk?.rotation && pk.rotation.y) || 0;
    pitch = (pk?.rotation && pk.rotation.x) || 0;

    lastPacketAt = Date.now();

    send({ t: 'ready', backend: raknetBackend });
    startLoops();
  });

  client.on('disconnect', (pk) => {
    const reason = pk?.reason || 'Unknown';
    send({ t: 'kick', reason });
    // Do not call close if not connected (can crash). Just exit; parent will restart if desired.
    safeExit(0);
  });

  client.on('close', () => {
    safeExit(0);
  });

  client.on('error', (e) => {
    send({ t: 'error', message: e?.message || String(e), stack: e?.stack || '' });
    safeExit(1);
  });

  client.on('packet', (_data, _meta) => {
    lastPacketAt = Date.now();
    // Keep this handler minimal to reduce overhead & memory pressure.
  });

  function scheduleNextAfk() {
    if (stopping) return;
    const delay = Math.floor(8000 + Math.random() * 12000);
    afkTimer = setTimeout(doAntiAfk, delay);
  }

  function doAntiAfk() {
    if (stopping || !client || !connected || !entityId) return scheduleNextAfk();

    try {
      const r = Math.random();

      // 1) swing
      if (r < 0.40) {
        client.write('animate', { action_id: 1, runtime_entity_id: entityId });

      // 2) crouch toggle
      } else if (r < 0.60) {
        client.write('player_action', {
          runtime_entity_id: entityId,
          action: 11,
          position: pos,
          result_position: pos,
          face: 0
        });
        setTimeout(() => {
          if (!client || stopping || !connected || !entityId) return;
          try {
            client.write('player_action', {
              runtime_entity_id: entityId,
              action: 12,
              position: pos,
              result_position: pos,
              face: 0
            });
          } catch {}
        }, Math.floor(1800 + Math.random() * 1800));

      // 3) jump (move up then down)
      } else if (r < 0.80) {
        client.write('player_action', {
          runtime_entity_id: entityId,
          action: 8,
          position: pos,
          result_position: pos,
          face: 0
        });

        const originalY = pos.y;
        tick += 1;
        client.queue('move_player', {
          runtime_entity_id: entityId,
          position: { x: pos.x, y: originalY + 0.45, z: pos.z },
          pitch,
          yaw,
          head_yaw: yaw,
          on_ground: false,
          mode: 0,
          tick
        });

        setTimeout(() => {
          if (!client || stopping || !connected || !entityId) return;
          try {
            tick += 1;
            client.queue('move_player', {
              runtime_entity_id: entityId,
              position: { x: pos.x, y: originalY, z: pos.z },
              pitch,
              yaw,
              head_yaw: yaw,
              on_ground: true,
              mode: 0,
              tick
            });
            pos.y = originalY;
          } catch {}
        }, Math.floor(350 + Math.random() * 250));

      // 4) micro-walk
      } else {
        const dx = (Math.random() - 0.5) * 0.45;
        const dz = (Math.random() - 0.5) * 0.45;
        pos.x += dx;
        pos.z += dz;

        tick += 1;
        client.queue('move_player', {
          runtime_entity_id: entityId,
          position: { x: pos.x, y: pos.y, z: pos.z },
          pitch,
          yaw,
          head_yaw: yaw,
          on_ground: true,
          mode: 0,
          tick
        });
      }
    } catch {
      // ignore
    }

    scheduleNextAfk();
  }

  function startLoops() {
    // Keepalive: lightweight packet to keep connection warm.
    keepaliveTimer = setInterval(() => {
      if (stopping || !client || !connected) return;
      try { client.queue('client_cache_status', { enabled: false }); } catch {}
    }, KEEPALIVE_MS);

    // Stale watchdog: if no packets for too long, exit and let parent restart.
    staleTimer = setInterval(() => {
      if (stopping) return;
      if (Date.now() - lastPacketAt > STALE_TIMEOUT_MS) {
        send({ t: 'warn', message: `stale (${STALE_TIMEOUT_MS}ms)` });
        safeExit(0);
      }
    }, Math.min(10_000, Math.max(2000, Math.floor(STALE_TIMEOUT_MS / 3))));

    scheduleNextAfk();
  }

  function safeExit(code) {
    if (stopping) return;
    stopping = true;

    try { if (afkTimer) clearTimeout(afkTimer); } catch {}
    try { if (keepaliveTimer) clearInterval(keepaliveTimer); } catch {}
    try { if (staleTimer) clearInterval(staleTimer); } catch {}

    // IMPORTANT: avoid calling client.close() if not fully connected (known crash trigger).
    if (connected && client) {
      try { client.close(); } catch {}
      setTimeout(() => process.exit(code), 500);
    } else {
      process.exit(code);
    }
  }
}

// =====================================================================
// Utilities
// =====================================================================

async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    return true;
  } catch (e) {
    console.error(`Failed to create directory ${dir}:`, e?.message || e);
    return false;
  }
}

class PersistentStore {
  constructor(filePath, debounceMs = 150) {
    this.filePath = filePath;
    this.debounceMs = debounceMs;
    this.data = null;
    this.timer = null;
    this.saving = false;
  }

  async load(defaultVal = {}) {
    this.data = defaultVal;
    try {
      const content = await fsp.readFile(this.filePath, 'utf8');
      if (content && content.trim()) {
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object') {
          this.data = { ...this.data, ...parsed };
        }
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') {
        console.error(`Failed to load ${this.filePath}:`, e?.message || e);
        // backup corrupt file
        try {
          await fsp.rename(this.filePath, `${this.filePath}.corrupt.${Date.now()}`);
        } catch {}
      }
    }
    return this.data;
  }

  get(key) { return this.data?.[key]; }

  set(key, value) {
    if (!this.data) this.data = {};
    this.data[key] = value;
    this.save();
  }

  delete(key) {
    if (!this.data) return;
    delete this.data[key];
    this.save();
  }

  async save(immediate = false) {
    if (immediate) return this._flush();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._flush(), this.debounceMs);
    return true;
  }

  async _flush() {
    if (this.saving) return false;
    this.saving = true;
    try {
      const dir = path.dirname(this.filePath);
      await fsp.mkdir(dir, { recursive: true });

      const json = JSON.stringify(this.data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
      const tmp = `${this.filePath}.tmp`;
      await fsp.writeFile(tmp, json);
      await fsp.rename(tmp, this.filePath);
      return true;
    } catch (e) {
      console.error('Store flush error:', e?.message || e);
      return false;
    } finally {
      this.saving = false;
    }
  }
}
