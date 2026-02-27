#!/usr/bin/env node
/**
 * Qwen Proxy CLI
 * 
 * A CLI tool to manage the Qwen Proxy Server with multi-account support
 * Standalone OAuth login - no dependency on qwen-code
 */

import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { execSync } from "child_process";

// Import OAuth functions
import {
  performDeviceAuthFlow,
  refreshAccessToken,
  isCredentialsExpired,
} from "./auth/oauth.js";

// Constants
const QWEN_PROXY_DIR = join(homedir(), ".qwen-proxy");
const PID_FILE = join(QWEN_PROXY_DIR, "server.pid");
const LOG_FILE = join(QWEN_PROXY_DIR, "server.log");
const ERROR_LOG_FILE = join(QWEN_PROXY_DIR, "error.log");
const CONFIG_FILE = join(QWEN_PROXY_DIR, "config.json");
const ACCOUNTS_FILE = join(QWEN_PROXY_DIR, "accounts.json");

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";

const HELP_TEXT = `
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
  account login       Login with new account (opens browser)
  account logout      Logout and remove account
  account default     Set default account
  account enable      Enable an account
  account disable     Disable an account
  account refresh     Refresh token for an account
  account rename      Rename an account

Options:
  -v                  Show version
  -h, help            Show this help

Examples:
  qwen-proxy start
  qwen-proxy account login --name work
  qwen-proxy account list
  qwen-proxy account default work
`;

// Version
function getVersion() {
  return "1.2.0";
}

// Ensure directory exists
function ensureDir() {
  if (!existsSync(QWEN_PROXY_DIR)) {
    mkdirSync(QWEN_PROXY_DIR, { recursive: true, mode: 0o700 });
  }
}

// Load config
function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return { port: DEFAULT_PORT, host: DEFAULT_HOST, routingStrategy: "default" };
}

// Save config
function saveConfig(config) {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Load accounts
function loadAccountsData() {
  ensureDir();
  if (!existsSync(ACCOUNTS_FILE)) {
    return { accounts: {}, defaultAccountId: null };
  }
  try {
    return JSON.parse(readFileSync(ACCOUNTS_FILE, "utf-8"));
  } catch {
    return { accounts: {}, defaultAccountId: null };
  }
}

// Save accounts
function saveAccountsData(data) {
  ensureDir();
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// Check if server is running
function isRunning() {
  if (!existsSync(PID_FILE)) {
    return { running: false };
  }

  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);

    try {
      process.kill(pid, 0);
      const config = loadConfig();
      return { running: true, pid, port: config.port, host: config.host };
    } catch {
      unlinkSync(PID_FILE);
      return { running: false };
    }
  } catch {
    return { running: false };
  }
}

// Open URL in browser
function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      execSync(`open "${url}"`);
    } else if (platform === "win32") {
      execSync(`start "" "${url}"`);
    } else {
      // Linux - try common browsers
      const browsers = ["xdg-open", "google-chrome", "firefox", "chromium"];
      for (const browser of browsers) {
        try {
          execSync(`which ${browser}`);
          execSync(`${browser} "${url}" >/dev/null 2>&1 &`);
          return;
        } catch {}
      }
    }
  } catch {
    // Fallback - just print the URL
  }
}

// ============================================
// Account Commands
// ============================================

function listAccounts() {
  const data = loadAccountsData();
  const accounts = Object.values(data.accounts);

  if (accounts.length === 0) {
    console.log("No accounts configured.");
    console.log("\nTo login with a new account:");
    console.log("  qwen-proxy account login --name <account-name>");
    return;
  }

  console.log("Accounts:\n");
  console.log("  ID                                    Name            Status        Expires       Default");
  console.log("  " + "-".repeat(85));

  for (const account of accounts) {
    const expired = isCredentialsExpired(account.credentials);
    const status = account.enabled
      ? (expired ? "⚠ expired" : "✓ valid")
      : "✗ disabled";
    const expires = account.credentials.expiryDate
      ? formatExpiry(account.credentials.expiryDate)
      : "never";
    const isDefault = account.id === data.defaultAccountId ? "★" : " ";
    
    console.log(`  ${account.id.slice(0, 36)}  ${account.name.padEnd(15)} ${status.padEnd(13)} ${expires.padEnd(13)} ${isDefault}`);
  }

  console.log("");
  console.log(`Total: ${accounts.length} account(s)`);
  console.log(`Active: ${accounts.filter(a => a.enabled && !isCredentialsExpired(a.credentials)).length} account(s)`);
}

