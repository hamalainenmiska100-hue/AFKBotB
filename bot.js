const bedrock = require('bedrock-protocol');
const { Authflow, Titles } = require('prismarine-auth');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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
  startTime: Date.now(),
  authCode: null,
  authUrl: null,
  isLinking: false
};

let client;
let isReconnecting = false;
let currentAuth = null;

// Ensure auth folder exists
if (!fs.existsSync(AUTH_PATH)){
    fs.mkdirSync(AUTH_PATH, { recursive: true });
}

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
        
        .status-indicator.auth {
            background: #00ffff;
            animation: blink 0.5s infinite;
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
        
        .mc-button.danger {
            background: #8b3a3a;
        }
        
        .mc-button.danger:hover {
            background: #a04545;
        }
        
        .mc-button.success {
            background: #3a8b3a;
        }
        
        .mc-button.success:hover {
            background: #45a045;
        }
        
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
        
        .auth-box {
            background: #3a5a8b;
            border: 4px solid #0000ff;
            border-top-color: #6666ff;
            border-left-color: #6666ff;
            padding: 20px;
            margin: 20px 0;
            color: #ffffff;
            display: none;
        }
        
        .auth-box.show {
            display: block;
            animation: slideIn 0.3s ease-out;
        }
        
        @keyframes slideIn {
            from { transform: translateY(-20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }
        
        .auth-code {
            font-size: 3rem;
            text-align: center;
            background: #000000;
            padding: 15px;
            margin: 15px 0;
            border: 4px solid #ffffff;
            color: #00ff00;
            text-shadow: 0 0 10px #00ff00;
            letter-spacing: 8px;
        }
        
        .auth-link {
            display: block;
            text-align: center;
            font-size: 1.8rem;
            color: #aaaaff;
            text-decoration: underline;
            margin: 10px 0;
            word-break: break-all;
        }
        
        .auth-instructions {
            font-size: 1.3rem;
            line-height: 1.6;
            margin-bottom: 15px;
        }
        
        .button-group {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin-top: 20px;
        }
        
        .footer {
            text-align: center;
            margin-top: 30px;
            color: #8b8b8b;
            font-size: 1.2rem;
            text-shadow: 1px 1px 0 #000000;
        }
        
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
        
                .loading-dots::after {
            content: ' ';
            animation: dots 1.5s steps(4, end) infinite;
        }
        
        @keyframes dots {
            0% { content: ' '; }
            25% { content: '.'; }
            50% { content: '..'; }
            75% { content: '...'; }
        }

        
        @media (max-width: 600px) {
            h1 { font-size: 2rem; }
            .status-text { font-size: 1.5rem; }
            .steve-container { display: none; }
            .button-group { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="grass-border"></div>
    
    <div class="container">
        <div class="mc-panel">
            <div class="steve-container">
                <div class="steve-head">
                    <div class="steve;
            letter-spacing: 1px;
        }
        
        .info-value {
            font-size: 1.8rem;
            color: #ffffff;
            text-shadow: 2px 2px 0 #000000;
            word-break: break-all;
        }
        
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
        
        .mc-button.danger {
            background: #8b3a3a;
        }
        
        .mc-button.danger:hover {
            background: #a04545;
        }
        
        .mc-button.success {
            background: #3a8b3a;
        }
        
        .mc-button.success:hover {
            background: #45a045;
        }
        
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
        
        .auth-box {
            background: #3a5a8b;
            border: 4px solid #0000ff;
            border-top-color: #6666ff;
            border-left-color: #6666ff;
            padding: 20px;
            margin: 20px 0;
            color: #ffffff;
            display: none;
        }
        
        .auth-box.show {
            display: block;
            animation: slideIn 0.3s ease-out;
        }
        
        @keyframes slideIn {
            from { transform: translateY(-20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }
        
        .auth-code {
            font-size: 3rem;
            text-align: center;
            background: #000000;
            padding: 15px;
            margin: 15px 0;
            border: 4px solid #ffffff;
            color: #00ff00;
            text-shadow: 0 0 10px #00ff00;
            letter-spacing: 8px;
        }
        
        .auth-link {
            display: block;
            text-align: center;
            font-size: 1.8rem;
            color: #aaaaff;
            text-decoration: underline;
            margin: 10px 0;
            word-break: break-all;
        }
        
        .auth-instructions {
            font-size: 1.3rem;
            line-height: 1.6;
            margin-bottom: 15px;
        }
        
        .button-group {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin-top: 20px;
        }
        
        .footer {
            text-align: center;
            margin-top: 30px;
            color: #8b8b8b;
            font-size: 1.2rem;
            text-shadow: 1px 1px 0 #000000;
        }
        
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
        
        @media (max-width: 600px) {
            h1 { font-size: 2rem; }
            .status-text { font-size: 1.5rem; }
            .steve-container { display: none; }
            .button-group { grid-template-columns: 1fr; }
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
                <div class="status-text" id="statusText">Initializing...</div>
            </div>
            
            <div class="auth-box" id="authBox">
                <div class="auth-instructions">
                    🔐 <strong>Link your Xbox Account</strong><br>
                    1. Go to the link below<br>
                    2. Enter this code<br>
                    3. Sign in with your Microsoft account
                </div>
                <a href="#" class="auth-link" id="authLink" target="_;
            letter-spacing: 1px;
        }
        
        .info-value {
            font-size: 1.8rem;
            color: #ffffff;
            text-shadow: 2px 2px 0 #000000;
            word-break: break-all;
        }
        
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
        
        .mc-button.danger {
            background: #8b3a3a;
        }
        
        .mc-button.danger:hover {
            background: #a04545;
        }
        
        .mc-button.success {
            background: #3a8b3a;
        }
        
        .mc-button.success:hover {
            background: #45a045;
        }
        
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
        
        .auth-box {
            background: #3a5a8b;
            border: 4px solid #0000ff;
            border-top-color: #6666ff;
            border-left-color: #6666ff;
            padding: 20px;
            margin: 20px 0;
            color: #ffffff;
            display: none;
        }
        
        .auth-box.show {
            display: block;
            animation: slideIn 0.3s ease-out;
        }
        
        @keyframes slideIn {
            from { transform: translateY(-20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }
        
        .auth-code {
            font-size: 3rem;
            text-align: center;
            background: #000000;
            padding: 15px;
            margin: 15px 0;
            border: 4px solid #ffffff;
            color: #00ff00;
            text-shadow: 0 0 10px #00ff00;
            letter-spacing: 8px;
        }
        
        .auth-link {
            display: block;
            text-align: center;
            font-size: 1.8rem;
            color: #aaaaff;
            text-decoration: underline;
            margin: 10px 0;
            word-break: break-all;
        }
        
        .auth-instructions {
            font-size: 1.3rem;
            line-height: 1.6;
            margin-bottom: 15px;
        }
        
        .button-group {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin-top: 20px;
        }
        
        .footer {
            text-align: center;
            margin-top: 30px;
            color: #8b8b8b;
            font-size: 1.2rem;
            text-shadow: 1px 1px 0 #000000;
        }
        
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
        
        @media (max-width: 600px) {
            h1 { font-size: 2rem; }
            .status-text { font-size: 1.5rem; }
            .steve-container { display: none; }
            .button-group { grid-template-columns: 1fr; }
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
                <div class="status-text" id="statusText">Initializing...</div>
            </div>
            
            <div class="auth-box" id="authBox">
                <div class="auth-instructions">
                    🔐 <strong>Link your Xbox Account</strong><br>
                    1. Go to the link below<br>
                    2. Enter this code<br>
                    3. Sign in with your Microsoft account
                </div>
                <a href="#" class="auth-link" id="authLink" target="_blank">https://www.microsoft.com/link</a>
                <div class="auth-code" id="authCode">------</div>
                <button class="mc-button" onclick="checkAuthStatus()">
                    ✅ I've Linked My Account
                </button>
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
            
            <div class="button-group">
                <button class="mc-button" onclick="refreshStatus()">
                    🔄 Refresh
                </button>
                <button class="mc-button success" onclick="startLinking()" id="linkBtn">
                    🔗 Link Xbox
                </button>
            </div>
            
            <button class="mc-button danger" onclick="unlinkAccount()">
                🔓 Unlink Xbox Account
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
            document.getElementById('uptime').textContent = hours + ':' + minutes + ':' + seconds;
        }
        
        async function refreshStatus() {
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                
                document.getElementById('username').textContent = data.username || '-';
                document.getElementById('target').textContent = data.target || '-';
                document.getElementById('reconnects').textContent = data.reconnects || '0';
                
                const light = document.getElementById('statusLight');
                const text = document.getElementById('statusText');
                const authBox = document.getElementById('authBox');
                const linkBtn = document.getElementById('linkBtn');
                
                light.className = 'status-indicator';
                authBox.classList.remove('show');
                
                if (data.isLinking && data.authCode) {
                    light.classList.add('auth');
                    text.textContent = '🔐 Waiting for Xbox Link...';
                    text.style.color = '#55ffff';
                    authBox.classList.add('show');
                    document.getElementById('authCode').textContent = data.authCode;
                    document.getElementById('authLink').href = data.authUrl || 'https://www.microsoft.com/link';
                    linkBtn.disabled = true;
                    linkBtn.style.opacity = '0.5';
                } else if (data.online) {
                    light.classList.add('online');
                    text.textContent = '🟢 Online & AFK';
                    text.style.color = '#55ff55';
                    linkBtn.disabled = false;
                    linkBtn.style.opacity = '1';
                    linkBtn.textContent = '🔁 Re-Link Xbox';
                } else if (data.status === 'Connecting' || data.status === 'Initializing' || data.status === 'Authenticating') {
                    light.classList.add('connecting');
                    text.textContent = '🟡 ' + data.status + '<span class="loading-dots"></span>';
                    text.style.color = '#ffff55';
                } else {
                    light.classList.add('offline');
                    text.textContent = '🔴 ' + (data.status || 'Offline');
                    text.style.color = '#ff5555';
                    linkBtn.disabled = false;
                    linkBtn.style.opacity = '1';
                }
                
                const errorBox = document.getElementById('errorBox');
                if (data.lastError && !data.isLinking) {
                    errorBox.classList.add('show');
                    document.getElementById('errorText').textContent = data.lastError;
                } else {
                    errorBox.classList.remove('show');
                }
                
                if (data.startTime) {
                    startTime = data.startTime;
                }
            } catch (err) {
                document.getElementById('statusText').textContent = '🔴 Connection Failed';
                document.getElementById('statusLight').className = 'status-indicator';
            }
        }
        
        async function startLinking() {
            try {
                const response = await fetch('/api/link', { method: 'POST' });
                const data = await response.json();
                if (data.success) {
                    refreshStatus();
                }
            } catch (err) {
                alert('Failed to start linking process');
            }
        }
        
        async function checkAuthStatus() {
            try {
                const response = await fetch('/api/check-auth');
                const data = await response.json();
                if (data.authenticated) {
                    alert('✅ Account linked successfully! Bot will connect shortly.');
                    refreshStatus();
                } else {
                    alert('⏳ Still waiting... Please complete the login on Microsoft website.');
                }
            } catch (err) {
                alert('Error checking auth status');
            }
        }
        
        async function unlinkAccount() {
            if (!confirm('Are you sure you want to unlink your Xbox account? The bot will need to be re-authenticated.')) {
                return;
            }
            try {
                const response = await fetch('/api/unlink', { method: 'POST' });
                const data = await response.json();
                if (data.success) {
                    alert('✅ Account unlinked. Click "Link Xbox" to authenticate again.');
                    refreshStatus();
                }
            } catch (err) {
                alert('Failed to unlink account');
            }
        }
        
        refreshStatus();
        setInterval(refreshStatus, 5000);
        setInterval(updateUptime, 1000);
    </script>
</body>
</html>
`;


// --- AUTHENTICATION FUNCTIONS ---

function deleteAuthFiles() {
  try {
    if (fs.existsSync(AUTH_PATH)) {
      const files = fs.readdirSync(AUTH_PATH);
      for (const file of files) {
        fs.unlinkSync(path.join(AUTH_PATH, file));
      }
      console.log('🗑️ Auth files deleted');
      return true;
    }
  } catch (err) {
    console.error('Error deleting auth files:', err);
    return false;
  }
}

async function startAuthLinking() {
  if (botState.isLinking) return;
  
  console.log('🔐 Starting Xbox account linking...');
  botState.isLinking = true;
  botState.status = 'Waiting for Auth';
  
  // Delete old auth first
  deleteAuthFiles();
  
  try {
    const auth = new Authflow(USERNAME, AUTH_PATH, {
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: 'Nintendo',
      flow: 'live'
    });
    
    currentAuth = auth;
    
    // This will trigger the device code flow
    const xboxToken = await auth.getXboxToken();
    
    // If we get here, auth is complete!
    console.log('✅ Auth completed successfully!');
    botState.isLinking = false;
    botState.authCode = null;
    botState.authUrl = null;
    
    // Start the bot
    setTimeout(() => connectBot(), 1000);
    
  } catch (err) {
    // Expected to fail initially as we need user to complete auth
    console.log('Waiting for user to complete auth...');
  }
}

// Override the getXboxToken to capture device code
async function startDeviceCodeAuth() {
  const auth = new Authflow(USERNAME, AUTH_PATH, {
    authTitle: Titles.MinecraftNintendoSwitch,
    deviceType: 'Nintendo',
    flow: 'live'
  });
  
  // Listen for device code event
  auth.on('device_code', (deviceCode) => {
    console.log('📱 Device code received:', deviceCode.user_code);
    botState.authCode = deviceCode.user_code;
    botState.authUrl = deviceCode.verification_uri;
  });
  
  try {
   00</div>
                </div>
            </div>
            
            <div class="button-group">
                <button class="mc-button" onclick="refreshStatus()">
                    🔄 Refresh
                </button>
                <button class="mc-button success" onclick="startLinking()" id="linkBtn">
                    🔗 Link Xbox
                </button>
            </div>
            
            <button class="mc-button danger" onclick="unlinkAccount()">
                🔓 Unlink Xbox Account
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
        let checkAuthInterval = null;
        
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
                
                document.getElementById('username').textContent = data.username || '-';
                document.getElementById('target').textContent = data.target || '-';
                document.getElementById('reconnects').textContent = data.reconnects || '0';
                
                const light = document.getElementById('statusLight');
                const text = document.getElementById('statusText');
                const authBox = document.getElementById('authBox');
                const linkBtn = document.getElementById('linkBtn');
                
                light.className = 'status-indicator';
                authBox.classList.remove('show');
                
                if (data.isLinking && data.authCode) {
                    light.classList.add('auth');
                    text.textContent = '🔐 Waiting for Xbox Link...';
                    text.style.color = '#55ffff';
                    authBox.classList.add('show');
                    document.getElementById('authCode').textContent = data.authCode;
                    document.getElementById('authLink').href = data.authUrl || 'https://www.microsoft.com/link';
                    linkBtn.disabled = true;
                    linkBtn.style.opacity = '0.5';
                } else if (data.online) {
                    light.classList.add('online');
                    text.textContent = '🟢 Online & AFK';
                    text.style.color = '#55ff55';
                    linkBtn.disabled = false;
                    linkBtn.style.opacity = '1';
                    linkBtn.textContent = '🔁 Re-Link Xbox';
                } else if (data.status === 'Connecting' || data.status === 'Initializing' || data.status === 'Authenticating') {
                    light.classList.add('connecting');
                    text.textContent = '🟡 ' + data.status + '<span class="loading-dots"></span>';
                    text.style.color = '#ffff55';
                } else {
                    light.classList.add('offline');
                    text.textContent = '🔴 ' + (data.status || 'Offline');
                    text.style.color = '#ff5555';
                    linkBtn.disabled = false;
                    linkBtn.style.opacity = '1';
                }
                
                const errorBox = document.getElementById('errorBox');
                if (data.lastError && !data.isLinking) {
                    errorBox.classList.add('show');
                    document.getElementById('errorText').textContent = data.lastError;
                } else {
                    errorBox.classList.remove('show');
                }
                
                if (data.startTime) {
                    startTime = data.startTime;
                }
            } catch (err) {
                document.getElementById('statusText').textContent = '🔴 Connection Failed';
                document.getElementById('statusLight').className = 'status-indicator';
            }
        }
        
        async function startLinking() {
            try {
                const response = await fetch('/api/link', { method: 'POST' });
                const data = await response.json();
                if (data.success) {
                    refreshStatus();
                }
            } catch (err) {
                alert('Failed to start linking process');
            }
        }
        
        async function checkAuthStatus() {
            try {
                const response = await fetch('/api/check-auth');
                const data = await response.json();
                if (data.authenticated) {
                    alert('✅ Account linked successfully! Bot will connect shortly.');
                    refreshStatus();
                } else {
                    alert('⏳ Still waiting... Please complete the login on Microsoft website.');
                }
            } catch (err) {
                alert('Error checking auth status');
            }
        }
        
        async function unlinkAccount() {
            if (!confirm('Are you sure you want to unlink your Xbox account? The bot will need to be re-authenticated.')) {
                return;
            }
            try {
                const response = await fetch('/api/unlink', { method: 'POST' });
                const data = await response.json();
                if (data.success) {
                    alert('✅ Account unlinked. Click "Link Xbox" to authenticate again.');
                    refreshStatus();
                }
            } catch (err) {
                alert('Failed to unlink account');
            }
        }
        
        refreshStatus();
        setInterval(refreshStatus, 5000);
        setInterval(updateUptime, 1000);
    </script>
</body>
</html>
`;

// --- AUTHENTICATION FUNCTIONS ---

function deleteAuthFiles() {
  try {
    if (fs.existsSync(AUTH_PATH)) {
      const files = fs.readdirSync(AUTH_PATH);
      for (const file of files) {
        fs.unlinkSync(path.join(AUTH_PATH, file));
      }
      console.log('🗑️ Auth files deleted');
      return true;
    }
  } catch (err) {
    console.error('Error deleting auth files:', err);
    return false;
  }
}

async function startAuthLinking() {
  if (botState.isLinking) return;
  
  console.log('🔐 Starting Xbox account linking...');
  botState.isLinking = true;
  botState.status = 'Waiting for Auth';
  
  // Delete old auth first
  deleteAuthFiles();
  
  try {
    const auth = new Authflow(USERNAME, AUTH_PATH, {
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: 'Nintendo',
      flow: 'live'
    });
    
    currentAuth = auth;
    
    // This will trigger the device code flow
    const xboxToken = await auth.getXboxToken();
    
    // If we get here, auth is complete!
    console.log('✅ Auth completed successfully!');
    botState.isLinking = false;
    botState.authCode = null;
    botState.authUrl = null;
    
    // Start the bot
    setTimeout(() => connectBot(), 1000);
    
  } catch (err) {
    // Expected to fail initially as we need user to complete auth
    console.log('Waiting for user to complete auth...');
  }
}

// Override the getXboxToken to capture device code
async function startDeviceCodeAuth() {
  const auth = new Authflow(USERNAME, AUTH_PATH, {
    authTitle: Titles.MinecraftNintendoSwitch,
    deviceType: 'Nintendo',
    flow: 'live'
  });
  
  // Listen for device code event
  auth.on('device_code', (deviceCode) => {
    console.log('📱 Device code received:', deviceCode.user_code);
    botState.authCode = deviceCode.user_code;
    botState.authUrl = deviceCode.verification_uri;
  });
  
  try {
    await auth.getXboxToken();
  } catch (e) {
    // Will wait for user
  }
  
  return auth;
}

// --- WEB SERVER ---
const requestListener = async function (req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(botState));
  } else if (req.url === '/api/link' && req.method === 'POST') {
    // Start linking process
    if (!botState.isLinking) {
      startAuthLinking();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Linking started' }));
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Already linking' }));
    }
  } else if (req.url === '/api/check-auth' && req.method === 'GET') {
    // Check if auth files exist
    const hasAuth = fs.existsSync(AUTH_PATH) && fs.readdirSync(AUTH_PATH).length > 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authenticated: hasAuth }));
  } else if (req.url === '/api/unlink' && req.method === 'POST') {
    // Unlink account
    const success = deleteAuthFiles();
    botState.isLinking = false;
    botState.authCode = null;
    botState.authUrl = null;
    botState.online = false;
    botState.status = 'Unlinked';
    
    // Disconnect current client
    if (client) {
      client.removeAllListeners();
      client = null;
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success }));
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

async function connectBot() {
  if (isReconnecting || botState.isLinking) return;
  
  console.log(`[${new Date().toISOString()}] Connecting to ${SERVER_HOST}:${SERVER_PORT} as ${USERNAME}...`);
  botState.status = 'Connecting';

  try {
    // Check if we have auth
    const hasAuth = fs.existsSync(AUTH_PATH) && fs.readdirSync(AUTH_PATH).length > 0;
    if (!hasAuth) {
      console.log('⚠️ No auth found, waiting for linking...');
      botState.status = 'Needs Auth';
      botState.lastError = 'Please link your Xbox account using the web interface';
      return;
    }
    
    const auth = new Authflow(USERNAME, AUTH_PATH, {
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: 'Nintendo',
      flow: 'live'
    });
    
    // Try to get token (will use cached if available)
    await auth.getXboxToken();
    console.log('✅ Auth token valid!');
    
    client = bedrock.createClient({
      host: SERVER_HOST,
      port: SERVER_PORT,
      username: USERNAME,
      offline: false,
      profilesFolder: AUTH_PATH,
      authTitle: Titles.MinecraftNintendoSwitch,
     00</div>
                </div>
            </div>
            
            <div class="button-group">
                <button class="mc-button" onclick="refreshStatus()">
                    🔄 Refresh
                </button>
                <button class="mc-button success" onclick="startLinking()" id="linkBtn">
                    🔗 Link Xbox
                </button>
            </div>
            
            <button class="mc-button danger" onclick="unlinkAccount()">
                🔓 Unlink Xbox Account
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
        let checkAuthInterval = null;
        
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
                
                document.getElementById('username').textContent = data.username || '-';
                document.getElementById('target').textContent = data.target || '-';
                document.getElementById('reconnects').textContent = data.reconnects || '0';
                
                const light = document.getElementById('statusLight');
                const text = document.getElementById('statusText');
                const authBox = document.getElementById('authBox');
                const linkBtn = document.getElementById('linkBtn');
                
                light.className = 'status-indicator';
                authBox.classList.remove('show');
                
                if (data.isLinking && data.authCode) {
                    light.classList.add('auth');
                    text.textContent = '🔐 Waiting for Xbox Link...';
                    text.style.color = '#55ffff';
                    authBox.classList.add('show');
                    document.getElementById('authCode').textContent = data.authCode;
                    document.getElementById('authLink').href = data.authUrl || 'https://www.microsoft.com/link';
                    linkBtn.disabled = true;
                    linkBtn.style.opacity = '0.5';
                } else if (data.online) {
                    light.classList.add('online');
                    text.textContent = '🟢 Online & AFK';
                    text.style.color = '#55ff55';
                    linkBtn.disabled = false;
                    linkBtn.style.opacity = '1';
                    linkBtn.textContent = '🔁 Re-Link Xbox';
                } else if (data.status === 'Connecting' || data.status === 'Initializing' || data.status === 'Authenticating') {
                    light.classList.add('connecting');
                    text.textContent = '🟡 ' + data.status + '<span class="loading-dots"></span>';
                    text.style.color = '#ffff55';
                } else {
                    light.classList.add('offline');
                    text.textContent = '🔴 ' + (data.status || 'Offline');
                    text.style.color = '#ff5555';
                    linkBtn.disabled = false;
                    linkBtn.style.opacity = '1';
                }
                
                const errorBox = document.getElementById('errorBox');
                if (data.lastError && !data.isLinking) {
                    errorBox.classList.add('show');
                    document.getElementById('errorText').textContent = data.lastError;
                } else {
                    errorBox.classList.remove('show');
                }
                
                if (data.startTime) {
                    startTime = data.startTime;
                }
            } catch (err) {
                document.getElementById('statusText').textContent = '🔴 Connection Failed';
                document.getElementById('statusLight').className = 'status-indicator';
            }
        }
        
        async function startLinking() {
            try {
                const response = await fetch('/api/link', { method: 'POST' });
                const data = await response.json();
                if (data.success) {
                    refreshStatus();
                }
            } catch (err) {
                alert('Failed to start linking process');
            }
        }
        
        async function checkAuthStatus() {
            try {
                const response = await fetch('/api/check-auth');
                const data = await response.json();
                if (data.authenticated) {
                    alert('✅ Account linked successfully! Bot will connect shortly.');
                    refreshStatus();
                } else {
                    alert('⏳ Still waiting... Please complete the login on Microsoft website.');
                }
            } catch (err) {
                alert('Error checking auth status');
            }
        }
        
        async function unlinkAccount() {
            if (!confirm('Are you sure you want to unlink your Xbox account? The bot will need to be re-authenticated.')) {
                return;
            }
            try {
                const response = await fetch('/api/unlink', { method: 'POST' });
                const data = await response.json();
                if (data.success) {
                    alert('✅ Account unlinked. Click "Link Xbox" to authenticate again.');
                    refreshStatus();
                }
            } catch (err) {
                alert('Failed to unlink account');
            }
        }
        
        refreshStatus();
        setInterval(refreshStatus, 5000);
        setInterval(updateUptime, 1000);
    </script>
</body>
</html>
`;

// --- AUTHENTICATION FUNCTIONS ---

function deleteAuthFiles() {
  try {
    if (fs.existsSync(AUTH_PATH)) {
      const files = fs.readdirSync(AUTH_PATH);
      for (const file of files) {
        fs.unlinkSync(path.join(AUTH_PATH, file));
      }
      console.log('🗑️ Auth files deleted');
      return true;
    }
  } catch (err) {
    console.error('Error deleting auth files:', err);
    return false;
  }
}

async function startAuthLinking() {
  if (botState.isLinking) return;
  
  console.log('🔐 Starting Xbox account linking...');
  botState.isLinking = true;
  botState.status = 'Waiting for Auth';
  
  // Delete old auth first
  deleteAuthFiles();
  
  try {
    const auth = new Authflow(USERNAME, AUTH_PATH, {
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: 'Nintendo',
      flow: 'live'
    });
    
    currentAuth = auth;
    
    // This will trigger the device code flow
    const xboxToken = await auth.getXboxToken();
    
    // If we get here, auth is complete!
    console.log('✅ Auth completed successfully!');
    botState.isLinking = false;
    botState.authCode = null;
    botState.authUrl = null;
    
    // Start the bot
    setTimeout(() => connectBot(), 1000);
    
  } catch (err) {
    // Expected to fail initially as we need user to complete auth
    console.log('Waiting for user to complete auth...');
  }
}

// Override the getXboxToken to capture device code
async function startDeviceCodeAuth() {
  const auth = new Authflow(USERNAME, AUTH_PATH, {
    authTitle: Titles.MinecraftNintendoSwitch,
    deviceType: 'Nintendo',
    flow: 'live'
  });
  
  // Listen for device code event
  auth.on('device_code', (deviceCode) => {
    console.log('📱 Device code received:', deviceCode.user_code);
    botState.authCode = deviceCode.user_code;
    botState.authUrl = deviceCode.verification_uri;
  });
  
  try {
    await auth.getXboxToken();
  } catch (e) {
    // Will wait for user
  }
  
  return auth;
}

// --- WEB SERVER ---
const requestListener = async function (req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(botState));
  } else if (req.url === '/api/link' && req.method === 'POST') {
    // Start linking process
    if (!botState.isLinking) {
      startAuthLinking();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Linking started' }));
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Already linking' }));
    }
  } else if (req.url === '/api/check-auth' && req.method === 'GET') {
    // Check if auth files exist
    const hasAuth = fs.existsSync(AUTH_PATH) && fs.readdirSync(AUTH_PATH).length > 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authenticated: hasAuth }));
  } else if (req.url === '/api/unlink' && req.method === 'POST') {
    // Unlink account
    const success = deleteAuthFiles();
    botState.isLinking = false;
    botState.authCode = null;
    botState.authUrl = null;
    botState.online = false;
    botState.status = 'Unlinked';
    
    // Disconnect current client
    if (client) {
      client.removeAllListeners();
      client = null;
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success }));
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

async function connectBot() {
  if (isReconnecting || botState.isLinking) return;
  
  console.log(`[${new Date().toISOString()}] Connecting to ${SERVER_HOST}:${SERVER_PORT} as ${USERNAME}...`);
  botState.status = 'Connecting';

  try {
    // Check if we have auth
    const hasAuth = fs.existsSync(AUTH_PATH) && fs.readdirSync(AUTH_PATH).length > 0;
    if (!hasAuth) {
      console.log('⚠️ No auth found, waiting for linking...');
      botState.status = 'Needs Auth';
      botState.lastError = 'Please link your Xbox account using the web interface';
      return;
    }
    
    const auth = new Authflow(USERNAME, AUTH_PATH, {
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: 'Nintendo',
      flow: 'live'
    });
    
    // Try to get token (will use cached if available)
    await auth.getXboxToken();
    console.log('✅ Auth token valid!');
    
    client = bedrock.createClient({
      host: SERVER_HOST,
      port: SERVER_PORT,
      username: USERNAME,
      offline: false,
      profilesFolder: AUTH_PATH,
      authTitle: Titles.MinecraftNintendoSwitch,
      flow: 'live'
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
    
    // If auth error, prompt for re-linking
    if (e.message.includes('auth') || e.message.includes('token') || e.message.includes('flow')) {
      botState.lastError = 'Authentication failed. Please unlink and link your account again.';
    }
    
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
  if (isReconnecting || botState.isLinking) return;
  isReconnecting = true;
  botState.reconnects++;
  
  const delay = 30000; 
  console.log(`🔄 Reconnecting in ${delay / 1000} seconds...`);
  botState.status = 'Reconnecting...';
  
  setTimeout(() => {
    isReconnecting = false;
   00</div>
                </div>
            </div>
            
            <div class="button-group">
                <button class="mc-button" onclick="refreshStatus()">
                    🔄 Refresh
                </button>
                <button class="mc-button success" onclick="startLinking()" id="linkBtn">
                    🔗 Link Xbox
                </button>
            </div>
            
            <button class="mc-button danger" onclick="unlinkAccount()">
                🔓 Unlink Xbox Account
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
        let checkAuthInterval = null;
        
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
                
                document.getElementById('username').textContent = data.username || '-';
                document.getElementById('target').textContent = data.target || '-';
                document.getElementById('reconnects').textContent = data.reconnects || '0';
                
                const light = document.getElementById('statusLight');
                const text = document.getElementById('statusText');
                const authBox = document.getElementById('authBox');
                const linkBtn = document.getElementById('linkBtn');
                
                light.className = 'status-indicator';
                authBox.classList.remove('show');
                
                if (data.isLinking && data.authCode) {
                    light.classList.add('auth');
                    text.textContent = '🔐 Waiting for Xbox Link...';
                    text.style.color = '#55ffff';
                    authBox.classList.add('show');
                    document.getElementById('authCode').textContent = data.authCode;
                    document.getElementById('authLink').href = data.authUrl || 'https://www.microsoft.com/link';
                    linkBtn.disabled = true;
                    linkBtn.style.opacity = '0.5';
                } else if (data.online) {
                    light.classList.add('online');
                    text.textContent = '🟢 Online & AFK';
                    text.style.color = '#55ff55';
                    linkBtn.disabled = false;
                    linkBtn.style.opacity = '1';
                    linkBtn.textContent = '🔁 Re-Link Xbox';
                } else if (data.status === 'Connecting' || data.status === 'Initializing' || data.status === 'Authenticating') {
                    light.classList.add('connecting');
                    text.textContent = '🟡 ' + data.status + '<span class="loading-dots"></span>';
                    text.style.color = '#ffff55';
                } else {
                    light.classList.add('offline');
                    text.textContent = '🔴 ' + (data.status || 'Offline');
                    text.style.color = '#ff5555';
                    linkBtn.disabled = false;
                    linkBtn.style.opacity = '1';
                }
                
                const errorBox = document.getElementById('errorBox');
                if (data.lastError && !data.isLinking) {
                    errorBox.classList.add('show');
                    document.getElementById('errorText').textContent = data.lastError;
                } else {
                    errorBox.classList.remove('show');
                }
                
                if (data.startTime) {
                    startTime = data.startTime;
                }
            } catch (err) {
                document.getElementById('statusText').textContent = '🔴 Connection Failed';
                document.getElementById('statusLight').className = 'status-indicator';
            }
        }
        
        async function startLinking() {
            try {
                const response = await fetch('/api/link', { method: 'POST' });
                const data = await response.json();
                if (data.success) {
                    refreshStatus();
                }
            } catch (err) {
                alert('Failed to start linking process');
            }
        }
        
        async function checkAuthStatus() {
            try {
                const response = await fetch('/api/check-auth');
                const data = await response.json();
                if (data.authenticated) {
                    alert('✅ Account linked successfully! Bot will connect shortly.');
                    refreshStatus();
                } else {
                    alert('⏳ Still waiting... Please complete the login on Microsoft website.');
                }
            } catch (err) {
                alert('Error checking auth status');
            }
        }
        
        async function unlinkAccount() {
            if (!confirm('Are you sure you want to unlink your Xbox account? The bot will need to be re-authenticated.')) {
                return;
            }
            try {
                const response = await fetch('/api/unlink', { method: 'POST' });
                const data = await response.json();
                if (data.success) {
                    alert('✅ Account unlinked. Click "Link Xbox" to authenticate again.');
                    refreshStatus();
                }
            } catch (err) {
                alert('Failed to unlink account');
            }
        }
        
        refreshStatus();
        setInterval(refreshStatus, 5000);
        setInterval(updateUptime, 1000);
    </script>
</body>
</html>
`;

// --- AUTHENTICATION FUNCTIONS ---

function deleteAuthFiles() {
  try {
    if (fs.existsSync(AUTH_PATH)) {
      const files = fs.readdirSync(AUTH_PATH);
      for (const file of files) {
        fs.unlinkSync(path.join(AUTH_PATH, file));
      }
      console.log('🗑️ Auth files deleted');
      return true;
    }
  } catch (err) {
    console.error('Error deleting auth files:', err);
    return false;
  }
}

async function startAuthLinking() {
  if (botState.isLinking) return;
  
  console.log('🔐 Starting Xbox account linking...');
  botState.isLinking = true;
  botState.status = 'Waiting for Auth';
  
  // Delete old auth first
  deleteAuthFiles();
  
  try {
    const auth = new Authflow(USERNAME, AUTH_PATH, {
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: 'Nintendo',
      flow: 'live'
    });
    
    currentAuth = auth;
    
    // This will trigger the device code flow
    const xboxToken = await auth.getXboxToken();
    
    // If we get here, auth is complete!
    console.log('✅ Auth completed successfully!');
    botState.isLinking = false;
    botState.authCode = null;
    botState.authUrl = null;
    
    // Start the bot
    setTimeout(() => connectBot(), 1000);
    
  } catch (err) {
    // Expected to fail initially as we need user to complete auth
    console.log('Waiting for user to complete auth...');
  }
}

// Override the getXboxToken to capture device code
async function startDeviceCodeAuth() {
  const auth = new Authflow(USERNAME, AUTH_PATH, {
    authTitle: Titles.MinecraftNintendoSwitch,
    deviceType: 'Nintendo',
    flow: 'live'
  });
  
  // Listen for device code event
  auth.on('device_code', (deviceCode) => {
    console.log('📱 Device code received:', deviceCode.user_code);
    botState.authCode = deviceCode.user_code;
    botState.authUrl = deviceCode.verification_uri;
  });
  
  try {
    await auth.getXboxToken();
  } catch (e) {
    // Will wait for user
  }
  
  return auth;
}

// --- WEB SERVER ---
const requestListener = async function (req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(botState));
  } else if (req.url === '/api/link' && req.method === 'POST') {
    // Start linking process
    if (!botState.isLinking) {
      startAuthLinking();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Linking started' }));
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Already linking' }));
    }
  } else if (req.url === '/api/check-auth' && req.method === 'GET') {
    // Check if auth files exist
    const hasAuth = fs.existsSync(AUTH_PATH) && fs.readdirSync(AUTH_PATH).length > 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authenticated: hasAuth }));
  } else if (req.url === '/api/unlink' && req.method === 'POST') {
    // Unlink account
    const success = deleteAuthFiles();
    botState.isLinking = false;
    botState.authCode = null;
    botState.authUrl = null;
    botState.online = false;
    botState.status = 'Unlinked';
    
    // Disconnect current client
    if (client) {
      client.removeAllListeners();
      client = null;
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success }));
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

