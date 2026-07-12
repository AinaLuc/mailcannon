import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ProviderConfig } from "./types.js";

class StreamableHTTPTransport {
  private _url: URL;
  private _token: string;

  onmessage?: (message: any) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  constructor(url: URL, token: string = "") {
    this._url = url;
    this._token = token;
  }

  setToken(token: string) {
    this._token = token;
  }

  async start(): Promise<void> {
    // No persistent connection needed for Streamable HTTP
  }

  async close() {
    this.onclose?.();
  }

  async send(message: any) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this._token) {
      headers["Authorization"] = `Bearer ${this._token}`;
    }

    let response: Response;
    try {
      response = await fetch(this._url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
      });
    } catch (err: any) {
      this.onerror?.(err);
      throw err;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => null);
      const err = new Error(
        `HTTP ${response.status}: ${text}`,
      );
      this.onerror?.(err);
      throw err;
    }

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("text/event-stream")) {
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            data += line.slice(6);
          } else if (line === "" && data) {
            try {
              this.onmessage?.(JSON.parse(data));
            } catch { /* skip malformed SSE */ }
            data = "";
          }
        }
      }
    } else {
      const text = await response.text();
      if (!text) return;
      try {
        const result = JSON.parse(text);
        this.onmessage?.(result);
      } catch (err: any) {
        this.onerror?.(err);
      }
    }
  }
}

// --- OAuth 2.1 helpers ---

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopes_supported: string[];
  code_challenge_methods_supported: string[];
}

interface ClientRegistration {
  client_id: string;
  client_id_issued_at: number;
  client_secret?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function base64URLEncode(buf: Buffer): string {
  return buf
    .toString("base64url")
    .replace(/=+$/, "");
}

function sha256(plain: string): Buffer {
  return createHash("sha256").update(plain).digest();
}

function createCodeVerifier(): string {
  return base64URLEncode(randomBytes(32));
}

function createCodeChallenge(verifier: string): string {
  return base64URLEncode(sha256(verifier));
}

async function discoverOAuthMetadata(
  url: string,
): Promise<OAuthMetadata | null> {
  try {
    const origin = new URL(url).origin;

    const res = await fetch(
      `${origin}/.well-known/oauth-protected-resource`,
    );
    if (!res.ok) return null;
    const resourceMeta = await res.json();
    const authServerUrl = resourceMeta.authorization_servers?.[0];
    if (!authServerUrl) return null;

    const res2 = await fetch(
      `${authServerUrl}/.well-known/oauth-authorization-server`,
    );
    if (!res2.ok) return null;
    return await res2.json();
  } catch {
    return null;
  }
}

async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<ClientRegistration> {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "mailcannon",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(
      `Registration failed (HTTP ${res.status}): ${JSON.stringify(body)}`,
    );
  }
  return body;
}

function buildAuthUrl(
  authorizationEndpoint: string,
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  scope: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope,
  });
  return `${authorizationEndpoint}?${params}`;
}

async function exchangeCode(
  tokenEndpoint: string,
  clientId: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${text}`);
  }
  return await res.json();
}

async function refreshAccessToken(
  tokenEndpoint: string,
  clientId: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (HTTP ${res.status}): ${text}`);
  }
  return await res.json();
}

// --- OAuth state store ---

let pendingOAuthState: {
  verifier: string;
  config: ProviderConfig;
  metadata: OAuthMetadata;
  registration: ClientRegistration;
  redirectUri: string;
} | null = null;

// --- Public API ---

const transportCache = new Map<
  string,
  StdioClientTransport | StreamableHTTPTransport
>();

