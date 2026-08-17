import z from '@deepseek-ai/schemastery'

/** Configuration for the fleet agent provider plugin. */
export interface Config {
  /** Directory where git worktrees are created (default: $DSH_HOME/fleet/worktrees). */
  worktreeBase: string
  /** Root of the git repository to create worktrees from (default: cwd). */
  repoRoot: string
}

export const Config: z<Config> = z.object({
  worktreeBase: z.string().default(`${process.env['DSH_HOME'] ?? process.env['HOME'] ?? '/tmp'}/fleet/worktrees`),
  repoRoot: z.string().default(process.cwd()),
})
