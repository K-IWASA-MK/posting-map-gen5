export function formatPostingReport(metrics) {
  return `[POSTING REPORT] Total Households: ${metrics.totalHouseholds}, Estimated Time: ${metrics.requiredHours}h (${metrics.speedPerHour || 250} items/h)`;
}
