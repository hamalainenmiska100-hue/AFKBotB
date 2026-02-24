/*
 * Crash-hardened AFK bot for Minecraft Bedrock Edition (Discord-controlled).
 *
 * What was fixed (high level):
 *  1) Prevented native RakNet crashes (SIGABRT / SIGSEGV / free(): invalid pointer) by defaulting to the
 *     pure-JS RakNet backend ("jsp-raknet") and by NEVER calling client.close() during the pre-join handshake
 *     when using native backends (a known crash case). See refs in the chat response.
 *  2) Eliminated race conditions that caused double-close / close-after-free: every Bedrock event handler is
 *     now runId-guarded; reconnect is de-duplicated; and all packet sends go through a safeSend wrapper.
 *  3) Plugged timer-leaks and store-write races that could amplify instability over time.
 *
 * Run:
 *   npm i discord.js bedrock-protocol prismarine-auth
 *   DISCORD_TOKEN=... node --expose-gc bot.js
 *
 * Optional:
 *   RAKNET_BACKEND=jsp-raknet|raknet-native|raknet-node
 *   DEBUG=minecraft-protocol   (bedrock-protocol debug)
 */

'use strict';

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

const bedrock = require('bedrock-protocol');
const { Authflow, Titles } = require('prismarine-auth');
const fs = require('fs').promises;
const path = require('path');

// ==================== ENVIRONMENT & CONFIGURATION ====================

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN missing');
  process.exit(1);
}

/**
 * Central configuration
 */
const CONFIG = {
  ADMIN_ID: '1144987924123881564',
  LOG_CHANNEL_ID: '1464615030111731753',

  SAVE_DEBOUNCE_MS: 120,
  AUTO_SAVE_INTERVAL_MS: 15000,

  MAX_RECONNECT_ATTEMPTS: 10,
  RECONNECT_BASE_DELAY_MS: 10000,
  RECONNECT_MAX_DELAY_MS: 300000,

  CONNECTION_TIMEOUT_MS: 30000,
  KEEPALIVE_INTERVAL_MS: 15000,
  STALE_CONNECTION_TIMEOUT_MS: 60000,

  MEMORY_CHECK_INTERVAL_MS: 60000,
  MAX_MEMORY_MB: 1536,

  NATIVE_CLEANUP_DELAY_MS: 5000,
  PING_TIMEOUT_MS: 5000,

  // Default to crash-resistant backend. Override with env or settings modal.
  DEFAULT_RAKNET_BACKEND: (process.env.RAKNET_BACKEND || 'jsp-raknet').trim()
};

// Fly.io exposes FLY_VOLUME_PATH, but falls back to /data locally.
const DATA = process.env.FLY_VOLUME_PATH || '/data';
const AUTH_ROOT = path.join(DATA, 'auth');
const STORE = path.join(DATA, 'users.json');
const REJOIN_STORE = path.join(DATA, 'rejoin.json');
const CRASH_LOG = path.join(DATA, 'crash.log');

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
    return true;
  } catch (e) {
    console.error(`Failed to create directory ${dir}:`, e.message);
    return false;
  }
}

// ==================== PERSISTENT STORE (with write queue) ====================

class PersistentStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;

    this.saveTimeout = null;
    this.isSaving = false;
    this.needsSave = false;

    this.lastSaveTime = 0;
    this.saveCount = 0;
  }

  async load(defaultVal = {}) {
    this.data = defaultVal;
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      if (content.trim()) {
        const parsed = JSON.parse(content);
        if (typeof parsed === 'object' && parsed !== null) {
          this.data = { ...this.data, ...parsed };
        }
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') {
        console.error(`Failed to load ${this.filePath}:`, e.message);
        await this._backupCorruptFile();
      }
    }
    return this.data;
  }

  async _backupCorruptFile() {
    try {
      const backupPath = `${this.filePath}.backup.${Date.now()}`;
      await fs.rename(this.filePath, backupPath);
    } catch (_) {}
  }

  set(key, value) {
    try {
      if (!this.data) this.data = {};
      this.data[key] = value;
      this.save();
    } catch (e) {
      console.error('Store set error:', e.message);
    }
  }

  get(key) {
    try {
      return this.data?.[key];
    } catch (_) {
      return undefined;
    }
  }

  delete(key) {
    try {
      if (this.data) {
        delete this.data[key];
        this.save();
      }
    } catch (e) {
      console.error('Store delete error:', e.message);
    }
  }

  save(immediate = false) {
    if (immediate) return this._flush();
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this._flush(), CONFIG.SAVE_DEBOUNCE_MS);
    return Promise.resolve(true);
  }

  async _flush() {
    // If a write is already in progress, queue one more flush.
    if (this.isSaving) {
      this.needsSave = true;
      return;
    }

    this.isSaving = true;
    this.needsSave = false;

    try {
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });

      const jsonString = JSON.stringify(
        this.data,
        (key, value) => (typeof value === 'bigint' ? value.toString() : value),
        2
      );

      await fs.writeFile(`${this.filePath}.tmp`, jsonString);
      await fs.rename(`${this.filePath}.tmp`, this.filePath);

      this.lastSaveTime = Date.now();
      this.saveCount++;
    } catch (e) {
      console.error('Store flush error:', e.message);
      await this._emergencyBackup();
    } finally {
      this.isSaving = false;
      // If changes happened during the write, flush again once.
      if (this.needsSave) {
        setImmediate(() => this._flush().catch(() => {}));
      }
    }
  }

  async _emergencyBackup() {
    try {
      const emergencyPath = `${this.filePath}.emergency.${Date.now()}`;
      await fs.writeFile(
        emergencyPath,
        JSON.stringify(this.data, (key, value) => (typeof value === 'bigint' ? value.toString() : value))
      );
    } catch (_) {}
  }
}

