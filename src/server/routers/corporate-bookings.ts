import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  corporateBookings,
  classes,
  companies,
  companyMembers,
  checkins,
  users,
  notifications,
} from "@/db/schema";
import { router, protectedProcedure, staffProcedure } from "../trpc";
import { assertClassBookable, isFull as isClassFull, isOwnerOrStaff, isRefundable, promoteNextWaitlisted } from "@/features/bookings/booking.service";
import { FREE_CANCELLATION_HOURS } from "@/features/bookings/constant";
import { CORPORATE_FREE_CANCELLATION_HOURS } from "@/features/bookings/constant";



/**
 * Corporate members may cancel free of charge up to this many hours before
 * the class starts. Cancelling later still frees the spot but forfeits the credit.
 */
//export const CORPORATE_FREE_CANCELLATION_HOURS = 24;

//function hoursUntil(iso: string, now = new Date()): number {
  //return (new Date(iso).getTime() - now.getTime()) / 36e5;
//}

async function getCompanyForMember(
  db: typeof import("@/db").db,
  userId: number,
) {
  return db
    .select()
    .from(companyMembers)
    .innerJoin(companies, eq(companyMembers.companyId, companies.id))
    .where(
      and(
        eq(companyMembers.userId, userId),
        eq(companies.active, true),
      ),
    )
    .get();
}

