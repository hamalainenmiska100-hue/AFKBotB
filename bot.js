const bedrock = require('bedrock-protocol');
const { Authflow, Titles } = require('prismarine-auth');
const http = require('http');
const path = require('path');
const fs = require('fs');

// --- CONFIGURATION ---
const SERVER_HOST = process.env.SERVER_HOST || 'play.example.com'; 
const SERVER_PORT = parseInt(process.env.SERVER_PORT) || 19132;
const USERNAME = process.env.BOT_USERNAME || 'AFK_Bot';
const AUTH_PATH = process.env.PERSISTENT_DATA_PATH || path.join(__dirname, 'auth');

// --- WEB SERVER ---
const requestListener = function (req, res) {
  res.writeHead(200);
  res.end(`Bot Status: Running\nTarget: ${SERVER_HOST}\nReconnects: ${reconnectCount}`);
};
const server = http.createServer(requestListener);
const HTTP_PORT = process.env.PORT || 8080;
server.listen(HTTP_PORT, () => {
  console.log(`Web server running on port ${HTTP_PORT}`);
});

// --- BOT LOGIC ---
let client;
let reconnectCount = 0;
let isReconnecting = false;

if (!fs.existsSync(AUTH_PATH)){
    fs.mkdirSync(AUTH_PATH, { recursive: true });
}

async function authenticate() {
  console.log(`[${new Date().toISOString()}] Starting Microsoft authentication...`);
  
  // TÄRKEÄ: Lisätään deviceType ja authTitle oikein!
  const auth = new Authflow(USERNAME, AUTH_PATH, {
    authTitle: Titles.MinecraftNintendoSwitch,
    deviceType: 'Nintendo',
    flow: 'live'
  });

  try {
    // Haetaan Xbox-token ensin
    const xboxToken = await auth.getXboxToken();
    console.log('✅ Xbox authentication successful!');
    
    // TÄRKEÄ: Generoidaan ECDH-avain Bedrockia varten!
    const crypto = require('crypto');
    const { createEcdhKey } = require('prismarine-auth/src/common/Util');
    
    // Haetaan Minecraft Bedrock -token oikealla avaimella
    const mcToken = await auth.getMinecraftBedrockToken(createEcdhKey());
    console.log('✅ Minecraft token acquired!');
    
    return { auth, xboxToken, mcToken };
  } catch (error) {
    console.error('❌ Authentication failed:', error.message);
    throw error;
  }
}

async function connectBot() {
  if (isReconnecting) return;
  
  console.log(`[${new Date().toISOString()}] Connecting to ${SERVER_HOST}:${SERVER_PORT} as ${USERNAME}...`);

  try {
    const { auth, mcToken } = await authenticate();
    
    // Luodaan client oikeilla tokeneilla
    client = bedrock.createClient({
      host: SERVER_HOST,
      port: SERVER_PORT,
      username: USERNAME,
      offline: false,
      // Käytetään auth-oliota
      authFlow: auth,
      // Tai manuaalisesti asetetut tokenit
      skinData: mcToken.skinData || {}
    });

    client.on('play_status', (packet) => {
      if (packet.status === 'login_success') {
        console.log('🎮 Login successful!');
        reconnectCount = 0;
      }
    });

    client.on('start_game', (packet) => {
      console.log('🚀 Bot has spawned! Starting AFK routine.');
      startAfkLoop(packet.runtime_entity_id);
    });

    client.on('disconnect', (packet) => {
      console.warn('⚠️  Disconnected:', packet.message);
      scheduleReconnect();
    });

    client.on('kick', (packet) => {
      console.warn('🦶 Kicked:', packet.message);
      scheduleReconnect();
    });

    client.on('error', (err) => {
      console.error('❌ Client Error:', err);
      scheduleReconnect();
    });

  } catch (e) {
    console.error('❌ Initialization Error:', e);
    scheduleReconnect();
  }
}

function startAfkLoop(entityId) {
  if (client.afkInterval) clearInterval(client.afkInterval);

  client.afkInterval = setInterval(() => {
    if (client && client.status !== 2) {
      try {
        client.queue('animate', {
          action_id: 1,
          runtime_entity_id: entityId
        });
      } catch (e) {}
    }
  }, 4000);
}

function scheduleReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  
  const delay = 30000; 
  console.log(`🔄 Reconnecting in ${delay / 1000} seconds...`);
  
  setTimeout(() => {
    isReconnecting = false;
    if (client) {
      client.removeAllListeners();
      client = null;
    }
    connectBot();
  }, delay);
}

connectBot();
