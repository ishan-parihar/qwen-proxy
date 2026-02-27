#!/usr/bin/env node
/**
 * Qwen Proxy CLI
 * 
 * A CLI tool to manage the Qwen Proxy Server with multi-account support
 */

import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

// Constants - use relative paths that work after bundling
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

// Version
function getVersion(): string {
  return "1.1.0";
}

// Ensure directory exists
function ensureDir(): void {
  if (!existsSync(QWEN_PROXY_DIR)) {
    mkdirSync(QWEN_PROXY_DIR, { recursive: true, mode: 0o700 });
  }
}

// Load config
function loadConfig(): { port: number; host: string; routingStrategy: string } {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return { port: DEFAULT_PORT, host: DEFAULT_HOST, routingStrategy: "default" };
}

// Save config
function saveConfig(config: { port: number; host: string; routingStrategy?: string }): void {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Load accounts
function loadAccountsData(): any {
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
function saveAccountsData(data: any): void {
  ensureDir();
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// Check if server is running
function isRunning(): { running: boolean; pid?: number; port?: number; host?: string } {
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

// ============================================
// Account Commands
// ============================================

function listAccounts(): void {
  const data = loadAccountsData();
  const accounts = Object.values(data.accounts) as any[];

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
    const status = account.enabled
      ? (isValid ? "✓ valid" : "⚠ expired")
      : "✗ disabled";
    const isDefault = account.id === data.defaultAccountId ? "★" : " ";
    
    console.log(`  ${account.id.slice(0, 36)}  ${account.name.padEnd(9)} ${status.padEnd(11)} ${isDefault}`);
  }

  console.log("");
  console.log(`Total: ${accounts.length} account(s)`);
  console.log(`Active: ${accounts.filter(a => a.enabled && Date.now() < a.credentials.expiryDate).length} account(s)`);
}

function importAccount(name?: string): void {
  const qwenCredsPath = join(homedir(), ".qwen", "oauth_creds.json");
  
  if (!existsSync(qwenCredsPath)) {
    console.error("No qwen-code credentials found.");
    console.log("Please authenticate first:");
    console.log("  qwen-code auth login");
    return;
  }

  try {
    const creds = JSON.parse(readFileSync(qwenCredsPath, "utf-8"));
    
    if (!creds.access_token) {
      console.error("Invalid credentials file.");
      return;
    }

    const data = loadAccountsData();
    const accountId = randomUUID();

    data.accounts[accountId] = {
      id: accountId,
      name: name || `account-${Object.keys(data.accounts).length + 1}`,
      credentials: {
        accessToken: creds.access_token,
        tokenType: creds.token_type || "Bearer",
        refreshToken: creds.refresh_token,
        resourceUrl: creds.resource_url,
        expiryDate: creds.expiry_date,
        scope: creds.scope,
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
    console.log(`Account "${data.accounts[accountId].name}" added successfully.`);
    console.log(`ID: ${accountId}`);
  } catch (e) {
    console.error("Failed to import account:", e);
  }
}

function setDefaultAccount(accountId: string): void {
  const data = loadAccountsData();
  
  if (!data.accounts[accountId]) {
    const found = Object.values(data.accounts).find((a: any) => a.name === accountId);
    if (found) {
      accountId = (found as any).id;
    } else {
      console.error(`Account not found: ${accountId}`);
      return;
    }
  }

  data.defaultAccountId = accountId;
  saveAccountsData(data);
  console.log(`Default account set to: ${data.accounts[accountId].name}`);
}

function toggleAccount(accountId: string, enabled: boolean): void {
  const data = loadAccountsData();
  
  if (!data.accounts[accountId]) {
    const found = Object.values(data.accounts).find((a: any) => a.name === accountId);
    if (found) {
      accountId = (found as any).id;
    } else {
      console.error(`Account not found: ${accountId}`);
      return;
    }
  }

  data.accounts[accountId].enabled = enabled;
  saveAccountsData(data);
  console.log(`Account "${data.accounts[accountId].name}" ${enabled ? "enabled" : "disabled"}.`);
}

function removeAccount(accountId: string): void {
  const data = loadAccountsData();
  
  if (!data.accounts[accountId]) {
    const found = Object.values(data.accounts).find((a: any) => a.name === accountId);
    if (found) {
      accountId = (found as any).id;
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

// ============================================
// Server Commands
// ============================================

async function startServer(port?: number, host?: string): Promise<void> {
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

  // Find server.mjs relative to this script
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

  // Open log files
  const logFd = openSync(LOG_FILE, 'a');
  const errorLogFd = openSync(ERROR_LOG_FILE, 'a');

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

  // Wait for server to start
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

function stopServer(): void {
  const status = isRunning();

  if (!status.running) {
    console.log("Server is not running");
    return;
  }

  try {
    process.kill(status.pid!, "SIGTERM");
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
    console.log(`Server stopped (PID: ${status.pid})`);
  } catch (e) {
    console.error("Failed to stop server:", e);
  }
}

function showStatus(): void {
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
  const accounts = Object.values(data.accounts) as any[];
  
  console.log(`\nAccounts: ${accounts.length} configured`);
  if (accounts.length > 0) {
    const active = accounts.filter(a => a.enabled && Date.now() < a.credentials.expiryDate).length;
    console.log(`Active: ${active} account(s)`);
  }
}

// ============================================
// Main
// ============================================

function parseArgs(): { command: string; subcommand?: string; options: Record<string, any> } {
  const args = process.argv.slice(2);
  const command = args[0] || "help";
  const subcommand = args[1];
  const options: Record<string, any> = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
      options[key] = isNaN(Number(value)) ? value : Number(value);
    }
  }

  return { command, subcommand, options };
}

async function main(): Promise<void> {
  const { command, subcommand, options } = parseArgs();

  if (command === "account") {
    switch (subcommand) {
      case "list":
      case "ls":
        listAccounts();
        break;
      case "add":
      case "import":
        importAccount(options.name as string);
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
      await startServer(options.port as number | undefined, options.host as string | undefined);
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
