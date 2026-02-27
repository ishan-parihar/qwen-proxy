#!/usr/bin/env node
"use strict";

// src/cli.js
var import_child_process = require("child_process");
var import_fs = require("fs");
var import_path = require("path");
var import_os = require("os");
var import_crypto = require("crypto");
var import_child_process2 = require("child_process");

// src/auth/oauth.js
var import_node_crypto = require("node:crypto");
var OAUTH_CONFIG = {
  baseUrl: "https://chat.qwen.ai",
  deviceCodeEndpoint: "https://chat.qwen.ai/api/v1/oauth2/device/code",
  tokenEndpoint: "https://chat.qwen.ai/api/v1/oauth2/token",
  clientId: "f0304373b74a44d2b584a3fb70ca9e56",
  scope: "openid profile email model.completion",
  grantType: "urn:ietf:params:oauth:grant-type:device_code"
};
var TOKEN_REFRESH_BUFFER_MS = 30 * 1e3;
var SlowDownError = class extends Error {
  constructor() {
    super("slow_down: server requested increased polling interval");
    this.name = "SlowDownError";
  }
};
function generatePKCE() {
  const verifier = (0, import_node_crypto.randomBytes)(32).toString("base64url");
  const challenge = (0, import_node_crypto.createHash)("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
function objectToUrlEncoded(data) {
  return Object.keys(data).map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`).join("&");
}
async function requestDeviceAuthorization(codeChallenge) {
  const bodyData = {
    client_id: OAUTH_CONFIG.clientId,
    scope: OAUTH_CONFIG.scope,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  };
  const response = await fetch(OAUTH_CONFIG.deviceCodeEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "x-request-id": (0, import_node_crypto.randomUUID)()
    },
    body: objectToUrlEncoded(bodyData)
  });
  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Device auth failed: HTTP ${response.status}: ${errorData}`);
  }
  const result = await response.json();
  if (!result.device_code || !result.user_code) {
    throw new Error("Invalid device authorization response");
  }
  return result;
}
async function pollDeviceToken(deviceCode, codeVerifier) {
  const bodyData = {
    grant_type: OAUTH_CONFIG.grantType,
    client_id: OAUTH_CONFIG.clientId,
    device_code: deviceCode,
    code_verifier: codeVerifier
  };
  const response = await fetch(OAUTH_CONFIG.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: objectToUrlEncoded(bodyData)
  });
  if (!response.ok) {
    const responseText = await response.text();
    try {
      const errorData = JSON.parse(responseText);
      if (response.status === 400 && errorData.error === "authorization_pending") {
        return null;
      }
      if (response.status === 429 && errorData.error === "slow_down") {
        throw new SlowDownError();
      }
      throw new Error(`Token poll failed: ${errorData.error || responseText}`);
    } catch (parseError) {
      if (parseError instanceof SyntaxError) {
        throw new Error(`Token poll failed: ${response.status} ${response.statusText}`);
      }
      throw parseError;
    }
  }
  return await response.json();
}
function tokenResponseToCredentials(tokenResponse) {
  return {
    accessToken: tokenResponse.access_token,
    tokenType: tokenResponse.token_type || "Bearer",
    refreshToken: tokenResponse.refresh_token,
    resourceUrl: tokenResponse.resource_url,
    expiryDate: Date.now() + tokenResponse.expires_in * 1e3,
    scope: tokenResponse.scope
  };
}
async function refreshAccessToken(refreshToken) {
  const bodyData = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CONFIG.clientId
  };
  const response = await fetch(OAUTH_CONFIG.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: objectToUrlEncoded(bodyData)
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: HTTP ${response.status}: ${errorText}`);
  }
  const data = await response.json();
  return {
    accessToken: data.access_token,
    tokenType: data.token_type || "Bearer",
    refreshToken: data.refresh_token || refreshToken,
    resourceUrl: data.resource_url,
    expiryDate: Date.now() + data.expires_in * 1e3,
    scope: data.scope
  };
}
function isCredentialsExpired(credentials) {
  if (!credentials.expiryDate) return false;
  return Date.now() > credentials.expiryDate - TOKEN_REFRESH_BUFFER_MS;
}
async function performDeviceAuthFlow(onVerificationUrl, pollIntervalMs = 2e3, timeoutMs = 5 * 60 * 1e3) {
  const { verifier, challenge } = generatePKCE();
  const deviceAuth = await requestDeviceAuthorization(challenge);
  onVerificationUrl(deviceAuth.verification_uri_complete, deviceAuth.user_code);
  const startTime = Date.now();
  let interval = pollIntervalMs;
  while (Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    try {
      const tokenResponse = await pollDeviceToken(deviceAuth.device_code, verifier);
      if (tokenResponse) {
        return tokenResponseToCredentials(tokenResponse);
      }
    } catch (error) {
      if (error instanceof SlowDownError) {
        interval = Math.min(interval * 1.5, 1e4);
      } else {
        throw error;
      }
    }
  }
  throw new Error("Device authorization timeout");
}

// src/cli.js
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
function getVersion() {
  return "1.2.0";
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
function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      (0, import_child_process2.execSync)(`open "${url}"`);
    } else if (platform === "win32") {
      (0, import_child_process2.execSync)(`start "" "${url}"`);
    } else {
      const browsers = ["xdg-open", "google-chrome", "firefox", "chromium"];
      for (const browser of browsers) {
        try {
          (0, import_child_process2.execSync)(`which ${browser}`);
          (0, import_child_process2.execSync)(`${browser} "${url}" >/dev/null 2>&1 &`);
          return;
        } catch {
        }
      }
    }
  } catch {
  }
}
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
    const status = account.enabled ? expired ? "\u26A0 expired" : "\u2713 valid" : "\u2717 disabled";
    const expires = account.credentials.expiryDate ? formatExpiry(account.credentials.expiryDate) : "never";
    const isDefault = account.id === data.defaultAccountId ? "\u2605" : " ";
    console.log(`  ${account.id.slice(0, 36)}  ${account.name.padEnd(15)} ${status.padEnd(13)} ${expires.padEnd(13)} ${isDefault}`);
  }
  console.log("");
  console.log(`Total: ${accounts.length} account(s)`);
  console.log(`Active: ${accounts.filter((a) => a.enabled && !isCredentialsExpired(a.credentials)).length} account(s)`);
}
function formatExpiry(expiryDate) {
  const seconds = Math.floor((expiryDate - Date.now()) / 1e3);
  if (seconds < 0) return "expired";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
async function loginAccount(name) {
  const data = loadAccountsData();
  const accountName = name || `account-${Object.keys(data.accounts).length + 1}`;
  console.log(`
Starting OAuth login for account "${accountName}"...
`);
  try {
    const credentials = await performDeviceAuthFlow((url, userCode) => {
      console.log("Opening browser for authentication...\n");
      console.log(`  User Code: ${userCode}`);
      console.log(`  URL: ${url}
`);
      console.log("If the browser does not open automatically, visit the URL above.\n");
      openBrowser(url);
    });
    const accountId = (0, import_crypto.randomUUID)();
    data.accounts[accountId] = {
      id: accountId,
      name: accountName,
      credentials: {
        accessToken: credentials.accessToken,
        tokenType: credentials.tokenType,
        refreshToken: credentials.refreshToken,
        resourceUrl: credentials.resourceUrl,
        expiryDate: credentials.expiryDate,
        scope: credentials.scope
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
    console.log(`
\u2713 Account "${accountName}" logged in successfully!`);
    console.log(`  ID: ${accountId}`);
    console.log(`  Resource URL: ${credentials.resourceUrl || "portal.qwen.ai"}`);
    console.log(`  Expires: ${formatExpiry(credentials.expiryDate)}`);
  } catch (error) {
    console.error("\n\u2717 Login failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
async function refreshAccount(accountId) {
  const data = loadAccountsData();
  let account = data.accounts[accountId];
  if (!account) {
    const found = Object.values(data.accounts).find((a) => a.name === accountId);
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
      scope: newCredentials.scope
    };
    saveAccountsData(data);
    console.log(`\u2713 Token refreshed for "${account.name}"`);
    console.log(`  Expires: ${formatExpiry(newCredentials.expiryDate)}`);
  } catch (error) {
    console.error("\u2717 Failed to refresh token:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
function logoutAccount(accountId) {
  const data = loadAccountsData();
  let account = data.accounts[accountId];
  if (!account) {
    const found = Object.values(data.accounts).find((a) => a.name === accountId);
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
  console.log(`\u2713 Account "${name}" logged out.`);
}
function setDefaultAccount(accountId) {
  const data = loadAccountsData();
  let account = data.accounts[accountId];
  if (!account) {
    const found = Object.values(data.accounts).find((a) => a.name === accountId);
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
  console.log(`\u2713 Default account set to: ${data.accounts[accountId].name}`);
}
function toggleAccount(accountId, enabled) {
  const data = loadAccountsData();
  let account = data.accounts[accountId];
  if (!account) {
    const found = Object.values(data.accounts).find((a) => a.name === accountId);
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
  console.log(`\u2713 Account "${data.accounts[accountId].name}" ${enabled ? "enabled" : "disabled"}.`);
}
function renameAccount(accountId, newName) {
  const data = loadAccountsData();
  let account = data.accounts[accountId];
  if (!account) {
    const found = Object.values(data.accounts).find((a) => a.name === accountId);
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
  console.log(`\u2713 Account renamed from "${oldName}" to "${newName}"`);
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
    const active = accounts.filter((a) => a.enabled && !isCredentialsExpired(a.credentials)).length;
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
