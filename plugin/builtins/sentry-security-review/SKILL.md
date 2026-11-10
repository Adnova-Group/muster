---
name: security-review
description: "High-confidence security code review: trace attacker-controlled input before flagging injection, XSS, auth, crypto, SSRF or deserialization findings."
muster_builtin: true
license: CC-BY-SA-4.0
upstream:
  - repo: getsentry/skills
    ref: e94f22214528d69899d09c627b3315ddc3544816
    path: skills/security-review/SKILL.md
    license: CC-BY-SA-4.0
    relation: adapted
---
<!-- License: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). This file is adapted from getsentry/skills @ e94f22214528d69899d09c627b3315ddc3544816 skills/security-review/SKILL.md (Copyright 2025 Functional Software, Inc. dba Sentry); the skill's reference material derives from the OWASP Cheat Sheet Series (CC BY-SA 4.0, see LICENSE beside this file), and upstream licenses the whole skill under that file. Changes made by Muster: frontmatter (one-line description, muster_builtin, license, upstream provenance; allowed-tools dropped), paths (bare reference, language-guide and infrastructure file names are qualified with their references/, languages/ and infrastructure/ paths), this header, and a prompt-lint directive. Every other file in this directory is an unmodified upstream copy. -->

<!--
Reference material based on OWASP Cheat Sheet Series (CC BY-SA 4.0)
https://cheatsheetseries.owasp.org/
-->

# Security Review Skill

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001, GUARD-IDK-001: CC BY-SA 4.0 upstream skill body (getsentry/skills), carried verbatim apart from the changes the license header lists; muster loads it on demand for security review, which supplies the role. -->

Identify exploitable security vulnerabilities in code. Report only **HIGH CONFIDENCE** findings—clear vulnerable patterns with attacker-controlled input.

## Scope: Research vs. Reporting

**CRITICAL DISTINCTION:**

- **Report on**: Only the specific file, diff, or code provided by the user
- **Research**: The ENTIRE codebase to build confidence before reporting

Before flagging any issue, you MUST research the codebase to understand:
- Where does this input actually come from? (Trace data flow)
- Is there validation/sanitization elsewhere?
- How is this configured? (Check settings, config files, middleware)
- What framework protections exist?

**Do NOT report issues based solely on pattern matching.** Investigate first, then report only what you're confident is exploitable.

## Confidence Levels

| Level | Criteria | Action |
|-------|----------|--------|
| **HIGH** | Vulnerable pattern + attacker-controlled input confirmed | **Report** with severity |
| **MEDIUM** | Vulnerable pattern, input source unclear | **Note** as "Needs verification" |
| **LOW** | Theoretical, best practice, defense-in-depth | **Do not report** |

## Do Not Flag

### General Rules
- Test files (unless explicitly reviewing test security)
- Dead code, commented code, documentation strings
- Patterns using **constants** or **server-controlled configuration**
- Code paths that require prior authentication to reach (note the auth requirement instead)

### Server-Controlled Values (NOT Attacker-Controlled)

These are configured by operators, not controlled by attackers:

| Source | Example | Why It's Safe |
|--------|---------|---------------|
| Django settings | `settings.API_URL`, `settings.ALLOWED_HOSTS` | Set via config/env at deployment |
| Environment variables | `os.environ.get('DATABASE_URL')` | Deployment configuration |
| Config files | `config.yaml`, `app.config['KEY']` | Server-side files |
| Framework constants | `django.conf.settings.*` | Not user-modifiable |
| Hardcoded values | `BASE_URL = "https://api.internal"` | Compile-time constants |

**SSRF Example - NOT a vulnerability:**
```python
# SAFE: URL comes from Django settings (server-controlled)
response = requests.get(f"{settings.SEER_AUTOFIX_URL}{path}")
```

**SSRF Example - IS a vulnerability:**
```python
# VULNERABLE: URL comes from request (attacker-controlled)
response = requests.get(request.GET.get('url'))
```

### Framework-Mitigated Patterns
Check language guides before flagging. Common false positives:

| Pattern | Why It's Usually Safe |
|---------|----------------------|
| Django `{{ variable }}` | Auto-escaped by default |
| React `{variable}` | Auto-escaped by default |
| Vue `{{ variable }}` | Auto-escaped by default |
| `User.objects.filter(id=input)` | ORM parameterizes queries |
| `cursor.execute("...%s", (input,))` | Parameterized query |
| `innerHTML = "<b>Loading...</b>"` | Constant string, no user input |

