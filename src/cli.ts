#!/usr/bin/env node
/**
 * Qwen Proxy CLI
 * 
 * A CLI tool to manage the Qwen Proxy Server
 */

import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

// Constants
const QWEN_PROXY_DIR = join(homedir(), ".qwen-proxy");
const PID_FILE = join(QWEN_PROXY_DIR, "server.pid");
const LOG_FILE = join(QWEN_PROXY_DIR, "server.log");
const CONFIG_FILE = join(QWEN_PROXY_DIR, "config.json");

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";

const HELP_TEXT = `
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

// Version from package.json
function getVersion(): string {
  try {
    const packagePath = join(__dirname, "..", "package.json");
    const content = readFileSync(packagePath, "utf-8");
    return JSON.parse(content).version;
  } catch {
    return "1.0.0";
  }
}

// Ensure directory exists
function ensureDir(): void {
  if (!existsSync(QWEN_PROXY_DIR)) {
    mkdirSync(QWEN_PROXY_DIR, { recursive: true, mode: 0o700 });
  }
}

// Load config
function loadConfig(): { port: number; host: string } {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return { port: DEFAULT_PORT, host: DEFAULT_HOST };
}

// Save config
function saveConfig(config: { port: number; host: string }): void {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Check if server is running
function isRunning(): { running: boolean; pid?: number; port?: number; host?: string } {
  if (!existsSync(PID_FILE)) {
    return { running: false };
  }

  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);

    // Check if process exists
    try {
      process.kill(pid, 0);
      
      const config = loadConfig();
      return { running: true, pid, port: config.port, host: config.host };
    } catch {
      // Process doesn't exist, clean up
      unlinkSync(PID_FILE);
      return { running: false };
    }
  } catch {
    return { running: false };
  }
}

// Start server
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

  // Save config
  saveConfig({ port: finalPort, host: finalHost });

  // Find server.js
  const serverPath = join(__dirname, "server.mjs");
  
  if (!existsSync(serverPath)) {
    console.error("Error: server.mjs not found. Please build the project first.");
    process.exit(1);
  }

  console.log(`Starting Qwen Proxy Server on http://${finalHost}:${finalPort}...`);

  // Spawn server process
  const serverProcess = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      PORT: String(finalPort),
      HOST: finalHost,
    },
  });

  serverProcess.unref();

  // Save PID
  writeFileSync(PID_FILE, String(serverProcess.pid));

  // Wait a bit and check if it started
  await new Promise((resolve) => setTimeout(resolve, 1000));

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
    console.error("Failed to start server.");
    process.exit(1);
  }
}

// Stop server
function stopServer(): void {
  const status = isRunning();

  if (!status.running) {
    console.log("Server is not running");
    return;
  }

  try {
    process.kill(status.pid!, "SIGTERM");
    
    // Clean up PID file
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
    
    console.log(`Server stopped (PID: ${status.pid})`);
  } catch (e) {
    console.error("Failed to stop server:", e);
  }
}

// Show status
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

  // Check authentication
  const credsPath = join(homedir(), ".qwen", "oauth_creds.json");
  if (existsSync(credsPath)) {
    try {
      const creds = JSON.parse(readFileSync(credsPath, "utf-8"));
      const isValid = Date.now() < creds.expiry_date;
      console.log(`\nAuthentication:`);
      console.log(`  Status:      ${isValid ? "Valid" : "Expired"}`);
      console.log(`  Resource:    ${creds.resource_url || "Unknown"}`);
      console.log(`  Expires:     ${new Date(creds.expiry_date).toISOString()}`);
    } catch {
      console.log(`\nAuthentication: Unable to read credentials`);
    }
  } else {
    console.log(`\nAuthentication: Not configured`);
    console.log("Run 'qwen-code auth login' to authenticate");
  }
}

// Show logs
function showLogs(): void {
  if (!existsSync(LOG_FILE)) {
    console.log("No logs found");
    return;
  }

  const logs = readFileSync(LOG_FILE, "utf-8");
  console.log(logs);
}

// Configure server
async function configure(): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const currentConfig = loadConfig();

  console.log("Configure Qwen Proxy Server\n");

  const port = await new Promise<string>((resolve) => {
    rl.question(`Port [${currentConfig.port}]: `, resolve);
  });

  const host = await new Promise<string>((resolve) => {
    rl.question(`Host [${currentConfig.host}]: `, resolve);
  });

  rl.close();

  const newConfig = {
    port: parseInt(port) || currentConfig.port,
    host: host || currentConfig.host,
  };

  saveConfig(newConfig);

  console.log(`\nConfiguration saved:`);
  console.log(`  Port: ${newConfig.port}`);
  console.log(`  Host: ${newConfig.host}`);

  const status = isRunning();
  if (status.running) {
    console.log("\nServer is running. Restart to apply changes:");
    console.log("  qwen-proxy restart");
  }
}

// Parse arguments
function parseArgs(): { command: string; options: Record<string, string | number | boolean> } {
  const args = process.argv.slice(2);
  const command = args[0] || "help";
  const options: Record<string, string | number | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
      options[key] = isNaN(Number(value)) ? value : Number(value);
    }
  }

  return { command, options };
}

// Main
async function main(): Promise<void> {
  const { command, options } = parseArgs();

  switch (command) {
    case "start":
      await startServer(
        options.port as number | undefined,
        options.host as string | undefined
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
