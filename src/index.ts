import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  AddContactSchema,
  AddContactsSchema,
  RemoveContactSchema,
  addContact,
  addContacts,
  listContacts,
  removeContact,
} from "./tools/contacts.js";
import {
  CreateCampaignSchema,
  AddStepSchema,
  ScheduleCampaignSchema,
  createCampaign,
  addStep,
  listCampaigns,
} from "./tools/campaigns.js";
import { scheduleCampaign, listSchedules } from "./tools/scheduler.js";

const server = new Server(
  { name: "mailcannon", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "add_contact",
      description: "Add a single contact",
      inputSchema: { type: "object", properties: { email: { type: "string" }, firstName: { type: "string" }, lastName: { type: "string" }, company: { type: "string" }, title: { type: "string" } }, required: ["email", "firstName"] },
    },
    {
      name: "add_contacts",
      description: "Bulk add contacts",
      inputSchema: { type: "object", properties: { contacts: { type: "array", items: { type: "object", properties: { email: { type: "string" }, firstName: { type: "string" }, lastName: { type: "string" }, company: { type: "string" }, title: { type: "string" } }, required: ["email", "firstName"] } } }, required: ["contacts"] },
    },
    {
      name: "list_contacts",
      description: "List all contacts",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "remove_contact",
      description: "Remove a contact by ID",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    {
      name: "create_campaign",
      description: "Create a new email campaign",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    {
      name: "add_campaign_step",
      description: "Add a sequence step to a campaign (day offset, subject, body)",
      inputSchema: { type: "object", properties: { campaignId: { type: "string" }, day: { type: "number" }, subject: { type: "string" }, body: { type: "string" } }, required: ["campaignId", "day", "subject", "body"] },
    },
    {
      name: "list_campaigns",
      description: "List all campaigns with their steps",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "schedule_campaign",
      description: "Assign contacts to a campaign and schedule it (like Instantly)",
      inputSchema: { type: "object", properties: { campaignId: { type: "string" }, contactIds: { type: "array", items: { type: "string" } }, startAt: { type: "string" } }, required: ["campaignId", "contactIds"] },
    },
    {
      name: "list_schedules",
      description: "List all scheduled campaign runs",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "add_contact": {
      const input = AddContactSchema.parse(args);
      const contact = await addContact(input);
      return { content: [{ type: "text", text: JSON.stringify(contact) }] };
    }
    case "add_contacts": {
      const input = AddContactsSchema.parse(args);
      const contacts = await addContacts(input);
      return { content: [{ type: "text", text: `Added ${contacts.length} contacts` }] };
    }
    case "list_contacts": {
      const contacts = await listContacts();
      return { content: [{ type: "text", text: JSON.stringify(contacts, null, 2) }] };
    }
    case "remove_contact": {
      const { id } = RemoveContactSchema.parse(args);
      const removed = await removeContact(id);
      return { content: [{ type: "text", text: removed ? `Removed ${id}` : "Not found" }] };
    }
    case "create_campaign": {
      const { name } = CreateCampaignSchema.parse(args);
      const campaign = await createCampaign(name);
      return { content: [{ type: "text", text: JSON.stringify(campaign) }] };
    }
    case "add_campaign_step": {
      const input = AddStepSchema.parse(args);
      const step = await addStep(input);
      return { content: [{ type: "text", text: JSON.stringify(step) }] };
    }
    case "list_campaigns": {
      const campaigns = await listCampaigns();
      return { content: [{ type: "text", text: JSON.stringify(campaigns, null, 2) }] };
    }
    case "schedule_campaign": {
      const { campaignId, contactIds, startAt } = ScheduleCampaignSchema.parse(args);
      const items = await scheduleCampaign(campaignId, contactIds, startAt);
      return { content: [{ type: "text", text: `Scheduled ${items.length} contacts in campaign` }] };
    }
    case "list_schedules": {
      const schedules = await listSchedules();
      return { content: [{ type: "text", text: JSON.stringify(schedules, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