**Only flag these when:**
- Django: `{{ var|safe }}`, `{% autoescape off %}`, `mark_safe(user_input)`
- React: `dangerouslySetInnerHTML={{__html: userInput}}`
- Vue: `v-html="userInput"`
- ORM: `.raw()`, `.extra()`, `RawSQL()` with string interpolation

## Review Process

### 1. Detect Context

What type of code am I reviewing?

| Code Type | Load These References |
|-----------|----------------------|
| API endpoints, routes | `references/authorization.md`, `references/authentication.md`, `references/injection.md` |
| Django/DRF views, permission classes, object-level access | Use the `django-access-review` skill if available for access control; otherwise `references/authorization.md` |
| Frontend, templates | `references/xss.md`, `references/csrf.md`, `references/modern-threats.md` (DOM clobbering, prototype pollution) |
| File handling, uploads | `references/file-security.md` |
| Crypto, secrets, tokens | `references/cryptography.md`, `references/data-protection.md` |
| Data serialization | `references/deserialization.md` |
| External requests | `references/ssrf.md` |
| Business workflows | `references/business-logic.md` |
| GraphQL, REST design | `references/api-security.md` |
| Config, headers, CORS | `references/misconfiguration.md` |
| CI/CD, dependencies | `references/supply-chain.md` |
| Error handling | `references/error-handling.md` |
| Audit, logging | `references/logging.md` |
| Object merging/cloning, `__proto__`, DOM `id`/`name` lookups, WebSocket handlers, LLM prompt construction | `references/modern-threats.md` |

### 2. Load Language Guide

Based on file extension or imports:

| Indicators | Guide |
|------------|-------|
| `.py`, `django`, `flask`, `fastapi` | `languages/python.md` |
| `.js`, `.ts`, `express`, `react`, `vue`, `next` | `languages/javascript.md` |

For other languages there is no dedicated guide; rely on the `references/` files and verify framework protections directly in the codebase.

### 3. Load Infrastructure Guide (if applicable)

| File Type | Guide |
|-----------|-------|
| `Dockerfile`, `.dockerignore` | `infrastructure/docker.md` |
| GitHub Actions workflows | Use the `gha-security-review` skill if available; otherwise `references/supply-chain.md` |
| Other CI/CD pipelines, lockfiles, package manifests | `references/supply-chain.md` |

### 4. Research Before Flagging

**For each potential issue, research the codebase to build confidence:**

- Where does this value actually come from? Trace the data flow.
- Is it configured at deployment (settings, env vars) or from user input?
- Is there validation, sanitization, or allowlisting elsewhere?
- What framework protections apply?

Only report issues where you have HIGH confidence after understanding the broader context.

### 5. Verify Exploitability

For each potential finding, confirm:

**Is the input attacker-controlled?**

| Attacker-Controlled (Investigate) | Server-Controlled (Usually Safe) |
|-----------------------------------|----------------------------------|
| `request.GET`, `request.POST`, `request.args` | `settings.X`, `app.config['X']` |
| `request.json`, `request.data`, `request.body` | `os.environ.get('X')` |
| `request.headers` (most headers) | Hardcoded constants |
| `request.cookies` (unsigned) | Internal service URLs from config |
| URL path segments: `/users/<id>/` | Database content from admin/system |
| File uploads (content and names) | Signed session data |
| Database content from other users | Framework settings |
| WebSocket messages | |

**Does the framework mitigate this?**
- Check language guide for auto-escaping, parameterization
- Check for middleware/decorators that sanitize

**Is there validation upstream?**
- Input validation before this code
- Sanitization libraries (DOMPurify, bleach, etc.)

### 6. Report HIGH Confidence Only

Skip theoretical issues. Report only what you've confirmed is exploitable after research.

---

## Severity Classification

| Severity | Impact | Examples |
|----------|--------|----------|
| **Critical** | Direct exploit, severe impact, no auth required | RCE, SQL injection to data, auth bypass, hardcoded secrets |
| **High** | Exploitable with conditions, significant impact | Stored XSS, SSRF to metadata, IDOR to sensitive data |
| **Medium** | Specific conditions required, moderate impact | Reflected XSS, CSRF on state-changing actions, path traversal |
| **Low** | Defense-in-depth, minimal direct impact | Missing headers, verbose errors, weak algorithms in non-critical context |

---

## Quick Patterns Reference

