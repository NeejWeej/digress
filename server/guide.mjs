// What "Ask about Digress" knows (GET /api/guide): what the app does, then how it's set up, then how it works inside.
// Shared with demo/build.mjs, so the demo's copy of the documentation is the same list.
// The developer notes are AGENTS.md (the overview) and every file in agents/, read whole.
import fs from 'node:fs';
// worked out on each call, so a note added to agents/ shows up without a restart, and a copy without agents/ still runs
const agentNotes = () => { try { return fs.readdirSync(new URL('../agents/', import.meta.url)).filter(f => f.endsWith('.md')).sort()
  .map(f => ['agents/' + f, 'How it works inside: ' + f.replace(/\.md$/, '')]); } catch { return []; } };
export const guideDocs = () => [['README.md', 'What Digress does (README)'], ['docs/guide.md', 'Feature guide'], ['docs/setup.md', 'Setting it up'], ['docs/remote-access.md', 'Using it from your phone and other devices'],
  ['docs/clipper.md', 'Browser Clipper extension'], ['docs/flashcards.md', 'Flashcards'], ['docs/development.md', 'Developing Digress'], ['AGENTS.md', 'How it works inside (notes for developers)'], ...agentNotes(), ['docs/future.md', 'Ideas that are NOT built yet']];
