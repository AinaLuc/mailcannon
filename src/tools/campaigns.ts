import { z } from "zod";
import crypto from "node:crypto";
import { db } from "../db.js";
import type { Campaign, CampaignStep } from "../types.js";

export const CreateCampaignSchema = z.object({
  name: z.string().min(1),
});

export const AddStepSchema = z.object({
  campaignId: z.string(),
  day: z.number().min(0),
  subject: z.string(),
  body: z.string(),
});

export const ScheduleCampaignSchema = z.object({
  campaignId: z.string(),
  contactIds: z.array(z.string()).min(1),
  startAt: z.string().optional(),
  provider: z.enum(["gmail", "zoho"]).optional().default("gmail"),
});

export function createCampaign(name: string): Campaign {
  const store = db.load();
  const campaign: Campaign = {
    id: crypto.randomUUID(),
    name,
    steps: [],
    createdAt: new Date().toISOString(),
  };
  store.campaigns.push(campaign);
  db.save(store);
  return campaign;
}

export function addStep(input: z.infer<typeof AddStepSchema>): CampaignStep {
  const store = db.load();
  const campaign = store.campaigns.find((c) => c.id === input.campaignId);
  if (!campaign) throw new Error(`Campaign ${input.campaignId} not found`);

  const step: CampaignStep = {
    id: crypto.randomUUID(),
    day: input.day,
    subject: input.subject,
    body: input.body,
  };
  campaign.steps.push(step);
  db.save(store);
  return step;
}

export function listCampaigns(): Campaign[] {
  return db.load().campaigns;
}