// ==================== INITIALIZE STORES ====================

const userStore = new PersistentStore(STORE);
const sessionStore = new PersistentStore(REJOIN_STORE);

let users = {};
let activeSessionsStore = {};
let storesInitialized = false;

async function initializeStores() {
  await ensureDir(DATA);
  await ensureDir(AUTH_ROOT);
  users = await userStore.load({});
  activeSessionsStore = await sessionStore.load({});
  storesInitialized = true;
  console.log(
    `Loaded ${Object.keys(users).length} users and ${Object.keys(activeSessionsStore).length} active sessions`
  );
}

// ==================== RUNTIME STATE ====================

const sessions = new Map(); // uid -> session object
const pendingLink = new Map();
const lastMsa = new Map();
const lastInteractionAt = new Map();
let isShuttingDown = false;
let discordReady = false;
const cleanupLocks = new Set();

// ==================== DISCORD FLAGS HELPERS (discord.js v15 compatible) ====================

const EPHEMERAL_FLAGS = MessageFlags?.Ephemeral ?? (1 << 6);

function withEphemeralFlags(payload, ephemeral) {
  if (!payload || typeof payload !== 'object') return payload;
  if (!ephemeral) {
    if ('ephemeral' in payload) delete payload.ephemeral;
    return payload;
  }
  if (payload.flags === undefined) payload.flags = EPHEMERAL_FLAGS;
  if ('ephemeral' in payload) delete payload.ephemeral;
  return payload;
}

// ==================== DISCORD CLIENT ====================

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel, Partials.Message, Partials.User],
  failIfNotExists: false,
  allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
  rest: {
    rejectOnRateLimit: () => false,
    retries: 2,
    timeout: 15000
  },
  presence: { status: 'online', activities: [{ name: 'AFK Bot System', type: ActivityType.Watching }] }
});

// ==================== CRASH LOGGER ====================

const crashLogger = {
  log: async (type, err) => {
    try {
      const timestamp = new Date().toISOString();
      const errorMsg = `[${timestamp}] ${type}:\n${err?.stack || err?.message || String(err)}\n\n`;
      await fs.appendFile(CRASH_LOG, errorMsg).catch(() => {});
    } catch (_) {}
  },
  isFatal: (err) => {
    const fatalCodes = ['EADDRINUSE', 'EACCES', 'ENOTFOUND', 'EAI_AGAIN'];
    return fatalCodes.includes(err?.code);
  }
};

process.on('uncaughtException', (err) => {
  crashLogger.log('UNCAUGHT EXCEPTION', err);
  if (crashLogger.isFatal(err)) gracefulShutdown('FATAL_ERROR');
});

process.on('unhandledRejection', (reason) => {
  crashLogger.log('UNHANDLED REJECTION', reason);
});

// ==================== DISCORD CONNECTION RESILIENCE ====================

client.on('error', (error) => {
  console.error('DISCORD ERROR:', error?.message);
  discordReady = false;
});

client.on(Events.ShardError, (error) => {
  console.error('SHARD ERROR:', error?.message);
});

client.on(Events.ShardDisconnect, () => {
  discordReady = false;
  console.log('Discord shard disconnected. Auto-reconnecting...');
});

client.on(Events.ShardResume, (_shardId, replayed) => {
  discordReady = true;
  console.log(`Discord shard resumed. Replayed: ${replayed}`);
});

// ==================== GRACEFUL SHUTDOWN ====================