async function connectBot() {
  if (isReconnecting || botState.isLinking) return;
  
  console.log(`[${new Date().toISOString()}] Connecting to ${SERVER_HOST}:${SERVER_PORT} as ${USERNAME}...`);
  botState.status = 'Connecting';

  try {
    // Check if we have auth
    const hasAuth = fs.existsSync(AUTH_PATH) && fs.readdirSync(AUTH_PATH).length > 0;
    if (!hasAuth) {
      console.log('⚠️ No auth found, waiting for linking...');
      botState.status = 'Needs Auth';
      botState.lastError = 'Please link your Xbox account using the web interface';
      return;
    }
    
    const auth = new Authflow(USERNAME, AUTH_PATH, {
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: 'Nintendo',
      flow: 'live'
    });
    
    // Try to get token (will use cached if available)
    await auth.getXboxToken();
    console.log('✅ Auth token valid!');
    
    client = bedrock.createClient({
      host: SERVER_HOST,
      port: SERVER_PORT,
      username: USERNAME,
      offline: false,
      profilesFolder: AUTH_PATH,
      authTitle: Titles.MinecraftNintendoSwitch,
      flow: 'live'
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
    
    // If auth error, prompt for re-linking
    if (e.message.includes('auth') || e.message.includes('token') || e.message.includes('flow')) {
      botState.lastError = 'Authentication failed. Please unlink and link your account again.';
    }
    
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
  if (isReconnecting || botState.isLinking) return;
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

// Start
connectBot();
