import { execFileSync } from "node:child_process";

/**
 * Every file the next commit would contain: what git tracks, plus what it would add, less what has
 * been deleted.
 *
 * **Not `git ls-files` alone, which grades the INDEX.** A file created since the last commit was
 * invisible to every arm that reads the file list until it was committed, so a new module passed
 * every gate run before the commit that shipped it unread. A file deleted since the last commit was
 * worse: still listed, it failed those arms with `ENOENT` on a tree that no longer contains it.
 * Ignored files stay out, as they do from a commit.
 */
export function workingTreeFiles(packageRoot: string, ...pathspec: readonly string[]): string[] {
	const git = (...args: readonly string[]): string[] =>
		execFileSync("git", [...args, "--", ...pathspec], {
			cwd: packageRoot,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		})
			.split("\n")
			.filter((line) => line.trim() !== "");
	const deleted = new Set(git("ls-files", "--deleted"));
	return [...new Set(git("ls-files", "--cached", "--others", "--exclude-standard"))]
		.filter((file) => !deleted.has(file))
		.toSorted();
}