async function gracefulShutdown(signal) {
  console.log(`Shutting down due to ${signal}...`);
  isShuttingDown = true;

  const forceExit = setTimeout(() => process.exit(1), 15000);

  try {
    await saveAllSessionData();
    await Promise.all([userStore.save(true), sessionStore.save(true)]);
    await cleanupAllSessions();
    await client.destroy();

    clearTimeout(forceExit);
    process.exit(0);
  } catch (e) {
    console.error('Shutdown error:', e);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ==================== SESSION DATA MANAGEMENT ====================

async function saveSessionData(uid) {
  if (!uid) return;
  const u = getUser(uid);
  if (!u) return;

  activeSessionsStore[uid] = {
    startedAt: Date.now(),
    server: u.server,
    connectionType: u.connectionType,
    bedrockVersion: u.bedrockVersion,
    offlineUsername: u.offlineUsername,
    linked: u.linked,
    authTokenExpiry: u.authTokenExpiry,
    tokenAcquiredAt: u.tokenAcquiredAt,
    raknetBackend: u.raknetBackend,
    lastActive: Date.now()
  };

  await sessionStore.save();
}

async function saveAllSessionData() {
  for (const [uid] of sessions) {
    await saveSessionData(uid);
  }
}

async function clearSessionData(uid) {
  if (activeSessionsStore[uid]) {
    delete activeSessionsStore[uid];
    await sessionStore.save();
  }
}

// ==================== USER MANAGEMENT ====================

function getUser(uid) {
  // For safety, allow a temp user when uid is missing/invalid.
  if (!uid || typeof uid !== 'string' || !/^\d+$/.test(uid)) {
    return {
      connectionType: 'online',
      bedrockVersion: 'auto',
      raknetBackend: CONFIG.DEFAULT_RAKNET_BACKEND,
      _temp: true
    };
  }

  if (!users[uid]) {
    users[uid] = {
      connectionType: 'online',
      bedrockVersion: 'auto',
      raknetBackend: CONFIG.DEFAULT_RAKNET_BACKEND,
      createdAt: Date.now(),
      lastActive: Date.now()
    };
    userStore.save();
  }

  users[uid].connectionType = users[uid].connectionType || 'online';
  users[uid].bedrockVersion = users[uid].bedrockVersion || 'auto';
  users[uid].raknetBackend = users[uid].raknetBackend || CONFIG.DEFAULT_RAKNET_BACKEND;
  users[uid].lastActive = Date.now();

  return users[uid];
}

async function getUserAuthDir(uid) {
  if (!uid || typeof uid !== 'string') return null;
  const safeUid = uid.replace(/[^a-zA-Z0-9]/g, '');
  if (!safeUid) return null;
  const dir = path.join(AUTH_ROOT, safeUid);
  await ensureDir(dir);
  return dir;
}

async function unlinkMicrosoft(uid) {
  if (!uid) return false;
  const dir = await getUserAuthDir(uid);
  if (dir) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (_) {}
  }
  const u = getUser(uid);
  u.linked = false;
  u.authTokenExpiry = null;
  u.tokenAcquiredAt = null;
  await userStore.save();
  return true;
}

// ==================== VALIDATION HELPERS ====================

function isValidIP(ip) {
  if (!ip || typeof ip !== 'string') return false;
  if (ip.length > 253) return false;
  if (ip.includes('..') || ip.startsWith('.') || ip.endsWith('.')) return false;
  if (ip.includes('://')) return false;

  const ipv4Regex =
    /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
  const hostnameRegex =
    /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;

  return ipv4Regex.test(ip) || ipv6Regex.test(ip) || hostnameRegex.test(ip);
}

function isValidPort(port) {
  const num = parseInt(port, 10);
  return !isNaN(num) && num > 0 && num <= 65535;
}

function isValidBackend(backend) {
  return ['jsp-raknet', 'raknet-native', 'raknet-node'].includes(String(backend || '').trim());
}

// ==================== DISCORD HELPERS ====================

async function logToDiscord(message) {
  if (!message || isShuttingDown || !discordReady) return;
  try {
    const channel = await client.channels.fetch(CONFIG.LOG_CHANNEL_ID);
    if (!channel) return;
    const embed = new EmbedBuilder().setColor('#5865F2').setDescription(String(message).slice(0, 4096)).setTimestamp();
    await channel.send({ embeds: [embed] }).catch(() => {});
  } catch (_) {}
}

async function safeReply(interaction, content, ephemeral = true) {
  try {
    if (!interaction) return;

    const payload = typeof content === 'string' ? { content } : { ...content };
    withEphemeralFlags(payload, ephemeral);

    // Defer if not acknowledged yet (avoids "Unknown interaction")
    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.deferReply(withEphemeralFlags({}, ephemeral));
      } catch (e) {
        if (e?.code === 10062) return; // Unknown interaction
      }
    }

    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply(payload).catch((e) => {
        if (e?.code !== 10062) console.error('Failed to editReply:', e);
      });
      return;
    }

    if (interaction.replied) {
      await interaction.followUp(payload).catch((e) => {
        if (e?.code !== 10062) console.error('Failed to followUp:', e);
      });
      return;
    }

    await interaction.reply(payload).catch((e) => {
      if (e?.code !== 10062) console.error('Failed to reply:', e);
    });
  } catch (e) {
    console.error('SafeReply error:', e);
  }
}

// ==================== UI COMPONENTS ====================

function panelRow(isJava = false) {
  const title = isJava ? 'Java AFKBot Panel' : 'Bedrock AFKBot Panel';
  const startCustomId = isJava ? 'start_java' : 'start_bedrock';
  return {
    content: `**${title}**`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('link').setLabel('Link Microsoft').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('unlink').setLabel('Unlink Microsoft').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(startCustomId).setLabel('Start').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('settings').setLabel('Settings').setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}

// ==================== MICROSOFT AUTHENTICATION ====================

async function linkMicrosoft(uid, interaction) {
  if (!uid || !interaction) return;
  await interaction.deferReply(withEphemeralFlags({}, true)).catch(() => {});

  if (pendingLink.has(uid)) {
    return interaction
      .followUp(withEphemeralFlags({ content: 'Login already in progress. Check your DMs or use the last code.' }, true))
      .catch(() => {});
  }

  const authDir = await getUserAuthDir(uid);
  if (!authDir) {
    return interaction
      .followUp(withEphemeralFlags({ content: 'System error: Cannot create auth directory.' }, true))
      .catch(() => {});
  }

  const u = getUser(uid);
  const timeoutId = setTimeout(() => {
    pendingLink.delete(uid);
    interaction.followUp(withEphemeralFlags({ content: 'Login timed out after 5 minutes.' }, true)).catch(() => {});
  }, 300000);

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
        lastMsa.set(uid, { uri, code, at: Date.now() });

        const msg = `**Microsoft Authentication Required**\n\n1. Visit: ${uri}\n2. Enter Code: \`${code}\`\n\n**Security Notice:** Your account tokens are saved locally and are never shared.`;
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Open link').setStyle(ButtonStyle.Link).setURL(uri));

        await interaction.followUp(withEphemeralFlags({ content: msg, components: [row] }, true)).catch(() => {});
      }
    );

    flow
      .getMsaToken()
      .then(async () => {
        clearTimeout(timeoutId);
        u.linked = true;
        u.tokenAcquiredAt = Date.now();
        await userStore.save();
        await interaction.followUp(withEphemeralFlags({ content: 'Microsoft account linked!' }, true)).catch(() => {});
        pendingLink.delete(uid);
      })
      .catch(async (e) => {
        clearTimeout(timeoutId);
        const errorMsg = e?.message || 'Unknown error';
        await interaction.followUp(withEphemeralFlags({ content: `Login failed: ${errorMsg}` }, true)).catch(() => {});
        pendingLink.delete(uid);
      });

    pendingLink.set(uid, true);
  } catch (_) {
    clearTimeout(timeoutId);
    pendingLink.delete(uid);
    await interaction.followUp(withEphemeralFlags({ content: 'Authentication system error.' }, true)).catch(() => {});
  }
}

