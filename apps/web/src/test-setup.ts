import { configure } from '@testing-library/dom';

// testing-library's default `waitFor`/`findBy*` timeout is 1 s. On the GitHub runner, with the
// whole suite in parallel workers, a screen that renders in ~50 ms here takes longer than that
// often enough to fail a run (BoardColumnsSettings "renames on blur" timed out on main once).
// 5 s changes nothing for a passing test — waitFor resolves as soon as the assertion holds —
// and only stops a slow worker from being read as a bug.
//
// It must stay below vitest's `testTimeout` (vite.config.ts, 15 s): a test has room for a slow
// wait and still fails with testing-library's own message. A test that needs several waits in a
// row is a test with several actions: split it (one action, one wait), do not raise this.
configure({ asyncUtilTimeout: 5_000 });

// Tests run in pt-BR, the source language, so they query the Portuguese text the code holds; the
// browser (or Node's own `navigator`) would otherwise pick English. A test that renders in English
// switches with `i18n.changeLanguage('en')` and switches back.
import { i18n } from './i18n';

void i18n.changeLanguage('pt-BR');
