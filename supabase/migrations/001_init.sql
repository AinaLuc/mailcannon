create table contacts (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  "firstName" text not null,
  "lastName" text,
  company text,
  title text,
  "createdAt" timestamptz not null default now(),
  unsubscribed boolean not null default false,
  "unsubscribedAt" timestamptz
);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  "createdAt" timestamptz not null default now()
);

create table campaign_steps (
  id uuid primary key default gen_random_uuid(),
  "campaignId" uuid not null references campaigns(id) on delete cascade,
  day integer not null,
  subject text not null,
  body text not null
);

create table schedules (
  id uuid primary key default gen_random_uuid(),
  "campaignId" uuid not null references campaigns(id) on delete cascade,
  "contactId" uuid not null references contacts(id) on delete cascade,
  "nextStepIndex" integer not null default 0,
  "nextSendAt" timestamptz,
  status text not null default 'active',
  "startedAt" timestamptz not null default now(),
  "providerId" text
);

create table providers (
  id text primary key,
  name text not null,
  kind text not null,
  transport text not null default 'stdio',
  command text,
  args jsonb,
  url text,
  env jsonb,
  "accessToken" text,
  "refreshToken" text,
  "clientId" text,
  "tokenExpiresAt" bigint,
  "createdAt" timestamptz not null default now(),
  "readingUrl" text,
  "readingAccessToken" text,
  "readingRefreshToken" text,
  "readingClientId" text,
  "readingTokenExpiresAt" bigint
);

create table sent_emails (
  id text primary key,
  "campaignId" text,
  "contactId" text,
  "recipientEmail" text not null,
  subject text not null,
  "sentAt" timestamptz not null default now(),
  status text not null default 'sent',
  "openedAt" timestamptz,
  "bouncedAt" timestamptz,
  "repliedAt" timestamptz,
  "messageId" text,
  "threadId" text
);

create index idx_sent_emails_status on sent_emails(status);
create index idx_sent_emails_recipient on sent_emails("recipientEmail");
create index idx_sent_emails_thread on sent_emails("threadId");
create index idx_schedules_status on schedules(status);
create index idx_campaign_steps_campaign on campaign_steps("campaignId");
