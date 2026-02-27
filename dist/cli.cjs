#!/usr/bin/env node
"use strict";

// src/cli.ts
var import_child_process = require("child_process");
var import_fs = require("fs");
var import_path = require("path");
var import_os = require("os");
var import_readline = require("readline");
var QWEN_PROXY_DIR = (0, import_path.join)((0, import_os.homedir)(), ".qwen-proxy");
var PID_FILE = (0, import_path.join)(QWEN_PROXY_DIR, "server.pid");
var LOG_FILE = (0, import_path.join)(QWEN_PROXY_DIR, "server.log");
var CONFIG_FILE = (0, import_path.join)(QWEN_PROXY_DIR, "config.json");
var DEFAULT_PORT = 3e3;
var DEFAULT_HOST = "127.0.0.1";
var HELP_TEXT = `
Usage: qwen-proxy [command]

Commands:
  start     Start the proxy server
  stop      Stop the proxy server
  restart   Restart the proxy server
  status    Show server status
  logs      Show server logs
  config    Configure server settings
  -v        Show version
  -h, help  Show this help

Examples:
  qwen-proxy start
  qwen-proxy start --port 8080
  qwen-proxy stop
  qwen-proxy status
`;
function getVersion() {
  try {
    const packagePath = (0, import_path.join)(__dirname, "..", "package.json");
    const content = (0, import_fs.readFileSync)(packagePath, "utf-8");
    return JSON.parse(content).version;
  } catch {
    return "1.0.0";
  }
}
function ensureDir() {
  if (!(0, import_fs.existsSync)(QWEN_PROXY_DIR)) {
    (0, import_fs.mkdirSync)(QWEN_PROXY_DIR, { recursive: true, mode: 448 });
  }
}
function loadConfig() {
  try {
    if ((0, import_fs.existsSync)(CONFIG_FILE)) {
      return JSON.parse((0, import_fs.readFileSync)(CONFIG_FILE, "utf-8"));
    }
  } catch {
  }
  return { port: DEFAULT_PORT, host: DEFAULT_HOST };
}
function saveConfig(config) {
  ensureDir();
  (0, import_fs.writeFileSync)(CONFIG_FILE, JSON.stringify(config, null, 2));
}
function isRunning() {
  if (!(0, import_fs.existsSync)(PID_FILE)) {
    return { running: false };
  }
  try {
    const pid = parseInt((0, import_fs.readFileSync)(PID_FILE, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0);
      const config = loadConfig();
      return { running: true, pid, port: config.port, host: config.host };
    } catch {
      (0, import_fs.unlinkSync)(PID_FILE);
      return { running: false };
    }
  } catch {
    return { running: false };
  }
}
async function startServer(port, host) {
  const status = isRunning();
  if (status.running) {
    console.log(`Server is already running on http://${status.host}:${status.port} (PID: ${status.pid})`);
    return;
  }
  ensureDir();
  const config = loadConfig();
  const finalPort = port || config.port;
  const finalHost = host || config.host;
  saveConfig({ port: finalPort, host: finalHost });
  const serverPath = (0, import_path.join)(__dirname, "server.mjs");
  if (!(0, import_fs.existsSync)(serverPath)) {
    console.error("Error: server.mjs not found. Please build the project first.");
    process.exit(1);
  }
  console.log(`Starting Qwen Proxy Server on http://${finalHost}:${finalPort}...`);
  const serverProcess = (0, import_child_process.spawn)(process.execPath, [serverPath], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      PORT: String(finalPort),
      HOST: finalHost
    }
  });
  serverProcess.unref();
  (0, import_fs.writeFileSync)(PID_FILE, String(serverProcess.pid));
  await new Promise((resolve) => setTimeout(resolve, 1e3));
  const newStatus = isRunning();
  if (newStatus.running) {
    console.log(`Server started successfully (PID: ${newStatus.pid})`);
    console.log(`
Endpoints:`);
    console.log(`  GET  http://${finalHost}:${finalPort}/v1/models`);
    console.log(`  POST http://${finalHost}:${finalPort}/v1/chat/completions`);
    console.log(`  GET  http://${finalHost}:${finalPort}/status`);
    console.log(`
Usage with OpenAI SDK:`);
    console.log(`  OPENAI_API_KEY=any OPENAI_BASE_URL=http://${finalHost}:${finalPort}/v1`);
  } else {
    console.error("Failed to start server.");
    process.exit(1);
  }
}
function stopServer() {
  const status = isRunning();
  if (!status.running) {
    console.log("Server is not running");
    return;
  }
  try {
    process.kill(status.pid, "SIGTERM");
    if ((0, import_fs.existsSync)(PID_FILE)) {
      (0, import_fs.unlinkSync)(PID_FILE);
    }
    console.log(`Server stopped (PID: ${status.pid})`);
  } catch (e) {
    console.error("Failed to stop server:", e);
  }
}
function showStatus() {
  const status = isRunning();
  if (!status.running) {
    console.log("Server is not running");
    console.log("\nTo start the server, run:");
    console.log("  qwen-proxy start");
    return;
  }
  console.log(`Server is running:`);
  console.log(`  PID:  ${status.pid}`);
  console.log(`  Host: ${status.host}`);
  console.log(`  Port: ${status.port}`);
  console.log(`  URL:  http://${status.host}:${status.port}`);
  console.log(`
Endpoints:`);
  console.log(`  GET  /v1/models`);
  console.log(`  POST /v1/chat/completions`);
  console.log(`  GET  /status`);
  const credsPath = (0, import_path.join)((0, import_os.homedir)(), ".qwen", "oauth_creds.json");
  if ((0, import_fs.existsSync)(credsPath)) {
    try {
      const creds = JSON.parse((0, import_fs.readFileSync)(credsPath, "utf-8"));
      const isValid = Date.now() < creds.expiry_date;
      console.log(`
Authentication:`);
      console.log(`  Status:      ${isValid ? "Valid" : "Expired"}`);
      console.log(`  Resource:    ${creds.resource_url || "Unknown"}`);
      console.log(`  Expires:     ${new Date(creds.expiry_date).toISOString()}`);
    } catch {
      console.log(`
Authentication: Unable to read credentials`);
    }
  } else {
    console.log(`
Authentication: Not configured`);
    console.log("Run 'qwen-code auth login' to authenticate");
  }
}
function showLogs() {
  if (!(0, import_fs.existsSync)(LOG_FILE)) {
    console.log("No logs found");
    return;
  }
  const logs = (0, import_fs.readFileSync)(LOG_FILE, "utf-8");
  console.log(logs);
}
async function configure() {
  const rl = (0, import_readline.createInterface)({
    input: process.stdin,
    output: process.stdout
  });
  const currentConfig = loadConfig();
  console.log("Configure Qwen Proxy Server\n");
  const port = await new Promise((resolve) => {
    rl.question(`Port [${currentConfig.port}]: `, resolve);
  });
  const host = await new Promise((resolve) => {
    rl.question(`Host [${currentConfig.host}]: `, resolve);
  });
  rl.close();
  const newConfig = {
    port: parseInt(port) || currentConfig.port,
    host: host || currentConfig.host
  };
  saveConfig(newConfig);
  console.log(`
Configuration saved:`);
  console.log(`  Port: ${newConfig.port}`);
  console.log(`  Host: ${newConfig.host}`);
  const status = isRunning();
  if (status.running) {
    console.log("\nServer is running. Restart to apply changes:");
    console.log("  qwen-proxy restart");
  }
}
function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";
  const options = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
      options[key] = isNaN(Number(value)) ? value : Number(value);
    }
  }
  return { command, options };
}
async function main() {
  const { command, options } = parseArgs();
  switch (command) {
    case "start":
      await startServer(
        options.port,
        options.host
      );
      break;
    case "stop":
      stopServer();
      break;
    case "restart":
      stopServer();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await startServer();
      break;
    case "status":
      showStatus();
      break;
    case "logs":
      showLogs();
      break;
    case "config":
      await configure();
      break;
    case "-v":
    case "--version":
      console.log(`qwen-proxy v${getVersion()}`);
      break;
    case "-h":
    case "--help":
    case "help":
      console.log(HELP_TEXT);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP_TEXT);
      process.exit(1);
  }
}
main().catch(console.error);
