/** Local kernel fixture. The production atomic checks are exercised separately
 * by backend.test.mo and the checked package upgrade qualification. */
export function deleteDraftFixture(stored: Map<string, Uint8Array>, value: unknown) {
  const request = value as { id: string; expected: Array<{ id: string; value: Uint8Array }> };
  const roots = [`operation:${request.id}`, `ethereum:operation:${request.id}`, `ethereum:step:${request.id}:approval`, `ethereum:step:${request.id}:deposit`];
  for (const id of roots) {
    const saved = stored.get(id), expected = request.expected.find(row => row.id === id)?.value;
    if (saved ? !expected || Buffer.compare(saved, expected) !== 0 : expected) return { err: "Operation changed while dismissing it" };
  }
  for (const id of stored.keys()) if (roots.some(root => id === root || id.startsWith(`history:${root}:`))) stored.delete(id);
  return { ok: request.id };
}
