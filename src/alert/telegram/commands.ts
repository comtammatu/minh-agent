/**
 * Thin re-export barrel for split implementation.
 * Keeps bot.ts import "./commands.js" and public API surface unchanged.
 * Real code + registration in ./commands/index.js (split across submodules).
 */
export * from './commands/index.js';