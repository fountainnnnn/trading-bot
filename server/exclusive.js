// Runs at most one task at a time. A call made while a task is still running
// is skipped (not queued), so a slow scan can never overlap the next timer
// tick or a manual /api/analyze-all and process the same symbols twice.
export function createExclusiveRunner() {
  let busy = false;
  return async function runExclusive(fn) {
    if (busy) return { skipped: true };
    busy = true;
    try {
      return { skipped: false, value: await fn() };
    } finally {
      busy = false;
    }
  };
}
