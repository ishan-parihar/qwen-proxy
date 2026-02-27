#!/usr/bin/env node

// src/server.js
import http from "node:http";
import { URL } from "node:url";

// src/accounts/manager.js
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
var QWEN_PROXY_DIR = join(homedir(), ".qwen-proxy");
var ACCOUNTS_FILE = join(QWEN_PROXY_DIR, "accounts.json");
var CONFIG_FILE = join(QWEN_PROXY_DIR, "config.json");
var QWEN_CREDS_FILE = join(homedir(), ".qwen", "oauth_creds.json");
var TOKEN_REFRESH_BUFFER_MS = 30 * 1e3;
var OAUTH_CONFIG = {
  deviceCodeEndpoint: "https://chat.qwen.ai/api/v1/oauth2/device/code",
  tokenEndpoint: "https://chat.qwen.ai/api/v1/oauth2/token",
  clientId: "f0304373b74a44d2b584a3fb70ca9e56",
  scope: "openid profile email model.completion",
  grantType: "urn:ietf:params:oauth:grant-type:device_code"
};
var API_ENDPOINTS = {
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  dashscopeIntl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  portal: "https://portal.qwen.ai/v1"
};
function ensureDir() {
  if (!existsSync(QWEN_PROXY_DIR)) {
    mkdirSync(QWEN_PROXY_DIR, { recursive: true, mode: 448 });
  }
}
function loadAccounts() {
  ensureDir();
  if (!existsSync(ACCOUNTS_FILE)) {
    const migrated = migrateFromQwenCode();
    if (migrated) {
      return loadAccounts();
    }
    return { accounts: {}, defaultAccountId: null };
  }
  try {
    const content = readFileSync(ACCOUNTS_FILE, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    console.error("Error loading accounts:", error.message);
    return { accounts: {}, defaultAccountId: null };
  }
}
function saveAccounts(data) {
  ensureDir();
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), { mode: 384 });
}
function migrateFromQwenCode() {
  if (!existsSync(QWEN_CREDS_FILE)) {
    return false;
  }
  try {
    const content = readFileSync(QWEN_CREDS_FILE, "utf-8");
    const creds = JSON.parse(content);
    if (!creds.access_token) {
      return false;
    }
    const accountId = randomUUID();
    const accounts = {
      accounts: {
        [accountId]: {
          id: accountId,
          name: "default",
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
        }
      },
      defaultAccountId: accountId
    };
    saveAccounts(accounts);
    console.log("Migrated credentials from qwen-code CLI");
    return true;
  } catch (error) {
    console.error("Migration error:", error.message);
    return false;
  }
}
function getAccount(accountId) {
  const data = loadAccounts();
  return data.accounts[accountId] || null;
}
function getDefaultAccount() {
  const data = loadAccounts();
  if (!data.defaultAccountId) {
    return null;
  }
  return data.accounts[data.defaultAccountId] || null;
}
function updateCredentials(accountId, credentials) {
  const data = loadAccounts();
  if (!data.accounts[accountId]) {
    throw new Error(`Account not found: ${accountId}`);
  }
  data.accounts[accountId].credentials = {
    ...data.accounts[accountId].credentials,
    ...credentials
  };
  saveAccounts(data);
}
function updateAccountStats(accountId) {
  const data = loadAccounts();
  if (!data.accounts[accountId]) {
    return;
  }
  data.accounts[accountId].lastUsed = Date.now();
  data.accounts[accountId].requestCount = (data.accounts[accountId].requestCount || 0) + 1;
  saveAccounts(data);
}
function isTokenValid(credentials) {
  if (!credentials?.expiryDate || !credentials?.accessToken) {
    return false;
  }
  return Date.now() < credentials.expiryDate - TOKEN_REFRESH_BUFFER_MS;
}
function resolveBaseUrl(resourceUrl) {
  if (!resourceUrl) {
    return API_ENDPOINTS.dashscope;
  }
  const normalized = resourceUrl.toLowerCase().trim();
  if (normalized.includes("portal.qwen.ai")) {
    return API_ENDPOINTS.portal;
  }
  if (normalized.includes("dashscope-intl")) {
    return API_ENDPOINTS.dashscopeIntl;
  }
  if (normalized.includes("dashscope")) {
    return API_ENDPOINTS.dashscope;
  }
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    const url = resourceUrl.endsWith("/v1") ? resourceUrl : `${resourceUrl}/v1`;
    return url;
  }
  return API_ENDPOINTS.dashscope;
}
async function refreshAccessToken(refreshToken) {
  const response = await fetch(OAUTH_CONFIG.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OAUTH_CONFIG.clientId
    })
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
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
async function getValidCredentials(accountId) {
  const account = getAccount(accountId);
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }
  if (!account.enabled) {
    throw new Error(`Account is disabled: ${account.name}`);
  }
  let credentials = account.credentials;
  if (!isTokenValid(credentials)) {
    if (!credentials.refreshToken) {
      throw new Error("Token expired and no refresh token available.");
    }
    console.log(`Refreshing token for account: ${account.name}`);
    credentials = await refreshAccessToken(credentials.refreshToken);
    updateCredentials(accountId, credentials);
    console.log("Token refreshed successfully.");
  }
  return credentials;
}
function buildHeaders(credentials) {
  const resourceUrl = credentials.resourceUrl?.toLowerCase() || "";
  const isDashScope = resourceUrl.includes("dashscope") || !resourceUrl;
  const headers = {
    "Authorization": `Bearer ${credentials.accessToken}`,
    "Content-Type": "application/json"
  };
  if (isDashScope) {
    headers["X-DashScope-CacheControl"] = "enable";
    headers["X-DashScope-UserAgent"] = "qwen-proxy/1.1.0";
    headers["X-DashScope-AuthType"] = "qwen-oauth";
  }
  return headers;
}
function getNextAvailableAccount() {
  const data = loadAccounts();
  const enabledAccounts = Object.values(data.accounts).filter(
    (a) => a.enabled && isTokenValid(a.credentials)
  );
  if (enabledAccounts.length === 0) {
    const refreshableAccounts = Object.values(data.accounts).filter(
      (a) => a.enabled && a.credentials.refreshToken
    );
    if (refreshableAccounts.length > 0) {
      return refreshableAccounts[0];
    }
    return null;
  }
  enabledAccounts.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  return enabledAccounts[0];
}
function getAccountForRequest(strategy = "default") {
  switch (strategy) {
    case "round-robin":
    case "load-balance":
      return getNextAvailableAccount();
    case "default":
    default:
      return getDefaultAccount();
  }
}

