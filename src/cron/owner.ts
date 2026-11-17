/**
 * Who a cron fire's session belongs to (the cron spec, §3.2, §5.2): the
 * principal `cron`, as a board run's belongs to `kanban`. A leaf module that
 * imports nothing, so the registry can refuse to attach a fire's session
 * without a cycle through the scheduler.
 */
export const CRON_OWNER = { openId: 'cron', unionId: null, displayName: 'cron' } as const;

/** A session's `owner_principal` when it is a fire's. */
export const CRON_PRINCIPAL = CRON_OWNER.openId;
