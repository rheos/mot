// OQ-P4 stub. The retention cron and its (ministry, status) → days rules land in Phase 4.
// In Phase 1 the rule set is empty (all null); the shape is reserved so callers can wire
// against it without a later type change.
export const retentionPolicy = {
  // (ministry, status) → days; all null in Phase 1
  rules: [] as Array<{ ministry: string; status: string; days: number | null }>,
};
