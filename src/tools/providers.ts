import { z } from "zod";
import crypto from "node:crypto";
import { supabase } from "../supabase.js";
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
  readingUrl: z.string().optional(),
  readingAccessToken: z.string().optional(),
  readingRefreshToken: z.string().optional(),
  readingClientId: z.string().optional(),
  readingTokenExpiresAt: z.number().optional(),
});

export async function addProvider(input: z.infer<typeof AddProviderSchema>): Promise<ProviderConfig> {
  const provider = {
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
    readingUrl: input.readingUrl,
    readingAccessToken: input.readingAccessToken,
    readingRefreshToken: input.readingRefreshToken,
    readingClientId: input.readingClientId,
    readingTokenExpiresAt: input.readingTokenExpiresAt,
  };

  const { data, error } = await supabase
    .from("providers")
    .insert(provider)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function listProviders(): Promise<ProviderConfig[]> {
  const { data, error } = await supabase
    .from("providers")
    .select("*")
    .order("createdAt", { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function removeProvider(id: string): Promise<boolean> {
  const { error, count } = await supabase.from("providers").delete({ count: "exact" }).eq("id", id);
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

export async function updateProvider(
  id: string,
  patch: Partial<ProviderConfig>,
): Promise<ProviderConfig | null> {
  const { data, error } = await supabase
    .from("providers")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) {
    if (error.code === "PGRST116") return null;
    throw new Error(error.message);
  }
  return data;
}
