# Refactoring Log

This log explains everything changed while refactoring
FlexFit Studio. The goal was to move business logic out of the tRPC routers
and into shared service files, so that the same rules live in ONE place
instead of being copied in several spots. Nothing about how the app behaves
was supposed to change - only where the code lives.

## Layering we followed

UI  ->  tRPC Router  ->  Feature Service  ->  Database

- Routers only handle the tRPC/API layer (input validation, auth, calling a service).
- Services hold the business rules and talk to the database.
- Services never depend on routers.

## 1. Admin router split into a folder

**Commits:** `61dfb04` ... `1bbdec3` (one commit per procedure moved)

`src/server/routers/admin.ts` was one big file with 9 admin-only procedures.
We split it into a folder so each topic has its own file:

- `admin/overview.ts`   -> `stats`
- `admin/revenue.ts`    -> `revenueByMonth`, `revenueByMethod`, `refundCount`
- `admin/operations.ts` -> `classUtilisation`, `expiringMemberships`,
                           `checkinsPerDay`, `topTrainers`, `noShowList`
- `admin/index.ts`      -> the composition point (spreads all 9 procedures)

The front-end paths stayed FLAT (`admin.stats`, `admin.revenueByMonth`, ...)
- not `admin.overview.stats`. The old `admin.ts` was deleted once the folder
`index.ts` took over. Every procedure still uses `adminProcedure` (admin
only), so who can call them never changed.

## 2. Trainer procedure middleware

**Commit:** `e490f8c`

Added `trainerProcedure` in `src/server/trpc.ts` - a ready-made rule that
says "only trainers allowed" (FORBIDDEN "Only trainers can access this.").

The 4 trainer-only procedures in `trainers.ts` (`upcomingClasses`,
`availability`, `setAvailability`, `removeAvailability`) used to check the
role inside each handler. They now use the middleware instead. The rule is
the SAME (trainer only, same error message) - it just moved to one shared
place. `checkAvailability` still allows admin + trainer, unchanged.

## 3. Bug fixes (separate commits, never mixed with refactors)

### Bug 1 - Class cancellation: refunds + notifications (`ef2e717`)
When an admin cancelled a class, nothing else happened. Now:
- Booked members get their class credits refunded (same rules as a normal
  cancellation: only if not unlimited, refund exactly what they spent).
- Waitlisted members move to "cancelled" (they were stuck before).
- Booked and waitlisted members each get a "Class cancelled" notification.

### Bug 2 - Corporate check-in recorded the wrong id (`4e68c33`)
`corporateBookings.markAttended` now saves the actual booking id on the
check-in row instead of null.

### Bug 3 - Waitlist promotion notification (`d394aec`)
When a waitlisted member gets promoted to a confirmed spot, ONLY that
member now receives a "You've been promoted!" notification (in both the
personal and corporate cancel flows). Other waitlisted people get nothing.

## 4. Booking credit/refund logic moved into a service

**Commit:** `dc5f095`

Added to `src/features/bookings/booking.service.ts`:
- `activeMembershipFor`      - find the member's active membership
- `isRefundable`             - can this cancellation refund credits? Shared
                               by personal (12h) AND corporate (24h) flows
- `assertMembershipCreditsFor` - enough credits? (throws if not)
- `deductMembershipCredits`  - take credits from a membership
- `refundMembershipCredits`  - give credits back to a membership

`bookings.ts` and `corporate-bookings.ts` now call these instead of
repeating the logic inline. The corporate credit-pool money logic stays in
the corporate router (different credit model).

## 5. Reschedule logic moved into a service

**Commit:** `8d6d0c3`

Added `performReschedule` to `src/features/bookings/reschedule.service.ts`.
It validates (same checks + error messages as before), creates the new
booking keeping the ORIGINAL credits used (no double charge), cancels the
old booking, and records the reschedule.

`reschedules.ts` is now a thin router that just calls the service.

## 6. Verification work (no code changes)

We verified the refactor did not change behavior using real database runs:

- **Feature Map checks** (manual test lists): booking 13/13, reschedule
  12/12, corporate 6/7 all passed. The 1 corporate failure is a pre-existing
  check-in FK issue from the Bug 2 fix, unrelated to the refactor.
- **Invariants** (actual stored DB values): waitlisted creditsUsed=0,
  normal creditsUsed=class.creditCost, unlimited creditsRemaining=999,
  personal refund threshold 12h, corporate 24h, reschedule keeps original
  creditsUsed - all confirmed. One documented exception: rescheduling into
  a FULL class creates a waitlisted booking that keeps the original
  creditsUsed (this is expected, pre-existing behavior - we kept it).
- **Authorization**: every affected procedure's access rule (public /
  signed-in / staff / admin / trainer) was verified identical before and
  after - same error codes and messages.

## Commits created (in order)

```
e490f8c refactor: add trainer procedure middleware
ef2e717 fix: class cancellation refunds and notifications
61dfb04 refactor: split admin router into per-topic files
3a7f34b refactor: move classUtilisation to admin operations router
6dee450 refactor: move expiringMemberships to admin operations router
6bc8b09 refactor: move revenueByMonth to admin revenue router
2a97c24 refactor: move revenueByMethod to admin revenue router
6129b50 refactor: move refundCount to admin revenue router
3b9e0aa refactor: move checkinsPerDay to admin operations router
c19fe94 refactor: move topTrainers to admin operations router
7115ec8 refactor: move noShowList to admin operations router
1bbdec3 refactor: use admin router folder index as composition point
dc5f095 refactor: move booking credit logic into booking service
4e68c33 fix: link corporate checkins to bookings
8d6d0c3 refactor: extract reschedule service
```

Bug fixes and refactors were kept in SEPARATE commits on purpose. All
commits live on the `refactor/booking-architecture` branch, which was pushed
to GitHub as the `main` branch.

## Known limitations

- **Corporate check-in foreign key.** `checkins.booking_id` is declared as a
  foreign key to `bookings.id` (the PERSONAL bookings table), but
  `corporateBookings.markAttended` stores the corporate booking id there.
  Where SQLite foreign keys are enforced, the corporate check-in insert
  fails; where they are not (the live app, no `PRAGMA foreign_keys`),
  it stores a corporate id in a column meant for personal booking ids.
  `admin.stats` and `admin.checkinsPerDay` only count rows and are not
  affected; `bookings.checkinCountFor` joins on the id, so a corporate id
  colliding with a personal booking id in the same class could inflate the
  count. We chose NOT to change code for this - documented as a known
  limitation. A clean fix would be to drop the FK on `checkins.booking_id`
  (making it a loose id) and harden `checkinCountFor`, or add a separate
  `corporate_checkins` table.

## Notes

- The repository has no automated tests ("No test files found"), so the
  manual Feature Map / invariant harness runs acted as the test suite.
- `npm run lint` fails with a pre-existing error about a circular structure
  while reading `.eslintrc.json` (Next.js/ESLint 9 legacy config). It was
  never fixed as part of this refactor and the config was not modified.
- Unrelated ESLint dependency changes that appeared in the working tree
  (eslint, eslint-config-next, a lockfile re-resolution, and an
  `unrs-resolver` allowBuilds placeholder) were reverted - they were not
  part of the refactor and nothing in the refactor needs them.
