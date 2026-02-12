const bedrock = require('bedrock-protocol');
const http = require('http');
const path = require('path');
const fs = require('fs');

// --- CONFIGURATION ---
const SERVER_HOST = process.env.SERVER_HOST || 'play.example.com'; 
const SERVER_PORT = parseInt(process.env.SERVER_PORT) || 19132;
const USERNAME = process.env.BOT_USERNAME || 'AFK_Bot';

// Path to store login tokens (Mapped to Fly.io Volume)
// If running locally, it defaults to an 'auth' folder in the current directory
const AUTH_PATH = process.env.PERSISTENT_DATA_PATH || path.join(__dirname, 'auth');

// --- WEB SERVER (REQUIRED FOR 24/7 CLOUD HOSTING) ---
// Cloud platforms need a port to bind to, or they will kill the app.
const requestListener = function (req, res) {
  res.writeHead(200);
  res.end(`Bot Status: Running\nTarget: ${SERVER_HOST}\nReconnects: ${reconnectCount}`);
};
const server = http.createServer(requestListener);
const HTTP_PORT = process.env.PORT || 8080;
server.listen(HTTP_PORT, () => {
  console.log(`Web server running on port ${HTTP_PORT} (Keeps the bot alive)`);
});

// --- BOT LOGIC ---
let client;
let reconnectCount = 0;
let isReconnecting = false;

// Ensure auth folder exists
if (!fs.existsSync(AUTH_PATH)){
    fs.mkdirSync(AUTH_PATH, { recursive: true });
}

function connectBot() {
  if (isReconnecting) return;
  
  console.log(`[${new Date().toISOString()}] Connecting to ${SERVER_HOST}:${SERVER_PORT} as ${USERNAME}...`);

  try {
    client = bedrock.createClient({
      host: SERVER_HOST,
      port: SERVER_PORT,
      username: USERNAME,
      offline: false, // Online mode requires Microsoft Auth
      profilesFolder: AUTH_PATH, // CRITICAL: Save auth token to the Volume
      // If we don't save this, the bot asks for a code on every restart
    });

    client.on('play_status', (packet) => {
      if (packet.status === 'login_success') {
        console.log('Login successful!');
        reconnectCount = 0; // Reset counter on success
      }
    });

    client.on('start_game', (packet) => {
      console.log('Bot has spawned! Starting AFK routine.');
      startAfkLoop(packet.runtime_entity_id);
    });

    client.on('disconnect', (packet) => {
      console.warn('Disconnected:', packet.message);
      scheduleReconnect();
    });

    client.on('kick', (packet) => {
      console.warn('Kicked:', packet.message);
      scheduleReconnect();
    });

    client.on('error', (err) => {
      console.error('Client Error:', err);
      scheduleReconnect();
    });

  } catch (e) {
    console.error('Initialization Error:', e);
    scheduleReconnect();
  }
}

function startAfkLoop(entityId) {
  // Clear any existing intervals if we are reconnecting
  if (client.afkInterval) clearInterval(client.afkInterval);

  client.afkInterval = setInterval(() => {
    if (client && client.status !== 2) { // 2 = disconnected in some internal states, but safer to try/catch
      try {
        client.queue('animate', {
          action_id: 1, // Swing Arm
          runtime_entity_id: entityId
        });
      } catch (e) {
        // Queue failed, likely disconnected
      }
    }
  }, 4000); // Swing every 4 seconds
}

function scheduleReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  
  // Exponential backoff or fixed delay? Fixed is usually fine for AFK bots.
  const delay = 30000; 
  console.log(`Reconnecting in ${delay / 1000} seconds...`);
  
  setTimeout(() => {
    isReconnecting = false;
    // Clean up old client
    if (client) {
      client.removeAllListeners();
      client = null;
    }
    connectBot();
  }, delay);
}

// Start the bot
connectBot();


