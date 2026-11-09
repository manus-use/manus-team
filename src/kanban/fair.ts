/**
 * The boards' turns in a dispatcher pass (spec §16.7): a turn for each board in
 * rotation, so a burst of tasks on one board cannot starve another. Within a
 * board, the order the tasks came in -- priority, then age -- is kept; across
 * boards, priority does not count, since one board's priorities say nothing
 * about another's.
 *
 * Each board's claimable tasks, as one queue per board, in the order the boards
 * take their turns. `after` is the board of the last agent claim before: the
 * turns start with the board after it, by name, wrapping round, so the board
 * that got the last slot does not get the next one too. Pure: the dispatcher
 * remembers `after` itself, and decides what ends a board's turn.
 */
export function boardQueues<T extends { board: string }>(tasks: readonly T[], after?: string): T[][] {
  const byBoard = new Map<string, T[]>();
  for (const task of tasks) {
    const queue = byBoard.get(task.board);
    if (queue === undefined) byBoard.set(task.board, [task]);
    else queue.push(task);
  }
  const names = [...byBoard.keys()].sort();
  const start = after === undefined ? 0 : names.findIndex((name) => name > after);
  const turns = start <= 0 ? names : [...names.slice(start), ...names.slice(0, start)];
  return turns.map((name) => byBoard.get(name) ?? []);
}

/**
 * The order a pass tries the tasks in when every claim succeeds: the first task
 * of each board's queue, then the second of each, and so on.
 */
export function fairOrder<T extends { board: string }>(tasks: readonly T[], after?: string): T[] {
  const queues = boardQueues(tasks, after);
  const out: T[] = [];
  for (let round = 0; out.length < tasks.length; round += 1) {
    for (const queue of queues) {
      const task = queue[round];
      if (task !== undefined) out.push(task);
    }
  }
  return out;
}
