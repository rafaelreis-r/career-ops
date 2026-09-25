# ATS Auto-Fill Flow (Apply Mode)

The `apply` mode interactive assistant helps you fill out applications for job postings. It reads the form questions in your browser and drafts personalized answers based on your profile and the evaluated report.

**Interactive `apply` never submits.** The agent prepares responses, selects options, and types text fields; you click Submit.

The separately invoked hybrid driver is a narrow exception. It may submit one eligible application after its final gate verifies every required answer, the posting-specific CV attachment, consent, the absence of a detected captcha, and native browser validity. If any check fails, it leaves the filled tab open for you.

## Hybrid Driver

Run it from `web/` with a job or application URL and either a tracker row or report:

```bash
node scripts/apply-hybrid.mjs --url <job-or-form-url> --row <n>
# or
node scripts/apply-hybrid.mjs --url <job-or-form-url> --report <report.md>
```

If the URL opens a job page, the driver follows an application link into the form, including Gupy's “Candidatar-se” and Get on Board's “Apply now” links. A final submit still waits for the pre-submit gate.

Optional `--cv <pdf>` is accepted only when the filename can be tied to the posting and no other report owns it. A CV linked to the selected report by its number may use the zero-padded report number (such as `042`) or its unpadded form (`42`) even when the filename lacks the company name. `--out <json>` changes the metrics path; the default is `data/ab-test/hybrid.json` under the resolved data root.

The driver keeps one visible browser for the round and one tab per posting. It reuses interrupted tabs, attaches the posting-specific CV, fills exact canonical answers deterministically, and uses typed model decisions only for unresolved fields. Report answers may fill only open text fields asking for motivation or fit with the company or role, including a cover note or letter. Factual fields, including yes/no questions, use profile or CV facts instead. It does not invent answers. Captchas and required questions without verified canonical answers block submission and remain listed on the open tab.

When `application_answers.salary` uses profile compensation, the driver can fill a salary field with the profile's figure for the field's stated currency and, for BRL fields that name CLT or PJ, the matching regime. It enters digits for numeric fields. It does not convert currencies; fields with an incompatible currency, regime, or pay period remain blocked. Bonus and other compensation components do not receive a salary target.

Profile self-declaration answers can fill matching disability, CID, and accessibility fields. These answers are kept out of model requests, and their values and failure reasons are redacted in the driver's metrics JSON.

It refuses to open a posting already recorded as sent, a blacklisted company, or a company whose configured submission window is exhausted. A durable attempt claim prevents a second submission after a click whose outcome is uncertain.

Exit codes are: `0` submitted and confirmed; `3` left open for the human; `4` no form; `5` ineligible; `6` clicked but refused or not confirmed; `1` run failure.

---

## Interactive Apply: How It Works Per ATS

We have field-tested the auto-fill flow across several major ATS platforms (Ashby, Greenhouse, Lever, and Workable). The agent adapts its behavior to handle specific ATS quirks silently:

### Ashby

- **Duplicate Prevention:** Ashby merges candidates based on their email. Before filling out the form, the agent checks if you've already applied to this company. If so, it warns you and suggests a modified email alias (like `you+teamname@domain.com`) to prevent silent failures or unintended profile merges.

### Lever

- **Checkboxes and the Captcha Stay Yours:** Lever often pops an hCaptcha challenge when checkboxes or radio buttons are clicked programmatically. The agent therefore auto-fills text, textareas, and standard select dropdowns only, and never touches the checkboxes, the radio buttons, or the captcha widget. It lists every field it skipped along with recommended values, and you tick them, solve the captcha, and submit.

### Workable

- **Stale DOM References:** Workable is a Single Page Application (SPA) that aggressively re-renders form components, which can break automated typing. The agent works around this by using direct clipboard dispatch (`Ctrl+V` pasting) and querying fresh elements right before every paste. If that fails, it will present a numbered list of answers for you to paste manually.

### Generic Quirks (React-Select)

- Dropdowns powered by `react-select` (common across Greenhouse, Ashby, and Lever) recreate their DOM on every keystroke. The agent types character-by-character with short delays and re-snapshots the DOM to pick up changes instead of caching broken references.
- For massive native dropdowns (like countries or universities with 1,000+ options), the agent won't dump them all into its context. Instead, it selects them directly by value or visible label, or asks you for the correct label.

---

## Interactive Apply: Knock-Out Pre-Scan

Before it drafts a single answer, the agent scans the form for **knock-out questions**. These are questions designed to immediately disqualify you if your answers don't match the employer's hard requirements.

The agent checks your `config/profile.yml` against questions regarding:
- Minimum years of experience
- Degree or education requirements
- Work authorization or visa sponsorship needs
- Salary floors or expectations

**How the warning works:**
If the agent detects a potential mismatch (for example, you need visa sponsorship and the form automatically filters out applicants who do), it halts the generation process immediately and shows you a warning:

> `⚠️ KNOCK-OUT WARNING: The form asks "[question text]". Based on your profile/CV, answering "[profile answer]" may trigger immediate automatic rejection by the ATS. How would you like to answer this, or do you want to skip applying?`

This saves you from spending time tailoring responses for a job that the ATS will automatically reject.

---

## Troubleshooting

- **Agent hangs or crashes mid-form:** This usually happens when an ATS updates its React DOM unexpectedly or pops a hidden captcha. When this happens, look at the agent's output—it always prints a complete list of generated answers. You can easily copy and paste the remaining answers manually.
- **Form changes:** If you notice the form on screen is for a different role than the one evaluated in your report, the agent will detect it and ask if you want to adapt the responses to the new title or stop and re-evaluate.
- **Multiple roles in one session:** Running batch applies? Always run a **Liveness sweep** (`node check-liveness.mjs --file data/pipeline.md`) first to drop dead postings from your pipeline so you never waste time opening an expired role tab.
