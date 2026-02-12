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

// Bot state for frontend
let botState = {
  status: 'Initializing',
  target: `${SERVER_HOST}:${SERVER_PORT}`,
  username: USERNAME,
  reconnects: 0,
  online: false,
  lastError: null,
  startTime: Date.now()
};

// --- MINECRAFT THEMED FRONTEND ---
const minecraftHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AFK Bot Status | Minecraft</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=VT323&display=swap');
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            image-rendering: pixelated;
        }
        
        body {
            font-family: 'VT323', monospace;
            background: #1a1a1a;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
            position: relative;
            overflow-x: hidden;
        }
        
        /* Dirt background pattern */
        body::before {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-image: 
                repeating-linear-gradient(
                    0deg,
                    transparent,
                    transparent 2px,
                    rgba(0,0,0,0.1) 2px,
                    rgba(0,0,0,0.1) 4px
                ),
                linear-gradient(180deg, #5d3a1a 0%, #4a2e15 50%, #3d2611 100%);
            background-size: 100% 100%, 64px 64px;
            z-index: -2;
        }
        
        /* Grass top border */
        .grass-border {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 20px;
            background: linear-gradient(180deg, #5d8c47 0%, #4a7038 50%, #3d5a2d 100%);
            border-bottom: 4px solid #2d421f;
            z-index: -1;
            box-shadow: 0 4px 0 rgba(0,0,0,0.3);
        }
        
        .container {
            width: 100%;
            max-width: 800px;
            position: relative;
        }
        
        /* Minecraft-style GUI Panel */
        .mc-panel {
            background: #c6c6c6;
            border: 4px solid #373737;
            border-top-color: #ffffff;
            border-left-color: #ffffff;
            box-shadow: 
                inset -4px -4px 0 #555555,
                inset 4px 4px 0 #ffffff,
                0 8px 0 rgba(0,0,0,0.5);
            padding: 20px;
            position: relative;
        }
        
        .mc-panel::before {
            content: '';
            position: absolute;
            top: 4px;
            left: 4px;
            right: 4px;
            bottom: 4px;
            border: 2px solid #8b8b8b;
            pointer-events: none;
        }
        
        h1 {
            color: #3d3d3d;
            font-size: 3rem;
            text-align: center;
            margin-bottom: 10px;
            text-shadow: 2px 2px 0 #ffffff;
            letter-spacing: 2px;
        }
        
        .subtitle {
            text-align: center;
            color: #555;
            font-size: 1.5rem;
            margin-bottom: 30px;
            text-shadow: 1px 1px 0 #ffffff;
        }
        
        /* Status Box */
        .status-box {
            background: #8b8b8b;
            border: 4px solid #373737;
            border-top-color: #ffffff;
            border-left-color: #ffffff;
            padding: 15px;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 15px;
        }
        
        .status-indicator {
            width: 32px;
            height: 32px;
            background: #ff0000;
            border: 3px solid #373737;
            box-shadow: inset -2px -2px 0 rgba(0,0,0,0.3), inset 2px 2px 0 rgba(255,255,255,0.3);
            animation: pulse 2s infinite;
        }
        
        .status-indicator.online {
            background: #00ff00;
            animation: none;
        }
        
        .status-indicator.connecting {
            background: #ffff00;
            animation: blink 1s infinite;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
        }
        
        @keyframes blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
        }
        
        .status-text {
            font-size: 2rem;
            color: #ffffff;
            text-shadow: 2px 2px 0 #000000;
        }
        
        /* Info Grid */
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        
        .info-box {
            background: #373737;
            border: 4px solid #555555;
            border-top-color: #8b8b8b;
            border-left-color: #8b8b8b;
            padding: 12px;
            color: #ffffff;
        }
        
        .info-label {
            font-size: 1.2rem;
            color: #aaaaaa;
            margin-bottom: 5px;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        
        .info-value {
            font-size: 1.8rem;
            color: #ffffff;
            text-shadow: 2px 2px 0 #000000;
            word-break: break-all;
        }
        
        /* Minecraft Button */
        .mc-button {
            display: inline-block;
            background: #7d7d7d;
            border: 4px solid #373737;
            border-top-color: #ffffff;
            border-left-color: #ffffff;
            color: #ffffff;
            font-family: 'VT323', monospace;
            font-size: 1.5rem;
            padding: 12px 24px;
            cursor: pointer;
            text-decoration: none;
            text-shadow: 2px 2px 0 #000000;
            box-shadow: inset -4px -4px 0 #555555;
            transition: all 0.1s;
            width: 100%;
            text-align: center;
            margin-top: 10px;
        }
        
        .mc-button:hover {
            background: #8b8b8b;
        }
        
        .mc-button:active {
            background: #5d5d5d;
            border: 4px solid #ffffff;
            border-top-color: #373737;
            border-left-color: #373737;
            box-shadow: inset 4px 4px 0 #373737;
        }
        
        /* Error Box */
        .error-box {
            background: #8b3a3a;
            border: 4px solid #ff0000;
            border-top-color: #ff6666;
            border-left-color: #ff6666;
            padding: 15px;
            margin-top: 20px;
            color: #ffffff;
            display: none;
        }
        
        .error-box.show {
            display: block;
        }
        
        .error-title {
            font-size: 1.5rem;
            margin-bottom: 10px;
            color: #ffaaaa;
        }
        
        /* Footer */
        .footer {
            text-align: center;
            margin-top: 30px;
            color: #8b8b8b;
            font-size: 1.2rem;
            text-shadow: 1px 1px 0 #000000;
        }
        
        /* Steve Head Animation */
        .steve-container {
            position: absolute;
            top: -60px;
            right: 20px;
            width: 80px;
            height: 80px;
            animation: float 3s ease-in-out infinite;
        }
        
        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-10px); }
        }
        
        .steve-head {
            width: 100%;
            height: 100%;
            background: #f9b98f;
            border: 4px solid #000;
            position: relative;
            image-rendering: pixelated;
        }
        
        .steve-face {
            width: 100%;
            height: 100%;
            position: relative;
            background: 
                linear-gradient(to right, transparent 25%, #3d1f0f 25%, #3d1f0f 35%, transparent 35%),
                linear-gradient(to right, transparent 65%, #3d1f0f 65%, #3d1f0f 75%, transparent 75%),
                linear-gradient(to bottom, #5d3a1a 0%, #5d3a1a 30%, transparent 30%);
            background-size: 100% 100%, 100% 100%, 100% 100%;
        }
        
        .steve-face::after {
            content: '';
            position: absolute;
            top: 35%;
            left: 20%;
            width: 25%;
            height: 15%;
            background: #ffffff;
            box-shadow: 
                35px 0 0 #ffffff,
                0 5px 0 #3d8c9e,
                35px 5px 0 #3d8c9e;
        }
        
        /* Responsive */
        @media (max-width: 600px) {
            h1 { font-size: 2rem; }
            .status-text { font-size: 1.5rem; }
            .steve-container { display: none; }
        }
        
        /* Loading animation */
        .loading-dots::after {
            content: '';
            animation: dots 1.5s steps(4, end) infinite;
        }
        
        @keyframes dots {
            0% { content: ''; }
            25% { content: '.'; }
            50% { content: '..'; }
            75% { content: '...'; }
        }
    </style>
</head>
<body>
    <div class="grass-border"></div>
    
    <div class="container">
        <div class="mc-panel">
            <div class="steve-container">
                <div class="steve-head">
                    <div class="steve-face"></div>
                </div>
            </div>
            
            <h1>⛏️ AFK BOT STATUS</h1>
            <p class="subtitle">Minecraft Bedrock Edition</p>
            
            <div class="status-box">
                <div class="status-indicator" id="statusLight"></div>
                <div class="status-text" id="statusText">Connecting...</div>
            </div>
            
            <div class="info-grid">
                <div class="info-box">
                    <div class="info-label">Username</div>
                    <div class="info-value" id="username">-</div>
                </div>
                <div class="info-box">
                    <div class="info-label">Target Server</div>
                    <div class="info-value" id="target">-</div>
                </div>
                <div class="info-box">
                    <div class="info-label">Reconnects</div>
                    <div class="info-value" id="reconnects">0</div>
                </div>
                <div class="info-box">
                    <div class="info-label">Uptime</div>
                    <div class="info-value" id="uptime">00:00:00</div>
                </div>
            </div>
            
            <button class="mc-button" onclick="refreshStatus()">
                🔄 Refresh Status
            </button>
            
            <div class="error-box" id="errorBox">
                <div class="error-title">⚠️ Last Error</div>
                <div id="errorText">-</div>
            </div>
        </div>
        
        <div class="footer">
            <p>Running on Fly.io | Made with ❤️ and blocks</p>
            <p style="margin-top: 5px; font-size: 1rem;">Status updates every 5 seconds</p>
        </div>
    </div>
    
    <script>
        let startTime = Date.now();
        
        function updateUptime() {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            const hours = Math.floor(elapsed / 3600).toString().padStart(2, '0');
            const minutes = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
            const seconds = (elapsed % 60).toString().padStart(2, '0');
            document.getElementById('uptime').textContent = \`\${hours}:\${minutes}:\${seconds}\`;
        }
        
        async function refreshStatus() {
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                
                // Update fields
                document.getElementById('username').textContent = data.username || '-';
                document.getElementById('target').textContent = data.target || '-';
                document.getElementById('reconnects').textContent = data.reconnects || '0';
                
                // Update status light and text
                const light = document.getElementById('statusLight');
                const text = document.getElementById('statusText');
                
                light.className = 'status-indicator';
                
                if (data.online) {
                    light.classList.add('online');
                    text.textContent = '🟢 Online & AFK';
                    text.style.color = '#55ff55';
                } else if (data.status === 'Connecting' || data.status === 'Initializing') {
                    light.classList.add('connecting');
                    text.textContent = '🟡 ' + data.status + '<span class="loading-dots"></span>';
                    text.style.color = '#ffff55';
                } else {
                    light.classList.add('offline');
                    text.textContent = '🔴 ' + (data.status || 'Offline');
                    text.style.color = '#ff5555';
                }
                
                // Show error if exists
                const errorBox = document.getElementById('errorBox');
                if (data.lastError) {
                    errorBox.classList.add('show');
                    document.getElementById('errorText').textContent = data.lastError;
                } else {
                    errorBox.classList.remove('show');
                }
                
                // Update start time if provided
                if (data.startTime) {
                    startTime = data.startTime;
                }
            } catch (err) {
                document.getElementById('statusText').textContent = '🔴 Connection Failed';
                document.getElementById('statusLight').className = 'status-indicator';
            }
        }
        
        // Initial load and auto-refresh
        refreshStatus();
        setInterval(refreshStatus, 5000);
        setInterval(updateUptime, 1000);
    </script>
</body>
</html>
`;

// --- WEB SERVER ---
const requestListener = function (req, res) {
  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(botState));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(minecraftHTML);
  }
};

const server = http.createServer(requestListener);
const HTTP_PORT = process.env.PORT || 8080;
server.listen(HTTP_PORT, () => {
  console.log(`🌐 Web server running on port ${HTTP_PORT}`);
  console.log(`📊 Status page: http://localhost:${HTTP_PORT}`);
});

// --- BOT LOGIC ---
let client;
let isReconnecting = false;

if (!fs.existsSync(AUTH_PATH)){
    fs.mkdirSync(AUTH_PATH, { recursive: true });
}

async function authenticate() {
  botState.status = 'Authenticating';
  
  const auth = new Authflow(USERNAME, AUTH_PATH, {
    authTitle: Titles.MinecraftNintendoSwitch,
    deviceType: 'Nintendo',
    flow: 'live'
  });

  try {
    const xboxToken = await auth.getXboxToken();
    console.log('✅ Xbox authentication successful!');
    
    // For Bedrock, we need to handle the auth differently
    return auth;
  } catch (error) {
    console.error('❌ Authentication failed:', error.message);
    botState.lastError = error.message;
    throw error;
  }
}

async function connectBot() {
  if (isReconnecting) return;
  
  console.log(`[${new Date().toISOString()}] Connecting to ${SERVER_HOST}:${SERVER_PORT} as ${USERNAME}...`);
  botState.status = 'Connecting';

  try {
    const auth = await authenticate();
    
    // Try to create client - bedrock-protocol handles the token exchange
    client = bedrock.createClient({
      host: SERVER_HOST,
      port: SERVER_PORT,
      username: USERNAME,
      offline: false,
      profilesFolder: AUTH_PATH,
      authTitle: Titles.MinecraftNintendoSwitch,
    });

    client.on('play_status', (packet) => {
      if (packet.status === 'login_success') {
        console.log('🎮 Login successful!');
        botState.status = 'Online';
        botState.online = true;
        botState.lastError = null;
        botState.reconnects = 0;
      }
    });

    client.on('start_game', (packet) => {
      console.log('🚀 Bot has spawned! Starting AFK routine.');
      startAfkLoop(packet.runtime_entity_id);
    });

    client.on('disconnect', (packet) => {
      console.warn('⚠️  Disconnected:', packet.message);
      botState.status = 'Disconnected';
      botState.online = false;
      scheduleReconnect();
    });

    client.on('kick', (packet) => {
      console.warn('🦶 Kicked:', packet.message);
      botState.status = 'Kicked';
      botState.online = false;
      botState.lastError = packet.message;
      scheduleReconnect();
    });

    client.on('error', (err) => {
      console.error('❌ Client Error:', err);
      botState.status = 'Error';
      botState.online = false;
      botState.lastError = err.message;
      scheduleReconnect();
    });

  } catch (e) {
    console.error('❌ Initialization Error:', e);
    botState.status = 'Auth Failed';
    botState.lastError = e.message;
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
  botState.reconnects++;
  
  const delay = 30000; 
  console.log(`🔄 Reconnecting in ${delay / 1000} seconds...`);
  botState.status = 'Reconnecting...';
  
  setTimeout(() => {
    isReconnecting = false;
    if (client) {
      client.removeAllListeners();
      client = null;
    }
    connectBot();
  }, delay);
}

// Start the bot
connectBot();
