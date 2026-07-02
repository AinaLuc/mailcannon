import { z } from "zod";
import crypto from "node:crypto";
import { db } from "../db.js";
import type { ProviderConfig } from "../types.js";

export const AddProviderSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["gmail", "zoho"]),
  transport: z.enum(["stdio", "sse"]).default("stdio"),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string()).optional(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  clientId: z.string().optional(),
  tokenExpiresAt: z.number().optional(),
});

export function addProvider(input: z.infer<typeof AddProviderSchema>): ProviderConfig {
  const store = db.load();
  const provider: ProviderConfig = {
    id: crypto.randomUUID(),
    name: input.name,
    kind: input.kind,
    transport: input.transport ?? "stdio",
    command: input.command,
    args: input.args ?? [],
    url: input.url,
    env: input.env,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    clientId: input.clientId,
    tokenExpiresAt: input.tokenExpiresAt,
    createdAt: new Date().toISOString(),
  };
  store.providers.push(provider);
  db.save(store);
  return provider;
}

export function listProviders(): ProviderConfig[] {
  return db.load().providers;
}

export function removeProvider(id: string): boolean {
  const store = db.load();
  const len = store.providers.length;
  store.providers = store.providers.filter((p) => p.id !== id);
  db.save(store);
  return store.providers.length < len;
}

export function updateProvider(
  id: string,
  patch: Partial<ProviderConfig>,
): ProviderConfig | null {
  const store = db.load();
  const idx = store.providers.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  store.providers[idx] = { ...store.providers[idx], ...patch };
  db.save(store);
  return store.providers[idx];
}
