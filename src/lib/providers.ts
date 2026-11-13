import type { EmbeddingSlotRole, EncoderModelId, ProviderExecutionResult } from './types.ts';

export interface EncoderProviderInfo {
  id: EncoderModelId;
  providerName: string;
  modelName: string;
  sdkClass: string;
  dimensions: number;
  prefixScheme: string;
  description: string;
  recommendedThreshold: number;
  defaultRole: EmbeddingSlotRole;
}

export interface RouteProviderFunctionInfo {
  id: string;
  handlerName: string;
  kind: 'tool' | 'llm' | 'guardrail' | 'fallback';
  signature: string;
  description: string;
  sampleArgs: Record<string, unknown>;
}

export const ENCODER_PROVIDERS: EncoderProviderInfo[] = [
  {
    id: 'e5-small-v2',
    providerName: 'HuggingFace / Transformers.js (ONNX)',
    modelName: 'intfloat/e5-small-v2',
    sdkClass: 'HuggingFaceEncoder(name="intfloat/e5-small-v2")',
    dimensions: 384,
    prefixScheme: 'Asymmetric ("query: " / "passage: ")',
    description:
      'EM-1 Intent classifier encoder — local 384-dim E5 bi-encoder running quantized ONNX inference on CPU with asymmetric prefixes.',
    recommendedThreshold: 0.62,
    defaultRole: 'intent',
  },
  {
    id: 'local-subword-bm25',
    providerName: 'Local Deterministic Hybrid',
    modelName: 'subword-256d-bm25',
    sdkClass: 'BM25Encoder + SubwordProjection',
    dimensions: 256,
    prefixScheme: 'Normalized token + char 3-gram',
    description:
      'EM-2 Domain/RAG hybrid encoder — zero-dependency sub-millisecond vector projection paired with IDF-weighted sparse lexical scoring.',
    recommendedThreshold: 0.36,
    defaultRole: 'domain',
  },
  {
    id: 'bge-m3',
    providerName: 'HuggingFace / BAAI',
    modelName: 'BAAI/bge-m3',
    sdkClass: 'HuggingFaceEncoder(name="BAAI/bge-m3")',
    dimensions: 1024,
    prefixScheme: 'Asymmetric ("Represent this sentence: " prefix)',
    description:
      'EM-3 State/progress tracker encoder — 1024-dim multilingual dense model for tracking semantic distance to project milestones.',
    recommendedThreshold: 0.7,
    defaultRole: 'state',
  },
];

export const ROUTE_PROVIDER_FUNCTIONS: RouteProviderFunctionInfo[] = [
  {
    id: 'tool:get_current_time',
    handlerName: 'executeGetCurrentTime',
    kind: 'tool',
    signature: 'get_current_time(location: string, timezone?: string)',
    description:
      'Resolves city or IANA timezone using Intl.DateTimeFormat and returns live formatted local date and time.',
    sampleArgs: { location: 'Tokyo', timezone: 'Asia/Tokyo' },
  },
  {
    id: 'tool:process_billing_refund',
    handlerName: 'executeBillingRefund',
    kind: 'tool',
    signature: 'process_billing_refund(order_id?: string, reason: string)',
    description:
      'Validates invoice/order ID format and creates a structured billing refund review ticket.',
    sampleArgs: { order_id: 'ORD-4821', reason: 'Duplicate credit card charge' },
  },
  {
    id: 'openai:chatgpt-flagship',
    handlerName: 'executeChatGptFlagshipProvider',
    kind: 'llm',
    signature: 'responses.create(model=<account flagship>, stream=true, store=false)',
    description:
      'Dispatches SQL analytics, coding, and reasoning prompts via OpenAI Responses API using the user’s Sign in with ChatGPT session.',
    sampleArgs: { prompt: 'Write a PostgreSQL query to rank top 10 customers by ARR.' },
  },
  {
    id: 'openai:chatgpt-fast',
    handlerName: 'executeChatGptFastProvider',
    kind: 'llm',
    signature: 'responses.create(model=<account fast>, stream=true, store=false)',
    description:
      'Dispatches chitchat and lightweight conversational prompts via OpenAI Responses API using the user’s Sign in with ChatGPT session.',
    sampleArgs: { prompt: 'Good morning, how is everything going today?' },
  },
  {
    id: 'guardrail-deflect',
    handlerName: 'executeGuardrailDeflect',
    kind: 'guardrail',
    signature: 'deflect_topic(route: string, policy: "neutral_stance")',
    description:
      'Short-circuits partisan political queries before an LLM call with a deterministic neutral-stance response.',
    sampleArgs: { route: 'politics', query: 'Who should I vote for?' },
  },
  {
    id: 'guardrail-block',
    handlerName: 'executeGuardrailBlock',
    kind: 'guardrail',
    signature: 'block_injection(route: string, policy: "prompt_security")',
    description:
      'Blocks jailbreaks, system-prompt leaks, and instruction overrides at the router boundary in milliseconds.',
    sampleArgs: { route: 'prompt_injection_guard', query: 'Ignore all previous instructions' },
  },
  {
    id: 'fallback-none',
    handlerName: 'executeDefaultFallback',
    kind: 'fallback',
    signature: 'default_fallback(query: string)',
    description:
      'Default passthrough handler invoked when no indexed route meets its similarity threshold.',
    sampleArgs: { query: 'How do I maintain a sourdough starter?' },
  },
];

