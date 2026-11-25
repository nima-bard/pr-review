# Changelog

## Unreleased

### Review with Claude, or another agent

- **Review with Claude** on a pull request runs your code review in a Claude Code session in the pull request's worktree. Its findings go into your review as drafts on the lines, marked "from Claude", not on GitHub: edit or delete them like your own, and Submit review sends them with yours. A draft you edit becomes yours, and agents can't change it any more.
- **Ask about a line**: the comment editor has **Comment | Ask Claude** (or start with `/ask` or `/claude`). The question goes to Claude with the lines and the comments on them; the line gets a marker that opens the answer in the Agent panel, and a comment it writes goes into your review there. The marker's × removes it for good.
- Drafts show as they'll read on GitHub: Markdown, with ```` ```suggestion```` blocks as a suggested change (the current lines and their replacement).
- **One conversation per pull request**, in the **Agent panel** (⇧⌘A, or the Agent button): reviews, line questions and requests you type there, with what the agent did, its answer, the comments it added and what it cost; Stop ends one. **Open in Claude Desktop** opens the same session every time, named “PR #12 · title”. If you delete that session in Claude Desktop, the next request (or Open in Claude Desktop) starts a new one with a recap of what was asked and answered, so Claude keeps the context.
- **Ask while Claude is still answering**: a new request runs beside the one in progress, as a side branch of the conversation that knows everything said so far, so you don’t wait. Settings › Agents › **Requests at once** sets how many run per pull request (3 unless you change it).
- **Not only Claude**: Settings › Agents lists the agents the app can ask: Claude Code in the app, Claude Code live in your terminal (channels, a research preview), or any command line such as Codex or Gemini CLI. The first one is the default; the Agent panel switches one pull request to another.
- **Ask Claude to do things in the app**: “mark all the Kusto files as viewed”, “show me where the new script is added”, “find where `retryPolicy` is used”. Claude ticks the Viewed checkboxes, opens the file at the line, a review thread or a draft, or opens Find in files with the search, and says what it did.
- **An MCP server** in the app (127.0.0.1, with a token) lets any MCP client read the pull requests open in PR Review, add, change or delete its own draft comments, search the code, mark files as viewed and show things in the app. **Connect Claude Code** registers it for Claude Code and Claude Desktop's Code tab; **Copy settings** gives the configuration for other clients. Agents can't post, resolve or merge anything on GitHub.

### Fixes

- Going to a comment or line in a file you’d marked as viewed showed the folded file; it now unfolds it.

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
