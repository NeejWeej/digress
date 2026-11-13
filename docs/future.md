# Future directions

Ideas that aren't built yet, written down so they aren't lost. What's already built is in [done.md](done.md).

## Loose ends

- **Document tools:** a `view_area` tool (a sharp crop of part of a page) if small chart text turns out to
  be misread.
- **Prompt cache on the ChatGPT plan route** is best-effort: measured hit rates from 0 to 5 of 8 identical
  requests with the same prompt_cache_key, with or without tools. Nothing more to set on our side
  (prompt_cache_retention isn't accepted there); recheck if OpenAI documents more.
- **Web articles:** a bookmarklet or small browser extension that sends the article from the tab you're
  reading, for pages the server can't fetch (logins, paywalls you pay for).
- **Images in Markdown:** pasted or uploaded Markdown with image links still loads those images straight
  from their sites; it could get the same placeholders as web articles. The same goes for images in model replies, which is
  also a way a prompt-injected model could send conversation text to a site (in an image URL).
- **Split and join in the UI:** `ThreadOps.split` ("make the rest of this thread a branch") and `join`
  exist and are tested, but only "Use this version" uses them. Joining a side question into its parent
  would also need a way to keep its prefix (what the passage was) in the text.
- **Rewind:** delete a message and everything after it in a thread, with a confirmation listing what goes.

## Sub-agents that explore

An `explore(task)` tool: Digress starts a separate model run with the same read-only tools and a fresh
context; it reads as much as it needs and reports back, and only the report enters your thread.

- **Why:** when answering means reading far more than should sit in the conversation (every question
  resends the whole thread, so 50 pages of tool output make every later question bigger), or when a
  question spans many separate parts.
- **In parallel:** several explorers each take a part ("how do these three sections disagree?").
- **A conversation, not a handoff:** the main model can answer the report ("you skipped the appendix;
  check whether the numbers there agree") and the explorer continues with its own context, instead of
  starting over.
- **Explorers talking to each other:** e.g. one explorer per section, asked to reconcile their findings
  before reporting.
- **Keeping it honest:** a report is a summary the main model can't see behind, which is the same
  silent-missing-context risk as cutting a document down. So: every claim cites its page (or file and
  line), reports say what was searched and *not* found, the main model can check claims with
  `read_pages`, and each explorer's trail shows under the reply, folded.
- **In Digress's own terms:** an explorer's run, and any back-and-forth with it, could itself be a branch,
  visible on the tree and canvas like any other thread.

## A codebase (or a folder of documents) as the source

The same tools over a codebase or a set of documents: open a repository, ask about it, branch from a
function or a passage, and let explorers read across files. The branching tree and canvas then become a
map of everything you've worked out about it, in one place.

- **Access stays explicit:** the tools read only folders you attach, read-only, never anything else on the
  machine, in the spirit of the opt-in web toggle and "no other tools".
- **UI:** code views with line anchors (branch from a line range like from a highlight), file and symbol
  navigation, and a canvas that can lay branches out alongside the structure of the code.
