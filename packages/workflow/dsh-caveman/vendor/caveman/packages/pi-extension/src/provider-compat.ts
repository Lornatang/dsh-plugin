import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AnthropicMessagesCompat, OpenAICompletionsCompat, OpenAIResponsesCompat } from "@earendil-works/pi-ai";

type SelectedModel = NonNullable<ExtensionContext["model"]>;

// Endpoint policy compares whole host names, never substrings of the URL: a
// hostile host such as api.openai.com.evil.test must not match api.openai.com.
const hostName = (url: string | undefined): string => {
  if (!url) return "";
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
};
// onDomain matches the domain itself and its subdomains only. The leading dot
// in the suffix check keeps notexample.com from matching example.com.
const onDomain = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

// Pi's coding-agent layer adds these after auth resolution, outside model.compat.
// Canonical provider IDs keep their original attribution branch after routing.
// For aliases, an explicit later header or an identical model header can make
// the result independent of the active (private) telemetry setting. Require the
// original spelling: Pi merges these objects case-sensitively before the SDK.
export function unpreservedAttributionHeaders(
  model: SelectedModel, resolvedHeaders: Record<string, string | null> | undefined,
  sessionId: string | undefined, telemetryEnv = process.env.PI_TELEMETRY,
): string[] {
  let host: string | undefined;
  try { host = new URL(model.baseUrl).hostname; } catch { /* endpoint gate reports invalid URLs */ }
  const expected: Record<string, string | undefined> = {};
  const telemetryDisabled = telemetryEnv !== undefined && !["1", "true", "yes"].includes(telemetryEnv.toLowerCase());
  if (!telemetryDisabled) {
    if (model.provider !== "openrouter" && onDomain(host ?? "", "openrouter.ai")) {
      Object.assign(expected, { "HTTP-Referer": "https://pi.dev", "X-OpenRouter-Title": "pi", "X-OpenRouter-Categories": "cli-agent" });
    }
    if (model.provider !== "nvidia" && host === "integrate.api.nvidia.com") expected["X-BILLING-INVOKE-ORIGIN"] = "Pi";
    if (!["cloudflare-workers-ai", "cloudflare-ai-gateway"].includes(model.provider)
      && ["api.cloudflare.com", "gateway.ai.cloudflare.com"].includes(host ?? "")) expected["User-Agent"] = "pi-coding-agent";
  }
  if (!["opencode", "opencode-go"].includes(model.provider) && host === "opencode.ai") {
    expected["x-opencode-session"] = sessionId;
    expected["x-opencode-client"] = "pi";
  }
  return Object.entries(expected).filter(([name, value]) => {
    if (resolvedHeaders && Object.hasOwn(resolvedHeaders, name)) return false;
    return value === undefined || model.headers?.[name] !== value;
  }).map(([name]) => name).sort();
}

// Freeze only URL-dependent defaults before replacing the endpoint. Pi's
// public compat overrides take precedence over detection (nullish values do
// not override defaults). Provider/id-based behavior keeps its original input.
// Oracle: Pi 1.0.0's pi-ai 1.0.0, api/openai-completions.ts detectCompat/getCompat,
// api/openai-responses.ts detectSessionAffinityFormat and
// api/anthropic-messages.ts getAnthropicCompat. Real SDK payload tests cover
// this boundary so dependency updates cannot silently change semantics.
// 1.0.0 changes carried here: OpenRouter hosts send session-affinity headers by
// default on Chat and Anthropic; Chat strict mode is a constant false (so it is
// no longer frozen). Its ChatGPT sign-in heuristic (openai + api.openai.com +
// non-`sk-` key) is URL-derived too, but that credential is OAuth and the
// router already keeps OAuth models direct.
export function compatForRoutedModel(model: SelectedModel): SelectedModel["compat"] {
  const provider = model.provider;
  const url = model.baseUrl;
  const host = hostName(url);
  const openRouter = provider === "openrouter" || onDomain(host, "openrouter.ai");
  if (model.api === "openai-responses") {
    const explicit = model.compat as OpenAIResponsesCompat | undefined;
    return { ...explicit, sessionAffinityFormat: explicit?.sessionAffinityFormat ?? (openRouter ? "openrouter" : "openai") };
  }
  if (model.api === "anthropic-messages") {
    if (!openRouter) return model.compat;
    const explicit = model.compat as AnthropicMessagesCompat | undefined;
    return {
      ...explicit,
      sendSessionAffinityHeaders: explicit?.sendSessionAffinityHeaders ?? true,
      sessionAffinityFormat: explicit?.sessionAffinityFormat ?? "openrouter",
    };
  }
  if (model.api !== "openai-completions") return model.compat;

  const explicit = model.compat as OpenAICompletionsCompat | undefined;
  const zai = provider === "zai" || provider === "zai-coding-cn" || onDomain(host, "api.z.ai") || onDomain(host, "open.bigmodel.cn");
  const together = provider === "together" || onDomain(host, "api.together.ai") || onDomain(host, "api.together.xyz");
  const moonshot = provider === "moonshotai" || provider === "moonshotai-cn" || onDomain(host, "api.moonshot.ai") || onDomain(host, "api.moonshot.cn");
  const cloudflareWorkers = provider === "cloudflare-workers-ai" || onDomain(host, "api.cloudflare.com");
  const cloudflareGateway = provider === "cloudflare-ai-gateway" || onDomain(host, "gateway.ai.cloudflare.com");
  const nvidia = provider === "nvidia" || onDomain(host, "integrate.api.nvidia.com");
  const antLing = provider === "ant-ling" || onDomain(host, "api.ant-ling.com");
  const grok = provider === "xai" || onDomain(host, "api.x.ai");
  const deepseek = provider === "deepseek" || onDomain(host, "deepseek.com");
  const nonStandard = nvidia || provider === "cerebras" || onDomain(host, "cerebras.ai") || grok || together
    || onDomain(host, "chutes.ai") || deepseek || zai || moonshot
    || provider === "opencode" || onDomain(host, "opencode.ai") || cloudflareWorkers || cloudflareGateway || antLing;
  const maxTokens = onDomain(host, "chutes.ai") || deepseek || moonshot || cloudflareGateway || together || nvidia || antLing || zai;
  const openRouterDeveloper = openRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
  return {
    ...explicit,
    supportsStore: explicit?.supportsStore ?? !nonStandard,
    supportsDeveloperRole: explicit?.supportsDeveloperRole ?? (openRouterDeveloper || (!nonStandard && !openRouter)),
    supportsReasoningEffort: explicit?.supportsReasoningEffort ?? !(grok || zai || moonshot || together || cloudflareGateway || nvidia || antLing),
    maxTokensField: explicit?.maxTokensField ?? (maxTokens ? "max_tokens" : "max_completion_tokens"),
    requiresReasoningContentOnAssistantMessages: explicit?.requiresReasoningContentOnAssistantMessages ?? deepseek,
    thinkingFormat: explicit?.thinkingFormat ?? (deepseek ? "deepseek" : zai ? "zai" : together ? "together" : antLing ? "ant-ling" : openRouter ? "openrouter" : "openai"),
    sendSessionAffinityHeaders: explicit?.sendSessionAffinityHeaders ?? openRouter,
    sessionAffinityFormat: explicit?.sessionAffinityFormat ?? (openRouter ? "openrouter" : "openai"),
    supportsLongCacheRetention: explicit?.supportsLongCacheRetention ?? !(together || cloudflareWorkers || cloudflareGateway || nvidia || antLing),
  };
}
