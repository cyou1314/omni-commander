# workflows/ — solidified flows live here

The rule: **a flow the brain improvises successfully once gets saved here as a
script. Next time, the script runs — nobody improvises twice.**

## What goes in

- ego batch scripts (one `ego-browser nodejs` heredoc per flow)
- shell scripts for local file / terminal flows
- Playwright flows that must be reproducible
- cross-layer runbooks (`.md`): flows the brain executes across layers,
  written as exact step lists with a verification check at every hand-off

## File conventions

- Name: `NN-short-name.sh` or `NN-short-name.js`, numbered in the order added
  (e.g. `01-download-and-file.js`).
- Header comment in every file, four lines:
  - what it does, in one sentence
  - which layer(s) it uses
  - what it expects to exist beforehand (logins, folders, files)
  - what its verified end state is (how a runner knows it worked)
- No credentials, tokens, or cookies in scripts. Ever. Scripts use sessions
  that already exist (ego) or files that already exist locally.

## When a script breaks

Fix the script, not around it. A flow that only works when the brain
improvises is not solidified yet.