// ==================== SESSION LIFECYCLE HELPERS ====================

function getLiveSession(uid, runId) {
  const s = sessions.get(uid);
  if (!s) return null;
  if (runId && s.runId !== runId) return null;
  if (s.isCleaningUp) return null;
  return s;
}

function safeSend(uid, runId, fn) {
  const s = getLiveSession(uid, runId);
  if (!s || !s.client || s.clientClosing || !s.connected) return false;
  try {
    fn(s.client, s);
    return true;
  } catch (e) {
    // Errors here often indicate transport instability; schedule a reconnect if needed.
    if (!s.manualStop && !s.reconnectScheduled && !s.isReconnecting) {
      handleAutoReconnect(uid, (s.reconnectAttempt || 0) + 1);
    }
    return false;
  }
}

// ==================== SAFE BEDROCK CLIENT CLOSE ====================

async function safeCloseBedrockClient(uid, s, waitMs = 2000) {
  if (!s || !s.client) return;
  if (s.clientClosing) return;

  const mc = s.client;
  s.clientClosing = true;
  s.connected = false;

  // IMPORTANT:
  // bedrock-protocol has a known crash case where calling client.close() during pre-join handshake
  // (not fully connected yet) can abort the whole process (free(): invalid pointer).
  // If we're on a native backend and never reached start_game, we skip calling close().
  const backend = String(s.raknetBackend || CONFIG.DEFAULT_RAKNET_BACKEND);
  const allowClose =
    backend === 'jsp-raknet' ||
    backend === 'raknet-node' ||
    (backend === 'raknet-native' && s.connectedEver === true);

  if (!allowClose) {
    // Best effort: drop references and let the connection timeout.
    s.client = null;
    return;
  }

  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    const timeout = setTimeout(() => finish(), waitMs);

    try {
      mc.once?.('close', () => {
        clearTimeout(timeout);
        finish();
      });
    } catch (_) {}

    try {
      mc.close();
    } catch (_) {
      clearTimeout(timeout);
      finish();
    }
  });

  s.client = null;
}

// ==================== SESSION MANAGEMENT ====================

async function cleanupSession(uid) {
  if (!uid) return;
  if (cleanupLocks.has(uid)) return;
  cleanupLocks.add(uid);

  try {
    const s = sessions.get(uid);
    if (!s) return;

    s.isCleaningUp = true;
    s.manualStop = true;

    // Cancel timers / intervals
    const timers = ['reconnectTimer', 'afkTimeout', 'keepaliveTimer', 'staleCheckTimer'];
    for (const t of timers) {
      if (s[t]) {
        clearTimeout(s[t]);
        clearInterval(s[t]);
        s[t] = null;
      }
    }

    // Cancel nested anti-AFK timeouts
    try {
      if (s.pendingTimeouts && s.pendingTimeouts.size) {
        for (const t of s.pendingTimeouts) clearTimeout(t);
        s.pendingTimeouts.clear();
      }
    } catch (_) {}

    // Small delay to allow in-flight handlers to notice isCleaningUp
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      await safeCloseBedrockClient(uid, s, 2000);
    } catch (e) {
      console.error(`Error closing client for ${uid}:`, e?.message || e);
    }

    sessions.delete(uid);

    if (global.gc) global.gc();
  } finally {
    cleanupLocks.delete(uid);
  }
}

async function cleanupAllSessions() {
  const promises = [];
  for (const [uid] of sessions) promises.push(cleanupSession(uid));
  await Promise.allSettled(promises);
}

async function stopSession(uid) {
  if (!uid) return false;
  const s = sessions.get(uid);
  if (s) {
    s.manualStop = true;
    s.reconnectScheduled = true;
    if (s.reconnectTimer) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = null;
    }
  }
  await clearSessionData(uid);
  await cleanupSession(uid);
  return true;
}

// ==================== RECONNECTION SYSTEM ====================

