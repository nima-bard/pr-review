# Changelog

## Unreleased

- **Your pull request tabs in the Dock menu:** right-click PR Review's icon in the Dock to switch to any open pull request (the one in front is ticked), or open a new tab. A popped-out pull request's window is named after it, so macOS lists it there and in the Window menu too.
- **Clean up worktrees of merged and closed pull requests**, now including your own worktrees that have the pull request's branch checked out (the branch stays) and ones whose pull request is open in a tab (the tab closes). Clean up removes them all, or remove them one at a time. Worktrees that would lose something are listed too, labelled (Uncommitted changes, Commits on no branch, Locked), with Force remove for the first two.
- A merged or closed pull request shows a **banner offering to remove its worktree** and close the tab.
- The clean-up on the New tab checks again whenever you come back to it or close a pull request's tab.
- **Filters in All pull requests suggest as you type**, like github.com: people with their avatars (and @me) for Author, Reviewers and Assignee, the repository's labels with their colours, and the Review and Sort choices in words. Pick with the mouse or ↑ ↓ and Enter, or press Enter to filter by what you typed.
- **Slate** theme: primary buttons in Hydra's pink.

### Fixes

- A pull request popped out into its own window showed "Opening pull request…" until it next changed on GitHub.
- Filter menus in All pull requests stayed open when you opened another one or clicked elsewhere.

## 0.2.0

### Act on pull requests

- **Merge** from the app, with the same rules as github.com: required checks and reviews, conflicts and an out-of-date branch (with Update branch), the merge methods the repository allows, and the commit title and description GitHub proposes for each, which you can edit. You can delete the branch afterwards, turn on auto-merge, use the merge queue, or bypass the rules where you're allowed to. It only merges the commit you've seen in the app.
- **Request reviews** with a picker like GitHub's: suggestions, everyone with access and teams. Untick someone to withdraw the request.
- **Close and reopen** pull requests (with a comment, if you've typed one), and switch between **draft and ready for review**.

### Quick actions

- Your own commands for a pull request or one of its files, like `claude --model opus "/code-review $PR_NUMBER"` or `npm test`. They run in the pull request's worktree with its details in environment variables (`PR_NUMBER`, `PR_URL`, `PR_WORKTREE`, `PR_FILE`…).
- Run them in a new terminal tab or window (iTerm2, Terminal, Ghostty, WezTerm, kitty or Alacritty, detected), or in the background, with live output, Stop and a notification when they end.
- From the Actions button on the Overview, with ⌥⌘1–9, or from a file's ⋯ menu. Each one can be limited to some repositories.

### Reviewing

- **Find in the current view** (⌘F, ⌘G / ⇧⌘G), with match case, whole word and regular expressions, in both versions of a diff or just the old or new one.
- Search results (⇧⌘F) are highlighted only in the new version of the code, which is what the search looks at.
- A **⋯ menu on files**, also on right-click in the file tree: Show Whole File, Open in Editor, View on GitHub, Reveal in Finder, Copy Path and Copy Full Path. It replaces the "Open file" button.
- **⌘-click** a file in the tree, a diff's file name or a search result to open it in its own tab.

### Faster, clearer

- A pull request shows its **Overview right away** (description, reviewers, checks, conversation) while it's checked out, with placeholders for what's still loading.
- **Settings** has sections (General, Appearance, GitHub, Quick actions, Comments, About) and saves as you change things.
- **Update check:** the app tells you when there's a newer release (or check from the app menu or Settings › About).
- Clearer setup for the browser extension: links to the extensions page in Chrome and Edge, the extension's folder path, and installing by drag and drop.

### Fixes

- Closing a pull request's tab while it was still loading could bring it back, out of date, when opened again.
- After a change on GitHub (a reply, a merge…) the app could show the pull request as it was before, until the next check.
- Dragging the divider next to the file tree could scroll the tree instead.

## 0.1.0

The first release: review GitHub pull requests in your own checkout, with comments that follow the code as it changes.
