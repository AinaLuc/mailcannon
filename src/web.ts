import express from "express";
import cors from "cors";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import crypto from "node:crypto";
import {
  addContact,
  addContacts,
  listContacts,
  removeContact,
  unsubscribeContactByEmail,
} from "./tools/contacts.js";
import {
  createCampaign,
  addStep,
  listCampaigns,
} from "./tools/campaigns.js";
import { scheduleCampaign, listSchedules } from "./tools/scheduler.js";
import {
  addProvider,
  listProviders,
  removeProvider,
  updateProvider,
  AddProviderSchema,
} from "./tools/providers.js";
import { testConnection, startOAuth, completeOAuth, sendViaMCP } from "./mcp-client.js";
import { getGmailAuthUrl, handleGmailCallback, sendViaGmail } from "./gmail.js";
import { recordSentEmail, recordOpen, getDeliverabilityStats } from "./tools/tracking.js";
import { startInboxPoller } from "./poller.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || "3456", 10);

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, "..", "public")));

app.get("/api/contacts", async (_req, res) => {
  res.json(await listContacts());
});

app.post("/api/contacts", async (req, res) => {
  const contact = await addContact(req.body);
  res.status(201).json(contact);
});

app.post("/api/contacts/bulk", async (req, res) => {
  const contacts = await addContacts(req.body);
  res.status(201).json({ count: contacts.length });
});

