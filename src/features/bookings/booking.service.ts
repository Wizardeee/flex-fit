import { and, asc, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  bookings,
  classes,
  corporateBookings,
  memberships,
  type Booking,
  type CorporateBooking,
  type GymClass,
  type User,
} from "@/db/schema";
import { hoursUntil } from "@/lib/time";
import { UNLIMITED_CREDITS } from "@/features/bookings/constant";

/**
 * Asserts a class can still be booked: it must exist, not be cancelled, and
 * not have already started. Shared by the personal and corporate booking
 * flows. Preserves the exact error codes and messages the flows used before
 * this refactor. Does not query the database.
 */
export function assertClassBookable(
  cls: GymClass | undefined,
): asserts cls is GymClass {
  if (!cls) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Class not found." });
  }
  if (cls.cancelled) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This class has been cancelled.",
    });
  }
  if (hoursUntil(cls.startsAt) <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This class has already started.",
    });
  }
}

/**
 * Whether a user may cancel a booking for a given member: the booking owner
 * themselves, or staff (admin or trainer). Shared by the personal and
 * corporate cancellation flows.
 */
export function isOwnerOrStaff(
  userId: number,
  role: User["role"],
  bookingUserId: number,
): boolean {
  return bookingUserId === userId || role === "admin" || role === "trainer";
}

/**
 * Determines whether a class is full by counting confirmed bookings for it.
 * Only status = 'booked' counts; waitlisted and cancelled bookings do not.
 * Shared by the personal (bookings) and corporate (corporateBookings) flows.
 */
export async function isFull(
  db: typeof import("@/db").db,
  table: typeof bookings | typeof corporateBookings,
  classId: number,
  capacity: number,
): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(table)
    .where(sql`${table.classId} = ${classId} and ${table.status} = 'booked'`);
  return Number(row?.count ?? 0) >= capacity;
}

/**
 * Promotes the longest-waiting waitlisted person to a confirmed booking if the
 * class has a free spot. A free spot exists when the number of confirmed
 * (status = 'booked') bookings is below the class capacity. The oldest
 * waitlisted person is the one with the earliest bookedAt. Returns the
 * promoted booking so the caller can apply its flow-specific credit side
 * effects, or undefined when there is no free spot or nobody waiting.
 */
export async function promoteNextWaitlisted(
  db: typeof import("@/db").db,
  table: typeof bookings | typeof corporateBookings,
  classId: number,
): Promise<Booking | CorporateBooking | undefined> {
  const cls = await db
    .select()
    .from(classes)
    .where(eq(classes.id, classId))
    .get();
  if (!cls) {
    return undefined;
  }

  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(table)
    .where(sql`${table.classId} = ${classId} and ${table.status} = 'booked'`);
  if (Number(row?.count ?? 0) >= cls.capacity) {
    return undefined;
  }

  const next = (await db
    .select()
    .from(table)
    .where(
      sql`${table.classId} = ${classId} and ${table.status} = 'waitlisted'`,
    )
    .orderBy(asc(table.bookedAt))
    .get()) as Booking | CorporateBooking | undefined;

  if (!next) {
    return undefined;
  }

  await db
    .update(table)
    .set({ status: "booked", creditsUsed: cls.creditCost })
    .where(sql`${table.id} = ${next.id}`);

  return next;
}

/**
 * Finds the member's active, non-expired membership, ordered by the latest
 * end date. Used by the personal booking flow to charge class credits.
 */
export async function activeMembershipFor(
  db: typeof import("@/db").db,
  userId: number,
) {
  const today = new Date().toISOString().slice(0, 10);
  return db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.status, "active"),
        sql`${memberships.endDate} >= ${today}`,
      ),
    )
    .orderBy(desc(memberships.endDate))
    .get();
}

/**
 * Whether a cancellation refunds credits: the class is still at least
 * freeCancellationHours away and the booking consumed credits. Shared by the
 * personal (FREE_CANCELLATION_HOURS) and corporate
 * (CORPORATE_FREE_CANCELLATION_HOURS) cancellation flows via the caller's
 * flow-specific constant.
 */
export function isRefundable(
  startsAt: string,
  freeCancellationHours: number,
  creditsUsed: number,
): boolean {
  return hoursUntil(startsAt) >= freeCancellationHours && creditsUsed > 0;
}

/**
 * Personal flow: asserts a membership can afford `cost` credits and returns
 * whether it is unlimited. Preserves the exact error the personal booking
 * flow used before this refactor. Does not query the database.
 */
export function assertMembershipCreditsFor(
  membership: { creditsRemaining: number },
  cost: number,
): boolean {
  const unlimited = membership.creditsRemaining >= UNLIMITED_CREDITS;
  if (!unlimited && membership.creditsRemaining < cost) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Not enough class credits remaining.",
    });
  }
  return unlimited;
}

/**
 * Personal flow: deducts credits from a membership when a confirmed booking is
 * created or a waitlisted member is promoted. Never lets credits drop below
 * zero and never deducts from unlimited memberships.
 */
export async function deductMembershipCredits(
  db: typeof import("@/db").db,
  membershipId: number,
  amount: number,
): Promise<void> {
  const ms = await db
    .select()
    .from(memberships)
    .where(eq(memberships.id, membershipId))
    .get();
  if (ms && ms.creditsRemaining < UNLIMITED_CREDITS) {
    await db
      .update(memberships)
      .set({ creditsRemaining: Math.max(0, ms.creditsRemaining - amount) })
      .where(eq(memberships.id, ms.id));
  }
}

/**
 * Personal flow: refunds credits to a membership on a free cancellation.
 * Never refunds to unlimited memberships (they are never decremented).
 */
export async function refundMembershipCredits(
  db: typeof import("@/db").db,
  membershipId: number,
  amount: number,
): Promise<void> {
  const ms = await db
    .select()
    .from(memberships)
    .where(eq(memberships.id, membershipId))
    .get();
  if (ms && ms.creditsRemaining < UNLIMITED_CREDITS) {
    await db
      .update(memberships)
      .set({ creditsRemaining: ms.creditsRemaining + amount })
      .where(eq(memberships.id, ms.id));
  }
}
