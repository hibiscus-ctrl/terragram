// Validates a pull request's title + description. Run by .github/workflows/pr-validation.yml
// with PR_TITLE / PR_BODY in the env (never interpolated into the shell — avoids script
// injection from an untrusted PR title/body). Exits non-zero with an actionable message.

const title = (process.env.PR_TITLE ?? "").trim();
const body = process.env.PR_BODY ?? "";

const errors = [];

if (title.length < 10) {
  errors.push(`Title is too short: "${title}". Write a descriptive PR title.`);
}
if (/^(update|wip|fix|changes|misc)\.?$/i.test(title)) {
  errors.push(`Title "${title}" is not descriptive — say what changed and where.`);
}

// Description must contain real prose — strip HTML comments (template hints),
// markdown headings, and checkbox lines so an unfilled template counts as empty.
const meaningful = body
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/^#{1,6}\s.*$/gm, "")
  .replace(/^\s*[-*]\s*\[[ xX]\].*$/gm, "")
  .trim();
if (meaningful.length < 15) {
  errors.push(
    "Description is empty. Fill in the “What & why” section of the PR template — " +
      "what the change does and why (link the issue with “Fixes #123”).",
  );
}

if (errors.length > 0) {
  console.error("✗ PR validation failed:\n" + errors.map((e) => `  • ${e}`).join("\n"));
  process.exit(1);
}
console.log("✓ PR title and description look good.");
