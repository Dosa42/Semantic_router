import type {
  ChatGptInstructionsConfig,
  EmbeddingInstructionsConfig,
  RagRetrievalMatch,
  RouteDefinition,
  RouteInstructionOverride,
} from './types.ts';

export function normalizeEmbeddingInput(
  rawText: string,
  config: EmbeddingInstructionsConfig
): string {
  let out = rawText.trim();
  if (config.stripExtraWhitespace) {
    out = out.replace(/\s+/g, ' ');
  }
  if (config.lowercaseInput) {
    out = out.toLowerCase();
  }
  if (config.maxChars > 0 && out.length > config.maxChars) {
    out = out.slice(0, config.maxChars).trim();
  }
  return out;
}

export function formatEmbeddingText(
  rawText: string,
  role: 'query' | 'passage',
  config: EmbeddingInstructionsConfig,
  routeOverride?: RouteInstructionOverride
): string {
  const cleaned = normalizeEmbeddingInput(rawText, config);
  const template =
    role === 'query'
      ? config.queryTemplate || 'query: {text}'
      : config.passageTemplate || 'passage: {text}';

  const instructionText = config.taskInstruction.trim()
    ? `${config.taskInstruction.trim()} `
    : '';
  const contextText = routeOverride?.embeddingContextPrefix?.trim()
    ? `${routeOverride.embeddingContextPrefix.trim()} `
    : '';

  let rendered = template
    .replace(/\{instruction\}/g, instructionText)
    .replace(/\{context\}/g, contextText)
    .replace(/\{text\}/g, cleaned);

  // If template did not include {instruction} or {context}, prepend non-empty pieces cleanly
  if (instructionText && !template.includes('{instruction}') && role === 'query') {
    rendered = `${instructionText}${rendered}`;
  }
  if (contextText && !template.includes('{context}')) {
    rendered = `${contextText}${rendered}`;
  }

  return rendered.trim();
}

export function resolveChatGptSystemPrompt(
  config: ChatGptInstructionsConfig,
  opts?: {
    route?: RouteDefinition | null;
    ragMatches?: RagRetrievalMatch[];
  }
): string {
  const override = opts?.route?.instructionOverrides?.chatgptSystemInstruction?.trim();
  const basePrompt = override || config.responseSystemPrompt.trim();

  const parts: string[] = [basePrompt];

  if (opts?.route) {
    parts.push(
      `Matched Semantic Route: "${opts.route.name}" (${opts.route.routeType}).`
    );
  }

  if (config.conciseMode) {
    parts.push('Keep the response concise, structured, and directly actionable.');
  }

  const matches = opts?.ragMatches ?? [];
  if (matches.length > 0) {
    const ragLines = matches
      .map(
        (m, idx) =>
          `[${idx + 1}] (${m.connectorName} · score ${m.score.toFixed(3)} · ${m.sourceUrl})\n${m.text}`
      )
      .join('\n\n');
    const ragTemplate =
      config.ragContextTemplate.trim() ||
      'Grounding context retrieved from external RAG connectors:\n{rag_context}';
    const renderedRag = ragTemplate.includes('{rag_context}')
      ? ragTemplate.replace(/\{rag_context\}/g, ragLines)
      : `${ragTemplate}\n${ragLines}`;
    parts.push(renderedRag);

    if (config.enforceCitations) {
      parts.push(
        'Ground factual claims in the retrieved RAG context above and cite source numbers like [1], [2] when used.'
      );
    }
  }

  return parts.filter(Boolean).join('\n\n');
}
