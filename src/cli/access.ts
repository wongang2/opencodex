import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeOption,
  RuntimeApiError,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx access key [list] [--json]
  ocx access key create [name] [--json]
  ocx access key remove <id> --yes [--json]
  ocx access endpoints [--json]
  ocx access models [--json]
  ocx access test <model> [--protocol <chat|responses|messages>] [--expect <text>] [--json]`;

function completedOutputText(result: unknown, protocol: string): string | null {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  if (protocol === "responses") {
    if (record.status !== "completed") return null;
    const output = Array.isArray(record.output) ? record.output : [];
    const messages = output.filter(item => item && typeof item === "object"
      && (item as Record<string, unknown>).type === "message"
      && (item as Record<string, unknown>).status === "completed") as Array<Record<string, unknown>>;
    if (messages.length !== 1 || !Array.isArray(messages[0]?.content)) return null;
    const content = messages[0].content as Array<Record<string, unknown>>;
    if (content.length !== 1 || content[0]?.type !== "output_text" || typeof content[0]?.text !== "string") return null;
    return content[0].text;
  }
  if (protocol === "messages") {
    const content = Array.isArray(record.content) ? record.content as Array<Record<string, unknown>> : [];
    if (record.stop_reason !== "end_turn" || content.length !== 1
      || content[0]?.type !== "text" || typeof content[0]?.text !== "string") return null;
    return content[0].text;
  }
  const choices = Array.isArray(record.choices) ? record.choices as Array<Record<string, unknown>> : [];
  if (choices.length !== 1 || choices[0]?.finish_reason !== "stop") return null;
  const message = choices[0]?.message;
  return message && typeof message === "object" && typeof (message as Record<string, unknown>).content === "string"
    ? String((message as Record<string, unknown>).content)
    : null;
}

async function key(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const action = (args.shift() ?? "list").toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  if (action === "list") {
    rejectArgs(args, USAGE);
    const result = await runtimeRequest<Record<string, unknown>>("/api/keys", {}, deps);
    const keys = Array.isArray(result.keys) ? result.keys as Array<Record<string, unknown>> : [];
    printData(result, wantsJson, keys.length
      ? keys.map(entry => `${String(entry.id)}  ${String(entry.name)}  ${String(entry.prefix ?? "")}`)
      : ["No API access keys configured."]);
    return;
  }
  if (action === "create") {
    const name = args.shift() ?? "default";
    rejectArgs(args, USAGE);
    const result = await runtimeRequest<Record<string, unknown>>("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name }),
    }, deps);
    // The plaintext key is returned once. Keep text output explicit so callers know to store it.
    printData(result, wantsJson, [
      `Created API key ${String(result.name ?? name)} (${String(result.id ?? "")}).`,
      `Key (shown once): ${String(result.key ?? "")}`,
    ]);
    return;
  }
  if (action === "remove" || action === "delete") {
    const id = args.shift();
    const yes = takeFlag(args, "--yes");
    if (!id) throw new CliUsageError("key id is required", USAGE);
    if (!yes) throw new CliUsageError("remove requires --yes", USAGE);
    rejectArgs(args, USAGE);
    const result = await runtimeRequest("/api/keys", { method: "DELETE", body: JSON.stringify({ id }) }, deps);
    printData(result, wantsJson, [`Removed API key ${id}.`]);
    return;
  }
  throw new CliUsageError(`unknown key command ${action}`, USAGE);
}

async function endpoints(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<Record<string, unknown>>("/api/keys", {}, deps);
  const view = Object.fromEntries(Object.entries(result).filter(([key]) => key.endsWith("Endpoint") || key === "baseUrl" || key === "endpoint"));
  printData(view, wantsJson, Object.entries(view).map(([name, value]) => `${name}: ${String(value)}`));
}

async function models(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<Record<string, unknown>>("/v1/models", {}, deps);
  const rows = Array.isArray(result.data) ? result.data as Array<Record<string, unknown>> : [];
  printData(result, wantsJson, rows.map(row => `${String(row.id)}  ${String(row.owned_by ?? "")}`.trimEnd()));
}

async function testModel(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const model = args.shift();
  const wantsJson = takeFlag(args, "--json");
  const protocol = takeOption(args, "--protocol") ?? "chat";
  const expected = takeOption(args, "--expect");
  if (!model) throw new CliUsageError("model is required", USAGE);
  if (!(["chat", "responses", "messages"] as const).includes(protocol as "chat" | "responses" | "messages")) {
    throw new CliUsageError("--protocol must be chat, responses, or messages", USAGE);
  }
  rejectArgs(args, USAGE);
  const request = protocol === "responses"
    ? { path: "/v1/responses", body: { model, input: "Return exactly OK with no punctuation.", max_output_tokens: 16 } }
    : protocol === "messages"
      ? { path: "/v1/messages", body: { model, messages: [{ role: "user", content: "Return exactly OK with no punctuation." }], max_tokens: 16 } }
      : { path: "/v1/chat/completions", body: { model, messages: [{ role: "user", content: "Return exactly OK with no punctuation." }], max_tokens: 16, stream: false } };
  const result = await runtimeRequest(request.path, { method: "POST", body: JSON.stringify(request.body) }, deps);
  if (expected !== undefined && completedOutputText(result, protocol) !== expected) {
    throw new RuntimeApiError("Model response did not match the expected marker.", 502, null);
  }
  printData(result, wantsJson, [`${model}: ${protocol} request succeeded.`]);
}

export async function handleAccessCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "key", ...rest] = argv;
    if (sub === "key" || sub === "keys") await key(rest, deps);
    else if (sub === "endpoints") await endpoints(rest, deps);
    else if (sub === "models") await models(rest, deps);
    else if (sub === "test") await testModel(rest, deps);
    else throw new CliUsageError(`unknown access command ${sub}`, USAGE);
  });
}

export const ACCESS_USAGE = USAGE;
