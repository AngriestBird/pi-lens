---
section: Changed
audience: internal
---

- Serialize the six-writer instance-registry race test to prevent it from contending with timing-sensitive occupancy tests in the same shard (#4046).
