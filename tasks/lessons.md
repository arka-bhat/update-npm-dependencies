# Lessons

- **Check library behaviour in the docs/changelog for the version we will ship, not just the type definitions.** I described npm-check-updates' `cooldown` from its `.d.ts` comment and got it wrong for v20 (it hides the package entirely), and v22 changed it again (falls back to an older version). Run `ncu --help --<option>` and read the release notes before explaining an option.
