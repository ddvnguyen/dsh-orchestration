import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Create a git worktree for an isolated child agent workspace.
 * The worktree is created from the repo root on a new unique branch.
 * @param repoRoot - absolute path to the git repository root.
 * @param baseDir - parent directory for worktree storage.
 * @param branch - optional explicit branch name; auto-generated when omitted.
 * @returns the absolute path to the created worktree.
 */
export function createWorktree(repoRoot: string, baseDir: string, branch?: string): string {
  const branchName = branch ?? `fleet-${Date.now()}-${randomUUID().slice(0, 8)}`
  const worktreePath = join(baseDir, branchName)
  execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
    cwd: repoRoot,
    stdio: 'pipe',
  })
  return worktreePath
}

/**
 * Remove a git worktree and its branch.
 * @param repoRoot - absolute path to the git repository root.
 * @param worktreePath - absolute path to the worktree to remove.
 */
export function removeWorktree(repoRoot: string, worktreePath: string): void {
  if (!existsSync(worktreePath)) return
  execSync(`git worktree remove "${worktreePath}" --force`, {
    cwd: repoRoot,
    stdio: 'pipe',
  })
}

/**
 * List active git worktrees under the base directory.
 * @param repoRoot - absolute path to the git repository root.
 * @returns array of worktree absolute paths.
 */
export function listWorktrees(repoRoot: string): string[] {
  const raw = execSync('git worktree list --porcelain', {
    cwd: repoRoot,
    encoding: 'utf-8',
  })
  const worktrees: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      worktrees.push(line.slice('worktree '.length))
    }
  }
  return worktrees
}
