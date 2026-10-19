// Structure only: task binding, evidence content, approval and substantive
// rejection are deliberately caller policies.
export function coversCriteria(
  criteria: readonly { readonly id: string }[],
  entries: readonly { readonly id: string }[],
): boolean {
  return (
    entries.length === criteria.length &&
    new Set(entries.map((entry) => entry.id)).size === entries.length &&
    criteria.every((criterion) =>
      entries.some((entry) => entry.id === criterion.id),
    )
  );
}
