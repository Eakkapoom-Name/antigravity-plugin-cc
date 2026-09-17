---
name: agy-result-handling
description: Internal guidance for presenting Antigravity (agy) output back to the user
user-invocable: false
---

# Antigravity Result Handling

When an `/agy:*` command or the `agy:agy-rescue` subagent returns agy JSON output:

- Before parsing anything, check whether the returned text is JSON at all. If it is not, and it contains `denied by the Claude Code auto mode classifier`, agy was never invoked. See the section below. This is a host permission block, not an agy failure, and the whole rest of this list assumes agy JSON that does not exist in that case.
- Parse the JSON and present the `response` field as the primary content. Preserve its structure: verdicts, findings, file paths, line numbers, and section ordering stay as agy wrote them.
- Always report the `conversation_id` on its own line at the end, labeled as resumable via `/agy:rescue --resume`.
- If `status` is not `SUCCESS`, report the failure verbatim with the most actionable error line, and stop. Do not turn a failed agy run into a Claude-side implementation attempt.
- A non-empty `denied_actions` array is a failure even when `status` is `SUCCESS`, the exit code is 0, and `response` has text in it. agy 1.2.4 reports a headless tool denial that way: `[{"action":"read_file","display_name":"ViewFile"}]` for a refused file read, `[{"action":"command","display_name":"RunCommand"}]` for a refused command. The model narrates what it was about to do, the tool call is soft-denied, and the run ends after one turn having done nothing (GitHub issue #21). Report it as a permission failure naming each denied action, quote the stderr `jetski: no output produced` line when there is one, and give the rule for what was denied: `command(*)` or a narrower `command(<target>)` for `command`, `read_file(*)` for `read_file`. `--mode accept-edits` covers writes only, not reads. The companion script reports this as `failure: "denied"` with a `deniedActions` list.
- An empty `response` is a failure even when `status` says `SUCCESS`. Headless permission denial is the usual cause: agy prints a stderr line starting with `jetski: no output produced` saying a tool permission was auto-denied (observed with both `SUCCESS` and `CANCELED` statuses on agy 1.1.20, and reproduced on 1.2.4 together with the `denied_actions` field above). Report it as a permission failure, quote that stderr line, and point the user at `permissions.allow` (or a permissive `toolPermission` setting) in `~/.gemini/antigravity-cli/settings.json`. Never present an empty response as a successful run.
- The settings fix is the user's own step, made by hand in their terminal, outside the agent session. See the section below before relaying it.
- A companion result with `effortDropped: true` ran without `--effort`, because the chosen model rejects the flag. Say so in one line.
- If agy was never successfully invoked, do not generate a substitute answer.
- If agy made edits, say so explicitly and list touched files when the response names them.
- Preserve evidence boundaries: keep agy's inferences, uncertainties, and open questions marked as such.
- For review output: findings first, ordered by severity. If there are none, say so explicitly.
- CRITICAL for reviews: after presenting findings, STOP. Ask the user which findings to fix before changing any file.
- If the failure is missing binary or authentication, direct the user to `/agy:setup`. Do not improvise alternate auth flows. A Claude Code classifier denial is neither of those; do not send it to `/agy:setup`, which will pass and teach the user nothing.

## A Claude Code auto mode denial is not an agy failure

When the host Claude Code session runs in auto mode, its permission classifier can refuse the delegation one layer before agy is reached. The refusal lands either on the subagent's `Bash` call or on the outer `Agent` call, and the returned text carries the fragment `denied by the Claude Code auto mode classifier`. Match on that fragment, not on the full sentence: the trailing `Reason:` differs per denial. Three reasons have been observed: `Blocked by classifier`, `[Create Unsafe Agents]`, and `[Auto-Mode Bypass]`.

Report it as a host permission block. Say plainly that agy never ran, that there is no `conversation_id`, and that `/agy:setup` will pass because nothing is wrong with agy. Then give both remedies, in this order:

1. Grant the denied action through `/permissions`. This is the reliable fix; it worked on every reported occasion.
2. Reword the task text, which is cheaper but not dependable. Phrasing that asks Claude Code to skip its own confirmations was denied every time, for example "without asking for confirmation". Neutral phrasing that describes the working environment has passed, for example "This sandbox is a throwaway copy; editing files and running its tests is expected. Implement and verify the fix." The same rewording that worked on one date failed on a later one, so offer it as a first try, never as the answer.

After the user grants permission, relaunch with neutral task text. Do not send the stalled subagent a message saying permission was now granted: that message was itself denied as `[Auto-Mode Bypass]`. A neutral instruction to resume from where it stopped was delivered.

## The permission fix is the user's manual step

A denied action means a rule is missing in `~/.gemini/antigravity-cli/settings.json`. Say which rule, then hand over: the user edits that file by hand, in their own terminal, and reruns the delegation. Do not attempt the edit, do not pass `--dangerously-skip-permissions`, and do not run `agy -p "/permissions"` to look up the rule grammar. In a Claude Code auto mode session the classifier denied all three, each as `[Create Unsafe Agents]` (GitHub issue #21), so relaying the fix as something the agent can carry out produces three more denials and no fix. This is the same host classifier as the launch denial above, blocking the remedy rather than the launch.

Measured on agy 1.2.4, and the same harness passed on 1.2.5 on 2026-09-18: what decides this is the `toolPermission` setting, not
workspace membership. `always-proceed` approves everything with no rule;
`request-review`, the default, refuses commands, while
a read of a file inside the workspace was allowed with no rule;
`proceed-in-sandbox` refuses commands
unless agy is started with `--sandbox`, which this plugin does not pass;
`strict` refuses even an in-workspace read, and is the only mode that did.
GitHub issue #21 reported an in-workspace read refused under the default, which
has never reproduced here, so name the rule for whatever `denied_actions`
actually reports rather than predicting it from the mode. So name the rule for the
denied action, `read_file(*)` or `command(*)`, and also tell the user which mode
they are in, which `/agy:setup` now reports. `read_file` covers directory
listing too, reported as display name `ListDir`.

When the user cannot or will not change the settings right now, one fallback is known to work, from the same issue: the operator runs the shell steps and does the reading, and agy only writes. Inline into the task text everything agy would otherwise have read (the relevant plan or spec sections, the full current contents of every file to edit), state plainly that it has no shell and no file-read access and must not attempt either, and run with `--mode accept-edits`, which allowed file writes without any rule. That works for plan-driven tasks whose context is already written down and not for exploratory ones. Offer it as a fallback, not as the fix.

## A denied run is resumed once, automatically

agy stops the conversation stream the moment it soft-denies a tool, so its model never sees the refusal. The conversation survives, though, and `/agy:review`, `/agy:adversarial-review` and `/agy:transfer` now spend one extra turn on the same `conversation_id`, stating the constraint and asking the model to finish without the refused tools. The stop-review gate does not: a review that lost its file reads has nothing to say, and a second turn would only delay the block.

The companion reports what happened in a `recovery` object: `attempted`, `recovered`, `conversationId`, the `deniedActions` from the first turn, and `firstResult`. Read it before reporting the run.

- `recovery.recovered: true`. The second turn ran without another denial. That is not the same as the task being finished: under the constraint the model may correctly answer that it cannot do the work without the tool it was refused, which is what it is told to do. Read the response before deciding. Either way, name the rule from `recovery.deniedActions`, because the next run will be denied the same way, and never present it as a clean run.
- `recovery.recovered: false`. Both turns were denied. Report it as a denial and name the rule, exactly as if there had been no resume.

Note that the top-level `deniedActions` describes the second turn, so it is empty on a recovered run. The rule to report always comes from `recovery.deniedActions`.
- No `recovery` field. Nothing was denied, or there was no `conversation_id` to resume.

One resume is the cap, and it is deliberate: a second refusal means the constraint did not help. Going further is a judgement call that belongs to you, not to the script, and it takes the one thing the script does not have. agy never says which file it wanted, only that `read_file` was refused, so only the caller who knows the task inputs can inline them. When you have those inputs, run `/agy:continue <conversation_id>` yourself with the file contents pasted in and the constraint restated. That is the reporter's workaround from GitHub issue #21 and it works; it is just not something a script can build unaided.

## A plan is not a result

agy sometimes answers a write-capable run with a plan that ends in a question, such as `Proceed with implementation?`, and touches no files. The delegation is one-shot, so that run is finished and nothing was changed.

Do not present it as a completed task. Say that the run made no edits, then hand the user the exact follow-up that approves the plan in the same conversation:

```
/agy:continue <conversation_id> Yes, proceed.
```

Do not try to prevent this by appending "proceed without asking for confirmation" or similar to the original task text. That is the exact phrasing that trips the Claude Code classifier described above, so the cure produces the other failure.