function getTransportForUrl(
  config: ProviderConfig,
  url: string,
  isReading: boolean = false
): StdioClientTransport | StreamableHTTPTransport {
  const cacheKey = isReading ? `${config.id}-reading` : config.id;
  if (transportCache.has(cacheKey)) {
    return transportCache.get(cacheKey)!;
  }

  let transport: StdioClientTransport | StreamableHTTPTransport;

  if (config.transport === "sse" && url) {
    if (config.command) {
      const args = config.args ? [...config.args] : [];
      // Replace the URL argument in args with the target URL
      const urlIndex = args.findIndex(arg => arg.startsWith("http://") || arg.startsWith("https://"));
      if (urlIndex !== -1) {
        args[urlIndex] = url;
      } else {
        const mcpRemoteIndex = args.indexOf("mcp-remote");
        if (mcpRemoteIndex !== -1) {
          args.splice(mcpRemoteIndex + 1, 0, url);
        } else {
          args.push(url);
        }
      }

      transport = new StdioClientTransport({
        command: config.command,
        args: args,
        env: { ...process.env, ...config.env } as Record<string, string>,
      });
    } else {
      const token = isReading ? (config.readingAccessToken ?? "") : (config.accessToken ?? "");
      transport = new StreamableHTTPTransport(new URL(url), token);
    }
  } else {
    const proc = spawn(config.command!, config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env },
    });
    proc.on("error", (err) => {
      console.error(`[MCP] ${config.name} process error:`, err.message);
    });
    proc.on("exit", (code) => {
      console.error(`[MCP] ${config.name} exited with code ${code}`);
      transportCache.delete(cacheKey);
    });
    proc.stderr?.on("data", (d: Buffer) => {
      console.error(`[MCP:${config.name}] ${d.toString().trim()}`);
    });
    transport = new StdioClientTransport({
      command: config.command!,
      args: config.args ?? [],
    });
  }

  transportCache.set(cacheKey, transport);
  return transport;
}

export function getTransport(config: ProviderConfig): StdioClientTransport | StreamableHTTPTransport {
  return getTransportForUrl(config, config.url ?? "", false);
}

export function getReadingTransport(config: ProviderConfig): StdioClientTransport | StreamableHTTPTransport {
  return getTransportForUrl(config, config.readingUrl ?? "", true);
}

async function testConnectionForUrl(
  config: ProviderConfig,
  url: string,
  isReading: boolean,
): Promise<{
  ok: boolean;
  message: string;
  tools?: string[];
  accounts?: string;
  discoveredEnv?: Record<string, string>;
}> {
  const client = new Client(
    { name: "mailcannon-client", version: "0.1.0" },
    { capabilities: {} },
  );

  const cacheKey = isReading ? `${config.id}-reading` : config.id;
  transportCache.delete(cacheKey);

  try {
    const transport = getTransportForUrl(config, url, isReading);
    await client.connect(transport);
    const result = await client.listTools();
    const toolNames = result.tools.map((t) => t.name);
    const sendTool = toolNames.find((n) => n.toLowerCase().includes("send"));

    let accountsInfo = "";
    let discoveredEnv: Record<string, string> = {};
    const accountsTool = result.tools.find((t) =>
      t.name.toLowerCase().includes("getmailaccounts"),
    );
    if (accountsTool) {
      try {
        const acctResult = await client.callTool({
          name: accountsTool.name,
          arguments: {},
        });
        const text = (acctResult.content as any)
          ?.map((c: any) => c.text ?? "")
          .join("\n");
        if (text) accountsInfo = text;
        const parsed = JSON.parse(text);
        if (parsed.data?.length) {
          const acct = parsed.data[0];
          if (acct.accountId) discoveredEnv.accountId = acct.accountId;
          if (acct.sendMailDetails?.length) {
            discoveredEnv.senderEmail = acct.sendMailDetails[0].fromAddress;
          }
          if (!discoveredEnv.senderEmail && acct.primaryEmailAddress) {
            discoveredEnv.senderEmail = acct.primaryEmailAddress;
          }
        }
      } catch {}
    }

    await client.close();
    transportCache.delete(cacheKey);
    const sendMsg = sendTool
      ? `Found ${result.tools.length} tool(s), send-capable: "${sendTool}"`
      : `Found ${result.tools.length} tool(s): ${toolNames.join(", ")}`;
    return {
      ok: true,
      message: accountsInfo
        ? `${sendMsg}\n\nAccounts:\n${accountsInfo}`
        : sendMsg,
      tools: toolNames,
      accounts: accountsInfo,
      discoveredEnv: Object.keys(discoveredEnv).length ? discoveredEnv : undefined,
    };
  } catch (err: any) {
    transportCache.delete(cacheKey);
    return { ok: false, message: `Connection to ${url} failed: ${err.message}` };
  }
}

