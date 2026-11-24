import { rangeTouchCommits, RANGE_DRAG_MIN_PX } from './src/lib/rangeGesture.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}  ${extra}`); } };

console.log('rangeTouchCommits (scroll-safe sliders):');
ok('horizontal drag commits', rangeTouchCommits(40, 5));
ok('vertical scroll swipe does not commit', !rangeTouchCommits(6, 120));
ok('diagonal-but-mostly-vertical swipe does not commit', !rangeTouchCommits(30, 60));
ok('tap (no movement) does not commit — e.g. tapping to stop a fling', !rangeTouchCommits(0, 0));
ok('tiny jitter does not commit', !rangeTouchCommits(RANGE_DRAG_MIN_PX - 1, 0));
ok('drag at threshold commits', rangeTouchCommits(RANGE_DRAG_MIN_PX, 0));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
