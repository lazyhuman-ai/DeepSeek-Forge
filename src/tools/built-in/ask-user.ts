import type { ExecutableToolDefinition } from "../schemas.js";
import { buildTool } from "../schemas.js";

async function handler(args: Record<string, unknown>): Promise<unknown> {
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (!question) {
    return {
      output: "Error: question is required",
      isError: true,
    };
  }
  return question;
}

export const askUserTool: ExecutableToolDefinition = buildTool({
  name: "ask_user",
  description: `Ask the user a question and pause this session until they reply.

Use this when you cannot safely continue without user input. The question will be sent as the assistant message and the session will enter waiting_user.`,
  params: {
    question: {
      type: "string",
      description: "The question to ask the user",
    },
  },
  handler,
  isConcurrencySafe: false,
  isReadOnly: false,
  capabilities: ["user.prompt"],
  maxResultSizeChars: Infinity,
});
