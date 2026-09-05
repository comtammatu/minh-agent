import type { CaseCard } from "../domain/case/bus.js";

/** Plain-text Case card for Ink TUI. */
export function formatCaseCardText(card: CaseCard): string {
  const lines = [
    `Case ${card.id}`,
    `${card.coin} ${card.interval} · ${card.action} · conf ${card.confidence.toFixed(2)}`,
    card.summary,
  ];
  if (card.judge?.verdict) lines.push(`Judge: ${card.judge.verdict}`);
  if (card.guardian) lines.push(`Guardian: ${card.guardian.summary}`);
  if (card.executor) lines.push(`Executor: ${card.executor.summary}`);
  if (card.gate !== "none") lines.push(`Gate: ${card.gate}`);
  return lines.join("\n");
}

/** HTML Case card for Telegram Voice. */
export function formatCaseCardHtml(card: CaseCard): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    `<b>Minh Case</b> · ${esc(card.coin)} ${esc(card.interval)}`,
    `<b>${esc(card.action)}</b> · conf ${card.confidence.toFixed(2)}`,
    esc(card.summary),
    card.gate !== "none" ? `Gate: <code>${esc(card.gate)}</code>` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
