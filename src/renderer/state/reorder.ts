/** `items` with the one at `from` moved to sit before the item now at `slot` (0…length; length = the end). */
export function moveToSlot<T>(items: readonly T[], from: number, slot: number): T[] {
  const to = slot > from ? slot - 1 : slot;
  if (from < 0 || from >= items.length || to === from) return [...items];
  const out = [...items];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}
