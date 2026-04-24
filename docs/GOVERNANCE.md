# Governance - M-of-N + Exponential Backoff

## M-of-N Per Container

| Container | M | N | Backoff |
|-----------|---|---|---------|
| mariadb | 4 | 5 | ✅ |
| llama-deepseek | 2 | 3 | ✅ |
| nginx | 3 | 5 | ❌ |

## Exponential Backoff Example

```
Op 1: Restart → 1h cooldown
Op 2: (+1h) → 2h cooldown (2^1)
Op 3: (+3h) → 4h cooldown (2^2)
Op 4: (+7h) → 8h cooldown (2^3)
Op 5: (+15h) → 32h cooldown (16h × 2× churn)
```

**Churn multiplier:** 5+ ops/7d → 2×, 10+ → 3×, 15+ → 4×

**Result:** Attack becomes exponentially harder!

See full details in ARCHITECTURE.md
