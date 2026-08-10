Comprehensive list generated. Summary:

# 147 powers

### Sources & priority
| Source | Role |
|--------|------|
| **Way of the Psionicist** (DSCS Revised) | Overrides MAC + PSP cost; discipline/tier when present |
| **Complete Psionics Handbook** | Classic stats (Power Score, Initial/Maintenance, Prep Time) |
| **The Will and the Way** | Additional Dark Sun powers (OCR limited; many already covered via WOTP summary) |

### Coverage
| Metric | Count |
|--------|------:|
| Total powers | **147** |
| With revised MAC/PSP | **128** |
| Classic-only (no WOTP stats yet) | **19** |
| Dual (`ruleset: "both"`) | ~125 |

### By discipline
| Discipline | Count |
|------------|------:|
| Clairsentience | 18 |
| Psychokinesis | 21 |
| Psychometabolism | 34 |
| Psychoportation | 14 |
| Telepathy | 43 |
| Metapsionics | 18 *(classic only — eliminated in revised)* |

### Sample record (dual ruleset)
```json
{
  "id": "psionic_aura_sight_2e",
  "name": "Aura Sight",
  "class": "Psionic",
  "discipline": "Clairsentience",
  "tier": "Science",
  "powerScore": "Wis -5",
  "initialCost": "9",
  "maintenanceCost": "9/round",
  "preparationTime": "0",
  "mac": 7,
  "pspCost": "9/3",
  "pspCostSuccess": 9,
  "pspCostFailure": 3,
  "range": "50 yds.",
  "areaOfEffect": "personal",
  "prerequisites": "none",
  "sourceBooks": [
    "PHBR5 - The Complete Psionics Handbook",
    "Dark Sun Campaign Setting (Revised)"
  ],
  "ruleset": "both",
  "verified": false
}
```

### Notes
- **WOTP wins** on `mac`, `pspCost`, and discipline when both exist.
- Classic fields are left intact for import compatibility.
- A few classic field alignments may be off due to PDF text extraction (e.g. Range/Prep swapped on some entries) — those are good candidates for the editor’s **Verified** toggle.
- Metapsionic powers remain for classic campaigns; revised rules redistributed them.

Copy the file from the sandbox path into your Depp-Magic `output/` folder when ready. I can also improve WATW appendix extraction or wire this into the editor next if you want.
