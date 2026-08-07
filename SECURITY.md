# Security Policy

VibeTranslate runs with **Accessibility** permission on macOS (and an equivalent input hook
on Windows). That means it can read the text you have selected and send keystrokes on your
behalf. Reports about that surface are taken seriously and handled first.

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's [private vulnerability reporting](../../security/advisories/new), or email
**vibetranslateid@gmail.com** with:

- what the issue is and how to reproduce it
- the app version, OS and (if relevant) which engine was selected
- what an attacker could achieve

You'll get a first response within 72 hours. If the report is valid, you'll be credited in
the release notes unless you prefer otherwise.

## In scope

- Anything that lets another program or website read your clipboard/selection through this app
- Injection into the text sent to an AI provider that changes what gets pasted back
- Leaking your API keys (they are stored locally and never sent to our servers)
- Abuse of the auto-updater, or anything weakening update signature verification
- Privilege escalation through the native shortcut/clipboard paths

## Out of scope

- The closed backend service (report those to the same address; they are handled privately)
- Behaviour of third-party AI providers you configure yourself
- Findings that require an already-compromised machine or physical access

## Supported versions

Only the latest release receives security fixes. Because the app auto-updates, staying
current is the fastest protection.
