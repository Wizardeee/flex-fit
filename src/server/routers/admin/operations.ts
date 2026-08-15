import { z } from "zod";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  bookings,
  classes,
  users,
  checkins,
  memberships,
  membershipPlans,
} from "@/db/schema";
import { router, adminProcedure } from "../../trpc";

export const operationsRouter = router({
  classUtilisation: adminProcedure
    .input(z.object({ limit: z.number().default(10) }).default({}))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          id: classes.id,
          name: classes.name,
          startsAt: classes.startsAt,
          capacity: classes.capacity,
          booked: sql<number>`(
            select count(*) from ${bookings}
            where ${bookings.classId} = ${classes.id}
              and ${bookings.status} in ('booked','attended')
          )`.as("booked"),
        })
        .from(classes)
        .where(eq(classes.cancelled, false))
        .limit(input.limit);

      return rows.map((r) => ({
        ...r,
        booked: Number(r.booked),
        utilisation: r.capacity ? Number(r.booked) / r.capacity : 0,
      }));
    }),

  expiringMemberships: adminProcedure.query(async ({ ctx }) => {
    const today = new Date().toISOString().slice(0, 10);
    const in14Days = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const rows = await ctx.db
      .select({
        memberId: users.id,
        memberName: users.name,
        memberEmail: users.email,
        planName: membershipPlans.name,
        expiresAt: memberships.endDate,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .innerJoin(membershipPlans, eq(memberships.planId, membershipPlans.id))
      .where(
        and(
          eq(memberships.status, "active"),
          gte(memberships.endDate, today),
          lte(memberships.endDate, in14Days),
        ),
      )
      .orderBy(memberships.endDate);

    return rows;
  }),

  checkinsPerDay: adminProcedure.query(async ({ ctx }) => {
    const start = new Date();
    start.setDate(start.getDate() - 14);
    const startStr = start.toISOString().slice(0, 10);

    const rows = await ctx.db
      .select({
        date: sql<string>`date(${checkins.checkedInAt})`,
        count: sql<number>`count(*)`,
      })
      .from(checkins)
      .where(sql`date(${checkins.checkedInAt}) >= ${startStr}`)
      .groupBy(sql`date(${checkins.checkedInAt})`)
      .orderBy(sql`date(${checkins.checkedInAt}) DESC`);

    return rows.map((r) => ({
      date: r.date,
      count: Number(r.count),
    }));
  }),

  topTrainers: adminProcedure.query(async ({ ctx }) => {
    const start = new Date();
    start.setDate(start.getDate() - 14);
    const startStr = start.toISOString().slice(0, 10);

    const rows = await ctx.db
      .select({
        trainerId: classes.trainerId,
        trainerName: users.name,
        classCount: sql<number>`count(distinct ${bookings.classId})`,
        attendedCount: sql<number>`count(${bookings.id})`,
      })
      .from(bookings)
      .innerJoin(classes, eq(bookings.classId, classes.id))
      .innerJoin(users, eq(classes.trainerId, users.id))
      .where(
        and(
          eq(bookings.status, "attended"),
          sql`date(${classes.startsAt}) >= ${startStr}`,
        ),
      )
      .groupBy(classes.trainerId, users.name)
      .orderBy(sql`count(${bookings.id}) DESC`)
      .limit(10);

    return rows.map((r) => ({
      trainerId: r.trainerId,
      trainerName: r.trainerName,
      classCount: Number(r.classCount),
      attendedCount: Number(r.attendedCount),
    }));
  }),

  noShowList: adminProcedure.query(async ({ ctx }) => {
    const start = new Date();
    start.setDate(start.getDate() - 14);
    const startStr = start.toISOString().slice(0, 10);

    const rows = await ctx.db
      .select({
        bookingId: bookings.id,
        memberId: users.id,
        memberName: users.name,
        memberEmail: users.email,
        className: classes.name,
        classDate: classes.startsAt,
        trainerId: classes.trainerId,
      })
      .from(bookings)
      .innerJoin(classes, eq(bookings.classId, classes.id))
      .innerJoin(users, eq(bookings.userId, users.id))
      .where(
        and(
          eq(bookings.status, "no_show"),
          sql`date(${classes.startsAt}) >= ${startStr}`,
        ),
      )
      .orderBy(sql`${classes.startsAt} DESC`);

    const trainerIds = [...new Set(rows.map((r) => r.trainerId).filter((id) => id != null))];
    const trainers = new Map<number | null, string>();

    if (trainerIds.length > 0) {
      const trainerRows = await ctx.db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, trainerIds as number[]));

      trainerRows.forEach((t) => {
        trainers.set(t.id, t.name);
      });
    }

    return rows.map((r) => ({
      bookingId: r.bookingId,
      memberId: r.memberId,
      memberName: r.memberName,
      memberEmail: r.memberEmail,
      className: r.className,
      classDate: r.classDate,
      trainerId: r.trainerId,
      trainerName: r.trainerId ? trainers.get(r.trainerId) : undefined,
    }));
  }),
});
