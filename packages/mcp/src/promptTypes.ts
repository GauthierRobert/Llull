/** Shapes shared by the MCP prompt templates (mirror the MCP `Prompt` / `PromptMessage` / `GetPromptResult` schemas). */

interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

interface McpPromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface McpPromptDescriptor {
  name: string;
  description: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptResult {
  description: string;
  messages: McpPromptMessage[];
}

export interface PromptTemplate {
  descriptor: McpPromptDescriptor;
  buildMessages: (args: Record<string, string>) => McpPromptMessage[];
}

/** Every template is one user request answered by one assistant plan. */
export function conversation(userText: string, assistantText: string): McpPromptMessage[] {
  return [
    { role: 'user', content: { type: 'text', text: userText } },
    { role: 'assistant', content: { type: 'text', text: assistantText } },
  ];
}