// src/server.js
var PORT = process.env.PORT || 3e3;
var HOST = process.env.HOST || "localhost";
var ROUTING_STRATEGY = process.env.ROUTING_STRATEGY || "default";
var DEBUG = process.env.DEBUG === "1";
function log(...args) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  console.log(`[${timestamp}]`, ...args);
}
function debug(...args) {
  if (DEBUG) {
    log("[DEBUG]", ...args);
  }
}
var QWEN_MODELS = {
  "qwen3-coder-plus": {
    id: "qwen3-coder-plus",
    object: "model",
    created: Date.now(),
    owned_by: "qwen",
    permission: [],
    root: "qwen3-coder-plus"
  },
  "qwen3-coder-flash": {
    id: "qwen3-coder-flash",
    object: "model",
    created: Date.now(),
    owned_by: "qwen",
    permission: [],
    root: "qwen3-coder-flash"
  },
  "coder-model": {
    id: "coder-model",
    object: "model",
    created: Date.now(),
    owned_by: "qwen",
    permission: [],
    root: "coder-model"
  },
  "vision-model": {
    id: "vision-model",
    object: "model",
    created: Date.now(),
    owned_by: "qwen",
    permission: [],
    root: "vision-model"
  }
};
async function* streamIterator(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
async function handleModels(res) {
  const models = Object.values(QWEN_MODELS);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    object: "list",
    data: models
  }));
}
async function handleChatCompletions(req, res) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  let requestBody;
  try {
    requestBody = JSON.parse(body);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }
  debug("Request body:", JSON.stringify(requestBody, null, 2));
  const account = getAccountForRequest(ROUTING_STRATEGY);
  if (!account) {
    log("No available account");
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: 'No accounts configured. Use "qwen-proxy account add" to add an account.' }));
    return;
  }
  let credentials;
  try {
    credentials = await getValidCredentials(account.id);
  } catch (e) {
    log("Auth error for account", account.name, ":", e.message);
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
    return;
  }
  const baseUrl = resolveBaseUrl(credentials.resourceUrl);
  const endpoint = `${baseUrl}/chat/completions`;
  debug("Using account:", account.name, "->", endpoint);
  const headers = buildHeaders(credentials);
  const isStreaming = requestBody.stream === true;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody)
    });
    debug("Response status:", response.status);
    if (!response.ok) {
      const errorText = await response.text();
      log("API error:", response.status, errorText);
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(errorText);
      return;
    }
    updateAccountStats(account.id);
    if (isStreaming) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });
      for await (const chunk of streamIterator(response)) {
        res.write(chunk);
      }
      res.end();
    } else {
      const responseText = await response.text();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(responseText);
    }
  } catch (e) {
    log("Request error:", e.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Proxy error: ${e.message}` }));
  }
}
async function handleModel(req, res, modelId) {
  const model = QWEN_MODELS[modelId];
  if (!model) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Model not found" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(model));
}
async function handleStatus(res) {
  const accountsData = loadAccounts();
  const accounts = Object.values(accountsData.accounts || {}).map((account) => ({
    id: account.id,
    name: account.name,
    enabled: account.enabled,
    isValid: isTokenValid(account.credentials),
    resourceUrl: account.credentials.resourceUrl,
    expiryDate: account.credentials.expiryDate,
    isDefault: account.id === accountsData.defaultAccountId
  }));
  const status = {
    status: "ok",
    routingStrategy: ROUTING_STRATEGY,
    totalAccounts: accounts.length,
    activeAccounts: accounts.filter((a) => a.enabled && a.isValid).length,
    accounts,
    defaultAccountId: accountsData.defaultAccountId
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(status, null, 2));
}
async function handleAccounts(req, res, method) {
  const accountsData = loadAccounts();
  if (method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(accountsData, null, 2));
  } else {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
  }
}
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  log(`${req.method} ${path}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    if (path === "/v1/models" && req.method === "GET") {
      await handleModels(res);
    } else if (path.match(/^\/v1\/models\/[^/]+$/) && req.method === "GET") {
      const modelId = path.split("/").pop();
      await handleModel(req, res, modelId);
    } else if (path === "/v1/chat/completions" && req.method === "POST") {
      await handleChatCompletions(req, res);
    } else if (path === "/status" && req.method === "GET") {
      await handleStatus(res);
    } else if (path === "/accounts" && req.method === "GET") {
      await handleAccounts(req, res, req.method);
    } else if (path === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy" }));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  } catch (e) {
    log("Unhandled error:", e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
}
var server = http.createServer(handleRequest);
server.listen(PORT, HOST, () => {
  log(`Qwen Proxy Server running at http://${HOST}:${PORT}`);
  log(`Routing strategy: ${ROUTING_STRATEGY}`);
  log("");
  const accountsData = loadAccounts();
  const accountCount = Object.keys(accountsData.accounts || {}).length;
  log(`Loaded ${accountCount} account(s)`);
  if (accountCount === 0) {
    log("WARNING: No accounts configured!");
    log('Run "qwen-proxy account add" to add an account.');
  }
  log("");
  log("Endpoints:");
  log(`  GET  http://${HOST}:${PORT}/v1/models`);
  log(`  GET  http://${HOST}:${PORT}/v1/models/:id`);
  log(`  POST http://${HOST}:${PORT}/v1/chat/completions`);
  log(`  GET  http://${HOST}:${PORT}/status`);
  log(`  GET  http://${HOST}:${PORT}/accounts`);
  log(`  GET  http://${HOST}:${PORT}/health`);
  log("");
  log("Usage with OpenAI SDK:");
  log(`  OPENAI_API_KEY=any OPENAI_BASE_URL=http://${HOST}:${PORT}/v1`);
  log("");
  log("Usage with curl:");
  log(`  curl http://${HOST}:${PORT}/v1/models`);
});
process.on("SIGINT", () => {
  log("Shutting down...");
  server.close(() => {
    log("Server closed");
    process.exit(0);
  });
});
