/**
 * The order a dispatcher pass tries its claimable tasks in (spec §16): a turn
 * for each board in rotation, so a burst of tasks on one board cannot starve
 * another. Within a board, the order the tasks came in -- priority, then age --
 * is kept; across boards, priority does not count, since one board's priorities
 * say nothing about another's.
 *
 * `after` is the board of the pass's last agent claim before: this pass starts
 * with the board after it, by name, wrapping round, so the board that got the
 * last slot does not get the next one too. Pure: the dispatcher remembers
 * `after` itself.
 */
export function fairOrder<T extends { board: string }>(tasks: readonly T[], after?: string): T[] {
  const byBoard = new Map<string, T[]>();
  for (const task of tasks) {
    const queue = byBoard.get(task.board);
    if (queue === undefined) byBoard.set(task.board, [task]);
    else queue.push(task);
  }
  const names = [...byBoard.keys()].sort();
  const start = after === undefined ? 0 : names.findIndex((name) => name > after);
  const turns = start <= 0 ? names : [...names.slice(start), ...names.slice(0, start)];
  const out: T[] = [];
  for (let round = 0; out.length < tasks.length; round += 1) {
    for (const name of turns) {
      const task = byBoard.get(name)?.[round];
      if (task !== undefined) out.push(task);
    }
  }
  return out;
}
