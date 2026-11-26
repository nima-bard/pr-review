# Changelog

## Unreleased

- **Your pull request tabs in the Dock menu:** right-click PR Review's icon in the Dock to switch to any open pull request (the one in front is ticked), or open a new tab. A popped-out pull request's window is named after it, so macOS lists it there and in the Window menu too.
- **Clean up worktrees of merged and closed pull requests**, now including your own worktrees that have the pull request's branch checked out (the branch stays) and ones whose pull request is open in a tab (the tab closes). Clean up removes them all, or remove them one at a time. Worktrees that would lose something are listed too, labelled (Uncommitted changes, Commits on no branch, Locked), with Force remove for the first two.
- A merged or closed pull request shows a **banner offering to remove its worktree** and close the tab.
- The clean-up on the New tab checks again whenever you come back to it or close a pull request's tab.
- **Filters in All pull requests suggest as you type**, like github.com: people with their avatars (and @me) for Author, Reviewers and Assignee, the repository's labels with their colours, and the Review and Sort choices in words. Pick with the mouse or ↑ ↓ and Enter, or press Enter to filter by what you typed.
- **Slate** theme: primary buttons in Hydra's pink.
- Resolving a conversation collapses it, and unresolving one opens it again.
- A file’s sideways scrollbar stays at the bottom of the window while the file is on screen, so you can scroll long lines in the middle of a big file without going to its end first.

### Ask Claude

- **Optional**: Claude is off until you turn it on in Settings › Claude, and runs as your own Claude Code, signed in as you are. Then each pull request gets a **Claude** button: it shows the conversation, and its arrow opens the session in **Claude Desktop** or **Claude Code**.
- **One side panel** in the Files view, in place of the Conversations panel: it shows the review comments, each with a link to its line, or the conversation with Claude. The **Comments** button (⇧⌘C) and the **Claude** button (⇧⌘A) show it with theirs, or hide it.
- **One Claude Code session per pull request, and it is the conversation.** Questions about a line and what you type in the side panel go into it, and it opens in Claude Desktop or Claude Code, named “PR #12 · title”, the same session every time. What you ask there shows in the app too, as it happens. PR Review keeps no copy of the conversation: it reads it from the session, and keeps only which session it is, in the worktree’s git folder (never committed, and removed with the worktree).
- **Ask about a line**: the comment editor has **Comment | Ask Claude** (or start with `/ask` or `/claude`). The question goes to Claude with the lines and the comments on them; the line gets a marker that opens the answer in the conversation, with Go to line and the comments Claude added. Comments Claude writes go into your review as drafts on the lines, marked “from Claude”, not on GitHub: edit or delete them like your own. The marker’s × removes it for good.
- **A conversation like Claude Desktop’s**: your messages on the right, Claude’s answers on the left, each with how long Claude worked (counting up while it answers). You type in a box that grows as you write; **Enter** sends, **Shift+Enter** starts a new line.
- **Ask Claude about a review thread**: every thread has **Ask Claude** at its bottom right. The conversation opens with the thread shown over the box (× removes it), and your question goes with the whole thread and its code. Your message links back to the thread.
- **Model, effort and context** under the box, as in Claude Desktop (“Opus 5.5 Extra ◔”): the model and the effort are separate buttons, and a ring shows how full the conversation’s context is. Each pull request’s conversation can choose its own model and effort, from the models your Claude Code offers and the effort levels each supports. Settings › Claude has the default (Opus 5.5, Fable 5.2 and Haiku 5.5 to choose from when Claude Code’s list can’t be read). A change applies from the next question.
- **Short prompts**: how to work with PR Review is given to Claude once, as part of its system prompt, so each question in the session (and in Claude Desktop) is just what you asked and the lines it’s about. Claude hands wide searches to a subagent and keeps its answers short.
- **Claude offers the next step as buttons**: when an answer leads to one thing Claude could do here (a review comment, marking files as viewed, showing something), it ends with a short question and numbered choices under the answer, as Claude Desktop asks, like **Yes, leave a comment** and **No** (1, 2… choose too). A choice sends its prompt back as your next question, about the same lines; **No** puts the buttons away.
- **Ask while Claude is still answering**: your question waits in the same session and Claude takes it next. Claude stays ready for a minute after its last answer, so the next question is quick.
- **One place answers at a time**: while Claude is answering in Claude Desktop, a question from the app waits and goes as soon as Desktop is done. While Claude Code has the session open in a terminal, the conversation asks: **OK** closes Claude Code there and sends your question (Open in Claude Code picks the session up again), **Cancel** drops it, and a new question replaces it. Desktop shows what was asked in the app when it opens the session again (⌘R in Desktop reloads it).
- **Ask Claude to do things in the app**: “mark all the Kusto files as viewed”, “show me where the new script is added”, “find where `retryPolicy` is used”. Claude ticks the Viewed checkboxes, opens the file at the line, a review thread or a draft, or opens Find in files with the search, and says what it did.
- Drafts show as they’ll read on GitHub: Markdown, with ```` ```suggestion```` blocks as a suggested change (the current lines and their replacement).
- **An MCP server** in the app (127.0.0.1, with a token) lets any MCP client read the pull requests open in PR Review, add, change or delete its own draft comments, search the code, mark files as viewed and show things in the app. **Connect Claude Code** registers it for Claude Code and Claude Desktop’s Code tab; **Copy settings** gives the configuration for other clients. Nothing can post, resolve or merge on GitHub through it.

### Smaller changes

- The pull request lists show each author’s avatar.

### Fixes

- A pull request could stay on “Opening pull request…” until it next changed on GitHub: in a window reopened from the Dock after you closed the last one (#1), when popped out into its own window, or when opened again while it was open in another window.
- Filter menus in All pull requests stayed open when you opened another one or clicked elsewhere.
- In a collapsed conversation the text sat a little higher than the arrow and buttons beside it.
- After you resolved a conversation, “Unresolve conversation” only appeared once the pull request next synced with GitHub.
- Your draft comments showed your initials instead of your GitHub profile picture.
- In a narrow column a draft comment’s header broke “Line 5” over two lines and cut off its labels.
- Dragging over lines (the line numbers, or the “+” as on github.com) only highlighted the lines you’d picked once you let go. They now light up as you drag.
- Going to a comment or line in a file you’d marked as viewed showed the folded file; it now unfolds it.
- Marking several files as viewed stopped at the first one GitHub refused and put all of them back. GitHub’s passing errors are now tried again, and only the files it still refuses stay unmarked.
- On a pull request you wrote, in a big checkout, the app could quit with “too many open files” when watching your edits failed. It now checks for edits every few seconds instead.
- Submit review showed each comment’s raw Markdown, and a long file path ran under the Show button and off the dialog. Comments now read as they will on GitHub, and paths are cut from the left so the file name stays.
- The file tree, folded threads and the Overview’s threads previewed a comment by its first raw line (“### **Severity**…”); they now show its text.
- A suggested change in a posted comment showed as a padded table in a text font, without its indentation. It now reads like the one on drafts: code font, indentation kept, − and + beside the lines.


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
