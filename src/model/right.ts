/** What the service lets a group do at a place; which group holds which is the tool's choice. */
export const RIGHTS = ['see', 'speak', 'edit', 'plan', 'decide', 'manage'] as const;

/** One of the fixed rights. */
export type Right = (typeof RIGHTS)[number];