function formatExpiry(expiryDate) {
  const seconds = Math.floor((expiryDate - Date.now()) / 1000);
  if (seconds < 0) return "expired";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

async function loginAccount(name) {
  const data = loadAccountsData();
  const accountName = name || `account-${Object.keys(data.accounts).length + 1}`;

  console.log(`\nStarting OAuth login for account "${accountName}"...\n`);

  try {
    const credentials = await performDeviceAuthFlow((url, userCode) => {
      console.log("Opening browser for authentication...\n");
      console.log(`  User Code: ${userCode}`);
      console.log(`  URL: ${url}\n`);
      console.log("If the browser does not open automatically, visit the URL above.\n");
      
      openBrowser(url);
    });

    const accountId = randomUUID();

    data.accounts[accountId] = {
      id: accountId,
      name: accountName,
      credentials: {
        accessToken: credentials.accessToken,
        tokenType: credentials.tokenType,
        refreshToken: credentials.refreshToken,
        resourceUrl: credentials.resourceUrl,
        expiryDate: credentials.expiryDate,
        scope: credentials.scope,
      },
      createdAt: Date.now(),
      lastUsed: null,
      requestCount: 0,
      enabled: true,
    };

    if (!data.defaultAccountId) {
      data.defaultAccountId = accountId;
    }

    saveAccountsData(data);
    
    console.log(`\n✓ Account "${accountName}" logged in successfully!`);
    console.log(`  ID: ${accountId}`);
    console.log(`  Resource URL: ${credentials.resourceUrl || "portal.qwen.ai"}`);
    console.log(`  Expires: ${formatExpiry(credentials.expiryDate)}`);
  } catch (error) {
    console.error("\n✗ Login failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function refreshAccount(accountId) {
  const data = loadAccountsData();
  
  // Find account by ID or name
  let account = data.accounts[accountId];
  if (!account) {
    const found = Object.values(data.accounts).find(a => a.name === accountId);
    if (found) {
      account = found;
      accountId = account.id;
    }
  }

  if (!account) {
    console.error(`Account not found: ${accountId}`);
    process.exit(1);
  }

  if (!account.credentials.refreshToken) {
    console.error(`Account "${account.name}" has no refresh token. Please login again.`);
    process.exit(1);
  }

  console.log(`Refreshing token for account "${account.name}"...`);

  try {
    const newCredentials = await refreshAccessToken(account.credentials.refreshToken);
    
    data.accounts[accountId].credentials = {
      accessToken: newCredentials.accessToken,
      tokenType: newCredentials.tokenType,
      refreshToken: newCredentials.refreshToken || account.credentials.refreshToken,
      resourceUrl: newCredentials.resourceUrl,
      expiryDate: newCredentials.expiryDate,
      scope: newCredentials.scope,
    };

    saveAccountsData(data);
    
    console.log(`✓ Token refreshed for "${account.name}"`);
    console.log(`  Expires: ${formatExpiry(newCredentials.expiryDate)}`);
  } catch (error) {
    console.error("✗ Failed to refresh token:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

function logoutAccount(accountId) {
  const data = loadAccountsData();
  
  // Find account by ID or name
  let account = data.accounts[accountId];
  if (!account) {
    const found = Object.values(data.accounts).find(a => a.name === accountId);
    if (found) {
      account = found;
      accountId = account.id;
    } else {
      console.error(`Account not found: ${accountId}`);
      process.exit(1);
    }
  }

  const name = account.name;
  delete data.accounts[accountId];

  if (data.defaultAccountId === accountId) {
    const remaining = Object.keys(data.accounts);
    data.defaultAccountId = remaining.length > 0 ? remaining[0] : null;
  }

  saveAccountsData(data);
  console.log(`✓ Account "${name}" logged out.`);
}

function setDefaultAccount(accountId) {
  const data = loadAccountsData();
  
  let account = data.accounts[accountId];
  if (!account) {
    const found = Object.values(data.accounts).find(a => a.name === accountId);
    if (found) {
      account = found;
      accountId = account.id;
    } else {
      console.error(`Account not found: ${accountId}`);
      return;
    }
  }

  data.defaultAccountId = accountId;
  saveAccountsData(data);
  console.log(`✓ Default account set to: ${data.accounts[accountId].name}`);
}

function toggleAccount(accountId, enabled) {
  const data = loadAccountsData();
  
  let account = data.accounts[accountId];
  if (!account) {
    const found = Object.values(data.accounts).find(a => a.name === accountId);
    if (found) {
      account = found;
      accountId = account.id;
    } else {
      console.error(`Account not found: ${accountId}`);
      return;
    }
  }

  data.accounts[accountId].enabled = enabled;
  saveAccountsData(data);
  console.log(`✓ Account "${data.accounts[accountId].name}" ${enabled ? "enabled" : "disabled"}.`);
}

function renameAccount(accountId, newName) {
  const data = loadAccountsData();
  
  let account = data.accounts[accountId];
  if (!account) {
    const found = Object.values(data.accounts).find(a => a.name === accountId);
    if (found) {
      account = found;
      accountId = account.id;
    } else {
      console.error(`Account not found: ${accountId}`);
      return;
    }
  }

  const oldName = account.name;
  data.accounts[accountId].name = newName;
  saveAccountsData(data);
  console.log(`✓ Account renamed from "${oldName}" to "${newName}"`);
}

// ============================================
// Server Commands
// ============================================

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

  // Find server.mjs
  const serverPathGlobal = join(homedir(), ".bun", "install", "global", "node_modules", "@ishan-parihar", "qwen-proxy", "dist", "server.mjs");
  const serverPathLocal = join(process.cwd(), "dist", "server.mjs");
  const serverPathDev = join(process.cwd(), "src", "server.js");
  
  let actualServerPath = serverPathGlobal;
  if (existsSync(serverPathLocal)) {
    actualServerPath = serverPathLocal;
  } else if (existsSync(serverPathDev)) {
    actualServerPath = serverPathDev;
  }

  if (!existsSync(actualServerPath)) {
    console.error("Error: server not found. Please build the project first.");
    process.exit(1);
  }

  console.log(`Starting Qwen Proxy Server on http://${finalHost}:${finalPort}...`);

  const logFd = openSync(LOG_FILE, "a");
  const errorLogFd = openSync(ERROR_LOG_FILE, "a");

  const serverProcess = spawn(process.execPath, [actualServerPath], {
    detached: true,
    stdio: ["ignore", logFd, errorLogFd],
    env: {
      ...process.env,
      PORT: String(finalPort),
      HOST: finalHost,
      ROUTING_STRATEGY: config.routingStrategy || "default",
    },
  });

  serverProcess.unref();
  writeFileSync(PID_FILE, String(serverProcess.pid));

  await new Promise((resolve) => setTimeout(resolve, 1500));

  const newStatus = isRunning();
  if (newStatus.running) {
    console.log(`Server started successfully (PID: ${newStatus.pid})`);
    console.log(`\nEndpoints:`);
    console.log(`  GET  http://${finalHost}:${finalPort}/v1/models`);
    console.log(`  POST http://${finalHost}:${finalPort}/v1/chat/completions`);
    console.log(`  GET  http://${finalHost}:${finalPort}/status`);
    console.log(`\nUsage with OpenAI SDK:`);
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
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
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
  console.log(`\nEndpoints:`);
  console.log(`  GET  /v1/models`);
  console.log(`  POST /v1/chat/completions`);
  console.log(`  GET  /status`);
  console.log(`  GET  /accounts`);

  const data = loadAccountsData();
  const accounts = Object.values(data.accounts);
  
  console.log(`\nAccounts: ${accounts.length} configured`);
  if (accounts.length > 0) {
    const active = accounts.filter(a => a.enabled && !isCredentialsExpired(a.credentials)).length;
    console.log(`Active: ${active} account(s)`);
  }
}

// ============================================
// Main
// ============================================

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
      case "login":
        await loginAccount(options.name);
        break;
      case "logout":
      case "remove":
      case "rm":
        if (!process.argv[3] || process.argv[3].startsWith("--")) {
          console.error("Usage: qwen-proxy account logout <account-id-or-name>");
          process.exit(1);
        }
        logoutAccount(process.argv[3]);
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
      case "refresh":
        if (!process.argv[3]) {
          console.error("Usage: qwen-proxy account refresh <account-id-or-name>");
          process.exit(1);
        }
        await refreshAccount(process.argv[3]);
        break;
      case "rename":
        if (!process.argv[3] || !process.argv[4]) {
          console.error("Usage: qwen-proxy account rename <account-id-or-name> <new-name>");
          process.exit(1);
        }
        renameAccount(process.argv[3], process.argv[4]);
        break;
      default:
        console.log("Account commands:");
        console.log("  list        List all accounts");
        console.log("  login       Login with new account (opens browser)");
        console.log("  logout      Logout and remove account");
        console.log("  default     Set default account");
        console.log("  enable      Enable an account");
        console.log("  disable     Disable an account");
        console.log("  refresh     Refresh token for an account");
        console.log("  rename      Rename an account");
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
      if (!existsSync(LOG_FILE)) {
        console.log("No logs found");
        return;
      }
      console.log(readFileSync(LOG_FILE, "utf-8"));
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
