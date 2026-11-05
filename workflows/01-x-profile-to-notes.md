# Workflow 01 — x-profile-to-notes

- **What it does:** reads the user's own X profile stats with the logged-in
  browser, files them locally, and puts the follower count into a Notes note.
- **Layers, in order:** (1) ego-browser (logged-in browser) →
  (2) Desktop Commander (files) → (3) Cua Driver (desktop, background only).
- **Expects beforehand:** ego running, its daily profile logged in to X as
  the account owner; Desktop Commander allowlist set to the work folder
  (`/Users/<you>/commander-work` on the first test machine — substitute your
  own); Cua Driver accessibility + screen-recording permissions granted;
  Notes present. No credentials in this file — the ego session already exists.
- **Verified end state:** the `-done` file's four lines equal this run's
  leg-1 readings, and the Notes read-back shows the same follower count.
  Values may differ between runs (counts change); they must agree *within*
  a run.

## Steps

### Leg 1 — ego-browser

1. Create a fresh task Space under the logged-in (daily) profile.
2. Open X and go to the user's own profile page.
3. From the page snapshot, record four values **verbatim**: display name,
   @handle, Following count, Followers count.
4. Close the Space. Never touch daily tabs; no posting, liking, or following.

*Verify:* all four values were actually visible in the snapshot. If the
profile page does not show them, stop and report — do not guess.

*Hand-off:* the four values, verbatim.

### Leg 2 — Desktop Commander

1. In the work folder, write `step6-x-profile.txt` with four labelled lines:
   `显示名：<display name>` / `用户名：<@handle>` / `关注：<following>` /
   `粉丝：<followers>` (labels as used on the first test machine).
2. Read the file back and compare against the leg-1 values.
3. Rename it to `step6-x-profile-done.txt`. If a file of that name exists
   from an earlier run of this workflow, replace it — it is this workflow's
   own artefact.
4. Read the renamed file back once more.

*Verify:* the post-rename read-back equals the leg-1 values, line for line.

*Hand-off:* the follower count, verbatim.

### Leg 3 — Cua Driver (background only)

1. Open Notes without bringing it to the foreground.
2. Create a new note: title `omni step6`, body one line `粉丝数是 <followers>`.
   A same-titled note from an earlier run may coexist — that is fine.
3. Read the note's title and body back from the accessibility tree.

*Verify:* the read-back title and body match what was written.

## Rules in force

The standing router rules apply throughout: verify every step before the
next, the hand-off list stays in force, and if one layer fails twice, stop
and report instead of switching layers to improvise.
