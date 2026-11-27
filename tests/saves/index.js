// Test entry point for `node --test tests/saves/`.
//
// An explicit directory argument is not expanded into test files by the Node
// test runner: it is handed to Node as a module path (Node 24 verified; the
// runner treats positional arguments as file paths/globs, while the recursive
// default patterns apply only when no arguments are given). The path then
// resolves through the classic `index.js` directory entry. This shim keeps the
// documented command (`node --test tests/saves/`, also used by CI) working: it
// imports every test file so their cases are registered in the one process.
//
// `node --test` (no arguments) discovers the *.test.mjs files directly and does
// not execute this file, so no suite runs twice.
//
// When adding a new *.test.mjs file, import it here too.
import './browser-files.test.mjs';
import './campaign-state.test.mjs';
import './save-files.test.mjs';
