import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
});

const MODEL_ID =
  process.env.BEDROCK_MODEL_ID ||
  "anthropic.claude-3-5-sonnet-20241022-v2:0";

export async function planDay(tasksSummary: string): Promise<string> {
  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: `Here are today's tasks:\n${tasksSummary}\n\nSuggest a realistic, time-blocked plan for the day. Keep it concise.`,
      },
    ],
  });

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body,
  });

  const response = await client.send(command);
  const raw = new TextDecoder().decode(response.body);
  const parsed = JSON.parse(raw);
  return parsed.content?.[0]?.text ?? "No plan generated.";
}