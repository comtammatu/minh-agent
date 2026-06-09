/**
 * Advisor stub (optional foundation).
 * When enabled (ANTHROPIC_API_KEY or OPENAI via Cursor secret + ai-sdk), provides daily/weekly review + suggestions.
 * Safety: never auto-apply; backtest + owner approve required.
 */
export type { AdvisorContext, AdvisorSuggestion } from "./types.js";

// Placeholder client factory (no dep yet to avoid secret requirement).
export function createAdvisorClient() {
  return {
    async suggest(
      _context: import("./types.js").AdvisorContext,
    ): Promise<import("./types.js").AdvisorSuggestion[]> {
      // TODO: wire ai-sdk generateText with structured, rate limit from config, cost track.
      return [];
    },
  };
}

// Wire hook example (call from journal on close):
// import { insertMemory } from '../memory/index.js';
// await insertMemory({ category: 'trade_outcome', coin, ... , content: summary });
