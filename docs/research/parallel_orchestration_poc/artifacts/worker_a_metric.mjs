export function calculatePostingMetrics(totalHouseholds, speedPerHour) {
  const speed = speedPerHour > 0 ? speedPerHour : 250;
  const requiredHours = Math.ceil(totalHouseholds / speed);
  return {
    totalHouseholds,
    speedPerHour: speed,
    requiredHours
  };
}
