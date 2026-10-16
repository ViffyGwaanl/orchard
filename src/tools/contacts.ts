import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { call } from "../helper/client.js";
import { safe } from "../lib/errors.js";
import { text } from "../lib/format.js";
import { LimitSchema } from "./common.js";

export interface Contact {
  id: string;
  name: string;
  nickname: string | null;
  organization: string | null;
  job_title: string | null;
  phones: { label: string | null; value: string }[];
  emails: { label: string | null; value: string }[];
  birthday?: string;
}

export function contactBlock(c: Contact): string {
  const lines = [`- **${c.name}**${c.nickname ? ` (${c.nickname})` : ""}${c.organization ? ` · ${c.organization}${c.job_title ? `, ${c.job_title}` : ""}` : ""}`];
  for (const p of c.phones) lines.push(`    📞 ${p.value}${p.label ? ` (${p.label})` : ""}`);
  for (const e of c.emails) lines.push(`    ✉️ ${e.value}${e.label ? ` (${e.label})` : ""}`);
  if (c.birthday) lines.push(`    🎂 ${c.birthday}`);
  return lines.join("\n");
}

export async function searchContacts(query: string, limit = 10): Promise<Contact[]> {
  return call<Contact[]>("contacts.search", { query, limit });
}

export function registerContactTools(server: McpServer) {
  server.registerTool(
    "contacts_search",
    {
      title: "Search contacts",
      description: "Look up people in Contacts by name (full or partial, any language), nickname, company, phone number or email. Returns phones, emails and birthdays.",
      inputSchema: z.strictObject({
        query: z.string().min(1).max(200).describe("Name, phone number or email"),
        limit: LimitSchema(10, 100),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ query, limit }) => {
      const found = await searchContacts(query, limit);
      if (!found.length) return text(`No contacts match "${query}".`);
      return text(`# ${found.length} contact${found.length === 1 ? "" : "s"}\n${found.map(contactBlock).join("\n")}`);
    }),
  );
}