export const corporateBookingsRouter = router({
  mine: protectedProcedure
    .input(z.object({ includePast: z.boolean().default(false) }).default({}))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          id: corporateBookings.id,
          status: corporateBookings.status,
          creditsUsed: corporateBookings.creditsUsed,
          bookedAt: corporateBookings.bookedAt,
          classId: classes.id,
          className: classes.name,
          room: classes.room,
          startsAt: classes.startsAt,
          durationMin: classes.durationMin,
          cancelled: classes.cancelled,
          companyName: companies.name,
        })
        .from(corporateBookings)
        .innerJoin(classes, eq(corporateBookings.classId, classes.id))
        .innerJoin(companies, eq(corporateBookings.companyId, companies.id))
        .where(eq(corporateBookings.userId, ctx.user.id))
        .orderBy(asc(classes.startsAt));

      const now = new Date();
      return rows.filter((r) =>
        input.includePast ? true : new Date(r.startsAt) >= now,
      );
    }),

  book: protectedProcedure
    .input(z.object({ classId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const cls = await ctx.db
        .select()
        .from(classes)
        .where(eq(classes.id, input.classId))
        .get();
      assertClassBookable(cls);

      const existing = await ctx.db
        .select()
        .from(corporateBookings)
        .where(
          and(
            eq(corporateBookings.classId, cls.id),
            eq(corporateBookings.userId, ctx.user.id),
            inArray(corporateBookings.status, ["booked", "waitlisted"]),
          ),
        )
        .get();

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "You are already on the list for this class.",
        });
      }

      const companyRow = await getCompanyForMember(ctx.db, ctx.user.id);
      if (!companyRow) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not linked to an active company.",
        });
      }

      const company = companyRow.companies;
      if (company.creditPoolBalance < cls.creditCost) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Your company does not have enough credits.",
        });
      }

      const isFull = await isClassFull(
        ctx.db,
        corporateBookings,
        cls.id,
        cls.capacity,
      );

      const created = await ctx.db
        .insert(corporateBookings)
        .values({
          classId: cls.id,
          userId: ctx.user.id,
          companyId: company.id,
          status: isFull ? "waitlisted" : "booked",
          creditsUsed: isFull ? 0 : cls.creditCost,
        })
        .returning()
        .get();

      if (!isFull) {
        await ctx.db
          .update(companies)
          .set({
            creditPoolBalance: company.creditPoolBalance - cls.creditCost,
          })
          .where(eq(companies.id, company.id));
      }

      return created;
    }),

  cancel: protectedProcedure
    .input(z.object({ bookingId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db
        .select({ booking: corporateBookings, cls: classes })
        .from(corporateBookings)
        .innerJoin(classes, eq(corporateBookings.classId, classes.id))
        .where(eq(corporateBookings.id, input.bookingId))
        .get();

      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found." });
      }

      if (!isOwnerOrStaff(ctx.user.id, ctx.user.role, row.booking.userId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You cannot cancel this booking.",
        });
      }

      if (row.booking.status !== "booked" && row.booking.status !== "waitlisted") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This booking is no longer active.",
        });
      }

      const refundable = isRefundable(
        row.cls.startsAt,
        CORPORATE_FREE_CANCELLATION_HOURS,
        row.booking.creditsUsed,
      );

      await ctx.db
        .update(corporateBookings)
        .set({ status: "cancelled", cancelledAt: new Date().toISOString() })
        .where(eq(corporateBookings.id, row.booking.id));

      if (refundable) {
        const company = await ctx.db
          .select()
          .from(companies)
          .where(eq(companies.id, row.booking.companyId))
          .get();

        if (company) {
          await ctx.db
            .update(companies)
            .set({
              creditPoolBalance:
                company.creditPoolBalance + row.booking.creditsUsed,
            })
            .where(eq(companies.id, company.id));
        }
      }

      // Freeing a confirmed spot promotes the member who has waited longest.
      if (row.booking.status === "booked") {
        const next = await promoteNextWaitlisted(
          ctx.db,
          corporateBookings,
          row.cls.id,
        );

        if (next) {
          // Notify ONLY the promoted member; users who were not promoted
          // must not receive a notification.
          await ctx.db.insert(notifications).values({
            userId: next.userId,
            type: "waitlist_promotion" as const,
            title: "You've been promoted!",
            message: `You have been promoted from the waitlist to a confirmed spot for ${row.cls.name}.`,
          });

          if ("companyId" in next) {
            const company = await ctx.db
              .select()
              .from(companies)
              .where(eq(companies.id, next.companyId))
              .get();

            if (company && company.creditPoolBalance >= row.cls.creditCost) {
              await ctx.db
                .update(companies)
                .set({
                  creditPoolBalance: Math.max(
                    0,
                    company.creditPoolBalance - row.cls.creditCost,
                  ),
                })
                .where(eq(companies.id, company.id));
            }
          }
        }
      }

      return { ok: true, refunded: refundable };
    }),

  markAttended: staffProcedure
    .input(
      z.object({
        bookingId: z.number(),
        source: z.enum(["front_desk", "kiosk", "app"]).default("front_desk"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const booking = await ctx.db
        .select()
        .from(corporateBookings)
        .where(eq(corporateBookings.id, input.bookingId))
        .get();

      if (!booking) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found." });
      }
      if (booking.status !== "booked") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only confirmed bookings can be checked in.",
        });
      }

      await ctx.db
        .update(corporateBookings)
        .set({ status: "attended" })
        .where(eq(corporateBookings.id, booking.id));

      await ctx.db.insert(checkins).values({
        userId: booking.userId,
        bookingId: booking.id,
      });

      return { ok: true };
    }),

  rosterFor: staffProcedure
    .input(z.object({ classId: z.number() }))
    .query(async ({ ctx, input }) => {
      const bookingRows = await ctx.db
        .select({
          bookingId: corporateBookings.id,
          status: corporateBookings.status,
          memberId: users.id,
          memberName: users.name,
          memberEmail: users.email,
          bookedAt: corporateBookings.bookedAt,
          companyName: companies.name,
        })
        .from(corporateBookings)
        .innerJoin(users, eq(corporateBookings.userId, users.id))
        .innerJoin(companies, eq(corporateBookings.companyId, companies.id))
        .where(eq(corporateBookings.classId, input.classId))
        .orderBy(asc(corporateBookings.bookedAt));

      return bookingRows;
    }),
});
