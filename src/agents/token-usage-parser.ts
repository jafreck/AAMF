/**
 * @module agents/token-usage-parser
 *
 * Token usage extraction from agent stdout/stderr output.
 * Supports Claude Code JSON format, Copilot CLI summary format,
 * and generic regex-based extraction.
 */

/**
 * Parse token usage from Claude's JSON-based output format.
 */
export function parseClaudeTokenUsage(
  output: string,
): { input: number; output: number; cachedInput?: number } | undefined {
  const usageRegex = /\{[^{}]*"usage"\s*:\s*\{[^{}]*"input_tokens"\s*:\s*(\d+)[^{}]*"output_tokens"\s*:\s*(\d+)[^{}]*\}/g;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = usageRegex.exec(output)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) return undefined;

  const inputTokens = parseInt(lastMatch[1]!, 10);
  const outputTokens = parseInt(lastMatch[2]!, 10);

  const cacheMatch = lastMatch[0].match(/"cache_read_input_tokens"\s*:\s*(\d+)/);
  const cachedInput = cacheMatch ? parseInt(cacheMatch[1]!, 10) : undefined;

  return { input: inputTokens, output: outputTokens, ...(cachedInput !== undefined && { cachedInput }) };
}

/**
 * Parse a numeric value that may use shorthand suffixes (e.g. `41.3k` → 41300).
 */
function parseShorthandNumber(value: string): number {
  const match = value.trim().match(/^([\d.]+)\s*([kmKM])?$/);
  if (!match) return NaN;
  const num = parseFloat(match[1]!);
  const suffix = match[2]?.toLowerCase();
  if (suffix === 'k') return Math.round(num * 1000);
  if (suffix === 'm') return Math.round(num * 1000000);
  return Math.round(num);
}

/**
 * Parse token usage from Copilot CLI headless usage summary format.
 */
export function parseCopilotCliUsage(
  output: string,
): { input: number; output: number; cachedInput?: number; premiumRequests?: number } | undefined {
  const breakdownMatch = output.match(/Breakdown by AI model:/i);
  if (!breakdownMatch) return undefined;

  const afterBreakdown = output.slice(breakdownMatch.index! + breakdownMatch[0].length);

  const tokenLineRegexLegacy = /tokens_in:\s*([\d.]+[kmKM]?)\s*,\s*tokens_out:\s*([\d.]+[kmKM]?)(?:\s*,\s*tokens_cached:\s*([\d.]+[kmKM]?))?(?:\s*,\s*premium_requests_est:\s*(\d+))?/g;
  const tokenLineRegexCurrent = /([\d.]+[kmKM]?)\s+in\s*,\s*([\d.]+[kmKM]?)\s+out(?:\s*,\s*([\d.]+[kmKM]?)\s+cached)?(?:\s*\(Est\.\s*(\d+)\s+Premium\s+requests?\))?/gi;

  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let hasCached = false;
  let totalPremium = 0;
  let hasPremium = false;
  let foundAny = false;

  const consume = (lineMatch: RegExpExecArray): void => {
    foundAny = true;
    totalInput += parseShorthandNumber(lineMatch[1]!);
    totalOutput += parseShorthandNumber(lineMatch[2]!);
    if (lineMatch[3]) {
      totalCached += parseShorthandNumber(lineMatch[3]!);
      hasCached = true;
    }
    if (lineMatch[4]) {
      totalPremium += parseInt(lineMatch[4]!, 10);
      hasPremium = true;
    }
  };

  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = tokenLineRegexLegacy.exec(afterBreakdown)) !== null) {
    consume(lineMatch);
  }
  while ((lineMatch = tokenLineRegexCurrent.exec(afterBreakdown)) !== null) {
    consume(lineMatch);
  }

  if (!foundAny) return undefined;

  return {
    input: totalInput,
    output: totalOutput,
    ...(hasCached ? { cachedInput: totalCached } : {}),
    ...(hasPremium ? { premiumRequests: totalPremium } : {}),
  };
}

/**
 * Parse token usage from agent stdout/stderr output.
 *
 * Dispatches to the appropriate parser based on `runtime`:
 * - `'claude-code'` → Claude JSON format
 * - `'copilot-cli'` → Copilot CLI summary format
 * - otherwise → generic regex-based extraction
 */
export function parseTokenUsage(
  output: string,
  runtime?: string,
): { input: number; output: number; cachedInput?: number; premiumRequests?: number } | undefined {
  if (runtime === 'claude-code') {
    return parseClaudeTokenUsage(output);
  }
  if (runtime === 'copilot-cli') {
    return parseCopilotCliUsage(output);
  }

  const promptMatch = output.match(/prompt[\s_-]*tokens?:?\s*(\d+)/i);
  const completionMatch = output.match(/completion[\s_-]*tokens?:?\s*(\d+)/i);
  const totalMatch = output.match(/total[\s_-]*tokens?:?\s*(\d+)/i);

  if (promptMatch && completionMatch) {
    const inputTokens = parseInt(promptMatch[1]!, 10);
    const outputTokens = parseInt(completionMatch[1]!, 10);
    return { input: inputTokens, output: outputTokens };
  }

  if (totalMatch) {
    const total = parseInt(totalMatch[1]!, 10);
    return { input: Math.round(total * 0.8), output: total - Math.round(total * 0.8) };
  }

  return undefined;
}
