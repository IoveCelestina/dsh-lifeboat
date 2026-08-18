# Relationship to adjacent community tools

DSH Lifeboat is an independent implementation, not a fork of another plugin.

The closest listed project found during the 2026-08-18 review is [`dsh-guard`](https://github.com/x2802490130-prog/dsh-guard). Its documented center of gravity is rolling snapshots, in-process failure rollback, and an in-Harness management panel. Its README also states that a plugin cannot rescue a startup crash from inside the failed process and points users to a separate external launcher mechanism.

Lifeboat occupies the narrower out-of-process diagnosis boundary:

| Capability | dsh-guard | DSH Lifeboat |
| --- | --- | --- |
| Rolling configuration snapshots | Yes | No |
| In-Harness management panel | Yes | No |
| Starts independently of the Harness Loader | External launcher is required for boot rescue | Yes |
| Fresh isolated Home for each probe | Not documented | Yes |
| Verified bounded-minimum recovery removal plan | Not documented | Yes |
| Evidence report before a guarded manifest edit | Different snapshot/rollback model | Yes |

The tools can be complementary: snapshots protect known-good state, while Lifeboat tries to reproduce a current startup failure and find a verified removal plan. This table describes documented behavior, not a quality ranking.
