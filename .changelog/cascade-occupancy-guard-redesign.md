---
section: Changed
audience: internal
---

- The cascade-graph occupancy test counts event-loop yields and checks scaling ratios instead of asserting a 300 ms budget, so a slow runner no longer fails it and a removed yield now does (#4046).
