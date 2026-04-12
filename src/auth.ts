/**
 * OAuth setup command: `freeagent-mcp-server auth`
 *
 * Walks the user through FreeAgent's OAuth authorization code flow and
 * writes the resulting refresh token to .mcp.json in the current directory,
 * ready for Claude Code or any MCP client to pick up.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createInterface, type Interface as ReadlineInterface } from "readline";
import { exec } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve as resolvePath } from "path";
import axios, { AxiosError } from "axios";
import { FA_TOKEN_URL } from "./constants.js";

const REDIRECT_URI = "http://localhost:8080/callback";
const CALLBACK_PORT = 8080;
const AUTHORIZE_URL = "https://api.freeagent.com/v2/approve_app";
const MCP_CONFIG_FILE = ".mcp.json";

// ── Public entry point ───────────────────────────────────────────────────────

export async function runAuth(): Promise<void> {
  writeStderr("\nFreeAgent MCP — OAuth setup\n");
  writeStderr("───────────────────────────────────────────────\n");
  writeStderr("Before starting:\n");
  writeStderr("  1. Create or open your app at https://dev.freeagent.com\n");
  writeStderr(`  2. Set the redirect URI to: ${REDIRECT_URI}\n\n`);

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const clientId = (await prompt(rl, "Client ID: ")).trim();
    const clientSecret = (await prompt(rl, "Client Secret: ")).trim();

    if (!clientId || !clientSecret) {
      throw new Error("Client ID and Client Secret are both required.");
    }

    const code = await listenForAuthCode(clientId);
    writeStderr("\nAuthorization code received. Exchanging for tokens...\n");

    const refreshToken = await exchangeCodeForToken({
      code,
      clientId,
      clientSecret,
    });

    const configPath = resolvePath(process.cwd(), MCP_CONFIG_FILE);
    writeMcpConfig(configPath, {
      clientId,
      clientSecret,
      refreshToken,
    });

    writeStderr(`\nCredentials saved to ${MCP_CONFIG_FILE}\n`);
    writeStderr("Next: restart Claude Code (or your MCP client) to pick up the new config.\n");
  } finally {
    rl.close();
  }
}

// ── Prompting ────────────────────────────────────────────────────────────────

function prompt(rl: ReadlineInterface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

// ── Local HTTP callback listener ─────────────────────────────────────────────

async function listenForAuthCode(clientId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");

      if (error || !code) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderHtml("Authorization failed", error ?? "No authorization code returned.", false));
        if (!settled) {
          settled = true;
          server.close();
          reject(new Error(`Authorization denied: ${error ?? "no code in callback"}`));
        }
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderHtml("All done", "You can close this tab and return to your terminal.", true));

      if (!settled) {
        settled = true;
        // Close after the response flushes so the browser sees the HTML.
        res.on("finish", () => server.close());
        resolve(code);
      }
    });

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${CALLBACK_PORT} is already in use. Stop the other process and try again.`
          )
        );
      } else {
        reject(err);
      }
    });

    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      const authorizeUrl =
        `${AUTHORIZE_URL}` +
        `?client_id=${encodeURIComponent(clientId)}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

      writeStderr("\nOpening FreeAgent authorization page in your browser...\n");
      writeStderr(`If it doesn't open automatically, visit:\n  ${authorizeUrl}\n\n`);
      openInBrowser(authorizeUrl);
    });
  });
}

// ── Token exchange ───────────────────────────────────────────────────────────

async function exchangeCodeForToken(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: REDIRECT_URI,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });

  try {
    const response = await axios.post<{ refresh_token?: string }>(
      FA_TOKEN_URL,
      params.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15_000,
      }
    );

    const refreshToken = response.data.refresh_token;
    if (!refreshToken) {
      throw new Error(
        "FreeAgent did not return a refresh_token. Check that your app is set up for long-lived tokens."
      );
    }
    return refreshToken;
  } catch (err) {
    if (err instanceof AxiosError && err.response) {
      const data = err.response.data as { error?: string; error_description?: string };
      const detail = data?.error_description ?? data?.error ?? err.response.statusText;
      throw new Error(`Token exchange failed (${err.response.status}): ${detail}`);
    }
    throw err;
  }
}

// ── .mcp.json read / merge / write ───────────────────────────────────────────

interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

function writeMcpConfig(
  path: string,
  creds: { clientId: string; clientSecret: string; refreshToken: string }
): void {
  let config: McpConfig = {};

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      config = JSON.parse(raw) as McpConfig;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeStderr(
        `Warning: existing ${MCP_CONFIG_FILE} could not be parsed (${message}). Backing it up to ${MCP_CONFIG_FILE}.bak and writing a fresh file.\n`
      );
      writeFileSync(`${path}.bak`, readFileSync(path, "utf8"), "utf8");
      config = {};
    }
  }

  const servers: Record<string, McpServerEntry> = config.mcpServers ?? {};
  servers.freeagent = {
    command: "npx",
    args: ["freeagent-mcp-server"],
    env: {
      ...(servers.freeagent?.env ?? {}),
      FREEAGENT_CLIENT_ID: creds.clientId,
      FREEAGENT_CLIENT_SECRET: creds.clientSecret,
      FREEAGENT_REFRESH_TOKEN: creds.refreshToken,
    },
  };
  config.mcpServers = servers;

  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ── Browser launch ───────────────────────────────────────────────────────────

function openInBrowser(url: string): void {
  const platform = process.platform;
  // URL is encoded/trusted (built from constants + a user-entered clientId that
  // we URI-encoded above), but shell-quote the argument defensively anyway.
  const quoted = `"${url.replace(/"/g, '\\"')}"`;
  const cmd =
    platform === "darwin" ? `open ${quoted}` :
    platform === "win32"  ? `start "" ${quoted}` :
                            `xdg-open ${quoted}`;

  exec(cmd, (err) => {
    if (err) {
      writeStderr(`(Could not open browser automatically: ${err.message})\n`);
    }
  });
}

// ── HTML page shown to the user after the callback ───────────────────────────

function renderHtml(title: string, message: string, success: boolean): string {
  const accent = success ? "#16a34a" : "#dc2626";
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; text-align: center; color: #1f2937; }
    h1 { font-size: 1.875rem; margin-bottom: 0.5rem; color: ${accent}; }
    p { font-size: 1.0625rem; color: #4b5563; line-height: 1.6; }
  </style>
</head>
<body>
  <h1>${safeTitle}</h1>
  <p>${safeMessage}</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function writeStderr(msg: string): void {
  process.stderr.write(msg);
}