async function handleAutoReconnect(uid, attempt = 1) {
  if (!uid || isShuttingDown) return;

  const s = sessions.get(uid);
  if (!s || s.manualStop || s.isCleaningUp) return;

  attempt = Math.max(1, attempt);

  if (attempt > CONFIG.MAX_RECONNECT_ATTEMPTS) {
    await logToDiscord(`Bot of <@${uid}> stopped after max failed attempts.`);
    await cleanupSession(uid);
    await clearSessionData(uid);
    return;
  }

  // De-duplicate reconnect scheduling
  if (s.reconnectScheduled) return;
  s.reconnectScheduled = true;

  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  s.isReconnecting = true;
  s.reconnectAttempt = attempt;

  const baseDelay = Math.min(
    CONFIG.RECONNECT_BASE_DELAY_MS * Math.pow(1.5, attempt - 1),
    CONFIG.RECONNECT_MAX_DELAY_MS
  );
  const jitter = Math.random() * 5000;
  const delay = baseDelay + jitter;

  await logToDiscord(
    `Bot of <@${uid}> disconnected. Reconnecting in ${Math.round(delay / 1000)}s (Attempt ${attempt})...`
  );

  s.reconnectTimer = setTimeout(async () => {
    const cur = sessions.get(uid);
    if (!cur) return;

    if (!isShuttingDown && !cur.manualStop) {
      await cleanupSession(uid);
      await new Promise((resolve) => setTimeout(resolve, CONFIG.NATIVE_CLEANUP_DELAY_MS));
      if (!isShuttingDown) {
        await startSession(uid, null, true, attempt);
      }
    } else {
      await cleanupSession(uid);
    }
  }, delay);
}

// ==================== CONNECTION HEALTH MONITORING ====================

function startHealthMonitoring(uid, runId) {
  const s = getLiveSession(uid, runId);
  if (!s) return;

  s.keepaliveTimer = setInterval(() => {
    safeSend(uid, runId, (mc, ses) => {
      // Harmless packet used as keepalive. Wrap in safeSend so it never throws out.
      mc.queue('client_cache_status', { enabled: false });
      ses.lastKeepalive = Date.now();
    });
  }, CONFIG.KEEPALIVE_INTERVAL_MS);

  s.staleCheckTimer = setInterval(() => {
    const ses = getLiveSession(uid, runId);
    if (!ses) return;
    if (!ses.connected || ses.clientClosing) return;

    const lastActivity = Math.max(ses.lastPacketTime || 0, ses.lastKeepalive || 0);
    if (Date.now() - lastActivity > CONFIG.STALE_CONNECTION_TIMEOUT_MS) {
      if (!ses.manualStop && !ses.reconnectScheduled) {
        handleAutoReconnect(uid, (ses.reconnectAttempt || 0) + 1);
      }
    }
  }, CONFIG.STALE_CONNECTION_TIMEOUT_MS);
}

// ==================== ANTI-AFK ====================

function scheduleSessionTimeout(uid, runId, ms, fn) {
  const s = getLiveSession(uid, runId);
  if (!s) return null;

  const t = setTimeout(() => {
    // Remove the handle to prevent pendingTimeouts growth
    try {
      const cur = sessions.get(uid);
      cur?.pendingTimeouts?.delete(t);
    } catch (_) {}

    const cur = getLiveSession(uid, runId);
    if (!cur) return;
    try {
      fn();
    } catch (_) {}
  }, ms);

  try {
    s.pendingTimeouts.add(t);
  } catch (_) {}

  return t;
}

function startAntiAfkLoop(uid, runId) {
  const s = getLiveSession(uid, runId);
  if (!s) return;

  const performAntiAfk = () => {
    const ses = getLiveSession(uid, runId);
    if (!ses || !ses.connected || ses.clientClosing) return;

    const r = Math.random();

    // Hand swing
    if (r < 0.4) {
      safeSend(uid, runId, (mc, cur) => {
        mc.write('animate', { action_id: 1, runtime_entity_id: cur.entityId });
      });
    }
    // Crouch
    else if (r < 0.6) {
      safeSend(uid, runId, (mc, cur) => {
        mc.write('player_action', {
          runtime_entity_id: cur.entityId,
          action: 11,
          position: cur.position,
          result_position: cur.position,
          face: 0
        });
      });

      const stopDelay = 2000 + Math.random() * 2000;
      scheduleSessionTimeout(uid, runId, stopDelay, () => {
        safeSend(uid, runId, (mc, cur) => {
          mc.write('player_action', {
            runtime_entity_id: cur.entityId,
            action: 12,
            position: cur.position,
            result_position: cur.position,
            face: 0
          });
        });
      });
    }
    // Jump
    else if (r < 0.8) {
      safeSend(uid, runId, (mc, cur) => {
        mc.write('player_action', {
          runtime_entity_id: cur.entityId,
          action: 8,
          position: cur.position,
          result_position: cur.position,
          face: 0
        });

        const original = { ...cur.position };
        const jumpPos = { x: original.x, y: original.y + 0.5, z: original.z };

        cur.tick = (cur.tick || 0) + 1;
        mc.queue('move_player', {
          runtime_entity_id: cur.entityId,
          position: jumpPos,
          pitch: cur.pitch || 0,
          yaw: cur.yaw || 0,
          head_yaw: cur.yaw || 0,
          on_ground: false,
          mode: 0,
          tick: cur.tick
        });

        scheduleSessionTimeout(uid, runId, 400 + Math.random() * 200, () => {
          safeSend(uid, runId, (mc2, cur2) => {
            cur2.tick = (cur2.tick || 0) + 1;
            mc2.queue('move_player', {
              runtime_entity_id: cur2.entityId,
              position: original,
              pitch: cur2.pitch || 0,
              yaw: cur2.yaw || 0,
              head_yaw: cur2.yaw || 0,
              on_ground: true,
              mode: 0,
              tick: cur2.tick
            });
            cur2.position = { ...original };
          });
        });
      });
    }
    // Walk
    else {
      safeSend(uid, runId, (mc, cur) => {
        const dx = (Math.random() - 0.5) * 0.5;
        const dz = (Math.random() - 0.5) * 0.5;
        cur.position.x += dx;
        cur.position.z += dz;

        cur.tick = (cur.tick || 0) + 1;
        mc.queue('move_player', {
          runtime_entity_id: cur.entityId,
          position: { x: cur.position.x, y: cur.position.y, z: cur.position.z },
          pitch: cur.pitch || 0,
          yaw: cur.yaw || 0,
          head_yaw: cur.yaw || 0,
          on_ground: true,
          mode: 0,
          tick: cur.tick
        });
      });
    }

    const nextDelay = Math.random() * 12000 + 8000;
    if (ses.afkTimeout) clearTimeout(ses.afkTimeout);
    ses.afkTimeout = scheduleSessionTimeout(uid, runId, nextDelay, performAntiAfk);
  };

  // Start after a short delay.
  scheduleSessionTimeout(uid, runId, 5000, performAntiAfk);
}

