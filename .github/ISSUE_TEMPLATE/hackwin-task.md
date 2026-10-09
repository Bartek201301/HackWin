---
name: HackWin task
about: One task, one pull request. Fill every field of the data block; the deadline is required.
---
```yaml
# hackwin:task
kind: task                 # task | proposal | integration | contract-change | foundation
role:                      # ownership role
wave:                      # wave number; optional for tasks written by hand and for proposals
paths:                     # allowed paths, globs, inside the role's scope or on the open list
  -
depends_on: []             # issue numbers
acceptance_tests:
  -                        # test file or test id
deadline: ""               # ISO 8601 with offset
```

## Problem
<!-- What is missing or wrong, in terms of the product. -->

## Expected result
<!-- What exists when the task is done, including the interfaces it must respect. -->

## Acceptance criteria
<!-- One line per criterion, each mapped to a test listed above. -->

## Out of scope
<!-- What this task must not change. -->