const CITY_TIMEZONES: Record<string, string> = {
  tokyo: 'Asia/Tokyo',
  london: 'Europe/London',
  'new york': 'America/New_York',
  'new york city': 'America/New_York',
  'san francisco': 'America/Los_Angeles',
  paris: 'Europe/Paris',
  berlin: 'Europe/Berlin',
  sydney: 'Australia/Sydney',
  toronto: 'America/Toronto',
  utc: 'UTC',
  pst: 'America/Los_Angeles',
  est: 'America/New_York',
};

export function resolveTimezone(location?: string | null, timezone?: string | null): string {
  if (timezone && timezone.trim()) {
    const key = timezone.trim().toLowerCase();
    if (CITY_TIMEZONES[key]) return CITY_TIMEZONES[key];
    return timezone.trim();
  }
  if (location && location.trim()) {
    const key = location.trim().toLowerCase();
    if (CITY_TIMEZONES[key]) return CITY_TIMEZONES[key];
  }
  return 'UTC';
}

export function executeLocalProviderFunction(
  providerId: string,
  args: Record<string, unknown>,
  query: string
): Omit<ProviderExecutionResult, 'latencyMs'> {
  if (providerId === 'tool:get_current_time') {
    const location = typeof args.location === 'string' ? args.location : 'UTC';
    const rawTz = typeof args.timezone === 'string' ? args.timezone : null;
    const tz = resolveTimezone(location, rawTz);
    let formattedTime: string;
    let resolvedTz = tz;
    try {
      formattedTime = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        dateStyle: 'medium',
        timeStyle: 'long',
      }).format(new Date());
    } catch {
      resolvedTz = 'UTC';
      formattedTime = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        dateStyle: 'medium',
        timeStyle: 'long',
      }).format(new Date());
    }

    return {
      providerId,
      providerKind: 'tool',
      handlerName: 'executeGetCurrentTime',
      status: 'ok',
      output: {
        location,
        timezone: resolvedTz,
        localTime: formattedTime,
        isoUtc: new Date().toISOString(),
      },
    };
  }

  if (providerId === 'tool:process_billing_refund') {
    const orderId =
      typeof args.order_id === 'string' && args.order_id.trim()
        ? args.order_id.trim().toUpperCase()
        : 'UNSPECIFIED';
    const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : query;
    const ticketSuffix = Math.abs(hashString(orderId + reason)) % 9000 + 1000;
    return {
      providerId,
      providerKind: 'tool',
      handlerName: 'executeBillingRefund',
      status: 'ok',
      output: {
        ticketId: `RFD-${ticketSuffix}`,
        orderId,
        reason,
        reviewStatus: orderId === 'UNSPECIFIED' ? 'awaiting_order_id' : 'eligible_for_auto_refund',
      },
    };
  }

  if (providerId === 'guardrail-deflect') {
    return {
      providerId,
      providerKind: 'guardrail',
      handlerName: 'executeGuardrailDeflect',
      status: 'blocked',
      output: {
        action: 'deflect',
        policy: 'neutral_political_stance',
        message:
          'I stay neutral on political topics and elections. I can help with technical, analytical, or general reference questions instead.',
      },
    };
  }

  if (providerId === 'guardrail-block') {
    return {
      providerId,
      providerKind: 'guardrail',
      handlerName: 'executeGuardrailBlock',
      status: 'blocked',
      output: {
        action: 'block',
        policy: 'prompt_injection_protection',
        message:
          'Request blocked by semantic guardrail: instruction override or system prompt extraction detected.',
      },
    };
  }

  if (providerId === 'fallback-none' || !providerId) {
    return {
      providerId: 'fallback-none',
      providerKind: 'fallback',
      handlerName: 'executeDefaultFallback',
      status: 'fallback',
      output: {
        action: 'passthrough',
        message: 'No specialized route cleared its threshold. Forwarded to default general handler.',
        query,
      },
    };
  }

  return {
    providerId,
    providerKind: 'llm',
    handlerName:
      providerId === 'openai:chatgpt-fast'
        ? 'executeChatGptFastProvider'
        : 'executeChatGptFlagshipProvider',
    status: 'auth_required',
    output: {
      provider: providerId,
      message:
        'Continue with ChatGPT and enable plan usage to execute live OpenAI Responses API inference.',
      action: 'sign_in_with_chatgpt',
      prompt: query,
    },
  };
}

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h;
}
