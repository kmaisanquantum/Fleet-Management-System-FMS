# Business Rules

Configurable operational values (spec section 34). Sourced directly from the `business_rules` database table and editable in-app by system administrators via `/settings`.

| Rule Key | Description | Type | Default |
|---|---|---|---|
| `max_allowed_variance_pct` | Max allowed reconciliation variance before flagging alert | Number | `0.5` (%) |
| `default_currency` | Base operating currency code | String | `PGK` |
| `invoice_payment_terms_days` | Default payment terms due window in days | Number | `30` (days) |
| `default_calibration_period_months` | Standard calibration validity period in months | Number | `12` (months) |
| `negative_inventory_allowed` | Allows stock withdrawals below zero balance | Boolean | `false` |

## Negative inventory

Disallowed by default (`postInventoryMovement` throws `422` if a movement would push a tank below zero). The `negative_inventory_allowed` business rule governs controlled exceptions.

## Capacity enforcement

Both tanks and refuellers reject movements that would exceed their `capacity` field (`422` error), inside the same transaction as the movement itself — never a warning after the fact.

## Reconciliation variance threshold

`Math.abs(variancePct) > max_allowed_variance_pct` triggers `investigation_required` status and a critical alert. This mirrors the brief's worked example precisely (a −1.3% variance against a ±0.5% default threshold is flagged).
