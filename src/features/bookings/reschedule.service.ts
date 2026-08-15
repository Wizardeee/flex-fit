import { and, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  bookings,
  classes,
  reschedules,
  type Booking,
  type GymClass,
} from "@/db/schema";
import { hoursUntil } from "@/lib/time";
import { FREE_RESCHEDULE_HOURS } from "@/features/bookings/constant";

export type RescheduleErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "BAD_REQUEST"
  | "CONFLICT";

export type RescheduleValidationResult =
  | {
      valid: true;
      targetIsFull: boolean;
      originalBooking: Booking;
      originalClass: GymClass;
      targetClass: GymClass;
    }
  | {
      valid: false;
      code: RescheduleErrorCode;
      reason: string;
    };

/**
 * Validates whether a reschedule from one class to another is allowed and
 * whether the target class is full. Performs the exact checks, in the exact
 * order, with the exact error codes and messages the reschedule flow used
 * before this extraction. Does not create or cancel anything.
 */
export async function validateReschedule(
  db: typeof import("@/db").db,
  userId: number,
  fromBookingId: number,
  toClassId: number,
): Promise<RescheduleValidationResult> {
  const originalRow = await db
    .select({ booking: bookings, cls: classes })
    .from(bookings)
    .innerJoin(classes, eq(bookings.classId, classes.id))
    .where(eq(bookings.id, fromBookingId))
    .get();

  if (!originalRow) {
    return { valid: false, code: "NOT_FOUND", reason: "Booking not found." };
  }

  const originalBooking = originalRow.booking;
  const originalClass = originalRow.cls;

  if (originalBooking.userId !== userId) {
    return {
      valid: false,
      code: "FORBIDDEN",
      reason: "You cannot reschedule this booking.",
    };
  }

  if (
    originalBooking.status !== "booked" &&
    originalBooking.status !== "waitlisted"
  ) {
    return {
      valid: false,
      code: "BAD_REQUEST",
      reason: "This booking is no longer active.",
    };
  }

  const hoursBeforeOriginal = hoursUntil(originalClass.startsAt);
  if (hoursBeforeOriginal < FREE_RESCHEDULE_HOURS) {
    return {
      valid: false,
      code: "BAD_REQUEST",
      reason: `You can only reschedule up to ${FREE_RESCHEDULE_HOURS} hours before the class starts.`,
    };
  }

  const targetClass = await db
    .select()
    .from(classes)
    .where(eq(classes.id, toClassId))
    .get();

  if (!targetClass) {
    return {
      valid: false,
      code: "NOT_FOUND",
      reason: "Target class not found.",
    };
  }

  if (targetClass.name !== originalClass.name) {
    return {
      valid: false,
      code: "BAD_REQUEST",
      reason: "You can only reschedule to a class with the same name.",
    };
  }

  if (targetClass.id === originalClass.id) {
    return {
      valid: false,
      code: "BAD_REQUEST",
      reason: "You are already booked for this class.",
    };
  }

  if (hoursUntil(targetClass.startsAt) <= 0) {
    return {
      valid: false,
      code: "BAD_REQUEST",
      reason: "This class has already started.",
    };
  }

  if (targetClass.cancelled) {
    return {
      valid: false,
      code: "BAD_REQUEST",
      reason: "This class has been cancelled.",
    };
  }

  const existingBooking = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.classId, targetClass.id),
        eq(bookings.userId, userId),
        sql`${bookings.status} in ('booked', 'waitlisted')`,
      ),
    )
    .get();

  if (existingBooking) {
    return {
      valid: false,
      code: "CONFLICT",
      reason: "You already have an active booking for this class.",
    };
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(bookings)
    .where(
      and(eq(bookings.classId, targetClass.id), eq(bookings.status, "booked")),
    );

  const targetIsFull = Number(count) >= targetClass.capacity;

  return {
    valid: true,
    targetIsFull,
    originalBooking,
    originalClass,
    targetClass,
  };
}

/**
 * Performs a reschedule: validates first, then creates the new booking
 * keeping the original credits used (no new charge), cancels the original
 * booking, and records the reschedule. Throws the same TRPCErrors the
 * reschedule mutation threw before this extraction. Returns the new booking
 * and its status.
 */
export async function performReschedule(
  db: typeof import("@/db").db,
  userId: number,
  fromBookingId: number,
  toClassId: number,
): Promise<{ newBooking: Booking; newStatus: "booked" | "waitlisted" }> {
  const result = await validateReschedule(
    db,
    userId,
    fromBookingId,
    toClassId,
  );

  if (!result.valid) {
    throw new TRPCError({ code: result.code, message: result.reason });
  }

  const { originalBooking, originalClass, targetClass, targetIsFull } = result;
  const status = targetIsFull ? "waitlisted" : "booked";

  const newBooking = await db
    .insert(bookings)
    .values({
      classId: targetClass.id,
      userId,
      membershipId: originalBooking.membershipId,
      status,
      creditsUsed: originalBooking.creditsUsed,
    })
    .returning()
    .get();

  await db
    .update(bookings)
    .set({ status: "cancelled", cancelledAt: new Date().toISOString() })
    .where(eq(bookings.id, originalBooking.id));

  await db.insert(reschedules).values({
    userId,
    fromBookingId: originalBooking.id,
    toBookingId: newBooking.id,
    fromClassId: originalClass.id,
    toClassId: targetClass.id,
  });

  return { newBooking, newStatus: status };
}