export async function testConnection(
  config: ProviderConfig,
): Promise<{
  ok: boolean;
  message: string;
  tools?: string[];
  accounts?: string;
  discoveredEnv?: Record<string, string>;
}> {
  const primaryResult = await testConnectionForUrl(config, config.url ?? "", false);

  if (config.kind === "zoho" && config.readingUrl) {
    const readingResult = await testConnectionForUrl(config, config.readingUrl, true);
    if (!primaryResult.ok) {
      return {
        ok: false,
        message: `Sending connection failed: ${primaryResult.message}`,
      };
    }
    if (!readingResult.ok) {
      return {
        ok: false,
        message: `Sending OK, but Reading connection failed: ${readingResult.message}`,
      };
    }

    const combinedTools = [
      ...(primaryResult.tools ?? []).map((t) => `${t} (sending)`),
      ...(readingResult.tools ?? []).map((t) => `${t} (reading)`),
    ];
    return {
      ok: true,
      message: `Sending URL connected OK. Reading URL connected OK.\n\nSending tools: ${primaryResult.message}\n\nReading tools: ${readingResult.message}`,
      tools: combinedTools,
      accounts: primaryResult.accounts || readingResult.accounts,
      discoveredEnv: { ...primaryResult.discoveredEnv, ...readingResult.discoveredEnv },
    };
  }

  return primaryResult;
}

function buildToolArgs(
  schema: any,
  params: { to: string[]; subject: string; body: string },
  config: ProviderConfig,
): Record<string, any> {
  const props = schema?.properties ?? {};
  const args: Record<string, any> = {};
  const env = config.env ?? {};

  for (const [key, prop] of Object.entries(props)) {
    const p = prop as any;

    if ((p.type === "object" || p.properties) && p.properties) {
      const nested: Record<string, any> = {};
      for (const [nk, np] of Object.entries(p.properties)) {
        const ns = np as any;
        const lk = nk.toLowerCase();
        if (lk === "toaddress" || lk === "to" || lk === "recipients" || lk === "recipient") {
          nested[nk] = params.to.length === 1 ? params.to[0] : params.to;
        } else if (lk === "subject") {
          nested[nk] = params.subject;
        } else if (lk === "content" || lk === "body" || lk === "html" || lk === "text" || lk === "message") {
          nested[nk] = params.body;
        } else if (lk === "fromaddress" || lk === "from" || lk === "sender") {
          nested[nk] = env.senderEmail ?? env.fromAddress ?? "";
        } else if (lk === "mailformat" || lk === "format") {
          nested[nk] = ns.default ?? "html";
        } else if (ns.default !== undefined) {
          nested[nk] = ns.default;
        } else if (lk === "accountid" || lk === "account_id") {
          nested[nk] = env.accountId ?? "";
        }
      }
      args[key] = nested;
    } else if (p.type === "string") {
      const lk = key.toLowerCase();
      if (lk === "to" || lk === "toaddress" || lk === "recipient" || lk === "recipients") {
        args[key] = params.to.length === 1 ? params.to[0] : params.to;
      } else if (lk === "subject") {
        args[key] = params.subject;
      } else if (lk === "body" || lk === "content" || lk === "html" || lk === "text" || lk === "message") {
        args[key] = params.body;
      } else if (lk === "from" || lk === "fromaddress" || lk === "sender") {
        args[key] = env.senderEmail ?? env.fromAddress ?? "";
      }
    }
  }

  return args;
}

