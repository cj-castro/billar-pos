# Diagnostic views (kept, not yet on any screen)

Batch D4 removed 14 views nothing used (migration 047). These 14 are also
unused by the app today but answer questions an owner or an installer will ask,
so they stay. Query them in psql; candidates for a screen are marked.

| View | What it answers | Candidate screen |
|---|---|---|
| `v_menu_items_without_recipe` | Menu items that sell without deducting any stock | **Costos** ("sin receta") |
| `v_recipe_coverage` | Per item: recipe / modifier rules / neither, with sales | **Costos** |
| `v_untracked_products` | Products sold that no inventory tracks | **Costos** |
| `v_modifier_groups_unsatisfiable` | Mandatory option groups with no available option (item can't be ordered) | Menú (config errors) |
| `v_suspicious_tips_v2` | Tips that look out of pattern per server | **Riesgos** |
| `v_unauthorized_value_reductions` | Value removed without a recorded authorization | **Riesgos** |
| `v_manager_override_summary` | Overrides per manager per day | **Riesgos** |
| `v_authorization_overrides_daily` | Overrides per action / requester / approver per day | Riesgos |
| `v_audit_timeline` | One timeline of audit, overrides, movements, violations, production | Auditoría |
| `v_shrinkage_summary` | Waste and count/manual adjustments per item per business day, valued | Inventario (merma $) |
| `v_kds_undelivered` | Kitchen/bar events not delivered to a screen | Operación |
| `v_kds_watermark_drift` | Lines whose KDS quantity drifted from the ticket | Operación |
| `v_production_variance` | Production batches: expected vs actual yield | Producción (no UI yet) |
| `v_production_yield_trend` | Average yield per product over time | Producción (no UI yet) |

All dates in these views are business days in the venue's timezone
(`fn_bar_date()` / `fn_bar_business_ts()`, migrations 045–046).