// ==================== MAIN SESSION FUNCTION ====================

async function startSession(uid, interaction, isReconnect = false, reconnectAttempt = 1) {
  if (!uid || isShuttingDown) return;

  if (!storesInitialized) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!storesInitialized) {
      if (interaction) safeReply(interaction, 'System initializing, please try again.');
      return;
    }
  }

  if (interaction && !interaction.deferred && !interaction.replied) {
    await interaction.deferReply(withEphemeralFlags({}, true)).catch(() => {});
  }

  if (cleanupLocks.has(uid)) {
    let attempts = 0;
    while (cleanupLocks.has(uid) && attempts < 10) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      attempts++;
    }
  }

  const u = getUser(uid);
  if (!u) {
    if (interaction) safeReply(interaction, 'User data error.');
    return;
  }

  if (!u.linked) {
    if (interaction) safeReply(interaction, 'Please auth with Xbox to use the bot');
    else await clearSessionData(uid);
    return;
  }

  await saveSessionData(uid);

  if (!u.server?.ip) {
    if (interaction) safeReply(interaction, 'Please configure your server settings first.');
    await clearSessionData(uid);
    return;
  }

  const { ip, port } = u.server;
  if (!isValidIP(ip) || !isValidPort(port)) {
    if (interaction) safeReply(interaction, 'Invalid server IP or port format.');
    await clearSessionData(uid);
    return;
  }

  if (sessions.has(uid) && !isReconnect) {
    if (interaction) safeReply(interaction, '**Session Conflict**: Active session exists. Use `/stop` first.');
    return;
  }

  // For reconnect we always cleanup any leftovers first.
  if (sessions.has(uid)) {
    await cleanupSession(uid);
    await new Promise((resolve) => setTimeout(resolve, CONFIG.NATIVE_CLEANUP_DELAY_MS));
  }

  // Optional ping before first connect
  if (!isReconnect && interaction) {
    try {
      await bedrock.ping({ host: ip, port: parseInt(port, 10) || 19132, timeout: CONFIG.PING_TIMEOUT_MS });
    } catch (_) {}
  }

  const authDir = await getUserAuthDir(uid);
  if (!authDir) {
    if (interaction) safeReply(interaction, 'Auth directory error.');
    return;
  }

  const backend = isValidBackend(u.raknetBackend) ? u.raknetBackend : CONFIG.DEFAULT_RAKNET_BACKEND;

  const opts = {
    host: ip,
    port: parseInt(port, 10),
    connectTimeout: CONFIG.CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    viewDistance: 1,
    profilesFolder: authDir,
    username: uid,
    offline: false,
    skipPing: true,
    autoInitPlayer: true,
    useTimeout: true,
    raknetBackend: backend,
    conLog: null // reduce internal spam unless DEBUG enabled
  };

  if (u.connectionType === 'offline') {
    opts.username = u.offlineUsername || `AFK_${uid.slice(-4)}`;
    opts.offline = true;
  }

  // Build session state
  const currentSession = {
    client: null,
    clientClosing: false,
    connected: false,
    connectedEver: false,

    startedAt: Date.now(),
    runId: `${Date.now()}_${Math.random().toString(16).slice(2)}`,

    manualStop: false,
    isReconnecting: false,
    isCleaningUp: false,
    reconnectScheduled: false,
    reconnectAttempt: reconnectAttempt,

    raknetBackend: backend,

    entityId: null,
    reconnectTimer: null,

    afkTimeout: null,
    pendingTimeouts: new Set(),

    keepaliveTimer: null,
    staleCheckTimer: null,

    lastPacketTime: Date.now(),
    lastKeepalive: Date.now(),

    position: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    tick: 0
  };

  sessions.set(uid, currentSession);

  let mc;
  try {
    mc = bedrock.createClient(opts);
    currentSession.client = mc;
  } catch (err) {
    console.error('Failed to create client:', err);
    if (interaction) safeReply(interaction, 'Failed to create client.');
    await cleanupSession(uid);
    if (isReconnect) handleAutoReconnect(uid, (reconnectAttempt || 0) + 1);
    return;
  }

  if (!mc) {
    console.error('Client creation returned null');
    await cleanupSession(uid);
    return;
  }

  const runId = currentSession.runId;

  // ---------------- Bedrock client event handlers (runId-guarded) ----------------

  mc.on('disconnect', (packet) => {
    const s = getLiveSession(uid, runId);
    if (!s) return;
    const reason = packet?.reason || 'Unknown reason';
    logToDiscord(`Bot of <@${uid}> was kicked: ${reason}`);

    // Example heuristic: if server says "wait", stop reconnect loop (temporary ban / cooldown).
    if (typeof reason === 'string' && /(wait|before)/i.test(reason)) {
      s.manualStop = true;
      s.reconnectScheduled = true;
      clearSessionData(uid).catch(() => {});
    }
  });

  mc.on('spawn', () => {
    const s = getLiveSession(uid, runId);
    if (!s) return;

    logToDiscord(
      `Bot of <@${uid}> spawned on **${ip}:${port}**` + (isReconnect ? ` (Attempt ${reconnectAttempt})` : '')
    );
    if (interaction) safeReply(interaction, `**Online** on \`${ip}:${port}\``);
  });

  mc.on('start_game', (packet) => {
    const s = getLiveSession(uid, runId);
    if (!s || !packet) return;

    s.entityId = packet.runtime_entity_id;
    s.connected = true;
    s.connectedEver = true;

    s.isReconnecting = false;
    s.reconnectScheduled = false;
    s.reconnectAttempt = 0;

    s.lastPacketTime = Date.now();

    s.position = {
      x: packet.player_position?.x || 0,
      y: packet.player_position?.y || 0,
      z: packet.player_position?.z || 0
    };

    s.yaw = (packet.rotation && packet.rotation.y) || 0;
    s.pitch = (packet.rotation && packet.rotation.x) || 0;

    if (activeSessionsStore[uid]) {
      activeSessionsStore[uid].lastConnected = Date.now();
      activeSessionsStore[uid].entityId = packet.runtime_entity_id;
      activeSessionsStore[uid].raknetBackend = s.raknetBackend;
      sessionStore.save().catch(() => {});
    }

    startHealthMonitoring(uid, runId);
    startAntiAfkLoop(uid, runId);
  });

  mc.on('packet', (data, meta) => {
    const s = getLiveSession(uid, runId);
    if (!s) return;

    s.lastPacketTime = Date.now();

    try {
      if (!data || !meta) return;
      if (meta.name === 'move_player' && data?.position) {
        s.position = { x: data.position.x, y: data.position.y, z: data.position.z };
        if (typeof data.yaw === 'number') s.yaw = data.yaw;
        if (typeof data.pitch === 'number') s.pitch = data.pitch;
      }
    } catch (_) {}
  });

  mc.on('error', (e) => {
    const s = getLiveSession(uid, runId);
    if (!s) return;

    console.error(`Session error for ${uid}:`, e);
    logToDiscord(`Bot of <@${uid}> error: \`${e?.message || 'Unknown error'}\``);

    if (!s.manualStop && !s.reconnectScheduled && !s.isCleaningUp) {
      handleAutoReconnect(uid, (s.reconnectAttempt || 0) + 1);
    }
  });

  mc.on('close', () => {
    const s = sessions.get(uid);
    // If session already replaced/cleaned up, ignore.
    if (!s || s.runId !== runId) return;
    if (s.isCleaningUp || s.clientClosing) return;

    if (!s.manualStop && !s.reconnectScheduled) {
      handleAutoReconnect(uid, (s.reconnectAttempt || 0) + 1);
    } else {
      logToDiscord(`Bot of <@${uid}> disconnected manually.`);
    }
  });
}