function findSendTool(tools: any[]) {
  const name = (n: string) => n.toLowerCase();
  return (
    tools.find((t) => name(t.name) === "sendemail") ||
    tools.find((t) => name(t.name).includes("sendemail")) ||
    tools.find((t) => name(t.name).includes("send") && !name(t.name).includes("reply")) ||
    tools.find((t) => name(t.name).includes("send"))
  );
}

function wrapHtml(body: string): string {
  if (/<\w+[^>]*>/i.test(body)) return body;
  const lines = body.replace(/\n/g, "<br>");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#333;padding:20px"><div style="max-width:600px;margin:0 auto">${lines}</div></body></html>`;
}

import { randomUUID } from "node:crypto";

export async function sendViaMCP(
  config: ProviderConfig,
  to: string[],
  subject: string,
  body: string,
  trackingId?: string,
): Promise<{ ok: boolean; message: string; trackingId?: string }> {
  const actualTrackingId = trackingId || randomUUID();
  const client = new Client(
    { name: "mailcannon-client", version: "0.1.0" },
    { capabilities: {} },
  );

  try {
    const transport = getTransport(config);
    await client.connect(transport);

    const tools = await client.listTools();
    const sendTool = findSendTool(tools.tools);
    if (!sendTool) {
      return {
        ok: false,
        message: "No send-capable tool found on this MCP server",
      };
    }

    const baseUrl = process.env.PUBLIC_URL || process.env.APP_URL || "http://localhost:3456";
    const trackingPixel = `<img src="${baseUrl}/track/open/${actualTrackingId}" width="1" height="1" style="display:none" />`;
    const wrappedBody = wrapHtml(body);
    const bodyWithPixel = wrappedBody.includes("</body>")
      ? wrappedBody.replace("</body>", `${trackingPixel}</body>`)
      : `${wrappedBody}${trackingPixel}`;

    const toolArgs = buildToolArgs(sendTool.inputSchema, { to, subject, body: bodyWithPixel }, config);

    const result = await client.callTool({
      name: sendTool.name,
      arguments: toolArgs,
    });

    await client.close();
    transportCache.delete(config.id);
    return { ok: true, message: JSON.stringify(result.content), trackingId: actualTrackingId };
  } catch (err: any) {
    transportCache.delete(config.id);
    return { ok: false, message: `Send failed: ${err.message}` };
  }
}

// --- OAuth flow ---

export async function startOAuth(
  config: ProviderConfig,
  redirectUri: string,
): Promise<{ authUrl: string; stateId: string }> {
  if (!config.url) throw new Error("Provider URL is required");

  const metadata = await discoverOAuthMetadata(config.url);
  if (!metadata) {
    throw new Error("Could not discover OAuth metadata from provider URL");
  }

  const registration = await registerClient(
    metadata.registration_endpoint,
    redirectUri,
  );

  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);

  pendingOAuthState = {
    verifier,
    config,
    metadata,
    registration,
    redirectUri,
  };

  const authUrl = buildAuthUrl(
    metadata.authorization_endpoint,
    registration.client_id,
    redirectUri,
    challenge,
    metadata.scopes_supported.join(" "),
  );

  const stateId = registration.client_id;

  return { authUrl, stateId };
}

export async function completeOAuth(
  code: string,
  stateId: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  if (!pendingOAuthState) {
    throw new Error("No pending OAuth flow");
  }

  const { verifier, metadata, registration, redirectUri } = pendingOAuthState;

  const tokenResponse = await exchangeCode(
    metadata.token_endpoint,
    registration.client_id,
    code,
    verifier,
    redirectUri,
  );

  pendingOAuthState = null;

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresIn: tokenResponse.expires_in,
  };
}
