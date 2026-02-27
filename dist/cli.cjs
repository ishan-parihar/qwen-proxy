#!/usr/bin/env node
"use strict";

// src/cli.ts
var import_child_process = require("child_process");
var import_fs = require("fs");
var import_path = require("path");
var import_os = require("os");
var import_crypto = require("crypto");
var QWEN_PROXY_DIR = (0, import_path.join)((0, import_os.homedir)(), ".qwen-proxy");
var PID_FILE = (0, import_path.join)(QWEN_PROXY_DIR, "server.pid");
var LOG_FILE = (0, import_path.join)(QWEN_PROXY_DIR, "server.log");
var ERROR_LOG_FILE = (0, import_path.join)(QWEN_PROXY_DIR, "error.log");
var CONFIG_FILE = (0, import_path.join)(QWEN_PROXY_DIR, "config.json");
var ACCOUNTS_FILE = (0, import_path.join)(QWEN_PROXY_DIR, "accounts.json");
var DEFAULT_PORT = 3e3;
var DEFAULT_HOST = "127.0.0.1";
var HELP_TEXT = `
Usage: qwen-proxy [command]

Commands:
  start               Start the proxy server
  stop                Stop the proxy server
  restart             Restart the proxy server
  status              Show server status
  logs                Show server logs
  config              Configure server settings

Account Commands:
  account list        List all accounts
  account add         Add a new account (from qwen-code)
  account default     Set default account
  account enable      Enable an account
  account disable     Disable an account
  account remove      Remove an account
  account import      Import credentials from file

Options:
  -v                  Show version
  -h, help            Show this help

Examples:
  qwen-proxy start
  qwen-proxy start --port 8080
  qwen-proxy account list
  qwen-proxy account add --name work
  qwen-proxy account default <account-id>
`;
function getVersion() {
  return "1.1.0";
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
  return { port: DEFAULT_PORT, host: DEFAULT_HOST, routingStrategy: "default" };
}
function saveConfig(config) {
  ensureDir();
  (0, import_fs.writeFileSync)(CONFIG_FILE, JSON.stringify(config, null, 2));
}
function loadAccountsData() {
  ensureDir();
  if (!(0, import_fs.existsSync)(ACCOUNTS_FILE)) {
    return { accounts: {}, defaultAccountId: null };
  }
  try {
    return JSON.parse((0, import_fs.readFileSync)(ACCOUNTS_FILE, "utf-8"));
  } catch {
    return { accounts: {}, defaultAccountId: null };
  }
}
function saveAccountsData(data) {
  ensureDir();
  (0, import_fs.writeFileSync)(ACCOUNTS_FILE, JSON.stringify(data, null, 2), { mode: 384 });
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
function listAccounts() {
  const data = loadAccountsData();
  const accounts = Object.values(data.accounts);
  if (accounts.length === 0) {
    console.log("No accounts configured.");
    console.log("\nTo add an account:");
    console.log("  1. Run 'qwen-code auth login' to authenticate");
    console.log("  2. Run 'qwen-proxy account import' to import credentials");
    return;
  }
  console.log("Accounts:\n");
  console.log("  ID                                    Name      Status      Default");
  console.log("  " + "-".repeat(70));
  for (const account of accounts) {
    const isValid = Date.now() < account.credentials.expiryDate;
    const status = account.enabled ? isValid ? "\u2713 valid" : "\u26A0 expired" : "\u2717 disabled";
    const isDefault = account.id === data.defaultAccountId ? "\u2605" : " ";
    console.log(`  ${account.id.slice(0, 36)}  ${account.name.padEnd(9)} ${status.padEnd(11)} ${isDefault}`);
  }
  console.log("");
  console.log(`Total: ${accounts.length} account(s)`);
  console.log(`Active: ${accounts.filter((a) => a.enabled && Date.now() < a.credentials.expiryDate).length} account(s)`);
}
function importAccount(name) {
  const qwenCredsPath = (0, import_path.join)((0, import_os.homedir)(), ".qwen", "oauth_creds.json");
  if (!(0, import_fs.existsSync)(qwenCredsPath)) {
    console.error("No qwen-code credentials found.");
    console.log("Please authenticate first:");
    console.log("  qwen-code auth login");
    return;
  }
  try {
    const creds = JSON.parse((0, import_fs.readFileSync)(qwenCredsPath, "utf-8"));
    if (!creds.access_token) {
      console.error("Invalid credentials file.");
      return;
    }
    const data = loadAccountsData();
    const accountId = (0, import_crypto.randomUUID)();
    data.accounts[accountId] = {
      id: accountId,
      name: name || `account-${Object.keys(data.accounts).length + 1}`,
      credentials: {
        accessToken: creds.access_token,
        tokenType: creds.token_type || "Bearer",
        refreshToken: creds.refresh_token,
        resourceUrl: creds.resource_url,
        expiryDate: creds.expiry_date,
        scope: creds.scope
      },
      createdAt: Date.now(),
      lastUsed: null,
      requestCount: 0,
      enabled: true
    };
    if (!data.defaultAccountId) {
      data.defaultAccountId = accountId;
    }
    saveAccountsData(data);
    console.log(`Account "${data.accounts[accountId].name}" added successfully.`);
    console.log(`ID: ${accountId}`);
  } catch (e) {
    console.error("Failed to import account:", e);
  }
}
function setDefaultAccount(accountId) {
  const data = loadAccountsData();
  if (!data.accounts[accountId]) {
    const found = Object.values(data.accounts).find((a) => a.name === accountId);
    if (found) {
      accountId = found.id;
    } else {
      console.error(`Account not found: ${accountId}`);
      return;
    }
  }
  data.defaultAccountId = accountId;
  saveAccountsData(data);
  console.log(`Default account set to: ${data.accounts[accountId].name}`);
}
function toggleAccount(accountId, enabled) {
  const data = loadAccountsData();
  if (!data.accounts[accountId]) {
    const found = Object.values(data.accounts).find((a) => a.name === accountId);
    if (found) {
      accountId = found.id;
    } else {
      console.error(`Account not found: ${accountId}`);
      return;
    }
  }
  data.accounts[accountId].enabled = enabled;
  saveAccountsData(data);
  console.log(`Account "${data.accounts[accountId].name}" ${enabled ? "enabled" : "disabled"}.`);
}
function removeAccount(accountId) {
  const data = loadAccountsData();
  if (!data.accounts[accountId]) {
    const found = Object.values(data.accounts).find((a) => a.name === accountId);
    if (found) {
      accountId = found.id;
    } else {
      console.error(`Account not found: ${accountId}`);
      return;
    }
  }
  const name = data.accounts[accountId].name;
  delete data.accounts[accountId];
  if (data.defaultAccountId === accountId) {
    const remaining = Object.keys(data.accounts);
    data.defaultAccountId = remaining.length > 0 ? remaining[0] : null;
  }
  saveAccountsData(data);
  console.log(`Account "${name}" removed.`);
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
  saveConfig({ port: finalPort, host: finalHost, routingStrategy: config.routingStrategy });
  const serverPathGlobal = (0, import_path.join)((0, import_os.homedir)(), ".bun", "install", "global", "node_modules", "@ishan-parihar", "qwen-proxy", "dist", "server.mjs");
  const serverPathLocal = (0, import_path.join)(process.cwd(), "dist", "server.mjs");
  const serverPathDev = (0, import_path.join)(process.cwd(), "src", "server.js");
  let actualServerPath = serverPathGlobal;
  if ((0, import_fs.existsSync)(serverPathLocal)) {
    actualServerPath = serverPathLocal;
  } else if ((0, import_fs.existsSync)(serverPathDev)) {
    actualServerPath = serverPathDev;
  }
  if (!(0, import_fs.existsSync)(actualServerPath)) {
    console.error("Error: server not found. Please build the project first.");
    process.exit(1);
  }
  console.log(`Starting Qwen Proxy Server on http://${finalHost}:${finalPort}...`);
  const logFd = (0, import_fs.openSync)(LOG_FILE, "a");
  const errorLogFd = (0, import_fs.openSync)(ERROR_LOG_FILE, "a");
  const serverProcess = (0, import_child_process.spawn)(process.execPath, [actualServerPath], {
    detached: true,
    stdio: ["ignore", logFd, errorLogFd],
    env: {
      ...process.env,
      PORT: String(finalPort),
      HOST: finalHost,
      ROUTING_STRATEGY: config.routingStrategy || "default"
    }
  });
  serverProcess.unref();
  (0, import_fs.writeFileSync)(PID_FILE, String(serverProcess.pid));
  await new Promise((resolve) => setTimeout(resolve, 1500));
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
    console.error("Failed to start server. Check logs:");
    console.error(`  cat ${LOG_FILE}`);
    console.error(`  cat ${ERROR_LOG_FILE}`);
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
  console.log(`  GET  /accounts`);
  const data = loadAccountsData();
  const accounts = Object.values(data.accounts);
  console.log(`
Accounts: ${accounts.length} configured`);
  if (accounts.length > 0) {
    const active = accounts.filter((a) => a.enabled && Date.now() < a.credentials.expiryDate).length;
    console.log(`Active: ${active} account(s)`);
  }
}
function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";
  const subcommand = args[1];
  const options = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
      options[key] = isNaN(Number(value)) ? value : Number(value);
    }
  }
  return { command, subcommand, options };
}
async function main() {
  const { command, subcommand, options } = parseArgs();
  if (command === "account") {
    switch (subcommand) {
      case "list":
      case "ls":
        listAccounts();
        break;
      case "add":
      case "import":
        importAccount(options.name);
        break;
      case "default":
        if (!process.argv[3]) {
          console.error("Usage: qwen-proxy account default <account-id-or-name>");
          process.exit(1);
        }
        setDefaultAccount(process.argv[3]);
        break;
      case "enable":
        if (!process.argv[3]) {
          console.error("Usage: qwen-proxy account enable <account-id-or-name>");
          process.exit(1);
        }
        toggleAccount(process.argv[3], true);
        break;
      case "disable":
        if (!process.argv[3]) {
          console.error("Usage: qwen-proxy account disable <account-id-or-name>");
          process.exit(1);
        }
        toggleAccount(process.argv[3], false);
        break;
      case "remove":
      case "rm":
        if (!process.argv[3]) {
          console.error("Usage: qwen-proxy account remove <account-id-or-name>");
          process.exit(1);
        }
        removeAccount(process.argv[3]);
        break;
      default:
        console.log("Account commands:");
        console.log("  list      List all accounts");
        console.log("  add       Add a new account");
        console.log("  default   Set default account");
        console.log("  enable    Enable an account");
        console.log("  disable   Disable an account");
        console.log("  remove    Remove an account");
    }
    return;
  }
  switch (command) {
    case "start":
      await startServer(options.port, options.host);
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
      if (!(0, import_fs.existsSync)(LOG_FILE)) {
        console.log("No logs found");
        return;
      }
      console.log((0, import_fs.readFileSync)(LOG_FILE, "utf-8"));
      break;
    case "config":
      const currentConfig = loadConfig();
      console.log("Current configuration:");
      console.log(JSON.stringify(currentConfig, null, 2));
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
