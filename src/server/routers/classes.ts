import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { classes, bookings, users, memberships, notifications } from "@/db/schema";
import { UNLIMITED_CREDITS } from "@/features/bookings/constant";
import { router, publicProcedure, staffProcedure, adminProcedure } from "../trpc";

export const classesRouter = router({
  list: publicProcedure
    .input(
      z
        .object({
          from: z.string().optional(),
          to: z.string().optional(),
          includeCancelled: z.boolean().default(false),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const filters = [];
      if (input.from) filters.push(gte(classes.startsAt, input.from));
      if (input.to) filters.push(lte(classes.startsAt, input.to));
      if (!input.includeCancelled) filters.push(eq(classes.cancelled, false));

      const rows = await ctx.db
        .select({
          id: classes.id,
          name: classes.name,
          description: classes.description,
          room: classes.room,
          capacity: classes.capacity,
          startsAt: classes.startsAt,
          durationMin: classes.durationMin,
          creditCost: classes.creditCost,
          cancelled: classes.cancelled,
          trainerName: users.name,
          booked: sql<number>`(
            select count(*) from ${bookings}
            where ${bookings.classId} = ${classes.id}
              and ${bookings.status} = 'booked'
          )`.as("booked"),
        })
        .from(classes)
        .leftJoin(users, eq(classes.trainerId, users.id))
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(asc(classes.startsAt));

      return rows.map((r) => ({
        ...r,
        spotsLeft: Math.max(0, r.capacity - Number(r.booked)),
        full: Number(r.booked) >= r.capacity,
      }));
    }),

  byId: publicProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const cls = await ctx.db
        .select()
        .from(classes)
        .where(eq(classes.id, input.id))
        .get();

      if (!cls) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Class not found." });
      }

      const roster = await ctx.db
        .select({
          bookingId: bookings.id,
          status: bookings.status,
          memberName: users.name,
          memberEmail: users.email,
        })
        .from(bookings)
        .innerJoin(users, eq(bookings.userId, users.id))
        .where(eq(bookings.classId, cls.id));

      return { ...cls, roster };
    }),

  create: staffProcedure
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        trainerId: z.number().optional(),
        room: z.string().min(1),
        capacity: z.number().int().positive(),
        startsAt: z.string(),
        durationMin: z.number().int().positive().default(60),
        creditCost: z.number().int().min(0).default(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db
        .insert(classes)
        .values({
          ...input,
          description: input.description ?? null,
          trainerId: input.trainerId ?? null,
        })
        .returning()
        .get();
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        room: z.string().min(1).optional(),
        capacity: z.number().int().positive().optional(),
        startsAt: z.string().optional(),
        trainerId: z.number().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const updated = await ctx.db
        .update(classes)
        .set(patch)
        .where(eq(classes.id, id))
        .returning()
        .get();

      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Class not found." });
      }
      return updated;
    }),

  cancel: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const cls = await ctx.db
        .update(classes)
        .set({ cancelled: true })
        .where(eq(classes.id, input.id))
        .returning()
        .get();

      if (!cls) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Class not found." });
      }

      const affected = await ctx.db
        .select({
          userId: bookings.userId,
          membershipId: bookings.membershipId,
          creditsUsed: bookings.creditsUsed,
        })
        .from(bookings)
        .where(
          and(
            eq(bookings.classId, input.id),
            inArray(bookings.status, ["booked", "waitlisted"]),
          ),
        );

      await ctx.db
        .update(bookings)
        .set({ status: "cancelled", cancelledAt: new Date().toISOString() })
        .where(
          and(
            eq(bookings.classId, input.id),
            inArray(bookings.status, ["booked", "waitlisted"]),
          ),
        );

      // Refund the exact creditsUsed to booked members (same semantics as the
      // personal cancel flow). Waitlisted rows always have creditsUsed = 0 and
      // are therefore never refunded.
      for (const b of affected) {
        if (b.creditsUsed > 0 && b.membershipId) {
          const ms = await ctx.db
            .select()
            .from(memberships)
            .where(eq(memberships.id, b.membershipId))
            .get();

          if (ms && ms.creditsRemaining < UNLIMITED_CREDITS) {
            await ctx.db
              .update(memberships)
              .set({ creditsRemaining: ms.creditsRemaining + b.creditsUsed })
              .where(eq(memberships.id, ms.id));
          }
        }
      }

      // Notify every affected member (booked and waitlisted) that the class
      // was cancelled, using the exact notification schema and the
      // class_cancelled type already used by the seed data.
      if (affected.length > 0) {
        const date = new Date(cls.startsAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        await ctx.db.insert(notifications).values(
          affected.map((b) => ({
            userId: b.userId,
            type: "class_cancelled" as const,
            title: "Class cancelled",
            message: `The ${cls.name} class on ${date} has been cancelled by staff.`,
          })),
        );
      }

      return cls;
    }),
});
