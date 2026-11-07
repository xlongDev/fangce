import type { GraphRelation } from "@/types/ipc";

/** One entity on the other end of a relation, with how it is connected. */
export interface Neighbor {
  name: string;
  /** How many stored edges connect the centre to this entity. */
  count: number;
  /** One relation phrase, for the chip's tooltip. */
  sample: string;
}

/**
 * The other ends of a set of relations, folded by name.
 *
 * The drawer's relation list is one row per stored edge, so a pair mentioned
 * across five chapters shows up five times. Navigation wants one destination,
 * not five identical rows — and a relation whose other end is the centre
 * itself is not a destination at all.
 *
 * A relation with neither end at `center` is dropped: the backend filters on
 * `subject = center OR object = center`, but a fixture or a stale cached view
 * can carry one, and inventing a neighbour from it would be a wrong jump.
 */
export function neighbors(center: string, relations: readonly GraphRelation[]): Neighbor[] {
  const folded = new Map<string, Neighbor>();
  for (const relation of relations) {
    const other =
      relation.subject === center
        ? relation.object
        : relation.object === center
          ? relation.subject
          : null;
    if (!other || other === center) continue;

    const entry = folded.get(other);
    if (entry) {
      entry.count += 1;
    } else {
      folded.set(other, { name: other, count: 1, sample: relation.relation });
    }
  }
  return [...folded.values()].toSorted(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"),
  );
}
