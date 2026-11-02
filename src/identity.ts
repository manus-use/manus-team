/**
 * The product's name, as it identifies itself to the platforms and agents it
 * talks to.
 *
 * Deliberately *not* the name of anything on disk or in the environment: the
 * `PGW_*` variables, `PGW_HOME` and the `~/.prime-gateway` default home keep
 * their names, because a running deployment's configuration, database and
 * secrets live under them. See docs/specs/2026-11-02-kanban-design.md §13.
 */
export const PRODUCT_NAME = 'manus-team';
