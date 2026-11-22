# site-generator-speed

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: `solve.js` answers every case
exactly as makefun-site does — same output tree, byte for byte — with a
hand-rolled fast Markdown renderer, template engine, slugger and front-matter
parser. `main.ts` is the harness driver: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.
