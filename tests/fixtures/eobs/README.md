# EOB Fixtures

Sample Explanation of Benefits PDFs (extracted to `source.txt`) paired with parser test runs via `scripts/parse-harness.ts`. Used to:

1. Test `src/lib/billing/haiku-bill-parser.ts` against real-world insurer layout variations.
2. Validate DR-3D cycle detection v2 (greedy bipartite matching with line-distance tiebreaker) against reversal/correction patterns.
3. Catch parser regressions on accumulator emission, EX/CARC/RARC code extraction, and per-occurrence `_meta` confidence values.

## Slug convention

Each subdirectory is `<insurer-slug>-<descriptor>/`:

- `<insurer-slug>` — kebab-case carrier name OR `synthetic-<insurer>` for fabricated fixtures.
- `<descriptor>` — short tag describing what makes this fixture distinctive (e.g., `cycle-correction`, `denial-cycle`, `mixed`).

Single file per slug:
- `source.txt` — the document text (extracted via `pdftotext` for real EOBs, written verbatim for synthetic).

## Fixture inventory (current set: 6 EOBs)

| Slug | Insurer | Source kind | Distinctive feature | Added |
|---|---|---|---|---|
| `cigna-2026-03-26-hira-mixed` | Cigna | Real (Andrew's PEO claim, owner-consented) | Form 5; 2 lines; mixed happy+denied; PEO context; A0/A1 proprietary notes | Session 46 |
| `cigna-2025-06-09-labcorp-deny` | Cigna | Real (Andrew's claim, owner-consented) | EOB2; 4 lines; A1 denial (positional code reuse) | Session 47 |
| `cigna-2025-04-10-kwitnicki-preventive` | Cigna | Real (Andrew's claim, owner-consented) | EOB3; 8 lines; $2,730 preventive bundle; multi-accumulator | Session 47 |
| `synthetic-ambetter-denial-cycle` | Ambetter (Centene) | Synthetic (modeled on capture_audit §4.4 expected values) | 5 lines + 0100/0101/0102 reversal cycle; multi-year accumulator (2019 + 2018 prior-year snapshot) | Session 47 |
| `synthetic-bcbs-anthem-mixed` | Anthem BCBS | Synthetic (Path B; first-pass approximation) | 5 lines + 0001/0002 cancel-and-refile cycle; Anthem column terminology ("Total Billed", "Patient Savings", "Applied to Deductible", "Coins/Copay", "Claims Payment", "Member Owes"); reason codes R1/C2 | Session 49 |
| `synthetic-uhc-cycle-correction` | UnitedHealthcare | Synthetic (Path B; first-pass approximation) | 8 lines + 1/2 cancel + 7 corrected refile + denied EKG (A2); UHC column terminology ("Amount Billed", "Plan Discount", "Allowed Amount", "Plan Paid", "Patient Balance"); A1/A2/A3 reason codes mapped to CARC 18/197/1 | Session 49 |

### Path A vs Path B notes (synthetic fixtures only)

Per Phase 3.1B Subplan §3.1B-A0 (Session 49), 15-min web-search prefetch confirmed that publicly available BCBS + UHC sample EOBs are **all educational walkthroughs** with field-number annotations layered over EOB images — pdftotext extracts only the legend definitions, not the line-item data. No acceptable Path A source met the quality bar (text-extractable + ≥4 line items + accumulator block) for either insurer.

Both `synthetic-bcbs-anthem-mixed` and `synthetic-uhc-cycle-correction` were therefore constructed as **Path B first-pass approximations**, with insurer-specific terminology anchored on the educational PDFs that surfaced in A0 (Anthem examples from Peralta College; UHC's "Understanding your medical EOB" Medicare Advantage guide). Layout assumptions are best-effort and should be **replaced when real EOB samples become accessible**.

## Coverage matrix

| Insurer | Real fixture? | Synthetic fixture? | Reversal-cycle dogfood? |
|---|---|---|---|
| Cigna | 3 (Form 5, EOB2, EOB3) | — | — |
| Ambetter (Centene) | — | 1 (multi-year + reversal) | ✅ |
| Anthem BCBS | — | 1 (cancel-and-refile) | ✅ |
| UnitedHealthcare | — | 1 (cycle-correction + denial) | ✅ |
| BCBS Federal/state plans | — | — (Anthem covers Association tier) | — |

Cycle detection now validates against 3 distinct reversal patterns (Ambetter 3-line cycle with refile, Anthem 2-line cancel-and-refile, UHC 2-line cancel + 1-line correction).

## Adding a new fixture

1. Create directory under `tests/fixtures/eobs/<slug>/`.
2. Write `source.txt` (verbatim PDF text or synthetic content).
3. For synthetic fixtures, include header comment block documenting (a) which real EOB sample it approximates, (b) which capture_audit reference or web-research source supplied terminology, (c) "first-pass approximation" caveat.
4. Update this README inventory table.
5. Run `npx tsx scripts/parse-harness.ts --run-id <descriptor> --fixtures-dir tests/fixtures/eobs/` to baseline.