app.delete("/api/contacts/:id", async (req, res) => {
  const ok = await removeContact(req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});

app.get("/api/campaigns", async (_req, res) => {
  res.json(await listCampaigns());
});

app.post("/api/campaigns", async (req, res) => {
  const campaign = await createCampaign(req.body.name);
  res.status(201).json(campaign);
});

app.post("/api/campaigns/:id/steps", async (req, res) => {
  const step = await addStep({ campaignId: req.params.id, ...req.body });
  res.status(201).json(step);
});

app.get("/api/schedules", async (_req, res) => {
  res.json(await listSchedules());
});

app.get("/api/deliverability", async (_req, res) => {
  res.json(await getDeliverabilityStats());
});

app.post("/api/schedules", async (req, res) => {
  const items = await scheduleCampaign(req.body.campaignId, req.body.contactIds, req.body.startAt, req.body.providerId);
  res.status(201).json({ count: items.length });
});

app.get("/api/providers", async (_req, res) => {
  res.json(await listProviders());
});

app.post("/api/providers", async (req, res) => {
  try {
    const input = AddProviderSchema.parse(req.body);
    const provider = await addProvider(input);
    res.status(201).json(provider);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/providers/:id", async (req, res) => {
  const ok = await removeProvider(req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});

app.post("/api/providers/test", async (req, res) => {
  try {
    const input = AddProviderSchema.parse(req.body);
    const result = await testConnection({ id: "temp", createdAt: "", ...input });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

app.post("/api/providers/:id/test", async (req, res) => {
  const providers = await listProviders();
  const provider = providers.find((p) => p.id === req.params.id);
  if (!provider) return res.status(404).json({ ok: false, message: "Provider not found" });
  const result = await testConnection(provider);
  if (result.ok && result.discoveredEnv) {
    const merged = { ...(provider.env ?? {}), ...result.discoveredEnv };
    await updateProvider(provider.id, { env: merged });
  }
  res.json(result);
});

app.post("/api/providers/:id/send", async (req, res) => {
  try {
    const providers = await listProviders();
    const provider = providers.find((p) => p.id === req.params.id);
    if (!provider) return res.status(404).json({ ok: false, message: "Provider not found" });

    const { to, subject, body } = req.body;
    if (!to || !subject || !body) {
      return res.status(400).json({ ok: false, message: "Missing to, subject, or body" });
    }

    let result;
    if (provider.kind === "gmail" && provider.refreshToken) {
      result = await sendViaGmail(provider, [to], subject, body);
      if (!result.ok && result.message.includes("Invalid Credentials") && provider.refreshToken) {
        try {
          const { google } = await import("googleapis");
          const oauth2 = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID || "",
            process.env.GOOGLE_CLIENT_SECRET || "",
            `${process.env.PUBLIC_URL || `http://localhost:${PORT}`}/api/gmail/oauth/callback`,
          );
          oauth2.setCredentials({ refresh_token: provider.refreshToken });
          const { credentials } = await oauth2.refreshAccessToken();
          await updateProvider(provider.id, {
            accessToken: credentials.access_token || undefined,
            refreshToken: credentials.refresh_token || provider.refreshToken || undefined,
            tokenExpiresAt: credentials.expiry_date ?? undefined
          });
          result = await sendViaGmail({ ...provider, accessToken: credentials.access_token || undefined, refreshToken: credentials.refresh_token || provider.refreshToken || undefined }, [to], subject, body);
        } catch {}
      }
    } else {
      result = await sendViaMCP(provider, [to], subject, body);
    }

    if (result.ok && result.trackingId) {
      await recordSentEmail({
        id: result.trackingId,
        recipientEmail: Array.isArray(to) ? to.join(", ") : to,
        subject,
        messageId: (result as any).messageId || undefined,
        threadId: (result as any).threadId || undefined,
      });
    }

    res.json(result);
  } catch (err: any) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

const getOAuthRedirectUri = () => {
  const baseUrl = process.env.PUBLIC_URL || process.env.APP_URL || `http://localhost:${PORT}`;
  return `${baseUrl}/oauth/callback`;
};

app.post("/api/providers/:id/oauth/start", async (req, res) => {
  try {
    const providers = await listProviders();
    const provider = providers.find((p) => p.id === req.params.id);
    if (!provider) return res.status(404).json({ error: "Provider not found" });

    const result = await startOAuth(provider, getOAuthRedirectUri());
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/oauth/start", async (req, res) => {
  try {
    const { name, kind, url } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });

    const tempConfig = {
      id: "temp-oauth",
      name,
      kind: kind || "zoho",
      transport: "sse" as const,
      url,
      createdAt: new Date().toISOString(),
    };

    const result = await startOAuth(tempConfig, getOAuthRedirectUri());
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || typeof code !== "string") {
      return res.status(400).send("Missing authorization code");
    }

    const tokens = await completeOAuth(code, (state as string) || "");
    const tokenJson = JSON.stringify(tokens);
    res.send(`<!DOCTYPE html>
<html><body style="font-family:sans-serif;background:#0f0f0f;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <div style="font-size:48px;margin-bottom:16px">✅</div>
  <h2 style="margin:0 0 8px;color:#34d399">OAuth Complete!</h2>
  <p style="color:#888;font-size:14px">You can close this window and return to MailCannon.</p>
  <button onclick="window.close()" style="margin-top:12px;background:#34d399;color:#000;border:none;padding:8px 24px;border-radius:8px;cursor:pointer;font-size:14px">Close Window</button>
  <pre style="margin-top:16px;font-size:11px;color:#555;max-width:400px;overflow:hidden">Token received: ${tokens.accessToken ? tokens.accessToken.slice(0, 20) + '...' : 'N/A'}</pre>
</div>
<script>
  if (window.opener) {
    window.opener.postMessage(${tokenJson}, "*");
    setTimeout(function() { try { window.close(); } catch(e) {} }, 500);
  }
</script>
</body></html>`);
  } catch (err: any) {
    res.status(400).send(`<!DOCTYPE html>
<html><body style="font-family:sans-serif;background:#0f0f0f;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <div style="font-size:48px;margin-bottom:16px">❌</div>
  <h2 style="margin:0 0 8px;color:#f87171">OAuth Failed</h2>
  <p style="color:#888;font-size:14px">${err.message}</p>
  <button onclick="window.close()" style="margin-top:12px;background:#6b7280;color:#fff;border:none;padding:8px 24px;border-radius:8px;cursor:pointer;font-size:14px">Close Window</button>
</div>
</body></html>`);
  }
});

app.post("/api/gmail/oauth/start", async (_req, res) => {
  try {
    const state = crypto.randomUUID();
    const url = getGmailAuthUrl(state);
    res.json({ authUrl: url, stateId: state });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/gmail/oauth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || typeof code !== "string") {
      return res.status(400).send("Missing authorization code");
    }

    const tokens = await handleGmailCallback(code);
    const providerData = {
      name: "Gmail",
      kind: "gmail" as const,
      transport: "sse" as const,
      command: "npx",
      args: ["mcp-remote", `http://localhost:3000/mcp`, "--transport", "http-only"],
      url: `http://localhost:3000/mcp`,
      accessToken: tokens.access_token || undefined,
      refreshToken: tokens.refresh_token || undefined,
      tokenExpiresAt: tokens.expiry_date ? Math.floor(tokens.expiry_date / 1000) : undefined,
    };

    const existing = (await listProviders()).find((p) => p.kind === "gmail" && p.refreshToken);
    let provider;
    if (existing) {
      provider = await updateProvider(existing.id, providerData);
    } else {
      provider = await addProvider(providerData);
    }

    const tokenJson = JSON.stringify({ accessToken: tokens.access_token, stateId: "complete" });
    res.send(`<!DOCTYPE html>
<html><body style="font-family:sans-serif;background:#0f0f0f;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <div style="font-size:48px;margin-bottom:16px">✅</div>
  <h2 style="margin:0 0 8px;color:#34d399">Gmail Connected!</h2>
  <p style="color:#888;font-size:14px">You can close this window.</p>
  <button onclick="window.close()" style="margin-top:12px;background:#34d399;color:#000;border:none;padding:8px 24px;border-radius:8px;cursor:pointer;font-size:14px">Close Window</button>
</div>
<script>
  if (window.opener) {
    window.opener.postMessage(${tokenJson}, "*");
    setTimeout(function() { try { window.close(); } catch(e) {} }, 500);
  }
</script>
</body></html>`);
  } catch (err: any) {
    res.status(400).send(`<!DOCTYPE html>
<html><body style="font-family:sans-serif;background:#0f0f0f;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <div style="font-size:48px;margin-bottom:16px">❌</div>
  <h2 style="margin:0 0 8px;color:#f87171">Gmail OAuth Failed</h2>
  <p style="color:#888;font-size:14px">${err.message}</p>
  <button onclick="window.close()" style="margin-top:12px;background:#6b7280;color:#fff;border:none;padding:8px 24px;border-radius:8px;cursor:pointer;font-size:14px">Close Window</button>
</div>
</body></html>`);
  }
});

app.get("/track/open/:id", async (req, res) => {
  const { id } = req.params;
  await recordOpen(id);

  const pixel = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64"
  );
  res.writeHead(200, {
    "Content-Type": "image/gif",
    "Content-Length": pixel.length,
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
  });
  res.end(pixel);
});

app.get("/unsubscribe", async (req, res) => {
  const { email } = req.query;
  if (!email || typeof email !== "string") {
    return res.status(400).send("Invalid unsubscribe request: email is required.");
  }

  await unsubscribeContactByEmail(email);

  res.send(`<!DOCTYPE html>
<html><body style="font-family:sans-serif;background:#0f0f0f;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <div style="font-size:48px;margin-bottom:16px">🔕</div>
  <h2 style="margin:0 0 8px;color:#f43f5e">Unsubscribed</h2>
  <p style="color:#888;font-size:14px">The email <strong>${email}</strong> has been successfully unsubscribed from our lists.</p>
</div>
</body></html>`);
});

export default app;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.error(`[MailCannon] Web UI at http://localhost:${PORT}`);
    startInboxPoller();
  });
}