### Always Flag (Critical)
```
eval(user_input)           # Any language
exec(user_input)           # Any language
pickle.loads(user_data)    # Python
yaml.load(user_data)       # Python (not safe_load)
unserialize($user_data)    # PHP
deserialize(user_data)     # Java ObjectInputStream
shell=True + user_input    # Python subprocess
child_process.exec(user)   # Node.js
```

### Always Flag (High)
```
innerHTML = userInput              # DOM XSS
dangerouslySetInnerHTML={user}     # React XSS
v-html="userInput"                 # Vue XSS
f"SELECT * FROM x WHERE {user}"    # SQL injection
`SELECT * FROM x WHERE ${user}`    # SQL injection
os.system(f"cmd {user_input}")     # Command injection
```

### Always Flag (Secrets)
```
password = "hardcoded"
api_key = "sk-..."
AWS_SECRET_ACCESS_KEY = "..."
private_key = "-----BEGIN"
```

### Check Context First (MUST Investigate Before Flagging)
```
# SSRF - ONLY if URL is from user input, NOT from settings/config
requests.get(request.GET['url'])     # FLAG: User-controlled URL
requests.get(settings.API_URL)       # SAFE: Server-controlled config
requests.get(f"{settings.BASE}/{x}") # CHECK: Is 'x' user input?

# Path traversal - ONLY if path is from user input
open(request.GET['file'])            # FLAG: User-controlled path
open(settings.LOG_PATH)              # SAFE: Server-controlled config
open(f"{BASE_DIR}/{filename}")       # CHECK: Is 'filename' user input?

# Open redirect - ONLY if URL is from user input
redirect(request.GET['next'])        # FLAG: User-controlled redirect
redirect(settings.LOGIN_URL)         # SAFE: Server-controlled config

# Weak crypto - ONLY if used for security purposes
hashlib.md5(file_content)            # SAFE: File checksums, caching
hashlib.md5(password)                # FLAG: Password hashing
random.random()                      # SAFE: Non-security uses (UI, sampling)
random.random() for token            # FLAG: Security tokens need secrets module
```

---

## Output Format

```markdown
## Security Review: [File/Component Name]

### Summary
- **Findings**: X (Y Critical, Z High, ...)
- **Risk Level**: Critical/High/Medium/Low
- **Confidence**: High/Mixed

### Findings

#### [VULN-001] [Vulnerability Type] (Severity)
- **Location**: `file.py:123`
- **Confidence**: High
- **Issue**: [What the vulnerability is]
- **Impact**: [What an attacker could do]
- **Evidence**:
  ```python
  [Vulnerable code snippet]
  ```
- **Fix**: [How to remediate]

### Needs Verification

#### [VERIFY-001] [Potential Issue]
- **Location**: `file.py:456`
- **Question**: [What needs to be verified]
```

If no vulnerabilities found, state: "No high-confidence vulnerabilities identified."

---

## Reference Files

### Core Vulnerabilities (`references/`)
| File | Covers |
|------|--------|
| `references/injection.md` | SQL, NoSQL, OS command, LDAP, template injection |
| `references/xss.md` | Reflected, stored, DOM-based XSS |
| `references/authorization.md` | Authorization, IDOR, privilege escalation |
| `references/authentication.md` | Sessions, credentials, password storage |
| `references/cryptography.md` | Algorithms, key management, randomness |
| `references/deserialization.md` | Pickle, YAML, Java, PHP deserialization |
| `references/file-security.md` | Path traversal, uploads, XXE |
| `references/ssrf.md` | Server-side request forgery |
| `references/csrf.md` | Cross-site request forgery |
| `references/data-protection.md` | Secrets exposure, PII, logging |
| `references/api-security.md` | REST, GraphQL, mass assignment |
| `references/business-logic.md` | Race conditions, workflow bypass |
| `references/modern-threats.md` | Prototype pollution, LLM injection, WebSocket |
| `references/misconfiguration.md` | Headers, CORS, debug mode, defaults |
| `references/error-handling.md` | Fail-open, information disclosure |
| `references/supply-chain.md` | Dependencies, build security |
| `references/logging.md` | Audit failures, log injection |

### Language Guides (`languages/`)
- `languages/python.md` - Django, Flask, FastAPI patterns
- `languages/javascript.md` - Node, Express, React, Vue, Next.js

### Infrastructure (`infrastructure/`)
- `infrastructure/docker.md` - Container security
