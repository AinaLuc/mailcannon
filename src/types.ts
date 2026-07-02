export interface Contact {
  id: string;
  email: string;
  firstName: string;
  lastName?: string;
  company?: string;
  title?: string;
  createdAt: string;
}

export interface CampaignStep {
  id: string;
  day: number;
  subject: string;
  body: string;
}

export interface Campaign {
  id: string;
  name: string;
  steps: CampaignStep[];
  createdAt: string;
}

export interface ScheduleItem {
  id: string;
  campaignId: string;
  contactId: string;
  nextStepIndex: number;
  nextSendAt: string;
  status: "active" | "paused" | "completed" | "failed";
  startedAt: string;
  providerId?: string;
}

export type ProviderKind = "gmail" | "zoho";
export type TransportType = "stdio" | "sse";

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  transport: TransportType;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  tokenExpiresAt?: number;
  createdAt: string;
}

export interface SentEmail {
  id: string;
  campaignId?: string;
  contactId?: string;
  recipientEmail: string;
  subject: string;
  sentAt: string;
  status: "sent" | "opened" | "bounced" | "replied";
  openedAt?: string;
  bouncedAt?: string;
  repliedAt?: string;
  messageId?: string;
  threadId?: string;
}

