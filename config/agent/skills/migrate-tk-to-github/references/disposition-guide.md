# Disposition Guide

Use observable evidence. A ticket's age, status, or vague wording is never enough by itself.

## migrate-open

The ticket remains actionable, its acceptance criteria are not met, and it still matches current repository direction. It will become an open GitHub issue.

## migrate-closed

The ticket is closed and retains useful design, decision, or historical context. It will be migrated as a closed GitHub issue only when the user wants that history visible in GitHub.

## already-complete

The ticket is open or in progress but current code, tests, commits, or a merged pull request demonstrate its acceptance behavior. Recommend a closed historical GitHub issue only when preserving the record is useful; otherwise omit it with the user's approval.

## superseded-or-duplicate

Another ticket, GitHub issue, implementation, or documented decision replaced this work. Identify the replacement explicitly. Preserve a closed reference only when it clarifies history.

## irrelevant

The ticket no longer belongs to the intended product or workflow. Examples include abandoned experiments, removed components, or work made meaningless by the decision to replace the tracker. Explain why it is out of scope now.

## needs-user-decision

Use this when evidence cannot answer whether the work is still desired, whether it is complete, or whether historical visibility matters. Ask the smallest decision-ready question; do not archive by guesswork.
