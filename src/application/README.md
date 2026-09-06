# Application layer

Use-case services — orchestration only, per `04_ARCHITECTURE_SUMMARY.md` §4.3. One service per use
case (`SearchService`, `CommuteService`, `HistoryService`, etc. — see `05_CONTEXT_AND_CONTAINERS.md`
§5.3's component diagram).

Calls down into the domain layer for calculations and into infrastructure for data — holds no
business rules of its own, and no I/O beyond calling those two layers.