// ==================== DISCORD EVENTS ====================

client.once(Events.ClientReady, async () => {
  discordReady = true;
  console.log('Discord client ready');

  try {
    const cmds = [
      new SlashCommandBuilder().setName('panel').setDescription('Open Bedrock AFK panel'),
      new SlashCommandBuilder().setName('java').setDescription('Open Java AFKBot Panel'),
      new SlashCommandBuilder().setName('refresh').setDescription('Refresh Discord connection without restart')
    ];
    await client.application?.commands?.set(cmds);
  } catch (e) {
    console.error('Failed to register commands:', e);
  }

  setInterval(() => {
    const mem = process.memoryUsage();
    const mb = mem.rss / 1024 / 1024;
    if (mb > CONFIG.MAX_MEMORY_MB) {
      console.warn(`High memory usage: ${mb.toFixed(2)}MB`);
      if (global.gc) global.gc();
    }
  }, CONFIG.MEMORY_CHECK_INTERVAL_MS);

  setTimeout(() => {
    restoreSessions().catch((e) => console.error('restoreSessions error:', e));
  }, 10000);
});

// ==================== SESSION RESTORATION ====================

async function restoreSessions() {
  const previousSessions = Object.keys(activeSessionsStore || {});
  console.log(`Found ${previousSessions.length} sessions to restore`);

  let delay = 0;
  for (const uid of previousSessions) {
    if (typeof uid !== 'string' || !uid.match(/^\d+$/)) continue;

    const sessionData = activeSessionsStore[uid];
    if (!sessionData) continue;

    const hasServer = !!(sessionData.server && sessionData.server.ip && sessionData.server.port);
    const isLinked = sessionData.linked === true;

    if (!hasServer || !isLinked) {
      console.log(`Skipping restore for user ${uid}: missing server settings or not linked.`);
      await clearSessionData(uid);
      continue;
    }

    if (!users[uid]) users[uid] = {};
    if (sessionData.server) users[uid].server = sessionData.server;
    if (sessionData.connectionType) users[uid].connectionType = sessionData.connectionType;
    if (sessionData.bedrockVersion) users[uid].bedrockVersion = sessionData.bedrockVersion;
    if (sessionData.offlineUsername) users[uid].offlineUsername = sessionData.offlineUsername;
    if (sessionData.linked !== undefined) users[uid].linked = sessionData.linked;
    if (sessionData.authTokenExpiry) users[uid].authTokenExpiry = sessionData.authTokenExpiry;
    if (sessionData.tokenAcquiredAt) users[uid].tokenAcquiredAt = sessionData.tokenAcquiredAt;
    if (sessionData.raknetBackend) users[uid].raknetBackend = sessionData.raknetBackend;

    await userStore.save();

    setTimeout(() => {
      if (!isShuttingDown) {
        console.log(`Restoring session for user ${uid}`);
        startSession(uid, null, true).catch(() => {});
      }
    }, delay);

    delay += 8000;
  }
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (!i || isShuttingDown) return;
    if (!i.user?.id) return;

    const uid = i.user.id;
    const lastInteraction = lastInteractionAt.get(uid) || 0;
    if (Date.now() - lastInteraction < 1000) return safeReply(i, 'Please wait a moment before clicking again.');
    lastInteractionAt.set(uid, Date.now());

    if (i.isChatInputCommand()) {
      if (i.commandName === 'panel') return i.reply(panelRow(false)).catch(() => {});
      if (i.commandName === 'java') return i.reply(panelRow(true)).catch(() => {});
      if (i.commandName === 'refresh') {
        await safeReply(i, 'If Discord ever goes weird, a full restart is still the most reliable fix.');
        return;
      }
    }

    if (i.isButton()) {
      if (i.customId === 'start_bedrock' || i.customId === 'start_java') {
        if (sessions.has(uid)) return safeReply(i, '**Session Conflict**: Active session exists.');

        await i.deferReply(withEphemeralFlags({}, true)).catch(() => {});

        const embed =
          i.customId === 'start_java'
            ? new EmbedBuilder()
                .setTitle('Java Compatibility Check')
                .setDescription('For a successful connection to a Java server, ensure the following plugins are installed.')
                .addFields({ name: 'Required Plugins', value: 'GeyserMC\nFloodgate' })
                .setColor('#E67E22')
            : new EmbedBuilder().setTitle('Bedrock Connection').setDescription('Start bot?').setColor('#2ECC71');

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('confirm_start').setLabel('Start').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        );

        return i.followUp(withEphemeralFlags({ embeds: [embed], components: [row] }, true)).catch(() => {});
      }

      if (i.customId === 'confirm_start') {
        await i.deferReply(withEphemeralFlags({}, true)).catch(() => {});
        safeReply(i, '**Connecting...**', true);
        startSession(uid, i, false).catch((e) => console.error('startSession error:', e));
        return;
      }

      if (i.customId === 'cancel') return safeReply(i, 'Cancelled.');

      if (i.customId === 'stop') {
        await i.deferReply(withEphemeralFlags({}, true)).catch(() => {});
        const ok = await stopSession(uid);
        return safeReply(i, ok ? '**Session Terminated.**' : 'No active sessions.');
      }

      if (i.customId === 'link') return linkMicrosoft(uid, i);

      if (i.customId === 'unlink') {
        await i.deferReply(withEphemeralFlags({}, true)).catch(() => {});
        await unlinkMicrosoft(uid);
        return safeReply(i, 'Unlinked Microsoft account.');
      }

      if (i.customId === 'settings') {
        const u = getUser(uid);

        const modal = new ModalBuilder().setCustomId('settings_modal').setTitle('Configuration');

        const ipInput = new TextInputBuilder()
          .setCustomId('ip')
          .setLabel('Server IP')
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
          .setLabel('RakNet backend (jsp-raknet | raknet-native | raknet-node)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(String(u.raknetBackend || CONFIG.DEFAULT_RAKNET_BACKEND))
          .setMaxLength(20);

        modal.addComponents(
          new ActionRowBuilder().addComponents(ipInput),
          new ActionRowBuilder().addComponents(portInput),
          new ActionRowBuilder().addComponents(backendInput)
        );

        return i.showModal(modal);
      }
    }

    if (i.isModalSubmit() && i.customId === 'settings_modal') {
      const ip = i.fields?.getTextInputValue('ip')?.trim();
      const portStr = i.fields?.getTextInputValue('port')?.trim();
      const backend = i.fields?.getTextInputValue('backend')?.trim();

      const port = parseInt(portStr, 10);

      if (!ip || !portStr) return safeReply(i, 'IP and Port are required.');
      if (!isValidIP(ip)) return safeReply(i, 'Invalid IP address format.');
      if (!isValidPort(port)) return safeReply(i, 'Invalid port (must be 1-65535).');

      if (backend && !isValidBackend(backend)) {
        return safeReply(i, 'Invalid backend. Use: jsp-raknet | raknet-native | raknet-node');
      }

      const u = getUser(uid);
      u.server = { ip, port };
      if (backend) u.raknetBackend = backend;

      await userStore.save();

      return safeReply(i, `Saved: **${ip}:${port}**\nBackend: \`${u.raknetBackend || CONFIG.DEFAULT_RAKNET_BACKEND}\``);
    }
  } catch (e) {
    console.error('Interaction error:', e);
  }
});

// ==================== STARTUP ====================

async function main() {
  await initializeStores();
  client.login(DISCORD_TOKEN).catch((err) => {
    console.error('Initial login failed:', err);
    process.exit(1);
  });
}

main().catch((e) => {
  console.error('Fatal main() error:', e);
  process.exit(1);
});

// Heartbeat
setInterval(() => {
  console.log(
    `Heartbeat | Sessions: ${sessions.size} | Discord: ${discordReady ? 'Connected' : 'Disconnected'} | Uptime: ${Math.floor(
      process.uptime() / 60
    )}m`
  );
}, 60000);
